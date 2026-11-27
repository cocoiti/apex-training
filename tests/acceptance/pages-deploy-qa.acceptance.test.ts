// GitHub Pages への公開を GitHub Actions の公開のワークフローに移す（#104）の受け入れテスト（QA）。
// docs/spec/overview.md「公開」（OVR-7・OVR-9 の欠番、OVR-8、OVR-104-1・OVR-104-2）と
// docs/spec/architecture.md（ARC-61、ARC-104-1〜ARC-104-6）を確かめる。
// 公開された入口（.github/workflows/ のワークフローの設定、package.json の scripts、npm のコマンド、README.md・CLAUDE.md、
// docs/spec/、docs/adr/、ADR の目次を作るスクリプト、公開先の URL）だけを使い、実装の内部には依存しない。
//
// - ARC-104-1: 公開のジョブの if は、GitHub Actions の式の小さな評価器で、きっかけ（手で走らせた・CI の実行の完了）ごとに評価する。
// - ARC-104-4: deploy.yml のビルドの段（run）を読み、そのとおりに一時的な clone の中で流してから npm run check:subpath を流す。
//   npm ci は依存を入れ直すだけで重いので、手元の node_modules をリンクして代える（ほかの段はワークフローの run のまま）。
//   check:subpath にはポート 0（PORT=0）を渡し、空いているポートを OS に選ばせる（固定のポートを確かめてから使うと、間に取られうる）。
//   ARC-13 の clone の中で npm test を実行したときに入れ子で重い確認をしないよう、APEX_ACCEPTANCE_NESTED が立っていたら飛ばす。
// - ARC-104-6: 目次を作るスクリプトはリポジトリの外（~/dotfiles）にあるので、ないとき（CI など）はその確認だけを飛ばす。
// - OVR-8: 公開先を開く確認はネットワークと実際の公開が要るため、APEX_ACCEPTANCE_LIVE=1 のときだけ流す。
//   このファイルはブラウザを使わない（画面の表示はブラウザを使う tests/acceptance/deploy.acceptance.test.ts が確かめる）。
//   ここでは公開先の #/settings の HTML と、そこから読み込むスクリプトと武器データ（JSON）が 404 にならないことを HTTP で確かめる。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const LIVE = process.env.APEX_ACCEPTANCE_LIVE === '1';
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

// このファイル自身が「参照」にならないよう、探す文字列は組み立てる。
const DEPLOY_CMD = ['npm run', 'deploy'].join(' ');
const DEPLOY_SCRIPT = ['scripts', 'deploy.mjs'].join('/');

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...extra })) {
    if (v === undefined) continue;
    if (k === 'VITEST' || k.startsWith('VITEST_') || k === 'TEST' || k === 'NODE_ENV') continue;
    env[k] = v;
  }
  return env;
}

function sh(command: string, cwd: string, extra: Record<string, string> = {}) {
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', env: childEnv(extra), maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ---- ワークフローの YAML の小さな読み取り（GitHub Actions の設定で使う範囲だけ） ----

type Yaml = string | number | boolean | null | Yaml[] | { [k: string]: Yaml };
type Obj = { [k: string]: Yaml };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i);
  }
  return s;
}

function scalar(raw: string): Yaml {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^".*"$/.test(s) || /^'.*'$/.test(s)) return s.slice(1, -1);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((x) => scalar(x));
  }
  return s;
}

interface Line {
  indent: number;
  text: string;
}

function parseYaml(source: string): Yaml {
  const lines: Line[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const t = stripComment(raw).replace(/\s+$/, '');
    if (t.trim() === '') continue;
    lines.push({ indent: t.length - t.trimStart().length, text: t.trim() });
  }
  let i = 0;
  const splitKey = (text: string): [string, string] | undefined => {
    const m = /^([^\s:'"][^:]*?|"[^"]*"|'[^']*'):(\s+(.*))?$/.exec(text);
    if (!m) return undefined;
    return [String(scalar(m[1]!)), m[3] ?? ''];
  };
  function block(indent: number): Yaml {
    if (i >= lines.length || lines[i]!.indent < indent) return null;
    const ind = lines[i]!.indent;
    if (lines[i]!.text.startsWith('- ') || lines[i]!.text === '-') {
      const arr: Yaml[] = [];
      while (i < lines.length && lines[i]!.indent === ind && (lines[i]!.text.startsWith('- ') || lines[i]!.text === '-')) {
        const rest = lines[i]!.text.slice(1).trim();
        if (rest === '') {
          i++;
          arr.push(block(ind + 1));
          continue;
        }
        const kv = splitKey(rest);
        if (kv) {
          // "- key: v" の続きの項目は、"- " の後ろの桁にそろう。
          lines[i] = { indent: ind + 2, text: rest };
          arr.push(map(ind + 2));
        } else {
          i++;
          arr.push(scalar(rest));
        }
      }
      return arr;
    }
    return map(ind);
  }
  function map(ind: number): Obj {
    const obj: Obj = {};
    while (i < lines.length && lines[i]!.indent === ind && !lines[i]!.text.startsWith('- ')) {
      const kv = splitKey(lines[i]!.text);
      if (!kv) throw new Error(`読めない行: ${lines[i]!.text}`);
      const [key, value] = kv;
      i++;
      if (value === '|' || value === '>' || value === '|-' || value === '>-') {
        const parts: string[] = [];
        while (i < lines.length && lines[i]!.indent > ind) parts.push(lines[i++]!.text);
        obj[key] = parts.join('\n');
      } else if (value !== '') obj[key] = scalar(value);
      else if (i < lines.length && (lines[i]!.indent > ind || (lines[i]!.indent === ind && lines[i]!.text.startsWith('- '))))
        obj[key] = block(lines[i]!.indent);
      else obj[key] = null;
    }
    return obj;
  }
  return block(0);
}

interface Workflow {
  file: string;
  source: string;
  doc: Obj;
}

function workflow(file: string): Workflow {
  const source = read(`.github/workflows/${file}`);
  const doc = parseYaml(source);
  if (!isObj(doc)) throw new Error(`${file} が map でない`);
  return { file, source, doc };
}

const jobsOf = (w: Workflow): [string, Obj][] =>
  isObj(w.doc.jobs) ? Object.entries(w.doc.jobs).filter((e): e is [string, Obj] => isObj(e[1])) : [];
const stepsOf = (job: Obj): Obj[] => (Array.isArray(job.steps) ? job.steps.filter(isObj) : []);
const usesOf = (step: Obj) => (typeof step.uses === 'string' ? step.uses : '');
const runOf = (step: Obj) => (typeof step.run === 'string' ? step.run.trim() : '');

// ---- GitHub Actions の式の小さな評価器（==・!=・&&・||・!・括弧・文字列・真偽・null・文脈のパス） ----

type Ctx = Record<string, unknown>;

function evaluate(expression: string, ctx: Ctx): unknown {
  const src = expression.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  const tokens = src.match(/'(?:[^']|'')*'|==|!=|&&|\|\||[()!]|[A-Za-z_][\w.-]*|\S/g) ?? [];
  let p = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];
  const lookup = (path: string): unknown => {
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (path === 'null') return null;
    return path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Ctx)[k] : undefined), ctx);
  };
  const truthy = (v: unknown) => v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
  const eq = (a: unknown, b: unknown) =>
    typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : (a ?? null) === (b ?? null);
  function primary(): unknown {
    const t = next();
    if (t === undefined) throw new Error(`式の終わりが早い: ${expression}`);
    if (t === '(') {
      const v = or();
      if (next() !== ')') throw new Error(`括弧が閉じない: ${expression}`);
      return v;
    }
    if (t === '!') return !truthy(primary());
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === '(') throw new Error(`関数はこの評価器で扱わない: ${t}（${expression}）`);
      return lookup(t);
    }
    throw new Error(`読めない字句: ${t}（${expression}）`);
  }
  function cmp(): unknown {
    let v = primary();
    while (peek() === '==' || peek() === '!=') {
      const op = next();
      const r = primary();
      v = op === '==' ? eq(v, r) : !eq(v, r);
    }
    return v;
  }
  function and(): unknown {
    let v = cmp();
    while (peek() === '&&') {
      next();
      const r = cmp();
      v = truthy(v) ? r : v;
    }
    return v;
  }
  function or(): unknown {
    let v = and();
    while (peek() === '||') {
      next();
      const r = and();
      v = truthy(v) ? v : r;
    }
    return v;
  }
  const v = or();
  if (p !== tokens.length) throw new Error(`式の残り: ${tokens.slice(p).join(' ')}（${expression}）`);
  return v;
}

const truthy = (v: unknown) => v !== undefined && v !== null && v !== false && v !== '' && v !== 0;

/** きっかけごとの github の文脈。 */
function dispatchCtx(): Ctx {
  return { github: { event_name: 'workflow_dispatch', ref: 'refs/heads/main', event: {} } };
}
function workflowRunCtx(event: string, conclusion: string, headSha = '0123456789abcdef0123456789abcdef01234567'): Ctx {
  return {
    github: {
      event_name: 'workflow_run',
      ref: 'refs/heads/main',
      event: { action: 'completed', workflow_run: { event, conclusion, head_sha: headSha, head_branch: 'main' } },
    },
  };
}

const deploy = () => workflow('deploy.yml');
const ci = () => workflow('ci.yml');

/** 公開のジョブ（deploy-pages を使うジョブ）と、そのジョブが待つジョブ。 */
function publishJobs(w: Workflow): [string, Obj][] {
  const jobs = jobsOf(w);
  const pub = jobs.filter(([, j]) => stepsOf(j).some((s) => usesOf(s).startsWith('actions/deploy-pages@')));
  const names = new Set(pub.map(([n]) => n));
  // 公開のジョブが needs で待つジョブ（ビルドを別のジョブにしたとき）も、公開のジョブの組に入れる。
  let grew = true;
  while (grew) {
    grew = false;
    for (const [n, j] of jobs) {
      const needs = Array.isArray(j.needs) ? j.needs : typeof j.needs === 'string' ? [j.needs] : [];
      for (const need of needs) {
        if (names.has(n) && typeof need === 'string' && !names.has(need)) {
          names.add(need);
          grew = true;
        }
      }
    }
  }
  return jobs.filter(([n]) => names.has(n));
}

/** そのジョブが、その文脈で走るか（ジョブの if。needs で待つジョブが走らなければ走らない）。 */
function jobRuns(w: Workflow, name: string, ctx: Ctx, seen = new Set<string>()): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  const job = (w.doc.jobs as Obj)[name] as Obj;
  const needs = Array.isArray(job.needs) ? job.needs : typeof job.needs === 'string' ? [job.needs] : [];
  for (const need of needs) if (typeof need === 'string' && !jobRuns(w, need, ctx, new Set(seen))) return false;
  if (job.if === undefined || job.if === null) return true;
  return truthy(evaluate(String(job.if), ctx));
}

// ---- 受け入れ条件 ----

describe('OVR-7・OVR-9: 削除して欠番（gh-pages ブランチへの手元からの公開と、未コミットの変更での拒否の条件がない）', () => {
  const specFiles = readdirSync(join(ROOT, 'docs/spec')).filter((f) => f.endsWith('.md'));

  it('SPEC のどこにも OVR-7・OVR-9 の受け入れ条件がなく、ほかの条件にも使い回されていない', () => {
    for (const f of specFiles) {
      const text = read(`docs/spec/${f}`);
      expect(text, f).not.toMatch(/\bOVR-7\b(?!-)/);
      expect(text, f).not.toMatch(/\bOVR-9\b(?!-)/);
    }
  });

  it('OVR-8 は残っている', () => {
    expect(read('docs/spec/overview.md')).toMatch(/\*\*OVR-8\*\*: 公開した `https:\/\/cocoiti\.github\.io\/apex-training\/#\/settings` を直接開いたとき/);
  });

  it('公開のコマンド（gh-pages ブランチにビルド結果と .nojekyll を置く手元のコマンド）がない', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
    for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
      expect(cmd, `package.json の scripts.${name}`).not.toMatch(/gh-pages|nojekyll|git push/);
    }
  });
});

describe('OVR-104-1: 手元から公開するスクリプトとコマンドがなく、どこからも参照されていない', () => {
  it('scripts の deploy.mjs がない', () => {
    expect(existsSync(join(ROOT, DEPLOY_SCRIPT))).toBe(false);
  });

  it('package.json の scripts に deploy がない', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
    expect(Object.keys(pkg.scripts ?? {})).not.toContain('deploy');
  });

  it('置き換え済みの ADR と docs/proposal.md を除くファイルに、公開のコマンドとスクリプトへの参照がない', () => {
    const tracked = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    expect(tracked.length).toBeGreaterThan(0);
    const superseded = (f: string) =>
      /^docs\/adr\/[^/]+\.md$/.test(f) && /^---\r?\n[\s\S]*?^status:\s*superseded\s*$/m.test(read(f).split(/\r?\n---\r?\n/)[0] ?? '');
    const hits: string[] = [];
    for (const f of tracked) {
      if (f === 'docs/proposal.md' || superseded(f) || !existsSync(join(ROOT, f))) continue;
      if (/\.(png|jpe?g|gif|webp|ico|glb|gltf|bin|mp3|ogg|wav|woff2?)$/i.test(f)) continue;
      let text: string;
      try {
        text = read(f);
      } catch {
        continue;
      }
      text.split(/\r?\n/).forEach((line, n) => {
        if (!line.includes(DEPLOY_CMD) && !line.includes(DEPLOY_SCRIPT)) return;
        // OVR-104-1・OVR-104-2 の条件の文そのもの（それらが「ない」ことを述べる文）は参照に数えない。
        if (f.startsWith('docs/spec/') && /\*\*OVR-104-[12]\*\*/.test(line)) return;
        hits.push(`${f}:${n + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

describe('OVR-104-2: README.md と CLAUDE.md に、公開は main の CI が成功したあとに公開のワークフローが行うことが書いてある', () => {
  for (const file of ['README.md', 'CLAUDE.md']) {
    describe(file, () => {
      const text = read(file);

      it('手元から公開するコマンドや gh-pages ブランチへの push での公開が書かれていない', () => {
        expect(text).not.toContain(DEPLOY_CMD);
        expect(text).not.toMatch(/gh-pages/);
      });

      it('main で CI が成功したあとに公開のワークフロー（deploy.yml）が公開することが書いてある', () => {
        expect(text).toContain('deploy.yml');
        expect(text).toMatch(/`?main`?/);
        expect(text).toMatch(/CI[^\n]*成功[^\n]*公開|成功[^\n]*deploy\.yml|CI[^\n]*成功[^\n]*\n[^\n]*公開/);
      });

      it('手で走らせるときの gh workflow run deploy.yml が書いてある', () => {
        expect(text).toContain('gh workflow run deploy.yml');
      });
    });
  }
});

describe('ARC-61: CI のワークフロー（ci.yml）は ubuntu-latest だけを使い、gh-pages への push や Pages への公開の手順がない', () => {
  it('ci.yml のどのジョブも ubuntu-latest で動く', () => {
    const w = ci();
    const jobs = jobsOf(w);
    expect(jobs.length).toBeGreaterThan(0);
    for (const [name, job] of jobs) expect(job['runs-on'], `ci.yml のジョブ ${name}`).toBe('ubuntu-latest');
    expect(w.source).not.toMatch(/macos|windows|self-hosted/i);
  });

  it('ci.yml に gh-pages・git push・Pages への公開の action がない', () => {
    const w = ci();
    expect(w.source).not.toMatch(/gh-pages/);
    expect(w.source).not.toMatch(/git\s+push/);
    expect(w.source).not.toMatch(/upload-pages-artifact|deploy-pages|configure-pages|peaceiris|JamesIves/i);
    expect(w.source).not.toMatch(/^\s*pages\s*:\s*write/m);
  });
});

describe('ARC-104-1: deploy.yml は CI の完了（main）と手で走らせたときだけ走り、公開のジョブは dispatch か push の CI が成功したときだけ走る', () => {
  it('きっかけは workflow_run（CI・completed・branches: [main]）と workflow_dispatch の 2 つだけ', () => {
    const w = deploy();
    const on = w.doc.on;
    expect(isObj(on), 'on が map').toBe(true);
    expect(Object.keys(on as Obj).sort()).toEqual(['workflow_dispatch', 'workflow_run']);
    const wr = (on as Obj).workflow_run as Obj;
    expect(wr.types).toEqual(['completed']);
    expect(wr.branches).toEqual(['main']);
    // 待つワークフローは CI のワークフロー（ci.yml の name）。
    const ciName = ci().doc.name;
    expect(wr.workflows).toEqual([typeof ciName === 'string' ? ciName : 'ci.yml']);
  });

  it('PR のイベントと push のきっかけがない', () => {
    const on = deploy().doc.on as Obj;
    for (const ev of ['pull_request', 'pull_request_target', 'push']) expect(Object.keys(on), ev).not.toContain(ev);
  });

  it('公開のジョブ（ビルドを含む）は、手で走らせたときと、push で走った CI が success のときだけ走る', () => {
    const w = deploy();
    const jobs = publishJobs(w);
    expect(jobs.length, '公開のジョブ（deploy-pages を使うジョブ）がある').toBeGreaterThan(0);
    const cases: [string, Ctx, boolean][] = [
      ['workflow_dispatch', dispatchCtx(), true],
      ['workflow_run push success', workflowRunCtx('push', 'success'), true],
      ['workflow_run push failure', workflowRunCtx('push', 'failure'), false],
      ['workflow_run push cancelled', workflowRunCtx('push', 'cancelled'), false],
      ['workflow_run push skipped', workflowRunCtx('push', 'skipped'), false],
      ['workflow_run pull_request success', workflowRunCtx('pull_request', 'success'), false],
      ['workflow_run pull_request failure', workflowRunCtx('pull_request', 'failure'), false],
    ];
    for (const [label, ctx, expected] of cases) {
      // 公開の action を使うジョブがその文脈で走るか。
      const pub = jobs.filter(([, j]) => stepsOf(j).some((s) => usesOf(s).startsWith('actions/deploy-pages@')));
      for (const [name] of pub) expect(jobRuns(w, name, ctx), `${label} で公開のジョブ ${name}`).toBe(expected);
      // ビルド（npm run build）を流すジョブも、走らないときは走らない。
      for (const [name, j] of jobs) {
        if (!stepsOf(j).some((s) => /^npm run build(\s|$)/.test(runOf(s)))) continue;
        expect(jobRuns(w, name, ctx), `${label} でビルドのジョブ ${name}`).toBe(expected);
      }
    }
  });
});

describe('ARC-104-2: deploy.yml は CI が流れたコミット（手では main）を取り出し、npm ci → npm run build の成果物 dist を Pages に公開する', () => {
  /** 公開のジョブの段を、needs の順に並べてつないだもの。 */
  const steps = (): Obj[] => {
    const w = deploy();
    const jobs = publishJobs(w);
    const order: string[] = [];
    const visit = (n: string) => {
      if (order.includes(n)) return;
      const j = (w.doc.jobs as Obj)[n] as Obj;
      const needs = Array.isArray(j.needs) ? j.needs : typeof j.needs === 'string' ? [j.needs] : [];
      for (const need of needs) if (typeof need === 'string') visit(need);
      order.push(n);
    };
    for (const [n] of jobs) visit(n);
    return order.flatMap((n) => stepsOf((w.doc.jobs as Obj)[n] as Obj));
  };

  it('取り出すコミットは、workflow_run では workflow_run.head_sha、手で走らせたときは main', () => {
    const checkouts = steps().filter((s) => usesOf(s).startsWith('actions/checkout@'));
    expect(checkouts.length).toBeGreaterThan(0);
    const sha = 'fedcba9876543210fedcba9876543210fedcba98';
    for (const c of checkouts) {
      const ref = isObj(c.with) ? c.with.ref : undefined;
      expect(typeof ref, 'checkout に ref がある').toBe('string');
      expect(evaluate(String(ref), workflowRunCtx('push', 'success', sha))).toBe(sha);
      const manual = evaluate(String(ref), dispatchCtx());
      expect(['main', 'refs/heads/main']).toContain(manual);
    }
  });

  it('取り出し → npm ci → npm run build → upload-pages-artifact（dist）→ deploy-pages の順にある', () => {
    const s = steps();
    const idx = (pred: (st: Obj) => boolean, label: string) => {
      const i = s.findIndex(pred);
      expect(i, `${label} の段がある`).toBeGreaterThanOrEqual(0);
      return i;
    };
    const checkout = idx((st) => usesOf(st).startsWith('actions/checkout@'), 'checkout');
    const install = idx((st) => /^npm ci(\s|$)/.test(runOf(st)), 'npm ci');
    const build = idx((st) => /^npm run build(\s|$)/.test(runOf(st)), 'npm run build');
    const upload = idx((st) => usesOf(st).startsWith('actions/upload-pages-artifact@'), 'upload-pages-artifact');
    const pub = idx((st) => usesOf(st).startsWith('actions/deploy-pages@'), 'deploy-pages');
    expect(checkout).toBeLessThan(install);
    expect(install).toBeLessThan(build);
    expect(build).toBeLessThan(upload);
    expect(upload).toBeLessThan(pub);
    const path = isObj(s[upload]!.with) ? (s[upload]!.with as Obj).path : undefined;
    expect(String(path).replace(/^\.\//, '').replace(/\/$/, '')).toBe('dist');
  });

  it('gh-pages の文字と git push がない', () => {
    const w = deploy();
    expect(w.source).not.toMatch(/gh-pages/);
    expect(w.source).not.toMatch(/git\s+push/);
  });
});

describe('ARC-104-3: deploy.yml は ubuntu-latest だけで、permissions は 3 つだけ、concurrency は pages で取り消さず、secret を参照しない', () => {
  it('すべてのジョブの runner が ubuntu-latest', () => {
    const jobs = jobsOf(deploy());
    expect(jobs.length).toBeGreaterThan(0);
    for (const [name, job] of jobs) expect(job['runs-on'], `ジョブ ${name}`).toBe('ubuntu-latest');
    expect(deploy().source).not.toMatch(/macos|windows|self-hosted/i);
  });

  it('permissions が contents: read・pages: write・id-token: write の 3 つだけ', () => {
    const w = deploy();
    expect(w.doc.permissions).toEqual({ contents: 'read', pages: 'write', 'id-token': 'write' });
    // ジョブで権限を足していない（書くなら同じ 3 つのうちのもの）。
    for (const [name, job] of jobsOf(w)) {
      if (job.permissions === undefined) continue;
      expect(isObj(job.permissions), `ジョブ ${name} の permissions`).toBe(true);
      for (const [k, v] of Object.entries(job.permissions as Obj)) {
        expect({ [k]: v }, `ジョブ ${name} の permissions`).toEqual({ [k]: (w.doc.permissions as Obj)[k] });
      }
    }
  });

  it('concurrency の組が pages で cancel-in-progress が false', () => {
    const c = deploy().doc.concurrency;
    expect(isObj(c)).toBe(true);
    expect((c as Obj).group).toBe('pages');
    expect((c as Obj)['cancel-in-progress']).toBe(false);
  });

  it('secret を参照しない', () => {
    const w = deploy();
    expect(w.source).not.toMatch(/secrets\s*[.[]/);
    expect(w.source).not.toMatch(/secrets\s*:\s*inherit/);
  });
});

describe.skipIf(NESTED)('ARC-104-4: deploy.yml と同じ手順（npm ci → npm run build）の dist/ を /apex-training/ で配信すると #/settings が 404 にならない', () => {
  it('deploy.yml のビルドの段を clone の中で流したあと、npm run check:subpath が成功する', () => {
    const w = deploy();
    const runs = publishJobs(w)
      .flatMap(([, j]) => stepsOf(j))
      .map(runOf)
      .filter(Boolean);
    expect(runs).toEqual(['npm ci', 'npm run build']);

    const work = mkdtempSync(join(tmpdir(), 'arc104-qa-'));
    temps.push(work);
    const clone = join(work, 'clone');
    const c = sh(`git clone --quiet "${ROOT}" "${clone}"`, work);
    expect(c.status, c.output).toBe(0);
    for (const run of runs) {
      if (run === 'npm ci') {
        // 依存の導入は手元の node_modules をリンクして代える。
        symlinkSync(join(ROOT, 'node_modules'), join(clone, 'node_modules'));
        continue;
      }
      const r = sh(run, clone);
      expect(r.status, `${run}\n${r.output}`).toBe(0);
    }
    expect(existsSync(join(clone, 'dist/index.html'))).toBe(true);
    const check = sh('npm run check:subpath', clone, { PORT: '0' });
    expect(check.status, check.output).toBe(0);
  }, 600_000);
});

describe('ARC-104-5: CLAUDE.md のコマンド表に公開の行がなく、CI の節と守ることに公開のワークフローのことが書いてある', () => {
  const text = read('CLAUDE.md');
  /** 見出し（##）からつぎの同じ深さの見出しまで。 */
  const section = (title: RegExp): string => {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => /^## /.test(l) && title.test(l));
    expect(start, `節 ${title}`).toBeGreaterThanOrEqual(0);
    let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
    if (end < 0) end = lines.length;
    return lines.slice(start, end).join('\n');
  };

  it('コマンドの表に GitHub Pages へ公開する行がない', () => {
    const rows = text.split('\n').filter((l) => /^\|/.test(l));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toMatch(/Pages|公開|deploy|gh-pages/i);
    }
  });

  it('CI の節に、公開のワークフローが main の CI が成功したときに走ること・gh workflow run deploy.yml・PR では走らないことが書いてある', () => {
    const s = section(/^## CI\b/);
    expect(s).toContain('deploy.yml');
    expect(s).toMatch(/main/);
    expect(s).toMatch(/成功/);
    expect(s).toContain('gh workflow run deploy.yml');
    expect(s).toMatch(/PR[^\n]*走らない/);
  });

  it('守ることに、公開は deploy.yml だけが行い CI が成功した main だけを公開することと、ubuntu-latest だけを使うことが書いてある', () => {
    const s = section(/守ること/);
    expect(s).toMatch(/公開は\s*`?deploy\.yml`?\s*だけ/);
    expect(s).toMatch(/CI が成功した\s*`?main`?/);
    expect(s).toMatch(/ubuntu-latest[^\n]*だけ/);
  });
});

describe('ARC-104-6: 公開のワークフローの ADR が accepted で、手動の公開の ADR がそれに置き換えられている', () => {
  const ADR_DIR = join(ROOT, 'docs/adr');
  const OLD = '2026-11-25-manual-gh-pages-deploy-script';
  const front = (name: string): Record<string, string> => {
    const text = readFileSync(join(ADR_DIR, `${name}.md`), 'utf8');
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    expect(m, `${name} の frontmatter`).not.toBeNull();
    const meta: Record<string, string> = {};
    for (const line of m![1]!.split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0 && !/^\s/.test(line)) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
    }
    return meta;
  };

  it('置き換え先の ADR が accepted で、公開のワークフロー（deploy.yml）で公開することを決めている', () => {
    const old = front(OLD);
    expect(old.status).toBe('superseded');
    const next = old.superseded_by;
    expect(next, 'superseded_by').toBeTruthy();
    expect(existsSync(join(ADR_DIR, `${next}.md`)), `${next}.md がある`).toBe(true);
    const meta = front(next!);
    expect(meta.status).toBe('accepted');
    const body = readFileSync(join(ADR_DIR, `${next}.md`), 'utf8');
    expect(body).toContain('deploy.yml');
    expect(body).toMatch(/GitHub Actions|workflow_run/);
  });

  const script = join(homedir(), 'dotfiles/scripts/adr-index.py');
  it.skipIf(!existsSync(script))('ADR の目次を作るスクリプトを --check で実行すると 0 で終わる', () => {
    const r = spawnSync('python3', [script, '--check'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  });
});

describe.skipIf(!LIVE)('OVR-8: 公開した https://cocoiti.github.io/apex-training/#/settings が 404 にならない（APEX_ACCEPTANCE_LIVE=1 のときだけ）', () => {
  const BASE = 'https://cocoiti.github.io/apex-training/';

  it('#/settings の HTML と、そこから読み込むスクリプトと武器データ（JSON）が 404 にならない', async () => {
    const page = await fetch(`${BASE}#/settings`);
    expect(page.status).toBe(200);
    const html = await page.text();
    const scripts = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => new URL(m[1]!, BASE).href);
    expect(scripts.length).toBeGreaterThan(0);
    const json = new Set<string>();
    for (const src of scripts) {
      expect(new URL(src).pathname.startsWith('/apex-training/'), src).toBe(true);
      const r = await fetch(src);
      expect(r.status, src).toBe(200);
      const js = await r.text();
      // 読み込む URL（/ や https:// で始まるもの）だけを見る。"./r99.json" のような import.meta.glob の鍵は URL ではない。
      for (const m of js.matchAll(/["'`]((?:https?:\/\/[^/"'`\s]+)?\/[^"'`\s]*?\.json)["'`]/g)) json.add(new URL(m[1]!, src).href);
    }
    expect(json.size, '武器データ（JSON）の参照がある').toBeGreaterThan(0);
    for (const url of json) {
      expect(new URL(url).pathname.startsWith('/apex-training/'), url).toBe(true);
      const r = await fetch(url);
      expect(r.status, url).toBe(200);
    }
  }, 60_000);
});
