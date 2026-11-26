// 継続的インテグレーション（docs/spec/architecture.md「継続的インテグレーション（CI）」、ARC-57〜ARC-62）の確認。
// GitHub の上での実行は手元で再現できないので、ワークフローの設定（.github/workflows/ci.yml）・CLAUDE.md と、
// Chromium が見つからないときのブラウザを使うテストの振る舞い（入れ子に流す Vitest）を確かめる。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { browserTestFiles } from '../../vite.config';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const WORKFLOW = '.github/workflows/ci.yml';
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  /** ステップの設定の行（字下げを除く）。 */
  lines: string[];
}

/** ワークフローの steps: の下の各ステップ（「- 」で始まる行ごとに区切る）。 */
function workflowSteps(text: string): Step[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^\s*steps:\s*$/.test(l));
  if (start < 0) return [];
  const indent = /^(\s*)/.exec(lines[start + 1] ?? '')![1]!.length;
  const steps: Step[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const depth = /^(\s*)/.exec(line)![1]!.length;
    if (depth < indent) break;
    if (depth === indent && line.trimStart().startsWith('- ')) steps.push({ lines: [] });
    const step = steps.at(-1);
    if (!step) continue;
    const body = line.trim().replace(/^- /, '');
    step.lines.push(body);
    const m = /^(name|uses|run):\s*(.*)$/.exec(body);
    if (m && depth <= indent + 2) step[m[1] as 'name' | 'uses' | 'run'] = m[2]!.trim();
  }
  return steps;
}

describe('ワークフローの読み方', () => {
  it('調べ方: steps の各ステップの name・uses・run と、ステップの設定の行を読む', () => {
    const text = [
      'jobs:',
      '  a:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      '          fetch-depth: 0',
      '      # コメント',
      '      - name: x',
      '        run: npm ci',
      '        env:',
      "          A: '1'",
      'other: 1',
    ].join('\n');
    const steps = workflowSteps(text);
    expect(steps.map((s) => [s.uses, s.name, s.run])).toEqual([
      ['actions/checkout@v4', undefined, undefined],
      [undefined, 'x', 'npm ci'],
    ]);
    expect(steps[1]!.lines).toContain("A: '1'");
  });
});

describe('CI のワークフロー', () => {
  const text = existsSync(join(ROOT, WORKFLOW)) ? read(WORKFLOW) : '';
  const steps = workflowSteps(text);
  const runs = steps.flatMap((s) => (s.run ? [s.run] : []));

  it(`ARC-57: ${WORKFLOW} が 1 つだけあり、PR（作成・更新）と main への push で走る`, () => {
    expect(text, `${WORKFLOW} がない`).not.toBe('');
    const workflows = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '.github/workflows'], { cwd: ROOT, encoding: 'utf8' });
    expect(workflows.stdout.split('\n').filter(Boolean)).toEqual([WORKFLOW]);
    expect(text).toMatch(/^on:\s*\n\s+pull_request:\s*\n\s+push:\s*\n\s+branches:\s*\[main\]\s*$/m);
  });

  it('ARC-57: ubuntu-latest の 1 つのジョブで、npm ci・lint・単体のテスト・Chromium の導入・ブラウザのテスト・ビルド・検査をこの順に流す', () => {
    expect(text.match(/^\s+runs-on:/gm)).toHaveLength(1);
    expect(text).toMatch(/^\s+runs-on:\s*ubuntu-latest\s*$/m);
    const install = runs.findIndex((r) => /playwright@[\w.${}\s]+ install\b.*\bchromium\b/.test(r));
    expect(install, 'Chromium を導入するステップがない').toBeGreaterThanOrEqual(0);
    const order = runs.map((r, i) => (i === install ? 'Chromium の導入' : r));
    expect(order).toEqual([
      'npm ci',
      'npm run lint',
      'npm run test:unit',
      'Chromium の導入',
      'npm run test:browser',
      'npm run build',
      'npm run check:subpath',
      'npm run check:assets',
    ]);
  });

  it('ARC-57: Node.js は CLAUDE.md の版（22 系）を npm のキャッシュ付きで使い、Chromium はブラウザのテストが探すキャッシュに置いてキャッシュする', () => {
    const node = steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
    expect(node?.lines).toContain('node-version: 22');
    expect(node?.lines).toContain('cache: npm');
    expect(read('CLAUDE.md')).toMatch(/Node\.js 22\.12 以上/);
    const cache = steps.find((s) => s.uses?.startsWith('actions/cache@'));
    expect(cache?.lines).toContain('path: ~/.cache/ms-playwright');
    expect(read('tests/helpers/chromium.ts')).toContain("'.cache/ms-playwright'");
    expect(steps.indexOf(cache!)).toBeLessThan(steps.findIndex((s) => s.run?.includes(' install ')));
  });

  it('ARC-58: どのステップも失敗を飛ばさない（continue-on-error や || true がない）', () => {
    expect(text).not.toMatch(/continue-on-error/);
    expect(runs.filter((r) => /\|\|\s*(true|:|exit 0)/.test(r))).toEqual([]);
    expect(text).not.toMatch(/^\s+if:/m);
  });

  it('ARC-59: 同じブランチ（同じ PR）の新しい push で、走っている古い実行を取り消す', () => {
    expect(text).toMatch(/^concurrency:\s*\n\s+group:\s*.*github\.event\.pull_request\.number \|\| github\.ref.*\n\s+cancel-in-progress:\s*true\s*$/m);
  });

  it('ARC-60: ブラウザを使うテストのステップで APEX_REQUIRE_CHROMIUM を 1 にする', () => {
    const browser = steps.find((s) => s.run === 'npm run test:browser');
    expect(browser?.lines).toContain("APEX_REQUIRE_CHROMIUM: '1'");
  });

  it('ARC-61: runner は ubuntu-latest だけで、gh-pages への push や GitHub Pages への公開の手順がない', () => {
    expect(text).not.toMatch(/macos|windows/i);
    expect([...text.matchAll(/runs-on:\s*(\S+)/g)].map((m) => m[1])).toEqual(['ubuntu-latest']);
    expect(text).not.toMatch(/gh-pages|deploy|pages: write|actions\/(deploy|upload)-pages|configure-pages|git push/i);
    expect(text).toMatch(/^permissions:\s*\n\s+contents:\s*read\s*$/m);
  });
});

describe.skipIf(NESTED)('ARC-60: Chromium が見つからないときのブラウザを使うテスト', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** Chromium の見つからない環境（HOME を空の一時ディレクトリにし、CHROMIUM_PATH をない場所にする）で、ブラウザを使うテストを 1 ファイル流す。 */
  function runWithoutChromium(require: boolean) {
    const home = mkdtempSync(join(tmpdir(), 'arc47-'));
    dirs.push(home);
    const file = browserTestFiles(ROOT).find((f) => f === 'tests/ui/analytics-browser.test.ts');
    expect(file).toBeDefined();
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CHROMIUM_PATH: join(home, 'no-chromium'), CI: '1', FORCE_COLOR: '0' };
    delete env.APEX_REQUIRE_CHROMIUM;
    if (require) env.APEX_REQUIRE_CHROMIUM = '1';
    const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--project', 'browser', file!], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
    });
    return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
  }

  it('APEX_REQUIRE_CHROMIUM がなければ、ブラウザを使うテストは飛ばされて成功になる（対照）', () => {
    const r = runWithoutChromium(false);
    expect(r.status, r.output).toBe(0);
    expect(r.output).toMatch(/skipped/);
  }, 120_000);

  it('APEX_REQUIRE_CHROMIUM=1 なら、飛ばされて成功になるのではなく失敗になり、見つからないことが出力に出る', () => {
    const r = runWithoutChromium(true);
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toMatch(/APEX_REQUIRE_CHROMIUM=1 なのに Chromium が見つからない/);
  }, 120_000);
});

describe('ARC-62: CLAUDE.md の CI と GitHub Actions の記述', () => {
  // リポジトリの一部だけを写して流すテストもあるので、ファイルは集めるときでなくテストの中で読む。
  const claude = () => read('CLAUDE.md');

  it('CI があること（走るきっかけと実行する内容）と、Actions が有効で標準の Linux の runner だけを使うことが書いてある', () => {
    const text = claude();
    expect(text).toContain(WORKFLOW);
    expect(text).toMatch(/PR/);
    expect(text).toMatch(/`main` に push/);
    for (const command of ['npm ci', 'npm run lint', 'npm run test:unit', 'npm run test:browser', 'npm run build', 'npm run check:subpath', 'npm run check:assets']) {
      expect(text).toContain(command);
    }
    expect(text).toMatch(/GitHub Actions は有効/);
    expect(text).toMatch(/ubuntu-latest/);
    expect(text).toMatch(/標準の Linux の runner だけ/);
  });

  it('Actions を止めている・ワークフローを足しても動かない、という記述がない', () => {
    expect(claude()).not.toMatch(/Actions は費用のため止めている|止めている（2026-11-25）|ワークフローを足しても動かない/);
  });
});
