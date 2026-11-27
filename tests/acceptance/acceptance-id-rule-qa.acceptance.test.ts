// docs/spec/architecture.md・docs/spec/README.md「受け入れ条件の ID」（#96）の受け入れテスト（QA）。ARC-96-1〜ARC-96-4 を確かめる。
// 公開された入口（docs/spec/、CLAUDE.md、tests/acceptance/README.md の表、ARC-29 を確かめるテストのファイル
// tests/architecture/test-coverage.test.ts と、それを流す vitest のコマンド）だけを使う。
//
// - ARC-96-2・ARC-96-3: リポジトリの写しを作り、表・SPEC・ブラウザを使うテストのファイルを足して ARC-29 のテストだけを流す。
// - ARC-96-4: 前からある ID が表と SPEC に残っていることはいつも確かめる。npm test と npm run lint を実際に流すのは
//   APEX_ACCEPTANCE_ID_RULE=1 のときだけ（npm test はブラウザのテストを含み時間がかかり、npm test の中で流すと入れ子になる）。
//   APEX_ACCEPTANCE_ID_RULE=1 npx vitest run --project unit tests/acceptance/acceptance-id-rule-qa.acceptance.test.ts
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const HEAVY = process.env.APEX_ACCEPTANCE_ID_RULE === '1' && !NESTED;
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

const README = 'tests/acceptance/README.md';
/** ARC-29 を確かめるテストのファイル（tests/acceptance/README.md に書いてある）。 */
const ARC29_TEST = 'tests/architecture/test-coverage.test.ts';
/** 写しに足すブラウザを使うテストのファイル。 */
const FILE_A = 'tests/ui/qa96-a-browser.test.ts';
const FILE_B = 'tests/ui/qa96-b-browser.test.ts';
/** ブラウザを使うテストのファイルにする import（このファイル自身がブラウザを使うテストと見なされないよう、組み立てて作る）。 */
const BROWSER_IMPORT = ['import { appUrl } from', "'../helpers/browser';"].join(' ');

const browserFile = (...testNames: string[]) =>
  [BROWSER_IMPORT, "import { it } from 'vitest';", 'void appUrl;', ...testNames.map((n) => `it(${JSON.stringify(n)}, () => {});`), ''].join('\n');

const copies: string[] = [];
afterAll(() => {
  for (const dir of copies) rmSync(dir, { recursive: true, force: true });
});

interface Arc29Run { status: number | null; output: string; passed: number; failed: number; failures: string }

/**
 * リポジトリの写しを作り、表に行を足し（rows）、ブラウザを使うファイルを足して（files）、ARC-29 のテストだけを流す。
 * 写しの SPEC には UI-999 と UI-999-1 の条件を足しておく（表の ID が SPEC にあることも ARC-29 のテストが見るため）。
 */
function runArc29(rows: { id: string; file: string }[], files: Record<string, string>): Arc29Run {
  const copy = mkdtempSync(join(tmpdir(), 'qa96-'));
  copies.push(copy);
  for (const entry of ['src', 'tests', 'docs', 'package.json', 'tsconfig.json', 'vite.config.ts', 'CLAUDE.md']) {
    cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), 'dir');
  const screens = join(copy, 'docs/spec/screens.md');
  writeFileSync(screens, `${readFileSync(screens, 'utf8').trimEnd()}\n- **UI-999**: QA の見本の条件\n- **UI-999-1**: QA の見本の新しい形の条件\n`);
  const readme = join(copy, README);
  const extra = rows.map((r) => `| ${r.id} | [screens.md](../../docs/spec/screens.md) | \`${r.file}\` |`).join('\n');
  writeFileSync(readme, `${readFileSync(readme, 'utf8').trimEnd()}\n${extra}\n`);
  for (const [f, src] of Object.entries(files)) writeFileSync(join(copy, f), src);
  const report = join(copy, 'qa96-report.json');
  const result = spawnSync(
    'npx',
    ['vitest', 'run', ARC29_TEST, '-t', 'ARC-29:', '--reporter=default', '--reporter=json', `--outputFile.json=${report}`],
    { cwd: copy, encoding: 'utf8', env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', APEX_ACCEPTANCE_NESTED: '1' } },
  );
  let passed = 0;
  let failed = 0;
  let failures = '';
  try {
    const json = JSON.parse(readFileSync(report, 'utf8')) as {
      testResults: { assertionResults: { fullName: string; status: string; failureMessages: string[] }[] }[];
    };
    const asserts = json.testResults.flatMap((t) => t.assertionResults).filter((a) => a.fullName.includes('ARC-29'));
    passed = asserts.filter((a) => a.status === 'passed').length;
    failed = asserts.filter((a) => a.status === 'failed').length;
    failures = asserts.flatMap((a) => a.failureMessages).join('\n');
  } catch {
    // 報告がなければ数は 0 のまま（下の expect で出力ごと示す）。
  }
  // eslint-disable-next-line no-control-regex
  const output = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  // 失敗した expect の差分に出た、食い違いの項目（vitest の差分の「+   "..."」の行）。
  const diff = [...output.matchAll(/^\s*\+\s+"(.*)",?\s*$/gm)].map((m) => m[1]).join('\n');
  return { status: result.status, output, passed, failed, failures: `${failures}\n${diff}` };
}

const TIMEOUT = 180_000;

describe('ARC-96-1: 受け入れ条件の ID の決まりが docs/spec/README.md と CLAUDE.md に書いてある', () => {
  const spec = read('docs/spec/README.md');
  const claude = read('CLAUDE.md');

  it('docs/spec/README.md に、新しく足す ID の形 <接頭辞>-<Issue 番号>-<その Issue の中の番号> と例（UI-81-1 など）がある', () => {
    expect(spec).toMatch(/新しく足す受け入れ条件の ID[^\n]*<接頭辞>-<Issue 番号>-<その Issue の中の番号>/);
    expect(spec).toMatch(/UI-81-1/);
  });

  it('docs/spec/README.md に、前からある ID を付け替えないことが書いてある', () => {
    expect(spec).toMatch(/前からある[^\n]*ID[^\n]*付け替えない/);
  });

  it('docs/spec/README.md に、ID を欠番にして再利用しないことが書いてある', () => {
    expect(spec).toMatch(/欠番[^\n]*再利用しない/);
  });

  it('CLAUDE.md に、新しい ID の形が短く書いてある', () => {
    const lines = claude.split('\n').filter((l) => l.includes('<接頭辞>-<Issue 番号>-<その Issue の中の番号>'));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => /受け入れ条件の ID/.test(l) && /[A-Z]{2,5}-\d+-\d+/.test(l))).toBe(true);
  });
});

describe('ARC-96-2: 表と表が示すファイルに UI-999-1 があれば ARC-29 のテストが通り、食い違えば失敗する', () => {
  it('表に UI-999-1 の行があり、表が示すブラウザを使うファイルに名前に UI-999-1 を含むテストがあると、ARC-29 のテストが通る', () => {
    const r = runArc29([{ id: 'UI-999-1', file: FILE_A }], {
      [FILE_A]: browserFile('UI-999-1: 新しい形の ID の見本'),
      [FILE_B]: browserFile('ID のないテスト'),
    });
    expect(r.passed, r.output).toBeGreaterThan(0);
    expect(r.failed, r.failures || r.output).toBe(0);
    expect(r.status, r.output).toBe(0);
  }, TIMEOUT);

  it('describe の名前に UI-999-1 を書いたときも、ARC-29 のテストが通る', () => {
    const src = [BROWSER_IMPORT, "import { describe, it } from 'vitest';", 'void appUrl;', "describe('UI-999-1: 見本', () => { it('a', () => {}); });", ''].join('\n');
    const r = runArc29([{ id: 'UI-999-1', file: FILE_A }], { [FILE_A]: src });
    expect(r.passed, r.output).toBeGreaterThan(0);
    expect(r.failed, r.failures || r.output).toBe(0);
    expect(r.status, r.output).toBe(0);
  }, TIMEOUT);

  it('表に UI-999-1 の行がないと、ARC-29 のテストが失敗する', () => {
    const r = runArc29([], { [FILE_A]: browserFile('UI-999-1: 新しい形の ID の見本') });
    expect(r.failed, r.output).toBeGreaterThan(0);
    expect(r.status).not.toBe(0);
    expect(r.failures).toContain('UI-999-1');
  }, TIMEOUT);

  it('表が示すファイルに名前に UI-999-1 を含むテストがないと、ARC-29 のテストが失敗する', () => {
    const r = runArc29([{ id: 'UI-999-1', file: FILE_A }], { [FILE_A]: browserFile('ID のないテスト') });
    expect(r.failed, r.output).toBeGreaterThan(0);
    expect(r.status).not.toBe(0);
    expect(r.failures).toContain('UI-999-1');
  }, TIMEOUT);

  it('ほかのブラウザを使うファイルにも名前に UI-999-1 を含むテストがあると、ARC-29 のテストが失敗する', () => {
    const r = runArc29([{ id: 'UI-999-1', file: FILE_A }], {
      [FILE_A]: browserFile('UI-999-1: 新しい形の ID の見本'),
      [FILE_B]: browserFile('UI-999-1: 別のファイルにもある'),
    });
    expect(r.failed, r.output).toBeGreaterThan(0);
    expect(r.status).not.toBe(0);
    expect(r.failures).toContain(FILE_B);
  }, TIMEOUT);
});

describe('ARC-96-3: UI-999-1 と UI-999 は別の ID として照らす', () => {
  it('表に UI-999 の行がなく、名前に UI-999-1 を含むテストだけがあるとき、UI-999 のテストとは扱わない（表の UI-999 の行が満たされない）', () => {
    const r = runArc29([{ id: 'UI-999', file: FILE_A }], { [FILE_A]: browserFile('UI-999-1: 新しい形の ID の見本') });
    expect(r.failed, r.output).toBeGreaterThan(0);
    expect(r.status).not.toBe(0);
    expect(r.failures).toMatch(/UI-999(?!-)/);
  }, TIMEOUT);

  it('表に UI-999 の行がなく、名前に UI-999-1 を含むテストと表の UI-999-1 の行があるとき、UI-999 が表にない ID とはされない', () => {
    const r = runArc29([{ id: 'UI-999-1', file: FILE_A }], { [FILE_A]: browserFile('UI-999-1: 新しい形の ID の見本') });
    expect(r.failed, r.failures || r.output).toBe(0);
    expect(r.status, r.output).toBe(0);
  }, TIMEOUT);

  it('表に UI-999-1 の行だけがあり、名前に UI-999 だけを含むテストがあるとき、UI-999-1 のテストがないとして失敗する', () => {
    const r = runArc29([{ id: 'UI-999-1', file: FILE_A }], { [FILE_A]: browserFile('UI-999: 古い形の ID の見本') });
    expect(r.failed, r.output).toBeGreaterThan(0);
    expect(r.status).not.toBe(0);
    expect(r.failures).toContain('UI-999-1');
  }, TIMEOUT);
});

/**
 * main との分かれ目のコミット。ROOT が git の作業ツリーで main があるときだけ（ほかの受け入れテストが作る写しは
 * .git がないか、コミットのない git init だけなので、そこでは main との比べを飛ばす）。
 */
const BASE = (() => {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' });
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(ROOT)) return undefined;
  const base = spawnSync('git', ['merge-base', 'HEAD', 'main'], { cwd: ROOT, encoding: 'utf8' });
  return base.status === 0 ? base.stdout.trim() : undefined;
})();

/** main との分かれ目の版のファイル（なければ undefined）。 */
function atBase(file: string): string | undefined {
  const show = spawnSync('git', ['show', `${BASE}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return show.status === 0 ? show.stdout : undefined;
}

/**
 * 分かれ目のあとで受け入れ条件ごと消して欠番にした ID（docs/spec/README.md「受け入れ条件の ID」）。付け替えではないので、
 * SPEC と表から消えていてよい。Issue #104 で手元の公開のコマンドをなくしたときに OVR-7・OVR-9 を消した。
 */
const REMOVED = new Set(['OVR-7', 'OVR-9']);
const OLD_ROW = /^\|\s*([A-Z]{2,5}-\d+)\s*\|.*$/gm;
const OLD_SPEC_ID = /\*\*([A-Z]{2,5}-\d+)\*\*/g;

describe('ARC-96-4: 前からある <接頭辞>-<番号> の形の ID は付け替わらず、npm test と npm run lint が通る', () => {
  it.skipIf(!BASE)('main との分かれ目の版の表にあった <接頭辞>-<番号> の形の行は、どれもそのまま表に残っている', () => {
    const before = atBase(README);
    expect(before, 'main との分かれ目の版の表を読めない').toBeDefined();
    const oldRows = [...before!.matchAll(OLD_ROW)].filter((m) => !REMOVED.has(m[1]!)).map((m) => m[0].trim());
    expect(oldRows.length).toBeGreaterThan(50);
    const now = new Set(read(README).split('\n').map((l) => l.trim()));
    expect(oldRows.filter((row) => !now.has(row))).toEqual([]);
  });

  it.skipIf(!BASE)('main との分かれ目の版の SPEC にあった <接頭辞>-<番号> の形の ID は、どれも SPEC に残っている', () => {
    const files = ['architecture.md', 'input.md', 'modes.md', 'mouse.md', 'overview.md', 'pad.md', 'scoring.md', 'screens.md', 'weapons.md'];
    const missing: string[] = [];
    let count = 0;
    for (const f of files) {
      const before = atBase(`docs/spec/${f}`);
      if (before === undefined) continue;
      const now = new Set([...read(`docs/spec/${f}`).matchAll(OLD_SPEC_ID)].map((m) => m[1]));
      for (const m of before.matchAll(OLD_SPEC_ID)) {
        count++;
        if (!now.has(m[1]) && !REMOVED.has(m[1]!)) missing.push(`${f}: ${m[1]}`);
      }
    }
    expect(count).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });

  it.skipIf(!HEAVY)('npm run lint が通る', () => {
    const r = spawnSync('npm', ['run', 'lint'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  }, 600_000);

  it.skipIf(!HEAVY)('npm test が通る', () => {
    const r = spawnSync('npm', ['test'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0', APEX_ACCEPTANCE_NESTED: '1' },
    });
    expect(r.status, `${r.stdout.slice(-20000)}\n${r.stderr.slice(-5000)}`).toBe(0);
  }, 3_600_000);
});
