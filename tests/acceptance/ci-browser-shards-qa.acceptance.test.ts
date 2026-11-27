// docs/spec/architecture.md「継続的インテグレーション（CI）」のうち、ブラウザのテストを 4 つの組のジョブに分けてまとめのジョブで
// チェックを決める変更（#97）の受け入れ条件（ARC-57・ARC-58・ARC-60・ARC-74〜ARC-79）の受け入れテスト（QA）。
// 公開された入口（.github/workflows/ 以下のワークフローの設定、そこに書かれた run のコマンドと env、npm のコマンドとその終了コード・
// JSON の報告、GitHub の CI の実行の記録）だけを使い、実装の内部には依存しない。
//
// GitHub Actions がジョブを流す仕組み（段を順に流し、失敗したら後の段を流さない）は、ワークフローに書かれた run を同じ env で
// 手元で順に実行して真似る。ジョブの結果（success・failure など）を、まとめのジョブの段に `needs` の形で渡して結果を見る。
//
// - いつも流す: ワークフローの設定の確認、まとめのジョブの段の結果、Chromium がないときと流れるテストがない組の失敗、
//   ブラウザを使わないテストの失敗・lint の誤りでの失敗（作業ツリーの写しで）。
// - APEX_ACCEPTANCE_SHARDS=1 のときだけ流す（Chromium が要り（なければ CI の段の設定で失敗する）、ブラウザを使うテストの全体を 2 回流すので 30 分ほどかかる）:
//   作業ツリーの写しに 1 件わざと失敗するブラウザを使うテストを足し、分けずに 1 回と、CI の段のコマンドで 4 つの組を 1 回ずつ流して、
//   組の分かれ方・件数の合計・飛ばされたテストがないこと・失敗した組だけが失敗することを確かめる（ARC-60・ARC-74・ARC-75）。
//     APEX_ACCEPTANCE_SHARDS=1 npx vitest run --project unit tests/acceptance/ci-browser-shards-qa.acceptance.test.ts
// - APEX_ACCEPTANCE_LIVE=1 のときだけ流す: GitHub の CI の実行の記録（ネットワークが要る）。見るブランチは
//   APEX_ACCEPTANCE_CI_BRANCH（なければ今のブランチ）。
// ARC-13 の clone の中で npm test を実行したときに入れ子で重い確認をしないよう、APEX_ACCEPTANCE_NESTED が立っていたら子のプロセスを使う確認を飛ばす。
// このファイルはブラウザを使う組に入らない（tests/helpers/browser.ts を import しない）。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const LIVE = process.env.APEX_ACCEPTANCE_LIVE === '1';
const SHARD_RUN = process.env.APEX_ACCEPTANCE_SHARDS === '1' && !NESTED;
const SHARDS = 4;

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
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', env: childEnv(env), maxBuffer: 256 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * 作業ツリーを一時ディレクトリに写す。CI の checkout と同じく git の履歴を持つよう、今のリポジトリを clone してから、
 * 作業ツリーの内容（未コミットの変更を含む）を上に写す（node_modules は symlink、.git・dist は写さない）。
 */
function copyTree(prefix: string): string {
  const dir = join(tempDir(prefix), 'repo');
  const c = sh(`git clone --quiet "${ROOT}" "${dir}"`, ROOT);
  if (c.status !== 0) throw new Error(`git clone が失敗した:\n${c.output}`);
  cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const rel = relative(ROOT, src).split('/')[0];
      return rel !== 'node_modules' && rel !== '.git' && rel !== 'dist';
    },
  });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  return dir;
}

/** ブラウザを使うテストの組に入るファイルの中身（このファイル自身が組に入らないよう、import の行は組み立てて書く）。 */
function browserTestSource(body: string): string {
  const helper = ['..', 'helpers', 'browser'].join('/');
  return `import { expect, it } from 'vitest';\nimport { findChromium } from '${helper}';\nvoid expect;\n${body}\n`;
}

// ---- ワークフローの YAML を読む（GitHub Actions の設定で使う範囲だけを扱う小さな読み取り） ----

type Yaml = string | number | boolean | null | Yaml[] | { [k: string]: Yaml };
type Obj = Record<string, Yaml>;
const isObj = (v: Yaml | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function scalar(raw: string): Yaml {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^(".*"|'.*')$/.test(s)) return s.slice(1, -1);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map(scalar);
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function parseYaml(source: string): Yaml {
  const lines = source.split(/\r?\n/);
  let pos = 0;
  const indentOf = (raw: string) => raw.length - raw.trimStart().length;
  const peek = (): { indent: number; text: string } | undefined => {
    while (pos < lines.length) {
      const t = stripComment(lines[pos]!);
      if (t.trim() === '' || t.trim() === '---') {
        pos++;
        continue;
      }
      return { indent: indentOf(lines[pos]!), text: t.trim() };
    }
    return undefined;
  };
  const blockScalar = (parent: number): string => {
    const out: string[] = [];
    let ind = -1;
    while (pos < lines.length) {
      const raw = lines[pos]!;
      if (raw.trim() === '') {
        out.push('');
        pos++;
        continue;
      }
      if (indentOf(raw) <= parent) break;
      if (ind < 0) ind = indentOf(raw);
      out.push(raw.slice(ind));
      pos++;
    }
    while (out.length && out.at(-1) === '') out.pop();
    return `${out.join('\n')}\n`;
  };
  const valueAfter = (rest: string, indent: number): Yaml => {
    if (/^[|>][-+]?$/.test(rest)) return blockScalar(indent);
    if (rest !== '') return scalar(rest);
    const next = peek();
    if (!next || next.indent < indent || (next.indent === indent && !next.text.startsWith('-'))) return null;
    return node(next.indent);
  };
  const entry = (text: string, indent: number, out: Obj) => {
    const m = /^("[^"]*"|'[^']*'|[^:]+?):(?:\s+(.*))?$/.exec(text);
    if (!m) throw new Error(`YAML の行を読めない: ${text}`);
    out[String(scalar(m[1]!))] = valueAfter((m[2] ?? '').trim(), indent);
  };
  const node = (indent: number): Yaml => {
    const first = peek();
    if (!first) return null;
    if (first.text === '-' || first.text.startsWith('- ')) {
      const list: Yaml[] = [];
      for (let l = peek(); l && l.indent === indent && (l.text === '-' || l.text.startsWith('- ')); l = peek()) {
        pos++;
        const rest = l.text.slice(1).trim();
        if (rest === '') list.push(valueAfter('', indent));
        else if (/^[^\s"'[{][^:]*:(\s|$)/.test(rest)) {
          const obj: Obj = {};
          entry(rest, indent + 2, obj);
          for (let m = peek(); m && m.indent === indent + 2 && !m.text.startsWith('- '); m = peek()) {
            pos++;
            entry(m.text, indent + 2, obj);
          }
          list.push(obj);
        } else list.push(scalar(rest));
      }
      return list;
    }
    const obj: Obj = {};
    for (let l = peek(); l && l.indent === indent && !l.text.startsWith('- '); l = peek()) {
      pos++;
      entry(l.text, indent, obj);
    }
    return obj;
  };
  return node(0);
}

interface Workflow {
  file: string;
  source: string;
  doc: Obj;
}

/** PR と push で走るワークフロー（ちょうど 1 つ）。 */
function ciWorkflow(): Workflow {
  const dir = join(ROOT, '.github/workflows');
  const all = (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => /\.ya?ml$/.test(f))
    .map((file) => {
      const source = readFileSync(join(dir, file), 'utf8');
      const doc = parseYaml(source);
      if (!isObj(doc)) throw new Error(`${file} の最上位が対応表でない`);
      return { file, source, doc };
    })
    .filter((w) => {
      const on = w.doc.on ?? w.doc.true;
      return isObj(on) && 'pull_request' in on && 'push' in on;
    });
  expect(all.map((w) => w.file), 'PR と push で走るワークフロー').toHaveLength(1);
  return all[0]!;
}

function jobs(w: Workflow): [string, Obj][] {
  if (!isObj(w.doc.jobs)) throw new Error('jobs がない');
  return Object.entries(w.doc.jobs).map(([id, j]) => {
    if (!isObj(j)) throw new Error(`ジョブ ${id} が対応表でない`);
    return [id, j];
  });
}

function steps(job: Obj): Obj[] {
  return (Array.isArray(job.steps) ? job.steps : []).filter(isObj);
}

const runOf = (s: Obj) => (typeof s.run === 'string' ? s.run.trim() : '');

/** run の中身から、受け入れ条件に出てくる段の名前を決める。 */
function stageOf(run: string): string | undefined {
  if (/^npm ci(\s|$)/.test(run)) return 'npm ci';
  if (/playwright(@\$\{\{[^}]*\}\}|@\S+)?\s+install\b.*\bchromium\b/.test(run)) return 'Chromium の導入';
  const m = /^npm run ([\w:]+)(\s|$)/.exec(run);
  return m ? `npm run ${m[1]}` : undefined;
}

const stagesOf = (job: Obj) => steps(job).map((s) => stageOf(runOf(s))).filter((s): s is string => s !== undefined);

/** 段に stage を持つジョブ（ちょうど 1 つ）。 */
function jobWith(w: Workflow, stage: string): [string, Obj] {
  const found = jobs(w).filter(([, j]) => stagesOf(j).includes(stage));
  expect(found.map(([id]) => id), `${stage} を流すジョブ`).toHaveLength(1);
  return found[0]!;
}

const checkJob = (w: Workflow) => jobWith(w, 'npm run lint');
const browserJob = (w: Workflow) => jobWith(w, 'npm run test:browser');

/** まとめのジョブ: 検査のジョブとブラウザのテストのジョブを needs に持つジョブ。 */
function summaryJob(w: Workflow): [string, Obj] {
  const [checkId] = checkJob(w);
  const [browserId] = browserJob(w);
  const found = jobs(w).filter(([, j]) => {
    const needs = Array.isArray(j.needs) ? j.needs.map(String) : typeof j.needs === 'string' ? [j.needs] : [];
    return needs.includes(checkId) && needs.includes(browserId);
  });
  expect(found.map(([id]) => id), 'まとめのジョブ').toHaveLength(1);
  return found[0]!;
}

/** ${{ ... }} の参照を与えた文脈で置き換える（プロパティの参照だけ）。 */
function evalExpr(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expr: string) => {
    const v = expr.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), ctx);
    if (v === undefined) throw new Error(`式 ${expr} を評価できない`);
    return String(v);
  });
}

/** 段の環境変数（ワークフロー・ジョブ・段の順に重ねる）。式を含む値は ctx で置き換える。 */
function envOf(w: Workflow, job: Obj, step: Obj, ctx: Record<string, unknown> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const layer of [w.doc.env, job.env, step.env]) {
    if (!isObj(layer)) continue;
    for (const [k, v] of Object.entries(layer)) out[k] = evalExpr(String(v), { env: out, ...ctx });
  }
  return out;
}

/** ブラウザのテストのジョブの、ブラウザを使うテストの段のコマンドと環境変数（組の番号 shard）。 */
function browserStage(shard: number): { command: string; env: Record<string, string> } {
  const w = ciWorkflow();
  const [, job] = browserJob(w);
  const step = steps(job).find((s) => stageOf(runOf(s)) === 'npm run test:browser')!;
  const ctx = { matrix: { [matrixKey(job)]: shard } };
  return { command: evalExpr(runOf(step), ctx), env: { CI: 'true', ...envOf(w, job, step, ctx) } };
}

function matrixKey(job: Obj): string {
  const matrix = isObj(job.strategy) && isObj(job.strategy.matrix) ? job.strategy.matrix : {};
  const keys = Object.keys(matrix);
  expect(keys, 'ブラウザのテストのジョブの matrix の軸').toHaveLength(1);
  return keys[0]!;
}

/** まとめのジョブの段を、ほかのジョブの結果 results（ジョブの id ごとの result）で流す。成功したら true。 */
function runSummary(results: Record<string, string>): { ok: boolean; output: string } {
  const w = ciWorkflow();
  const [, job] = summaryJob(w);
  const needs = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { result: v, outputs: {} }]));
  const runSteps = steps(job).filter((s) => runOf(s) !== '');
  expect(runSteps.length, 'まとめのジョブの run の段').toBeGreaterThan(0);
  let output = '';
  for (const step of runSteps) {
    const ctx = { needs, 'toJSON(needs)': JSON.stringify(needs) };
    const expand = (s: string) =>
      s.replace(/\$\{\{\s*toJSON\(needs\)\s*\}\}/g, JSON.stringify(needs)).replace(/\$\{\{\s*(.*?)\s*\}\}/g, (m) => evalExpr(m, ctx));
    const env: Record<string, string> = {};
    for (const layer of [w.doc.env, job.env, step.env]) {
      if (isObj(layer)) for (const [k, v] of Object.entries(layer)) env[k] = expand(String(v));
    }
    const r = sh(expand(runOf(step)), ROOT, env);
    output += r.output;
    if (r.status !== 0) return { ok: false, output };
  }
  return { ok: true, output };
}

/** Actions と同じく、ジョブの run の段を順に流し、失敗した段で止める。流した段と、成功したかを返す。 */
function runJobSteps(
  w: Workflow,
  job: Obj,
  cwd: string,
  opts: { skip?: (stage: string) => boolean; extraArgs?: Record<string, string> } = {},
): { ok: boolean; ran: string[]; output: string } {
  const ran: string[] = [];
  let output = '';
  for (const step of steps(job)) {
    const run = runOf(step);
    const stage = stageOf(run);
    if (run === '' || !stage || opts.skip?.(stage)) continue;
    ran.push(stage);
    const extra = opts.extraArgs?.[stage];
    const r = sh(extra ? `${run} -- ${extra}` : run, cwd, envOf(w, job, step));
    output += `\n--- ${stage} ---\n${r.output}`;
    if (r.status !== 0) return { ok: false, ran, output };
  }
  return { ok: true, ran, output };
}

interface Report {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  testResults: { name: string; status: string; assertionResults: { title: string; status: string }[] }[];
}

/** ブラウザを使うテストの段のコマンド（追加の引数 extra）を cwd で流し、終了コードと JSON の報告を返す。 */
function runBrowserStage(cwd: string, command: string, env: Record<string, string | undefined>, extra = '') {
  const out = join(tempDir('ci-shards-report-'), 'report.json');
  const sep = command.includes(' -- ') ? '' : ' --';
  const r = sh(`${command}${sep} ${extra} --reporter=default --reporter=json --outputFile.json="${out}"`, cwd, env);
  const report = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Report) : undefined;
  return { ...r, report };
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
  conclusion: string | null;
  head_sha: string;
  created_at: string;
  run_started_at: string;
  path: string;
}

interface Job {
  id: number;
  name: string;
  labels: string[];
  conclusion: string | null;
  started_at: string;
  completed_at: string;
  steps: { name: string; number: number; conclusion: string | null }[];
}

const liveBranch = () => process.env.APEX_ACCEPTANCE_CI_BRANCH || sh('git branch --show-current', ROOT).stdout.trim();

function liveRuns(query: string): Run[] {
  const file = `.github/workflows/${ciWorkflow().file}`;
  const res = gh(`api "repos/${repoSlug()}/actions/runs?per_page=50&branch=${encodeURIComponent(liveBranch())}&${query}"`) as { workflow_runs: Run[] };
  return res.workflow_runs.filter((r) => r.path === file || r.path.startsWith(`${file}@`));
}

const liveJobs = (id: number) => (gh(`api "repos/${repoSlug()}/actions/runs/${id}/jobs?filter=latest"`) as { jobs: Job[] }).jobs;

/** ジョブの設定の name（${{ matrix.xxx }} を含む）から、実行の記録のジョブの名前に当たる正規表現。 */
function jobNamePattern(id: string, job: Obj): RegExp {
  const name = typeof job.name === 'string' ? job.name : id;
  const parts = name.split(/\$\{\{[^}]*\}\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.+?')}$`);
}

/** 実行の記録のジョブを、検査・ブラウザのテスト・まとめに分ける。 */
function classifyJobs(runId: number) {
  const w = ciWorkflow();
  const all = liveJobs(runId);
  const [checkId, check] = checkJob(w);
  const [browserId, browser] = browserJob(w);
  const [summaryId, summary] = summaryJob(w);
  return {
    all,
    check: all.filter((j) => jobNamePattern(checkId, check).test(j.name)),
    browser: all.filter((j) => jobNamePattern(browserId, browser).test(j.name)),
    summary: all.filter((j) => jobNamePattern(summaryId, summary).test(j.name)),
  };
}

const CHECK_STAGES = ['npm ci', 'npm run lint', 'npm run test:unit', 'npm run build', 'npm run check:subpath', 'npm run check:assets'];
const BROWSER_STAGES = ['npm ci', 'Chromium の導入', 'npm run test:browser'];

// ---- 受け入れテスト ----

describe('ARC-57: PR・PR のブランチへの push・main への push で、ubuntu-latest の CI が検査・4 つの組・まとめのジョブを流す', () => {
  it('PR（作成・更新）と main への push で走る', () => {
    const w = ciWorkflow();
    const on = (w.doc.on ?? w.doc.true) as Obj;
    const pr = on.pull_request;
    // types を絞るなら opened と synchronize を含む。branches を絞らない（どの PR のブランチでも走る）。
    if (isObj(pr)) {
      if (pr.types !== undefined) expect(pr.types).toEqual(expect.arrayContaining(['opened', 'synchronize']));
      expect(pr.branches === undefined || (Array.isArray(pr.branches) && pr.branches.includes('main'))).toBe(true);
    } else expect(pr).toBeNull();
    const push = on.push as Obj;
    expect(isObj(push) && Array.isArray(push.branches) ? push.branches : []).toContain('main');
  });

  it('検査のジョブ 1 つ・ブラウザのテストのジョブ（4 組）・まとめのジョブ 1 つがあり、どれも ubuntu-latest で動く', () => {
    const w = ciWorkflow();
    const [checkId] = checkJob(w);
    const [browserId, browser] = browserJob(w);
    const [summaryId] = summaryJob(w);
    expect(new Set([checkId, browserId, summaryId]).size).toBe(3);
    expect(jobs(w).map(([id]) => id).sort()).toEqual([checkId, browserId, summaryId].sort());
    for (const [id, j] of jobs(w)) expect(j['runs-on'], id).toBe('ubuntu-latest');
    const matrix = (browser.strategy as Obj).matrix as Obj;
    expect(matrix[matrixKey(browser)]).toHaveLength(SHARDS);
  });

  it('検査のジョブは npm ci・lint・test:unit・build・check:subpath・check:assets をこの順に流す', () => {
    expect(stagesOf(checkJob(ciWorkflow())[1])).toEqual(CHECK_STAGES);
  });

  it('ブラウザのテストのジョブは npm ci・Chromium の導入・その組の test:browser をこの順に流す', () => {
    expect(stagesOf(browserJob(ciWorkflow())[1])).toEqual(BROWSER_STAGES);
  });

  it('どの段も失敗を飛ばさない（continue-on-error・段の if・|| true がない）ので、失敗した段で止まる', () => {
    const w = ciWorkflow();
    for (const [id, j] of jobs(w)) {
      expect(j['continue-on-error'], id).toBeUndefined();
      for (const s of steps(j)) {
        const label = `${id} の段 ${String(s.name ?? s.uses ?? runOf(s))}`;
        expect(s['continue-on-error'], label).toBeUndefined();
        expect(s.if, label).toBeUndefined();
        expect(runOf(s), label).not.toMatch(/\|\|\s*(true|:|exit 0)/);
      }
    }
  });

  it.skipIf(NESTED)('ジョブの結果がすべて success のとき、まとめのジョブの段が成功する', () => {
    const w = ciWorkflow();
    const r = runSummary({ [checkJob(w)[0]]: 'success', [browserJob(w)[0]]: 'success' });
    expect(r.ok, r.output).toBe(true);
  });

  it.runIf(LIVE)('GitHub の実行の記録で、成功した最新の実行の各ジョブが ubuntu-latest で決まった順に段を流し、まとめのジョブが成功している', () => {
    const runs = liveRuns('status=completed').filter((r) => r.conclusion === 'success');
    expect(runs.length, `${liveBranch()} の成功した CI の実行`).toBeGreaterThan(0);
    const w = ciWorkflow();
    const { all, check, browser, summary } = classifyJobs(runs[0]!.id);
    for (const j of all) expect(j.labels, j.name).toEqual(['ubuntu-latest']);
    expect(check).toHaveLength(1);
    expect(browser).toHaveLength(SHARDS);
    expect(summary).toHaveLength(1);
    const stageNames = (wfJob: Obj) => new Map(steps(wfJob).filter((s) => typeof s.name === 'string' && stageOf(runOf(s))).map((s) => [String(s.name), stageOf(runOf(s))!]));
    for (const [wfJob, js, expected] of [[checkJob(w)[1], check, CHECK_STAGES], [browserJob(w)[1], browser, BROWSER_STAGES]] as const) {
      const names = stageNames(wfJob);
      for (const j of js) {
        const ran = j.steps.slice().sort((a, b) => a.number - b.number).filter((s) => names.has(s.name));
        expect(ran.map((s) => names.get(s.name)), j.name).toEqual(expected);
        expect(ran.every((s) => s.conclusion === 'success'), j.name).toBe(true);
      }
    }
    expect(summary[0]!.conclusion).toBe('success');
  });
});

describe('ARC-58: ブラウザを使わないテストの失敗・lint の誤りで、検査のジョブとまとめのジョブが失敗になる', () => {
  // 依存は symlink した node_modules を使うので npm ci の段は流さない。
  // test:unit の段は、写しの中のすべての単体のテストを流すと重いので、足したファイルだけを流すよう引数を足す。
  it.skipIf(NESTED)('わざと失敗させたブラウザを使わないテストを足すと、検査のジョブが test:unit の段で止まり、まとめのジョブが失敗する', () => {
    const repo = copyTree('arc58-unit-');
    const file = 'tests/zz-arc58-qa-failing.test.ts';
    writeFileSync(join(repo, file), "import { expect, it } from 'vitest';\nit('ARC-58 の QA でわざと失敗させるテスト', () => {\n  expect(1 + 1).toBe(3);\n});\n");
    const w = ciWorkflow();
    const [checkId, check] = checkJob(w);
    const r = runJobSteps(w, check, repo, { skip: (s) => s === 'npm ci', extraArgs: { 'npm run test:unit': file } });
    expect(r.ok, r.output).toBe(false);
    expect(r.ran.at(-1), r.output).toBe('npm run test:unit');
    expect(r.ran).not.toContain('npm run build');
    expect(r.output).toMatch(/ARC-58 の QA でわざと失敗させるテスト/);
    const s = runSummary({ [checkId]: 'failure', [browserJob(w)[0]]: 'success' });
    expect(s.ok, s.output).toBe(false);
  }, 600_000);

  it.skipIf(NESTED)('lint の誤りを入れると、検査のジョブが lint の段で止まり、まとめのジョブが失敗する', () => {
    const repo = copyTree('arc58-lint-');
    mkdirSync(join(repo, 'src/zz-qa'), { recursive: true });
    // 型の誤り（tsc --noEmit）と ESLint の誤り（使わない変数）を入れる。
    writeFileSync(join(repo, 'src/zz-qa/lint-error.ts'), "const unused = 1;\nexport const n: number = 'not a number';\n");
    const w = ciWorkflow();
    const [checkId, check] = checkJob(w);
    const r = runJobSteps(w, check, repo, { skip: (s) => s === 'npm ci' });
    expect(r.ok, r.output).toBe(false);
    expect(r.ran.at(-1), r.output).toBe('npm run lint');
    expect(r.ran).not.toContain('npm run test:unit');
    expect(r.output).toMatch(/lint-error\.ts/);
    const s = runSummary({ [checkId]: 'failure', [browserJob(w)[0]]: 'success' });
    expect(s.ok, s.output).toBe(false);
  }, 600_000);
});

describe('ARC-60: Chromium が見つからないとき、ブラウザのテストのジョブとまとめのジョブが失敗になる', () => {
  it.skipIf(NESTED)('どの組でも、Chromium がない状態で CI の段のコマンドを流すと失敗し、テストが 1 件も通らない', () => {
    const emptyHome = tempDir('arc60-home-');
    mkdirSync(join(emptyHome, '.cache'), { recursive: true });
    for (let shard = 1; shard <= SHARDS; shard++) {
      const { command, env } = browserStage(shard);
      const r = runBrowserStage(ROOT, command, {
        ...env,
        HOME: emptyHome,
        CHROMIUM_PATH: undefined,
        PLAYWRIGHT_BROWSERS_PATH: undefined,
        npm_config_cache: join(process.env.HOME ?? tmpdir(), '.npm'),
      });
      expect(r.status, `組 ${shard}: Chromium がないのに成功した\n${r.output.slice(-3000)}`).not.toBe(0);
      expect(r.report?.numPassedTests ?? 0, `組 ${shard}`).toBe(0);
    }
    const w = ciWorkflow();
    const s = runSummary({ [checkJob(w)[0]]: 'success', [browserJob(w)[0]]: 'failure' });
    expect(s.ok, s.output).toBe(false);
  }, 900_000);

  it.runIf(LIVE)('GitHub の実行の記録で、成功した最新の実行のどのブラウザのテストのジョブも、ファイルとテストを飛ばさずに流している', () => {
    const runs = liveRuns('status=completed').filter((r) => r.conclusion === 'success');
    expect(runs.length).toBeGreaterThan(0);
    const { browser } = classifyJobs(runs[0]!.id);
    expect(browser).toHaveLength(SHARDS);
    for (const j of browser) {
      const log = sh(`gh run view ${runs[0]!.id} --repo ${repoSlug()} --log --job ${j.id}`, ROOT);
      expect(log.status, log.output).toBe(0);
      const files = log.stdout.split('\n').find((l) => /Test Files\s+\d+/.test(l));
      const tests = log.stdout.split('\n').find((l) => /\bTests\s+\d+/.test(l));
      expect(files, j.name).toMatch(/Test Files\s+[1-9]\d* passed/);
      expect(files, j.name).not.toMatch(/skipped|failed/);
      expect(tests, j.name).not.toMatch(/skipped|failed|todo/);
    }
  });
});

describe('ARC-76: 流れるブラウザを使うテストが 1 件もない組は、そのジョブとまとめのジョブが失敗になる', () => {
  // 写しに、ブラウザを使うテストの組に入るがテストが全部飛ばされるファイルを足し、引数でそれらだけに絞って CI の段のコマンドを流す。
  const PREFIX = 'zz-arc76-qa-skipped-';
  const addSkippedFiles = (repo: string, n: number) => {
    for (let i = 1; i <= n; i++) {
      writeFileSync(
        join(repo, `tests/acceptance/${PREFIX}${i}.test.ts`),
        browserTestSource(`it.skip('ARC-76 の QA で飛ばすテスト ${i}', () => {\n  findChromium();\n});`),
      );
    }
  };

  it.skipIf(NESTED)('どの組でも、組のテストが全部飛ばされたとき CI の段のコマンドが失敗する（CI の環境変数がなければ成功する）', () => {
    const repo = copyTree('arc76-skipped-');
    addSkippedFiles(repo, 5); // 4 つの組のどれにも 1 つ以上のファイルが入る数
    const results: { shard: number; status: number | null; ran: number; skipped: number; files: number }[] = [];
    for (let shard = 1; shard <= SHARDS; shard++) {
      const { command, env } = browserStage(shard);
      const r = runBrowserStage(repo, command, env, PREFIX);
      const rep = r.report;
      results.push({ shard, status: r.status, ran: (rep?.numPassedTests ?? 0) + (rep?.numFailedTests ?? 0), skipped: rep?.numPendingTests ?? 0, files: rep?.testResults.length ?? 0 });
      expect(r.status, `組 ${shard}: 流れたブラウザを使うテストが 0 件なのに成功した\n${r.output.slice(-3000)}`).not.toBe(0);
    }
    // 組にファイルが入り、テストが飛ばされた（流れたのは 0 件）うえで失敗している。
    expect(results.every((x) => x.files > 0 && x.ran === 0 && x.skipped > 0), JSON.stringify(results)).toBe(true);
    expect(results.reduce((a, x) => a + x.files, 0), JSON.stringify(results)).toBe(5);

    // 比べるため: CI の段の環境変数を付けずに同じ組を流すと、飛ばされて成功する（手元の既定の動き）。
    const { command, env } = browserStage(1);
    const local = runBrowserStage(repo, command, Object.fromEntries(Object.keys(env).map((k) => [k, undefined])), PREFIX);
    expect(local.status, local.output.slice(-3000)).toBe(0);

    const w = ciWorkflow();
    const s = runSummary({ [checkJob(w)[0]]: 'success', [browserJob(w)[0]]: 'failure' });
    expect(s.ok, s.output).toBe(false);
  }, 900_000);

  it.skipIf(NESTED)('組に入るファイルがないとき（ブラウザを使うテストのファイルが組の数より少ない）、どの組でも CI の段のコマンドが失敗する', () => {
    const repo = copyTree('arc76-nofile-');
    addSkippedFiles(repo, SHARDS - 1); // 少なくとも 1 つの組にはファイルが入らない
    for (let shard = 1; shard <= SHARDS; shard++) {
      const { command, env } = browserStage(shard);
      const r = runBrowserStage(repo, command, env, PREFIX);
      expect(r.status, `組 ${shard}: 流れたブラウザを使うテストが 0 件なのに成功した\n${r.output.slice(-3000)}`).not.toBe(0);
      expect((r.report?.numPassedTests ?? 0) + (r.report?.numFailedTests ?? 0), `組 ${shard}`).toBe(0);
    }
  }, 900_000);
});

describe('ARC-77: まとめのジョブは、どれかが失敗・取り消しでも飛ばされずに走って失敗し、すべて成功したときだけ成功する', () => {
  it('まとめのジョブは検査のジョブとブラウザのテストのジョブをすべて needs に持ち、待ったジョブの結果によらず走る', () => {
    const w = ciWorkflow();
    const [summaryId, summary] = summaryJob(w);
    const others = jobs(w).map(([id]) => id).filter((id) => id !== summaryId);
    expect([...(summary.needs as string[])].sort()).toEqual(others.sort());
    // 失敗・取り消しのあとも走るのは always()（!cancelled() や failure() では取り消しのあとに飛ばされる）。
    expect(String(summary.if ?? '').replace(/^\$\{\{\s*|\s*\}\}$/g, '')).toBe('always()');
    expect(summary['continue-on-error']).toBeUndefined();
  });

  const results = ['success', 'failure', 'cancelled', 'skipped'] as const;
  const combos = results.flatMap((c) => results.map((b) => [c, b] as const));
  it.skipIf(NESTED).each(combos)('検査のジョブが %s・ブラウザのテストのジョブが %s のとき、両方 success のときだけまとめのジョブが成功する', (c, b) => {
    const w = ciWorkflow();
    const r = runSummary({ [checkJob(w)[0]]: c, [browserJob(w)[0]]: b });
    expect(r.ok, r.output).toBe(c === 'success' && b === 'success');
  });

  it.skipIf(NESTED)('待ったジョブの結果が渡らないとき（記録がない）、まとめのジョブは成功しない', () => {
    const w = ciWorkflow();
    const r = runSummary({ [checkJob(w)[0]]: 'success' });
    expect(r.ok, r.output).toBe(false);
  });

  it.runIf(LIVE)('GitHub の実行の記録で、失敗した実行ではまとめのジョブが飛ばされずに走って失敗している', (ctx) => {
    const runs = liveRuns('status=completed').filter((r) => r.conclusion === 'failure');
    if (runs.length === 0) ctx.skip(); // 失敗した実行がまだない
    const { summary } = classifyJobs(runs[0]!.id);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.conclusion).toBe('failure');
  });
});

describe('ARC-78: ブラウザのテストのジョブは 4 組の matrix で、--shard で分け、Chromium のキャッシュと CI の環境変数を使い、検査を待たない', () => {
  it('matrix は 4 つの組（1〜4）で、各組が npm run test:browser に --shard=<組の番号>/4 を付けて流す', () => {
    const [, job] = browserJob(ciWorkflow());
    const matrix = (job.strategy as Obj).matrix as Obj;
    expect(Object.keys(matrix)).toEqual([matrixKey(job)]);
    expect(matrix[matrixKey(job)]).toEqual([1, 2, 3, 4]);
    for (let shard = 1; shard <= SHARDS; shard++) {
      expect(browserStage(shard).command).toMatch(new RegExp(`^npm run test:browser -- (.* )?--shard[= ]${shard}/4( |$)`));
    }
  });

  it('Chromium のキャッシュ（actions/cache）を、Playwright の版を含むキーで、Chromium の導入より前に使う', () => {
    const w = ciWorkflow();
    const [, job] = browserJob(w);
    const all = steps(job);
    const cacheIdx = all.findIndex((s) => typeof s.uses === 'string' && /^actions\/cache(\/restore)?@/.test(s.uses));
    const installIdx = all.findIndex((s) => stageOf(runOf(s)) === 'Chromium の導入');
    expect(cacheIdx, 'Chromium のキャッシュの段').toBeGreaterThanOrEqual(0);
    expect(cacheIdx).toBeLessThan(installIdx);
    const cache = all[cacheIdx]!.with as Obj;
    expect(String(cache.path)).toMatch(/ms-playwright/);
    // キーに Playwright の版が入り、導入する Chromium の版と同じ値を使う。
    const version = String((w.doc.env as Obj | undefined)?.PLAYWRIGHT_VERSION ?? '');
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const key = evalExpr(String(cache.key).replace(/\$\{\{\s*runner\.os\s*\}\}/g, 'Linux'), { env: { PLAYWRIGHT_VERSION: version } });
    expect(key).toContain(version);
    expect(evalExpr(runOf(all[installIdx]!), { env: { PLAYWRIGHT_VERSION: version } })).toContain(`playwright@${version}`);
  });

  it('ブラウザを使うテストの段に APEX_REQUIRE_CHROMIUM=1 と APEX_BROWSER_WORKERS=2 が付く（どの組でも）', () => {
    for (let shard = 1; shard <= SHARDS; shard++) {
      expect(browserStage(shard).env).toMatchObject({ APEX_REQUIRE_CHROMIUM: '1', APEX_BROWSER_WORKERS: '2' });
    }
  });

  it('ブラウザのテストのジョブは検査のジョブを needs に持たず、1 つの組の失敗でほかの組を取り消さない', () => {
    const w = ciWorkflow();
    const [checkId] = checkJob(w);
    const [, job] = browserJob(w);
    const needs = job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
    expect(needs).not.toContain(checkId);
    expect(needs).toEqual([]);
    expect((job.strategy as Obj)['fail-fast']).toBe(false);
    expect(job['continue-on-error']).toBeUndefined();
  });
});

describe('ARC-74・ARC-75・ARC-60: CI の段のコマンドで 4 つの組を流す（APEX_ACCEPTANCE_SHARDS=1 のとき）', () => {
  const FAIL_FILE = 'tests/acceptance/zz-arc74-qa-failing-browser.test.ts';
  const FAIL_TITLE = 'ARC-74 の QA でわざと失敗させるブラウザを使うテスト';
  let state:
    | {
        whole: ReturnType<typeof runBrowserStage>;
        shards: ReturnType<typeof runBrowserStage>[];
        repo: string;
      }
    | undefined;

  /** 写しにわざと失敗するブラウザを使うテストを足し、分けずに 1 回と、4 つの組を 1 回ずつ流す（1 回だけ）。 */
  const prepare = () => {
    if (state) return state;
    const repo = copyTree('arc74-');
    writeFileSync(join(repo, FAIL_FILE), browserTestSource(`it('${FAIL_TITLE}', () => {\n  findChromium();\n  expect(1 + 1).toBe(3);\n});`));
    const base = browserStage(1);
    const wholeCommand = base.command.replace(/\s+--shard[= ]\S+/, '').replace(/\s+--$/, '');
    const whole = runBrowserStage(repo, wholeCommand, base.env);
    const shards = [1, 2, 3, 4].map((shard) => {
      const { command, env } = browserStage(shard);
      return runBrowserStage(repo, command, env);
    });
    state = { whole, shards, repo };
    return state;
  };

  const rel = (repo: string, f: string) => relative(repo, f.replace(/^\/private\//, '/'));
  const filesOf = (repo: string, r: { report: Report | undefined }) => (r.report?.testResults ?? []).map((t) => rel(repo.replace(/^\/private\//, '/'), t.name)).sort();

  it.runIf(SHARD_RUN)('ARC-74: わざと失敗させたテストのファイルが入る組が失敗し、ほかの組は止められずに最後まで流れ、まとめのジョブが失敗する', () => {
    const { shards, repo } = prepare();
    const withFail = shards.map((r, i) => ({ shard: i + 1, r })).filter(({ r }) => filesOf(repo, r).includes(FAIL_FILE));
    expect(withFail.map((x) => x.shard), 'わざと失敗させたファイルが入る組').toHaveLength(1);
    for (const [i, r] of shards.entries()) {
      const shard = i + 1;
      if (shard === withFail[0]!.shard) {
        expect(r.status, `組 ${shard}`).not.toBe(0);
        // 実時間で動くテストが手元の負荷で待ちの上限に当たって一緒に失敗することがあるので、わざと失敗させたテストが失敗に入っていることを見る。
        const failed = r.report!.testResults.flatMap((t) => t.assertionResults.filter((a) => a.status === 'failed').map((a) => a.title));
        expect(failed, `組 ${shard} の失敗したテスト\n${r.output.slice(-3000)}`).toContain(FAIL_TITLE);
      } else {
        // ほかの組は、わざと失敗させたテストを含まず、組に入ったどのファイルも最後まで流れて結果を持つ（途中で止められていない）。
        // 実時間で動くテストが手元の負荷で待ちの上限に当たることがあるので、ここでは組の成否は問わない（成否は LIVE で GitHub の記録を見る）。
        expect(r.report, `組 ${shard}\n${r.output.slice(-3000)}`).toBeDefined();
        const titles = r.report!.testResults.flatMap((t) => t.assertionResults.map((a) => a.title));
        expect(titles).not.toContain(FAIL_TITLE);
        expect(r.report!.testResults.length, `組 ${shard} のファイル`).toBeGreaterThan(0);
        for (const t of r.report!.testResults) expect(t.status, `組 ${shard} の ${t.name}`).toMatch(/^(passed|failed)$/);
        if (r.report!.numFailedTests === 0) expect(r.status, `組 ${shard}`).toBe(0);
      }
    }
    const w = ciWorkflow();
    const s = runSummary({ [checkJob(w)[0]]: 'success', [browserJob(w)[0]]: 'failure' });
    expect(s.ok, s.output).toBe(false);
  }, 3_600_000);

  it.runIf(SHARD_RUN)('ARC-75: 4 つの組で流れたファイルを合わせると、どのファイルもちょうど 1 つの組で流れ、テストの件数の合計が分けずに流したときと同じ', () => {
    const { whole, shards, repo } = prepare();
    const wholeFiles = filesOf(repo, whole);
    expect(wholeFiles.length).toBeGreaterThan(SHARDS);
    const merged = shards.flatMap((r) => filesOf(repo, r));
    expect(new Set(merged).size, '2 つ以上の組で流れたファイルがない').toBe(merged.length);
    expect(merged.sort()).toEqual(wholeFiles);
    for (const [i, r] of shards.entries()) expect(filesOf(repo, r).length, `組 ${i + 1} のファイルの数`).toBeGreaterThan(0);
    const sum = (k: keyof Report) => shards.reduce((a, r) => a + Number(r.report?.[k] ?? 0), 0);
    expect(sum('numTotalTests')).toBe(whole.report!.numTotalTests);
    // ファイルごとのテストの件数も、分けずに流したときと同じ（成否は実時間で動くテストが負荷で変わりうるので比べない）。
    const perFile = (r: { report: Report | undefined }) =>
      Object.fromEntries((r.report?.testResults ?? []).map((t) => [rel(repo.replace(/^\/private\//, '/'), t.name), t.assertionResults.length]));
    expect(Object.assign({}, ...shards.map(perFile))).toEqual(perFile(whole));
  }, 3_600_000);

  it.runIf(SHARD_RUN)('ARC-60: Chromium があるとき、どの組でもブラウザを使うテストのファイルが飛ばされずに流れる', () => {
    const { whole, shards, repo } = prepare();
    for (const [i, r] of shards.entries()) {
      expect(r.report, `組 ${i + 1}\n${r.output.slice(-3000)}`).toBeDefined();
      expect(r.report!.numPassedTests, `組 ${i + 1} の通ったテスト`).toBeGreaterThan(0);
      // どのファイルも飛ばされず、ファイルの中で 1 件以上のテストが流れている。
      for (const t of r.report!.testResults) {
        expect(t.status, `組 ${i + 1} の ${rel(repo, t.name)}`).toMatch(/^(passed|failed)$/);
        expect(t.assertionResults.some((a) => a.status === 'passed' || a.status === 'failed'), `組 ${i + 1} の ${rel(repo, t.name)}`).toBe(true);
      }
    }
    // テストのコードが条件で飛ばすもの（APEX_ACCEPTANCE_LIVE=1 のときだけ流すものなど）のほかに、組に分けて飛ばされたテストがない。
    const pending = shards.reduce((a, r) => a + (r.report?.numPendingTests ?? 0) + (r.report?.numTodoTests ?? 0), 0);
    expect(pending).toBe(whole.report!.numPendingTests + whole.report!.numTodoTests);
  }, 3_600_000);

  it.runIf(LIVE)('ARC-74: GitHub の実行の記録で、ブラウザのテストのジョブが失敗した実行では、ほかの組が取り消されずに終わり、まとめのジョブが失敗している', (ctx) => {
    const runs = liveRuns('status=completed').filter((r) => r.conclusion === 'failure');
    const target = runs.map((r) => ({ r, jobs: classifyJobs(r.id) })).find(({ jobs: j }) => j.browser.some((b) => b.conclusion === 'failure'));
    if (!target) ctx.skip(); // ブラウザのテストのジョブが失敗した実行がまだない
    const { browser, summary } = target!.jobs;
    expect(browser).toHaveLength(SHARDS);
    expect(browser.filter((b) => b.conclusion === 'cancelled')).toEqual([]);
    expect(summary[0]!.conclusion).toBe('failure');
  });
});

describe('ARC-79: キャッシュのある状態で、実行の始まりからすべてのジョブ（まとめを含む）の終わりまで 15 分以下', () => {
  it.runIf(LIVE)('GitHub の実行の記録で、成功した最新の実行の始まりから最後のジョブの終わりまでが 15 分以下', () => {
    const runs = liveRuns('status=completed').filter((r) => r.conclusion === 'success');
    expect(runs.length, `${liveBranch()} の成功した CI の実行`).toBeGreaterThan(0);
    const run = runs[0]!;
    const { all, summary } = classifyJobs(run.id);
    expect(summary).toHaveLength(1);
    const start = Math.min(Date.parse(run.run_started_at ?? run.created_at), Date.parse(run.created_at));
    const end = Math.max(...all.map((j) => Date.parse(j.completed_at)));
    expect((end - start) / 60_000, `実行 ${run.id} の時間（分）`).toBeLessThanOrEqual(15);
  });
});
