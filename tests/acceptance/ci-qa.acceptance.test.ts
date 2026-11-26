// docs/spec/architecture.md「継続的インテグレーション（CI）」の受け入れ条件（ARC-44〜ARC-49）の受け入れテスト。
// 公開された入口（.github/workflows/ 以下のワークフローの設定、npm のコマンド、CLAUDE.md、GitHub の CI の実行の記録）だけを使い、
// 実装の内部には依存しない。
//
// いつも流す確認:
// - ワークフローの設定を読み、走るきっかけ・runner・段の順・失敗で止まること・取り消し・公開の手順がないことを確かめる。
// - CI が実行するコマンド（ワークフローの run と env）を手元でそのとおりに実行し、テストの失敗・lint の誤りで失敗すること（ARC-45）、
//   Chromium が見つからないときにブラウザを使うテストが飛ばされて成功にならないこと（ARC-47）を確かめる。
// GitHub での実際の実行の確認（ARC-44・ARC-46・ARC-47 の実行の記録）は、ネットワークと push が要るため APEX_ACCEPTANCE_LIVE=1 のときだけ流す。
//   見る実行のブランチは APEX_ACCEPTANCE_CI_BRANCH（なければ今のブランチ）。
// ARC-13 の clone の中で npm test を実行したときに入れ子で重い確認をしないよう、APEX_ACCEPTANCE_NESTED が立っていたら子のプロセスを使う確認を飛ばす。
// このファイルはブラウザを使う組に入らない（Chromium は子のプロセスの Vitest が使う）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const LIVE = process.env.APEX_ACCEPTANCE_LIVE === '1';
const WORKFLOW_DIR = join(ROOT, '.github/workflows');

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** 子のプロセスの環境。親の Vitest の環境変数は渡さない。 */
function childEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...extra })) {
    if (v === undefined) continue;
    if (k === 'VITEST' || k.startsWith('VITEST_') || k === 'TEST' || k === 'NODE_ENV') continue;
    env[k] = v;
  }
  return env;
}

function sh(command: string, cwd: string, env: Record<string, string | undefined> = {}) {
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', env: childEnv(env), maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ---- ワークフローの YAML を読む（GitHub Actions の設定で使う範囲の YAML だけを扱う小さな読み取り） ----

type Yaml = string | number | boolean | null | Yaml[] | { [k: string]: Yaml };

interface Line {
  indent: number;
  text: string;
}

function stripComment(s: string): string {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1] ?? ''))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s.trimEnd();
}

function scalar(raw: string): Yaml {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((x) => scalar(x));
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    const out: Record<string, Yaml> = {};
    if (inner) for (const kv of inner.split(',')) {
      const i = kv.indexOf(':');
      out[kv.slice(0, i).trim()] = scalar(kv.slice(i + 1));
    }
    return out;
  }
  if (/^-?\d+(\.\d+)?$/.test(s) && !/^\d+\.\d+\.\d+/.test(s)) return Number(s);
  return s;
}

function parseYaml(source: string): Yaml {
  const rawLines = source.split(/\r?\n/);
  let pos = 0;

  function nextLine(): Line | undefined {
    while (pos < rawLines.length) {
      const raw = rawLines[pos] ?? '';
      const text = stripComment(raw);
      if (text.trim() === '' || text.trim() === '---') {
        pos++;
        continue;
      }
      return { indent: raw.length - raw.trimStart().length, text: text.trim() };
    }
    return undefined;
  }

  function blockScalar(parentIndent: number, folded: boolean): string {
    const lines: string[] = [];
    let indent = -1;
    while (pos < rawLines.length) {
      const raw = rawLines[pos] ?? '';
      if (raw.trim() === '') {
        lines.push('');
        pos++;
        continue;
      }
      const ind = raw.length - raw.trimStart().length;
      if (ind <= parentIndent) break;
      if (indent < 0) indent = ind;
      lines.push(raw.slice(indent));
      pos++;
    }
    while (lines.length && lines.at(-1) === '') lines.pop();
    return folded ? lines.join(' ') : `${lines.join('\n')}\n`;
  }

  function value(rest: string, indent: number): Yaml {
    if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') return blockScalar(indent, rest.startsWith('>'));
    if (rest !== '') return scalar(rest);
    const next = nextLine();
    if (!next || next.indent < indent || (next.indent === indent && !next.text.startsWith('- '))) return null;
    return block(next.indent);
  }

  function mapEntries(indent: number, out: Record<string, Yaml>, first?: string): void {
    let pending = first;
    for (;;) {
      let text: string;
      if (pending !== undefined) {
        text = pending;
        pending = undefined;
      } else {
        const line = nextLine();
        if (!line || line.indent !== indent || line.text.startsWith('- ')) return;
        text = line.text;
        pos++;
      }
      const m = /^("[^"]*"|'[^']*'|[^:]+?):(?:\s+(.*))?$/.exec(text);
      if (!m) throw new Error(`YAML の行を読めない: ${text}`);
      const key = String(scalar(m[1] ?? ''));
      out[key] = value((m[2] ?? '').trim(), indent);
    }
  }

  function block(indent: number): Yaml {
    const first = nextLine();
    if (!first) return null;
    if (first.text.startsWith('- ') || first.text === '-') {
      const list: Yaml[] = [];
      for (;;) {
        const line = nextLine();
        if (!line || line.indent !== indent || !(line.text.startsWith('- ') || line.text === '-')) break;
        pos++;
        const rest = line.text === '-' ? '' : line.text.slice(2).trim();
        const itemIndent = indent + 2;
        if (rest === '') list.push(value('', indent));
        else if (/^("[^"]*"|'[^']*'|[^:\s][^:]*?):(\s|$)/.test(rest) && !rest.startsWith('{')) {
          const obj: Record<string, Yaml> = {};
          mapEntries(itemIndent, obj, rest);
          list.push(obj);
        } else list.push(scalar(rest));
      }
      return list;
    }
    const obj: Record<string, Yaml> = {};
    mapEntries(indent, obj);
    return obj;
  }

  return block(0);
}

type Obj = Record<string, Yaml>;
const isObj = (v: Yaml | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

interface Workflow {
  file: string;
  source: string;
  doc: Obj;
}

function workflows(): Workflow[] {
  if (!existsSync(WORKFLOW_DIR)) return [];
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => {
      const source = readFileSync(join(WORKFLOW_DIR, f), 'utf8');
      const doc = parseYaml(source);
      if (!isObj(doc)) throw new Error(`${f} の最上位が対応表でない`);
      return { file: f, source, doc };
    });
}

/** PR と main への push で走るワークフロー（CI）。 */
function ciWorkflow(): Workflow {
  const all = workflows();
  const ci = all.filter((w) => {
    const on = w.doc.on ?? w.doc.true; // YAML 1.1 では on が true と読まれることがあるため両方を見る
    return isObj(on) && 'pull_request' in on && 'push' in on;
  });
  expect(ci.map((w) => w.file), 'PR と push で走るワークフローがちょうど 1 つある').toHaveLength(1);
  return ci[0]!;
}

function onlyJob(w: Workflow): Obj {
  const jobs = jobsOf(w);
  expect(jobs, `${w.file} のジョブは 1 つ`).toHaveLength(1);
  return jobs[0]![1];
}

function jobsOf(w: Workflow): [string, Obj][] {
  const jobs = w.doc.jobs;
  if (!isObj(jobs)) throw new Error(`${w.file} に jobs がない`);
  return Object.entries(jobs).map(([name, job]) => {
    if (!isObj(job)) throw new Error(`${w.file} のジョブ ${name} が対応表でない`);
    return [name, job];
  });
}

function stepsOf(job: Obj): Obj[] {
  const steps = job.steps;
  if (!Array.isArray(steps)) throw new Error('ジョブに steps がない');
  return steps.map((s) => {
    if (!isObj(s)) throw new Error('段が対応表でない');
    return s;
  });
}

const runOf = (step: Obj): string => (typeof step.run === 'string' ? step.run.trim() : '');

/** run を持つ段のうち、期待する段のどれに当たるか（当たらなければ undefined）。 */
const STAGES: { name: string; match: (run: string) => boolean }[] = [
  { name: 'npm ci', match: (r) => /^npm ci(\s|$)/.test(r) },
  { name: 'npm run lint', match: (r) => /^npm run lint(\s|$)/.test(r) },
  { name: 'npm run test:unit', match: (r) => /^npm run test:unit(\s|$)/.test(r) },
  { name: 'Chromium の導入', match: (r) => /playwright(?:@(?:\$\{\{[^}]*\}\}|\S+))?\s+install\b.*\bchromium\b/.test(r) },
  { name: 'npm run test:browser', match: (r) => /^npm run test:browser(\s|$)/.test(r) },
  { name: 'npm run build', match: (r) => /^npm run build(\s|$)/.test(r) },
  { name: 'npm run check:subpath', match: (r) => /^npm run check:subpath(\s|$)/.test(r) },
  { name: 'npm run check:assets', match: (r) => /^npm run check:assets(\s|$)/.test(r) },
];

function stageOf(run: string): string | undefined {
  return STAGES.find((s) => s.match(run))?.name;
}

/** ${{ ... }} を含まない値だけの環境変数（ワークフロー・ジョブ・段の順に重ねる）。 */
function literalEnv(...layers: (Yaml | undefined)[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const layer of layers) {
    if (!isObj(layer)) continue;
    for (const [k, v] of Object.entries(layer)) {
      const s = String(v);
      if (!s.includes('${{')) out[k] = s;
    }
  }
  return out;
}

/** CI の唯一のジョブと、ブラウザを使うテストの段の環境変数（ワークフロー・ジョブ・段）。 */
function browserStageEnv(): Record<string, string> {
  const w = ciWorkflow();
  const job = onlyJob(w);
  const step = stepsOf(job).find((s) => stageOf(runOf(s)) === 'npm run test:browser');
  if (!step) throw new Error('ブラウザを使うテストの段がない');
  return literalEnv(w.doc.env, job.env, step.env);
}

/** ${{ github.xxx }} の参照を、与えた GitHub の文脈で評価する（|| と && とプロパティの参照だけ）。 */
function evalExpr(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expr: string) => {
    const lookup = (path: string): unknown => {
      const p = path.trim();
      if (/^'.*'$/.test(p)) return p.slice(1, -1);
      return p.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), ctx);
    };
    const or = expr.split('||').map((part) => {
      const ands = part.split('&&').map(lookup);
      return ands.reduce((a, b) => (a ? b : a));
    });
    const v = or.find((x) => x !== undefined && x !== null && x !== '' && x !== false && x !== 0) ?? or.at(-1);
    return v === undefined || v === null ? '' : String(v);
  });
}

// ---- GitHub の CI の実行の記録（LIVE） ----

function gh(args: string): unknown {
  const r = sh(`gh ${args}`, ROOT);
  if (r.status !== 0) throw new Error(`gh ${args} が失敗した:\n${r.output}`);
  return JSON.parse(r.stdout);
}

function repoSlug(): string {
  const url = sh('git remote get-url origin', ROOT).stdout.trim();
  const m = /github\.com[:/](.+?)(?:\.git)?$/.exec(url);
  if (!m) throw new Error(`origin が GitHub のリポジトリでない: ${url}`);
  return m[1]!;
}

interface Run {
  id: number;
  event: string;
  status: string;
  conclusion: string | null;
  head_branch: string;
  head_sha: string;
  created_at: string;
  path: string;
}

interface Job {
  id: number;
  name: string;
  labels: string[];
  conclusion: string | null;
  steps: { name: string; number: number; conclusion: string | null }[];
}

function liveBranch(): string {
  return process.env.APEX_ACCEPTANCE_CI_BRANCH || sh('git branch --show-current', ROOT).stdout.trim();
}

function ciRuns(query: string): Run[] {
  const res = gh(`api "repos/${repoSlug()}/actions/runs?per_page=100&${query}"`) as { workflow_runs: Run[] };
  const ciFile = `.github/workflows/${ciWorkflow().file}`;
  return res.workflow_runs.filter((r) => r.path === ciFile || r.path.startsWith(`${ciFile}@`));
}

function jobsOfRun(id: number): Job[] {
  return (gh(`api "repos/${repoSlug()}/actions/runs/${id}/jobs?filter=all"`) as { jobs: Job[] }).jobs;
}

/** 実行のジョブの段の名前（ワークフローの name）と、ワークフローの段の対応から、期待する段の順に並べた段の結果。 */
function checkRunSteps(run: Run): void {
  const w = ciWorkflow();
  const wfJob = onlyJob(w);
  const nameToStage = new Map<string, string>();
  for (const s of stepsOf(wfJob)) {
    const stage = stageOf(runOf(s));
    if (stage && typeof s.name === 'string') nameToStage.set(s.name, stage);
  }
  const jobs = jobsOfRun(run.id);
  expect(jobs, `実行 ${run.id} のジョブは 1 つ`).toHaveLength(1);
  const job = jobs[0]!;
  expect(job.labels, `実行 ${run.id} の runner`).toEqual(['ubuntu-latest']);
  const executed = job.steps
    .slice()
    .sort((a, b) => a.number - b.number)
    .map((s) => ({ stage: nameToStage.get(s.name), conclusion: s.conclusion }))
    .filter((s): s is { stage: string; conclusion: string | null } => s.stage !== undefined);
  expect(executed.map((s) => s.stage), `実行 ${run.id} の段の順`).toEqual(STAGES.map((s) => s.name));
  expect(executed.every((s) => s.conclusion === 'success'), `実行 ${run.id} の段がすべて成功`).toBe(true);
  expect(job.conclusion).toBe('success');
}

// ---- 受け入れテスト ----

describe('ARC-44: PR・PR のブランチへの push・main への push で、ubuntu-latest の CI が決まった順に段を流す', () => {
  it('PR を作ったとき・PR を更新したとき・main に push したときに走る', () => {
    const w = ciWorkflow();
    const on = (w.doc.on ?? w.doc.true) as Obj;
    // pull_request: 種類を絞るなら opened と synchronize を含む。ブランチを絞らない（どの PR のブランチでも走る）。
    const pr = on.pull_request;
    if (isObj(pr)) {
      if (pr.types !== undefined) expect(pr.types).toEqual(expect.arrayContaining(['opened', 'synchronize']));
      expect(pr['branches-ignore'], 'PR の対象ブランチを除外しない').toBeUndefined();
      if (pr.branches !== undefined) expect(pr.branches).toEqual(expect.arrayContaining(['main']));
      expect(pr.paths, 'パスで絞らない').toBeUndefined();
      expect(pr['paths-ignore'], 'パスで絞らない').toBeUndefined();
    } else {
      expect(pr, 'pull_request は条件なしか対応表').toBeNull();
    }
    const push = on.push;
    if (isObj(push)) {
      if (push.branches !== undefined) expect(push.branches).toEqual(expect.arrayContaining(['main']));
      expect(push.paths).toBeUndefined();
      expect(push['paths-ignore']).toBeUndefined();
      expect(push['branches-ignore']).toBeUndefined();
    } else {
      expect(push).toBeNull();
    }
  });

  it('ubuntu-latest の 1 つのジョブで、npm ci → lint → test:unit → Chromium の導入 → test:browser → build → check:subpath → check:assets の順に流す', () => {
    const w = ciWorkflow();
    const job = onlyJob(w);
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job.if, 'ジョブに走る条件を付けない').toBeUndefined();
    const steps = stepsOf(job);
    const stages = steps.map((s) => stageOf(runOf(s))).filter((s): s is string => s !== undefined);
    expect(stages).toEqual(STAGES.map((s) => s.name));
    // 期待する段のほかに run の段を足さない（足すなら上の順のどれかに当たる）。
    const others = steps.filter((s) => runOf(s) !== '' && stageOf(runOf(s)) === undefined).map(runOf);
    expect(others, '決まった段のほかの run').toEqual([]);
    // 各段は 1 つのコマンドだけを実行する（|| や ; で結果を書き換えない）。
    for (const s of steps.filter((x) => runOf(x) !== '')) {
      expect(runOf(s), `段 ${String(s.name)}`).not.toMatch(/\|\||;|\n\s*\S/);
    }
  });

  it('Node.js は CLAUDE.md の版（22.12 以上）を使い、npm のキャッシュを使う', () => {
    const job = onlyJob(ciWorkflow());
    const steps = stepsOf(job);
    const setup = steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/setup-node@'));
    expect(setup, 'actions/setup-node の段').toBeDefined();
    const withs = setup!.with as Obj;
    const version = String(withs['node-version'] ?? '');
    // 22（22 系の最新）か、22.12 以上の版。
    const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+)|\.x)?$/.exec(version.replace(/^[>=^~]+/, ''));
    expect(m, `node-version: ${version}`).not.toBeNull();
    const [major, minor] = [Number(m![1]), m![2] === undefined ? Infinity : Number(m![2])];
    expect(major > 22 || (major === 22 && minor >= 12), `node-version ${version} が 22.12 以上`).toBe(true);
    expect(withs.cache).toBe('npm');
    const setupIndex = steps.indexOf(setup!);
    const ciIndex = steps.findIndex((s) => stageOf(runOf(s)) === 'npm ci');
    expect(setupIndex).toBeLessThan(ciIndex);
    // コードを取り出す段が npm ci より前にある。
    const checkout = steps.findIndex((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'));
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(checkout).toBeLessThan(ciIndex);
  });

  it('導入した Chromium をキャッシュして次の実行で使う（Playwright のキャッシュの場所）', () => {
    const job = onlyJob(ciWorkflow());
    const steps = stepsOf(job);
    const cache = steps.findIndex(
      (s) => typeof s.uses === 'string' && s.uses.startsWith('actions/cache@') && /ms-playwright/.test(String((s.with as Obj | undefined)?.path ?? '')),
    );
    const install = steps.findIndex((s) => stageOf(runOf(s)) === 'Chromium の導入');
    expect(cache, 'Playwright のキャッシュの場所をキャッシュする段').toBeGreaterThanOrEqual(0);
    expect(cache).toBeLessThan(install);
  });

  it.runIf(LIVE)('GitHub の実行の記録で、PR の実行が ubuntu-latest で決まった順に段を流して成功している', () => {
    const branch = liveBranch();
    const runs = ciRuns(`branch=${encodeURIComponent(branch)}&event=pull_request&status=completed`);
    const ok = runs.find((r) => r.conclusion === 'success');
    expect(ok, `${branch} の PR の CI の成功した実行`).toBeDefined();
    checkRunSteps(ok!);
    // PR を作ったとき（最初の実行）と PR のブランチへの push（その後の実行）で、それぞれ実行がある。
    const shas = new Set(runs.map((r) => r.head_sha));
    expect(shas.size, `${branch} の PR の CI の実行があるコミットの数`).toBeGreaterThanOrEqual(1);
  });

  it.runIf(LIVE)('GitHub の実行の記録で、main への push の実行が ubuntu-latest で決まった順に段を流して成功している', (ctx) => {
    const runs = ciRuns('branch=main&event=push&status=completed');
    if (runs.length === 0) ctx.skip(); // CI がまだ main に入っていない
    const ok = runs.find((r) => r.conclusion === 'success');
    expect(ok, 'main への push の CI の成功した実行').toBeDefined();
    checkRunSteps(ok!);
  });
});

describe('ARC-45: テストの失敗や lint の誤りがあると CI のチェックが失敗になる', () => {
  it('どの段も失敗を無視しない（continue-on-error・always などで後の段へ進めない）', () => {
    const w = ciWorkflow();
    const job = onlyJob(w);
    expect(job['continue-on-error'], 'ジョブの continue-on-error').toBeUndefined();
    for (const s of stepsOf(job)) {
      const label = String(s.name ?? s.uses ?? runOf(s));
      expect(s['continue-on-error'] === undefined || s['continue-on-error'] === false, `段 ${label} の continue-on-error`).toBe(true);
      expect(s.if, `段 ${label} に走る条件を付けない（失敗のあとも走る段を作らない）`).toBeUndefined();
      expect(s.shell, `段 ${label} は既定の shell（bash -e）で流す`).toBeUndefined();
    }
    expect(isObj(w.doc.defaults) ? (w.doc.defaults as Obj).run : undefined, '既定の shell を変えない').toBeUndefined();
  });

  describe.skipIf(NESTED)('CI が実行するコマンドを手元で実行する', () => {
    let clone = '';
    const setup = () => {
      if (clone) return clone;
      const work = tempDir('arc45-');
      clone = join(work, 'clone');
      const r = sh(`git clone --quiet "${ROOT}" "${clone}"`, work);
      if (r.status !== 0) throw new Error(`clone できない:\n${r.output}`);
      symlinkSync(join(ROOT, 'node_modules'), join(clone, 'node_modules'));
      return clone;
    };

    /** ワークフローの、その段の run を返す。 */
    const runFor = (stage: string): string => {
      const job = onlyJob(ciWorkflow());
      const step = stepsOf(job).find((s) => stageOf(runOf(s)) === stage);
      if (!step) throw new Error(`${stage} の段がない`);
      return runOf(step);
    };

    it('テストを 1 件わざと失敗させると、CI のブラウザを使わないテストの段が失敗する', () => {
      const dir = setup();
      const file = 'tests/zz-arc45-fail.test.ts';
      writeFileSync(
        join(dir, file),
        "import { expect, it } from 'vitest';\nit('ARC-45 でわざと失敗させるテスト', () => {\n  expect(1 + 1).toBe(3);\n});\n",
      );
      try {
        // CI の段の run（npm run test:unit）に、この 1 ファイルだけを流すよう引数を足す。
        const r = sh(`${runFor('npm run test:unit')} -- ${file}`, dir, { CI: 'true' });
        expect(r.output).toMatch(/ARC-45 でわざと失敗させるテスト/);
        expect(r.status, r.output).not.toBe(0);
      } finally {
        rmSync(join(dir, file), { force: true });
      }
    }, 300_000);

    it('lint の誤りを入れると、CI の lint・型の確認の段が失敗する', () => {
      const dir = setup();
      const ok = sh(runFor('npm run lint'), dir, { CI: 'true' });
      expect(ok.status, `誤りを入れる前の lint は通る:\n${ok.output}`).toBe(0);
      const file = 'src/zz-arc45-lint.ts';
      writeFileSync(join(dir, file), 'export function arc45(): number {\n  debugger;\n  return 1;\n}\n');
      try {
        const r = sh(runFor('npm run lint'), dir, { CI: 'true' });
        expect(r.output).toMatch(/zz-arc45-lint/);
        expect(r.status, r.output).not.toBe(0);
      } finally {
        rmSync(join(dir, file), { force: true });
      }
    }, 300_000);
  });
});

describe('ARC-46: 同じブランチに新しい push があると、走っている古い実行が取り消される', () => {
  const concurrencyOf = (): Obj => {
    const w = ciWorkflow();
    const job = onlyJob(w);
    const c = w.doc.concurrency ?? job.concurrency;
    expect(isObj(c), 'concurrency を group と cancel-in-progress で書く').toBe(true);
    return c as Obj;
  };

  it('走っている実行を取り消す', () => {
    expect(concurrencyOf()['cancel-in-progress']).toBe(true);
  });

  it('同じ PR の push どうし・main への push どうしは同じ組になり、別の PR・main とは別の組になる', () => {
    const group = String(concurrencyOf().group);
    const prEvent = (n: number, sha: string) => ({
      github: { event_name: 'pull_request', ref: `refs/pull/${n}/merge`, head_ref: `feat/${n}`, sha, run_id: sha, run_number: sha, event: { pull_request: { number: n } }, workflow: 'CI' },
    });
    const pushEvent = (branch: string, sha: string) => ({
      github: { event_name: 'push', ref: `refs/heads/${branch}`, head_ref: '', sha, run_id: sha, run_number: sha, event: {}, workflow: 'CI' },
    });
    const pr83a = evalExpr(group, prEvent(83, 'aaa'));
    const pr83b = evalExpr(group, prEvent(83, 'bbb'));
    const pr84 = evalExpr(group, prEvent(84, 'ccc'));
    const mainA = evalExpr(group, pushEvent('main', 'ddd'));
    const mainB = evalExpr(group, pushEvent('main', 'eee'));
    expect(pr83a).toBe(pr83b);
    expect(mainA).toBe(mainB);
    expect(new Set([pr83a, pr84, mainA]).size).toBe(3);
  });

  it.runIf(LIVE)('GitHub の実行の記録で、取り消された実行のあとに同じブランチの新しい実行が結果を残している', (ctx) => {
    const branch = liveBranch();
    const runs = ciRuns(`branch=${encodeURIComponent(branch)}`);
    const cancelled = runs.filter((r) => r.conclusion === 'cancelled');
    if (cancelled.length === 0) ctx.skip(); // 走っている途中の push をまだしていない
    for (const c of cancelled) {
      const later = runs.filter((r) => r.event === c.event && r.created_at > c.created_at && r.head_sha !== c.head_sha);
      expect(later.length, `取り消された実行 ${c.id} のあとの新しい push の実行`).toBeGreaterThan(0);
    }
    // 最新のコミットの実行は取り消されていない。
    const latest = runs.slice().sort((a, b) => b.created_at.localeCompare(a.created_at))[0]!;
    expect(latest.conclusion).not.toBe('cancelled');
  });
});

describe('ARC-47: CI で Chromium が見つからないとき、ブラウザを使うテストを飛ばして成功にしない', () => {
  /** 既存のブラウザを使うテストのうち小さい 1 ファイル（Chromium がないと飛ばされる）。 */
  const browserFile = 'tests/ui/correction-panel-browser.test.ts';

  /** CI のブラウザを使うテストの段と同じコマンドで、1 ファイルだけを流す。 */
  const runBrowser = (env: Record<string, string | undefined>, home: string) => {
    const job = onlyJob(ciWorkflow());
    const step = stepsOf(job).find((s) => stageOf(runOf(s)) === 'npm run test:browser')!;
    const out = join(tempDir('arc47-out-'), 'report.json');
    const r = sh(`${runOf(step)} -- ${browserFile} --reporter=default --reporter=json --outputFile.json="${out}"`, ROOT, {
      CHROMIUM_PATH: undefined,
      ...env,
      HOME: home,
      // npm がキャッシュを HOME に作らないよう、元の場所を使う。
      npm_config_cache: join(process.env.HOME ?? tmpdir(), '.npm'),
    });
    const report = existsSync(out)
      ? (JSON.parse(readFileSync(out, 'utf8')) as { numPassedTests: number; numPendingTests: number; numFailedTests: number; numTotalTests: number })
      : undefined;
    return { ...r, report };
  };

  describe.skipIf(NESTED)('CI の段のコマンドと環境変数を手元で使う', () => {
    it('Chromium が見つからないとき、CI の設定では飛ばされず失敗になる（CI の設定がなければ飛ばされる）', () => {
      const emptyHome = tempDir('arc47-home-');
      mkdirSync(join(emptyHome, '.cache'), { recursive: true });
      const ciEnv = { ...browserStageEnv(), CI: 'true' };
      const r = runBrowser(ciEnv, emptyHome);
      expect(r.status, `Chromium がないのに CI の段が成功した:\n${r.output}`).not.toBe(0);
      expect(r.report?.numPassedTests ?? 0, 'Chromium がないのにテストが通った').toBe(0);

      // 比べるため: CI の段の環境変数を付けないと、同じ状況で飛ばされて成功になる（手元の既定の動き）。
      const local = runBrowser(Object.fromEntries(Object.keys(ciEnv).map((k) => [k, undefined])), emptyHome);
      expect(local.status, local.output).toBe(0);
      expect(local.report?.numPendingTests ?? 0).toBeGreaterThan(0);
    }, 300_000);

    it('Chromium があるとき、CI の設定でブラウザを使うテストのファイルが飛ばされずに流れて通る', (ctx) => {
      const home = process.env.HOME ?? '';
      const ciEnv = { ...browserStageEnv(), CI: 'true', CHROMIUM_PATH: process.env.CHROMIUM_PATH };
      // Chromium があるかは、findChromium と同じ探し方になるよう、同じ段を APEX_REQUIRE_CHROMIUM なしで一度流して確かめる。
      // すべてのテストが飛ばされたら Chromium がない（キャッシュのディレクトリだけがある・ほかのブラウザだけがあるときも含む）。
      const probe = runBrowser({ ...ciEnv, APEX_REQUIRE_CHROMIUM: undefined }, home);
      expect(probe.status, probe.output).toBe(0);
      expect(probe.report, probe.output).toBeDefined();
      if (probe.report!.numPendingTests === probe.report!.numTotalTests) ctx.skip();
      const r = runBrowser(ciEnv, home);
      expect(r.status, r.output).toBe(0);
      expect(r.report, r.output).toBeDefined();
      expect(r.report!.numPendingTests, '飛ばされたテスト').toBe(0);
      expect(r.report!.numPassedTests).toBeGreaterThan(0);
      expect(r.report!.numPassedTests).toBe(r.report!.numTotalTests);
    }, 300_000);
  });

  it.runIf(LIVE)('GitHub の実行の記録で、ブラウザを使うテストの段がファイルを飛ばさずに流している', () => {
    const branch = liveBranch();
    const runs = ciRuns(`branch=${encodeURIComponent(branch)}&status=completed`).filter((r) => r.conclusion === 'success');
    expect(runs.length, `${branch} の成功した CI の実行`).toBeGreaterThan(0);
    const run = runs[0]!;
    const job = jobsOfRun(run.id)[0]!;
    const r = sh(`gh run view ${run.id} --repo ${repoSlug()} --log --job ${job.id}`, ROOT);
    expect(r.status, r.output).toBe(0);
    const w = ciWorkflow();
    const wfJob = onlyJob(w);
    const stepName = String(stepsOf(wfJob).find((s) => stageOf(runOf(s)) === 'npm run test:browser')!.name);
    const lines = r.stdout.split('\n').filter((l) => l.includes(stepName));
    const summary = lines.find((l) => /Test Files\s+/.test(l));
    expect(summary, `ブラウザを使うテストの段の Test Files の行:\n${lines.slice(-30).join('\n')}`).toBeDefined();
    expect(summary).toMatch(/Test Files\s+\d+ passed/);
    expect(summary).not.toMatch(/skipped/);
    const testsLine = lines.find((l) => /\bTests\s+\d+/.test(l));
    expect(testsLine).toBeDefined();
    expect(testsLine).not.toMatch(/skipped/);
  });
});

describe('ARC-48: CI は ubuntu-latest の runner だけを使い、GitHub Pages への公開をしない', () => {
  it('どのワークフローのジョブも ubuntu-latest だけで動き、macOS・Windows の runner を使わない', () => {
    const all = workflows();
    expect(all.length).toBeGreaterThan(0);
    for (const w of all) {
      for (const [name, job] of jobsOf(w)) {
        expect(job['runs-on'], `${w.file} のジョブ ${name}`).toBe('ubuntu-latest');
        expect(job.strategy, `${w.file} のジョブ ${name} は matrix で runner を増やさない`).toBeUndefined();
      }
      expect(w.source, w.file).not.toMatch(/macos|windows|self-hosted/i);
    }
  });

  it('gh-pages ブランチへの push や GitHub Pages への公開の手順がない', () => {
    for (const w of workflows()) {
      expect(w.source, w.file).not.toMatch(/gh-pages/);
      expect(w.source, w.file).not.toMatch(/deploy-pages|upload-pages-artifact|configure-pages|peaceiris|JamesIves/i);
      expect(w.source, w.file).not.toMatch(/npm run deploy|git push/);
      expect(w.source, w.file).not.toMatch(/^\s*(pages|contents|id-token)\s*:\s*write/m);
      for (const [name, job] of jobsOf(w)) {
        expect(job.environment, `${w.file} のジョブ ${name} に公開先の environment がない`).toBeUndefined();
      }
    }
  });
});

describe('ARC-49: CLAUDE.md に CI のことと GitHub Actions の今の状態が書いてある', () => {
  const text = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');

  it('CI があること、走るきっかけ（PR・PR のブランチへの push・main への push）が書いてある', () => {
    expect(text).toMatch(/\bCI\b/);
    expect(text).toMatch(/PR を作った/);
    expect(text).toMatch(/PR のブランチに push/);
    expect(text).toMatch(/`?main`? に push/);
  });

  it('CI が実行する内容が書いてある', () => {
    for (const cmd of ['npm ci', 'npm run lint', 'npm run test:unit', 'npm run test:browser', 'npm run build', 'npm run check:subpath', 'npm run check:assets']) {
      expect(text, cmd).toContain(cmd);
    }
    expect(text).toMatch(/Chromium の導入/);
  });

  it('GitHub Actions が有効で、標準の Linux の runner だけを使うことが書いてある', () => {
    expect(text).toMatch(/GitHub Actions は有効/);
    expect(text).toMatch(/標準の Linux の runner だけ/);
  });

  it('Actions を止めている・ワークフローを足しても動かない、という記述がない', () => {
    expect(text).not.toMatch(/止めている/);
    expect(text).not.toMatch(/止めて(い|お)/);
    expect(text).not.toMatch(/足しても動かない/);
    expect(text).not.toMatch(/動かない/);
  });
});
