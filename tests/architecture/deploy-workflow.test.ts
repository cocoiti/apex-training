// GitHub Pages への公開（docs/spec/architecture.md「公開のワークフロー」、ARC-104-1〜ARC-104-3・ARC-104-5・ARC-104-6、
// docs/spec/overview.md「公開」、OVR-104-1・OVR-104-2）の確認。
// GitHub の上での公開は手元で再現できないので、公開のワークフローの設定（.github/workflows/deploy.yml）・package.json・
// README.md・CLAUDE.md・ADR を調べる。ビルドした dist/ をサブパスで開く確認（ARC-104-4）は tests/acceptance/deploy.acceptance.test.ts。
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const DEPLOY = '.github/workflows/deploy.yml';
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const deployText = () => (existsSync(join(ROOT, DEPLOY)) ? read(DEPLOY) : '');
/** コメントを除いた行（YAML の `#` から行末まで。引用符の中の `#` はこのワークフローでは使わない）。 */
const withoutComments = (text: string) =>
  text
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, ''))
    .filter((l) => l.trim() !== '')
    .join('\n');

/** 最上位の項目 key の下の行（字下げしたまま）。 */
function topLevel(text: string, key: string): string[] {
  const lines = withoutComments(text).split('\n');
  const start = lines.findIndex((l) => new RegExp(`^${key}:\\s*$`).test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    out.push(line);
  }
  return out;
}

/** jobs: の下の各ジョブの行（ジョブ名ごと）。 */
function jobs(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let current: string[] | undefined;
  for (const line of topLevel(text, 'jobs')) {
    const m = /^ {2}([\w-]+):\s*$/.exec(line);
    if (m) out[m[1]!] = current = [];
    else current?.push(line);
  }
  return out;
}

/** ジョブの steps の各ステップ（uses・run と、ステップの行）。 */
function steps(job: string[]): { uses?: string; run?: string; lines: string[] }[] {
  const start = job.findIndex((l) => /^\s*steps:\s*$/.test(l));
  if (start < 0) return [];
  const indent = /^(\s*)/.exec(job[start + 1] ?? '')![1]!.length;
  const out: { uses?: string; run?: string; lines: string[] }[] = [];
  for (const line of job.slice(start + 1)) {
    const depth = /^(\s*)/.exec(line)![1]!.length;
    if (depth < indent) break;
    if (depth === indent && line.trimStart().startsWith('- ')) out.push({ lines: [] });
    const step = out.at(-1);
    if (!step) continue;
    const body = line.trim().replace(/^- /, '');
    step.lines.push(body);
    const m = /^(uses|run):\s*(.*)$/.exec(body);
    if (m) step[m[1] as 'uses' | 'run'] = m[2]!.trim();
  }
  return out;
}

describe('ワークフローの読み方', () => {
  it('調べ方: 最上位の項目・ジョブ・ステップを、コメントを除いて読む', () => {
    const text = [
      'on:',
      '  workflow_dispatch: # 手で',
      'jobs:',
      '  a:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      '          ref: main',
      '      # コメント',
      '      - name: x',
      '        run: npm ci',
    ].join('\n');
    expect(topLevel(text, 'on')).toEqual(['  workflow_dispatch:']);
    expect(Object.keys(jobs(text))).toEqual(['a']);
    expect(steps(jobs(text).a!).map((s) => [s.uses, s.run])).toEqual([
      ['actions/checkout@v4', undefined],
      [undefined, 'npm ci'],
    ]);
    expect(steps(jobs(text).a!)[0]!.lines).toContain('ref: main');
  });
});

describe('ARC-104-1: 公開のワークフローが走るきっかけと条件', () => {
  const text = deployText();

  it('きっかけは CI の workflow_run（completed、branches: [main]）と workflow_dispatch の 2 つだけ', () => {
    expect(text, `${DEPLOY} がない`).not.toBe('');
    const on = topLevel(text, 'on');
    expect(on.filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim())).toEqual(['workflow_run:', 'workflow_dispatch:']);
    expect(on.map((l) => l.trim())).toEqual(expect.arrayContaining(['workflows: [CI]', 'types: [completed]', 'branches: [main]']));
    // 見ているワークフローの名前は CI のワークフロー（ci.yml）の name。
    expect(read('.github/workflows/ci.yml')).toMatch(/^name: CI\s*$/m);
  });

  it('PR のイベントと push では走らない', () => {
    expect(withoutComments(text)).not.toMatch(/pull_request|^\s+push:/m);
  });

  it('公開のジョブは、手で走らせたとき、または CI のきっかけが push で結果が success のときだけ走る', () => {
    const all = jobs(text);
    expect(Object.keys(all)).toEqual(['deploy']);
    const conditions = all.deploy!.filter((l) => /^ {4}if:/.test(l)).map((l) => l.replace(/^\s*if:\s*/, ''));
    expect(conditions).toEqual([
      "github.event_name == 'workflow_dispatch' || (github.event.workflow_run.event == 'push' && github.event.workflow_run.conclusion == 'success')",
    ]);
    // ステップに条件を付けて一部だけ走らせない（ビルドを含めてジョブごと走るか走らないか）。
    expect(all.deploy!.filter((l) => /^\s+(- )?if:/.test(l))).toHaveLength(1);
  });
});

describe('ARC-104-2: 取り出すコミットと、ビルドから公開までの手順', () => {
  const text = deployText();
  const list = () => steps(jobs(text).deploy ?? []);

  it('取り出すのは workflow_run.head_sha で、手で走らせたときは main', () => {
    const checkout = list().find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout, 'actions/checkout のステップ').toBeDefined();
    expect(checkout!.lines).toContain("ref: ${{ github.event.workflow_run.head_sha || 'main' }}");
  });

  it('取り出しのあとに npm ci → npm run build がこの順にあり、upload-pages-artifact が dist を成果物にし、deploy-pages が公開する', () => {
    const order = list().map((s) => s.run ?? s.uses?.replace(/@.*$/, ''));
    expect(order).toEqual(['actions/checkout', 'actions/setup-node', 'npm ci', 'npm run build', 'actions/upload-pages-artifact', 'actions/deploy-pages']);
    const upload = list().find((s) => s.uses?.startsWith('actions/upload-pages-artifact@'))!;
    expect(upload.lines).toContain('path: dist');
  });

  it('Node.js は CI の検査のジョブと同じ版で、npm のキャッシュを使う', () => {
    const setup = list().find((s) => s.uses?.startsWith('actions/setup-node@'))!;
    const ci = read('.github/workflows/ci.yml');
    const version = /node-version:\s*(\S+)/.exec(ci)![1]!;
    expect(setup.lines).toContain(`node-version: ${version}`);
    expect(setup.lines).toContain('cache: npm');
  });

  it('gh-pages の文字と git push がない', () => {
    expect(text).not.toMatch(/gh-pages/);
    expect(text).not.toMatch(/git push/);
  });
});

describe('ARC-104-3: runner・権限・同時の公開・secret', () => {
  const text = deployText();

  it('すべてのジョブの runner が ubuntu-latest', () => {
    const all = Object.values(jobs(text));
    expect(all.length).toBeGreaterThan(0);
    for (const job of all) expect(job.filter((l) => /^ {4}runs-on:/.test(l)).map((l) => l.trim())).toEqual(['runs-on: ubuntu-latest']);
    expect(text).not.toMatch(/macos|windows|self-hosted/i);
  });

  it('permissions は contents: read・pages: write・id-token: write の 3 つだけで、ジョブごとの permissions がない', () => {
    expect(topLevel(text, 'permissions').map((l) => l.trim())).toEqual(['contents: read', 'pages: write', 'id-token: write']);
    expect(withoutComments(text).match(/permissions:/g)).toHaveLength(1);
  });

  it('concurrency は pages の組で、cancel-in-progress が false', () => {
    expect(topLevel(text, 'concurrency').map((l) => l.trim())).toEqual(['group: pages', 'cancel-in-progress: false']);
  });

  it('secret を参照しない', () => {
    expect(text).not.toMatch(/secrets\.|GITHUB_TOKEN|github\.token/);
  });
});

describe('OVR-104-1: 手元から公開するスクリプトとコマンドがない', () => {
  // 調べる文字列。このファイル自身が当たらないように分けて書く。
  const needles = [['npm run ', 'deploy'].join(''), ['scripts/', 'deploy.mjs'].join('')];

  it('公開のスクリプト（scripts の deploy.mjs）がなく、package.json の scripts に deploy がない', () => {
    expect(existsSync(join(ROOT, needles[1]!))).toBe(false);
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(Object.keys(pkg.scripts)).not.toContain('deploy');
  });

  it('置き換え済みの ADR と docs/proposal.md を除くファイルのどこにも参照がない', () => {
    const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    // 写しの作業ツリーが node_modules をシンボリックリンクで置くことがあるので、ふつうのファイルだけを見る。
    const files = r.stdout.split('\n').filter((f) => f && existsSync(join(ROOT, f)) && lstatSync(join(ROOT, f)).isFile());
    const superseded = (f: string) => /^docs\/adr\/[^/]+\.md$/.test(f) && /^---\n[\s\S]*?^status:\s*superseded\s*$[\s\S]*?\n---\n/m.test(read(f));
    // 置き換え済みの ADR の目次（index/inactive.md）は、置き換え済みの ADR の関連を写したもの。
    const excluded = (f: string) => f === 'docs/proposal.md' || f === 'docs/adr/index/inactive.md' || superseded(f);
    const found: string[] = [];
    for (const file of files.filter((f) => !excluded(f))) {
      const buf = readFileSync(join(ROOT, file));
      if (buf.includes(0)) continue; // 画像などのバイナリ
      buf
        .toString('utf8')
        .split('\n')
        .forEach((line, i) => {
          // SPEC の受け入れ条件 OVR-104-1・OVR-104-2 の文そのものは、ないことを確かめる対象の名前を書いている。
          if (file.startsWith('docs/spec/') && /^- \*\*OVR-104-[12]\*\*/.test(line)) return;
          if (needles.some((n) => line.includes(n))) found.push(`${file}:${i + 1}`);
        });
    }
    expect(found).toEqual([]);
  });
});

describe('OVR-104-2: README.md と CLAUDE.md の公開の方法', () => {
  it.each(['README.md', 'CLAUDE.md'])('%s に、手元のコマンドや gh-pages への push での公開が書かれていない', (file) => {
    const text = read(file);
    expect(text).not.toMatch(/npm\s+run\s+deploy/);
    expect(text).not.toMatch(/gh-pages/);
  });

  it.each(['README.md', 'CLAUDE.md'])('%s に、main で CI が成功したあとに公開のワークフローが公開することと、手で走らせる方法が書いてある', (file) => {
    const text = read(file);
    expect(text).toContain('.github/workflows/deploy.yml');
    expect(text).toMatch(/`main` に push したコミットで CI[^\n]*成功したあと|`main` に push したコミットで CI が成功したとき/);
    expect(text).toContain('gh workflow run deploy.yml');
  });
});

describe('ARC-104-5: CLAUDE.md の公開の記述', () => {
  const claude = () => read('CLAUDE.md');
  const section = (title: string) => {
    const text = claude();
    const start = text.indexOf(`\n## ${title}\n`);
    expect(start, `「${title}」の節`).toBeGreaterThanOrEqual(0);
    const rest = text.slice(start + 1);
    const end = rest.indexOf('\n## ', 1);
    return end < 0 ? rest : rest.slice(0, end);
  };

  it('コマンドの表に GitHub Pages へ公開する行がない', () => {
    const rows = claude()
      .split('\n')
      .filter((l) => l.startsWith('| '));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((l) => /公開|Pages|deploy/.test(l))).toEqual([]);
  });

  it('CI の節に、公開のワークフローが main の CI が成功したときに走ること、gh workflow run deploy.yml、PR では走らないことが書いてある', () => {
    const ci = section('CI');
    expect(ci).toContain('.github/workflows/deploy.yml');
    expect(ci).toMatch(/`main` に push したコミットで CI が成功したときに走り/);
    expect(ci).toContain('gh workflow run deploy.yml');
    expect(ci).toMatch(/PR を作ったとき・PR のブランチに push したときは走らない/);
  });

  it('守ることに、公開は deploy.yml だけが行い CI が成功した main だけを公開することと、ubuntu-latest だけを使うことが書いてある', () => {
    const rules = section('守ること');
    expect(rules).toMatch(/GitHub Pages への公開は `deploy\.yml` だけが行い、CI が成功した `main` のコミットだけを公開する/);
    expect(rules).toMatch(/`ubuntu-latest`）だけで動かす/);
  });
});

describe('ARC-104-6: 公開のワークフローの ADR', () => {
  const NEW = '2026-11-28-pages-deploy-workflow-after-ci';
  const OLD = '2026-11-25-manual-gh-pages-deploy-script';
  const meta = (name: string) => /^---\n([\s\S]*?)\n---\n/.exec(read(`docs/adr/${name}.md`))![1]!;

  it('新しい ADR が accepted で、手動の公開の ADR が superseded でそれを指す', () => {
    expect(meta(NEW)).toMatch(/^status: accepted$/m);
    expect(meta(OLD)).toMatch(/^status: superseded$/m);
    expect(meta(OLD)).toMatch(new RegExp(`^superseded_by: ${NEW}$`, 'm'));
  });

  // 目次を作るスクリプトはリポジトリの外（~/dotfiles）にあるので、あるときだけ流す。
  const script = join(homedir(), 'dotfiles/scripts/adr-index.py');
  it.runIf(existsSync(script))('ADR の目次を作るスクリプトを --check で実行すると 0 で終わる', () => {
    const r = spawnSync('python3', [script, '--check'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});
