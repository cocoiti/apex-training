// docs/spec/architecture.md「テストの実行」（#67: ブラウザを使うテストのファイルを並行に流す）の受け入れテスト（QA）。
// ARC-27・ARC-28・ARC-30〜ARC-35 と、振る舞い（既定で 2〜4 の決まった数を並行に流し、npm test と npm run test:browser で同じ数）を確かめる。
// npm run test:browser を実際に流して確かめる受け入れ条件は、このファイルだけで確かめる（ARC-26・ARC-29 は browser-tests-qa）。
// 公開された入口（CLAUDE.md、package.json の scripts、vitest の JSON の報告、流れている Chromium のプロセスの引数と環境変数）だけを使う。
//
// - ARC-33・ARC-35: いつも流す。設定を読むところで止まる・文書を読むだけなので速い。
//   ARC-33 は入れ子の npm test（APEX_ACCEPTANCE_NESTED=1）の中では流さない。
// - それ以外: npm run test:browser を何度も流すため 40 分ほどかかる。APEX_ACCEPTANCE_PARALLEL=1 のときだけ流す。
//   ほかの作業ツリーでテストを流していないときに、次のように流す。
//   APEX_ACCEPTANCE_PARALLEL=1 npx vitest run --project unit tests/acceptance/parallel-browser-qa.acceptance.test.ts
//
// 同時に流れるファイルの数は 2 通りで数える。
// - vitest の JSON の報告の、ファイルごとの開始と終了の時刻の重なり。
// - 流している間に ps で見た、このコマンドの子孫の Chromium の本体のプロセス（--type= のないもの）の数。ARC-26 で Chromium はファイルごとに 1 つ。
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const HEAVY = process.env.APEX_ACCEPTANCE_PARALLEL === '1' && !NESTED;
const WORKERS_ENV = 'APEX_BROWSER_WORKERS';
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 流す道具

interface ChromeSeen { pid: number; userDataDir: string | undefined; tmpDir: string | undefined; debugPort: string | undefined }

interface FileResult { file: string; start: number; end: number; status: string; durations: number[] }

interface RunResult {
  status: number | null;
  output: string;
  wallMs: number;
  files: FileResult[];
  numTotal: number;
  numFailed: number;
  numPassed: number;
  failed: string[];
  /** ps で見るたびの、子孫の Chromium の本体のプロセス。 */
  snapshots: ChromeSeen[][];
  /** 流した間の TMPDIR（流したあとに中身が残っていないかを見る）。 */
  tmp: string;
}

const execText = (file: string, args: string[]) =>
  new Promise<string>((done) => execFile(file, args, { maxBuffer: 64 * 1024 * 1024 }, (_e, stdout) => done(String(stdout ?? ''))));

const argOf = (command: string, name: string) => new RegExp(`--${name}=(\\S+)`).exec(command)?.[1];

/** root の子孫のうち、Chromium の本体のプロセス（--type= の付かないもの）と、その引数・環境変数。 */
async function chromesUnder(root: number): Promise<ChromeSeen[]> {
  const table = await execText('ps', ['-axww', '-o', 'pid=,ppid=,stat=,command=']);
  const children = new Map<number, number[]>();
  const commands = new Map<number, string>();
  const zombies = new Set<number>();
  for (const line of table.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (m[3]!.startsWith('Z')) zombies.add(pid);
    commands.set(pid, m[4]!);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const descendants: number[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    for (const c of children.get(pid) ?? []) { descendants.push(c); stack.push(c); }
  }
  const mains = descendants.filter((pid) => {
    // 終わって親に回収されるのを待っているだけのプロセス（ゾンビ）は、流れていないので数えない。
    if (zombies.has(pid)) return false;
    const cmd = commands.get(pid) ?? '';
    // 実行ファイルのパス（最初の -- の引数より前）が Chromium の本体のもの。Helper・crashpad・名前に chrom を含むだけのほかのプロセスは数えない。
    // 引数を読めないプロセス（サンドボックスの中の Helper など）は、ps が「(Google Chrome fo)」のように括弧で囲んだ名前だけを出す。
    if (cmd.startsWith('(')) return false;
    const exe = cmd.split(' --')[0]!;
    return /chrom/i.test(exe) && !/helper|crashpad/i.test(exe) && !/--type=/.test(cmd);
  });
  const out: ChromeSeen[] = [];
  for (const pid of mains) {
    const cmd = commands.get(pid)!;
    // macOS の ps -E はコマンドのあとに環境変数を続けて出す。
    const withEnv = await execText('ps', ['-E', '-ww', '-p', String(pid), '-o', 'command=']);
    // ps を 2 回呼ぶ間に終わったプロセスは、環境変数を読めないので見なかったことにする。
    if (withEnv.trim() === '') continue;
    const tmpDir = / TMPDIR=(\S+)/.exec(withEnv)?.[1];
    out.push({ pid, userDataDir: argOf(cmd, 'user-data-dir'), tmpDir, debugPort: argOf(cmd, 'remote-debugging-port') });
  }
  return out;
}

/** コマンドを流し、vitest の json の結果を書き出させて読む。流している間 ps で Chromium を見る。TMPDIR は新しい空のディレクトリにする。 */
function run(command: string, env: Record<string, string | undefined>, tag: string): Promise<RunResult> {
  const outDir = mkdtempSync(join(tmpdir(), `par-qa-out-${tag}-`));
  const tmp = mkdtempSync(join(tmpdir(), `par-qa-tmp-${tag}-`));
  temps.push(outDir, tmp);
  const json = join(outDir, 'result.json');
  // APEX_ACCEPTANCE_NESTED を付けるとブラウザのテストが飛ばされるので付けない。重い確かめの環境変数を外して、入れ子で自分を流さない。
  const childEnv: NodeJS.ProcessEnv = { ...process.env, CI: '1', TMPDIR: tmp };
  for (const k of ['APEX_ACCEPTANCE_PARALLEL', 'APEX_ACCEPTANCE_STRESS', 'APEX_ACCEPTANCE_TIMING', 'APEX_ACCEPTANCE_REPEAT', 'APEX_ACCEPTANCE_NESTED', 'VITEST', 'VITEST_WORKER_ID', 'VITEST_POOL_ID', 'NODE_ENV', WORKERS_ENV]) delete childEnv[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  const full = `${command} -- --reporter=default --reporter=json --outputFile.json="${json}"`;
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(full, { cwd: ROOT, shell: true, env: childEnv });
    let output = '';
    child.stdout.on('data', (d) => { output += String(d); });
    child.stderr.on('data', (d) => { output += String(d); });
    const snapshots: ChromeSeen[][] = [];
    let polling = false;
    const timer = setInterval(() => {
      if (polling || child.pid === undefined) return;
      polling = true;
      void chromesUnder(child.pid).then((s) => { snapshots.push(s); polling = false; });
    }, 300);
    child.on('close', (status) => {
      clearInterval(timer);
      const wallMs = Date.now() - started;
      let files: FileResult[] = [];
      let numTotal = -1;
      let numFailed = -1;
      let numPassed = -1;
      let failed: string[] = [];
      if (existsSync(json)) {
        const r = JSON.parse(readFileSync(json, 'utf8')) as {
          numTotalTests: number; numFailedTests: number; numPassedTests: number;
          testResults: { name: string; status: string; startTime: number; endTime: number; assertionResults: { fullName: string; status: string; duration: number | null }[] }[];
        };
        files = r.testResults.map((t) => ({
          file: relative(ROOT, t.name), start: t.startTime, end: t.endTime, status: t.status,
          durations: t.assertionResults.map((a) => a.duration ?? 0),
        }));
        failed = r.testResults.flatMap((t) => t.assertionResults.filter((a) => a.status === 'failed').map((a) => `${relative(ROOT, t.name)} > ${a.fullName}`));
        numTotal = r.numTotalTests;
        numFailed = r.numFailedTests;
        numPassed = r.numPassedTests;
      }
      done({ status, output, wallMs, files, numTotal, numFailed, numPassed, failed, snapshots, tmp });
    });
  });
}

/** JSON の報告の、ファイルの開始と終了の時刻の重なりの最大。 */
function maxOverlap(files: FileResult[]): number {
  const events = files.flatMap((f) => [{ t: f.start, d: 1 }, { t: f.end, d: -1 }]).sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0;
  let max = 0;
  for (const e of events) { cur += e.d; max = Math.max(max, cur); }
  return max;
}

/** ps で見た、同時に生きていた Chromium の本体の数の最大。 */
const maxChromes = (r: RunResult) => Math.max(0, ...r.snapshots.map((s) => s.length));

const summary = (r: RunResult) =>
  `status=${r.status} passed=${r.numPassed} failed=${r.numFailed}/${r.numTotal} wall=${(r.wallMs / 1000).toFixed(1)}s files=${r.files.length} overlap=${maxOverlap(r.files)} chromes=${maxChromes(r)}\n  ${r.failed.join('\n  ')}\n${r.status !== 0 ? r.output.slice(-3000) : ''}`;

/** ほかの作業ツリーの vitest が動いていないか（所要時間を比べる条件の前提）。 */
async function otherWorktreeVitest(): Promise<string[]> {
  const table = await execText('ps', ['-axww', '-o', 'pid=,command=']);
  return table.split('\n').filter((l) => /vitest/.test(l) && /node_modules/.test(l) && !l.includes(ROOT));
}

const BROWSER = 'npm run test:browser';

/** 一度流した結果を、いくつかの受け入れ条件で使い回す。 */
const memo = new Map<string, Promise<RunResult>>();
const once = (key: string, f: () => Promise<RunResult>) => {
  if (!memo.has(key)) memo.set(key, f());
  return memo.get(key)!;
};
const defaultRun = (i: number) => once(`default-${i}`, () => run(BROWSER, {}, `default${i}`));
const oneRun = () => once('one', () => run(BROWSER, { [WORKERS_ENV]: '1' }, 'one'));
const twoRun = () => once('two', () => run(BROWSER, { [WORKERS_ENV]: '2' }, 'two'));

const HOUR = 3_600_000;

// ---------------------------------------------------------------- 数え方の確認（いつも流す）

describe('調べ方の確認: 同時に流れていたファイルの数を、開始と終了の時刻から数える', () => {
  const at = (start: number, end: number): FileResult => ({ file: 'x', start, end, status: 'passed', durations: [] });
  it('終わった時刻に始まったファイルは重ならず、入れ子や部分的な重なりは数える', () => {
    expect(maxOverlap([at(0, 10), at(10, 20)])).toBe(1);
    expect(maxOverlap([at(0, 10), at(5, 20), at(6, 7)])).toBe(3);
    expect(maxOverlap([])).toBe(0);
  });
});

// ---------------------------------------------------------------- ARC-33（いつも流す。入れ子の npm test の中では流さない）

describe.skipIf(NESTED)('ARC-33: APEX_BROWSER_WORKERS が 1 以上の整数でないとき、ブラウザを使うテストが 1 つも流れず、その名前を示す誤りで終わる', () => {
  it.each(['0', 'abc'])('APEX_BROWSER_WORKERS=%s', async (value) => {
    const r = await run(BROWSER, { [WORKERS_ENV]: value }, `bad-${value}`);
    expect(r.status, r.output.slice(-3000)).not.toBe(0);
    expect(r.output).toContain(WORKERS_ENV);
    // 流れたテストがない（報告が出ないか、出ても 0 件）。
    expect(r.numTotal <= 0, summary(r)).toBe(true);
    expect(r.files.filter((f) => f.durations.length > 0), summary(r)).toEqual([]);
    // Chromium も起動していない。
    expect(maxChromes(r), summary(r)).toBe(0);
  }, 180_000);
});

// ---------------------------------------------------------------- ARC-35（いつも流す）

describe('ARC-35: CLAUDE.md のテストのコマンドに、既定の並行数と APEX_BROWSER_WORKERS での変え方が書いてある', () => {
  it('技術スタックの表のブラウザのテストの行に、既定の並行数（2〜4 の数）と、APEX_BROWSER_WORKERS=1 で 1 ファイルずつ流れることが書いてある', () => {
    const text = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
    const rows = text.split('\n').filter((l) => /^\|/.test(l) && /test:browser/.test(l));
    expect(rows.length, 'CLAUDE.md の表に npm run test:browser の行がない').toBeGreaterThan(0);
    const row = rows.join('\n');
    // 既定の並行数
    const m = /既定で\s*(\d+)\s*(?:ファイル|つ)/.exec(row);
    expect(m, `既定の並行数が書いていない: ${row}`).not.toBeNull();
    const n = Number(m![1]);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(4);
    expect(row).toMatch(/並[行列]/);
    // 変え方と、1 にすると 1 ファイルずつ流れること
    expect(row).toContain(WORKERS_ENV);
    expect(row).toMatch(/APEX_BROWSER_WORKERS=1[^|]*1\s*ファイルずつ/);
  });
});

// ---------------------------------------------------------------- 重い確かめ（APEX_ACCEPTANCE_PARALLEL=1）

describe.skipIf(!HEAVY)('振る舞い（テストの実行）: 既定で 2〜4 の決まった数を並行に流し、npm test と npm run test:browser で同じ数', () => {
  it('npm run test:browser で同時に流れるファイルの数の最大が 2〜4 で、npm test でブラウザを使うファイルを流したときも同じ数', async () => {
    const b = await defaultRun(1);
    expect(b.numPassed, summary(b)).toBeGreaterThan(0);
    const n = maxOverlap(b.files);
    expect(n, summary(b)).toBeGreaterThanOrEqual(2);
    expect(n, summary(b)).toBeLessThanOrEqual(4);
    expect(maxChromes(b), summary(b)).toBeLessThanOrEqual(n);

    // npm test を流し、そのうちのブラウザを使うファイルが同時に流れた数を比べる。
    const files = b.files.map((f) => f.file).sort();
    expect(files.length).toBeGreaterThan(4);
    const a = await run('npm test', {}, 'npmtest');
    const browserInAll = a.files.filter((f) => files.includes(f.file));
    expect(browserInAll.length, summary(a)).toBe(files.length);
    expect(maxOverlap(browserInAll), summary(a)).toBe(n);
    expect(a.failed, summary(a)).toEqual([]);
  }, 2 * HOUR);
});

describe.skipIf(!HEAVY)('ARC-27: ほかの作業ツリーでテストを流していないとき、既定の並行数の npm run test:browser が 415 秒以下で終わり、全件が通る', () => {
  it('既定の並行数の npm run test:browser が 415 秒以下で終わり、終了コード 0 で失敗したテストがない', async () => {
    const others = await otherWorktreeVitest();
    const r = await defaultRun(1);
    const report = `${summary(r)}\nほかの作業ツリーの vitest: ${others.length}`;
    console.log(`ARC-27: ${report}`);
    expect(r.numPassed, report).toBeGreaterThan(0);
    expect(r.failed, report).toEqual([]);
    expect(r.status, report).toBe(0);
    expect(r.wallMs / 1000, report).toBeLessThanOrEqual(415);
  }, HOUR);
});

describe.skipIf(!HEAVY)('ARC-32: APEX_BROWSER_WORKERS=1 ではファイルが同時に 2 つ以上流れず全件が通り、=2 では同時に 2 つ以下', () => {
  it('APEX_BROWSER_WORKERS=1: 全件が通り、同時に流れるファイルが 1 つ以下', async () => {
    const r = await oneRun();
    expect(r.numPassed, summary(r)).toBeGreaterThan(0);
    expect(r.failed, summary(r)).toEqual([]);
    expect(r.status, summary(r)).toBe(0);
    expect(maxOverlap(r.files), summary(r)).toBeLessThanOrEqual(1);
    expect(maxChromes(r), summary(r)).toBeLessThanOrEqual(1);
  }, HOUR);

  it('APEX_BROWSER_WORKERS=2: 同時に流れるファイルが 2 つ以下', async () => {
    const r = await twoRun();
    expect(r.numPassed, summary(r)).toBeGreaterThan(0);
    expect(maxOverlap(r.files), summary(r)).toBeLessThanOrEqual(2);
    expect(maxChromes(r), summary(r)).toBeLessThanOrEqual(2);
    // 2 を渡したら実際に 2 つ並行に流れる（1 ファイルずつに落ちていない）。
    expect(maxOverlap(r.files), summary(r)).toBe(2);
  }, HOUR);
});

const ARC28_LIMITS: Record<string, number> = {
  'retry-sets-qa': 61,
  'ghost-follow-qa': 45,
  'pad-navigation-qa': 39,
  'result-qa': 37,
  'measured-weapons-qa': 30,
};

describe.skipIf(!HEAVY)('ARC-28: APEX_BROWSER_WORKERS=1 で流したとき、各テストの時間の合計がファイルごとの上限以下', () => {
  it('retry-sets-qa 61 秒・ghost-follow-qa 45 秒・pad-navigation-qa 39 秒・result-qa 37 秒・measured-weapons-qa 30 秒以下', async () => {
    const others = await otherWorktreeVitest();
    const r = await oneRun();
    const sums = Object.fromEntries(Object.keys(ARC28_LIMITS).map((name) => {
      const f = r.files.find((x) => x.file === `tests/acceptance/${name}.acceptance.test.ts`);
      return [name, f ? f.durations.reduce((s, d) => s + d, 0) / 1000 : NaN];
    }));
    const report = `${JSON.stringify(sums)}\nほかの作業ツリーの vitest: ${others.length}\n${summary(r)}`;
    console.log(`ARC-28: ${report}`);
    for (const [name, limit] of Object.entries(ARC28_LIMITS)) {
      expect(sums[name], `${name}: ${report}`).not.toBeNaN();
      expect(sums[name], `${name}: ${report}`).toBeLessThanOrEqual(limit);
    }
  }, HOUR);
});

describe.skipIf(!HEAVY)('ARC-30: 既定の並行数で流すと、APEX_BROWSER_WORKERS=1 より所要時間が短い', () => {
  it('既定の並行数の npm run test:browser の所要時間が、APEX_BROWSER_WORKERS=1 のときより短い', async () => {
    const others = await otherWorktreeVitest();
    const d = await defaultRun(1);
    const one = await oneRun();
    const report = `既定: ${summary(d)}\n1: ${summary(one)}\nほかの作業ツリーの vitest: ${others.length}`;
    console.log(`ARC-30: ${report}`);
    expect(d.numPassed, report).toBeGreaterThan(0);
    expect(d.wallMs, report).toBeLessThan(one.wallMs);
  }, 2 * HOUR);
});

describe.skipIf(!HEAVY)('ARC-31: 既定の並行数で npm run test:browser を 3 回続けて流すと 3 回とも全件が通る', () => {
  it('3 回とも終了コード 0 で、失敗したテストがない', async () => {
    const results: RunResult[] = [];
    for (let i = 1; i <= 3; i++) results.push(await defaultRun(i));
    const report = results.map((r, i) => `#${i + 1}: ${summary(r)}`).join('\n');
    for (const r of results) {
      expect(r.numPassed, report).toBeGreaterThan(0);
      expect(r.failed, report).toEqual([]);
      expect(r.status, report).toBe(0);
    }
  }, 3 * HOUR);
});

describe.skipIf(!HEAVY)('ARC-34: 同時に流れるファイルの Chromium のプロファイルと一時ディレクトリがファイルごとに別で、終わったあとに残らない', () => {
  it('同時に生きている Chromium の --user-data-dir・TMPDIR・遠隔操作のポートが互いに違い、流したあとにどれも残らない', async () => {
    const r = await defaultRun(1);
    const all = new Map<number, ChromeSeen>();
    let concurrent = 0;
    for (const snap of r.snapshots) {
      for (const c of snap) all.set(c.pid, c);
      if (snap.length < 2) continue;
      concurrent++;
      const dirs = snap.map((c) => c.userDataDir);
      expect(dirs.every((d) => !!d), JSON.stringify(snap)).toBe(true);
      expect(new Set(dirs).size, `プロファイルを共有している: ${JSON.stringify(snap)}`).toBe(snap.length);
      const tmps = snap.map((c) => c.tmpDir);
      expect(tmps.every((d) => !!d), `TMPDIR を読めない: ${JSON.stringify(snap)}`).toBe(true);
      expect(new Set(tmps).size, `一時ディレクトリを共有している: ${JSON.stringify(snap)}`).toBe(snap.length);
      const ports = snap.map((c) => c.debugPort).filter((p) => p !== undefined && p !== '0');
      expect(new Set(ports).size, `遠隔操作のポートが重なる: ${JSON.stringify(snap)}`).toBe(ports.length);
    }
    expect(concurrent, `Chromium が同時に 2 つ以上生きている瞬間を見られなかった: ${summary(r)}`).toBeGreaterThan(0);
    expect(all.size, summary(r)).toBeGreaterThan(0);

    // 流したあとに、プロファイルと一時ディレクトリが残らない（TMPDIR の既定の値そのものは除く）。
    const left = [...all.values()].flatMap((c) => [c.userDataDir, c.tmpDir])
      .filter((d): d is string => !!d && resolve(d) !== resolve(r.tmp) && resolve(d) !== resolve(tmpdir()))
      .filter((d) => existsSync(d));
    expect(left, `残っている: ${JSON.stringify([...all.values()])}`).toEqual([]);
    // 流した間の TMPDIR の下にも、テストのファイルが作ったものが残らない。
    // node-compile-cache は Node.js 自身が TMPDIR に置くモジュールのコンパイルのキャッシュで、テストのファイルが作るものではないので除く。
    expect(readdirSync(r.tmp).filter((name) => name !== 'node-compile-cache'), `TMPDIR に残っている: ${r.tmp}`).toEqual([]);
  }, HOUR);
});
