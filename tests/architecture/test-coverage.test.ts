// ブラウザを使うテストの作りと網羅の分担（docs/spec/architecture.md「テストの実行」「テストの網羅の分担」、ARC-26・ARC-29・ARC-96-2〜ARC-96-4）の確認。
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserTestFiles } from '../../vite.config';
import { acceptanceIds, browserLaunches, coverageProblems, coverageTable, testCases, testsReusingPage } from '../helpers/test-coverage';

const ROOT = resolve(__dirname, '../..');
/** 見本のコードの Chromium を起動する関数の名前（このファイル自身がブラウザを使うテストと見なされないよう、組み立てて作る）。 */
const LAUNCH = ['launch', 'Browser'].join('');
const README = 'tests/acceptance/README.md';
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

/** docs/spec/ に **ID** として書かれた受け入れ条件の ID（UI-43 の形と UI-81-1 の形）。 */
function specIds(): Set<string> {
  const ids = new Set<string>();
  for (const f of readdirSync(join(ROOT, 'docs/spec')).filter((x) => x.endsWith('.md'))) {
    for (const m of read(`docs/spec/${f}`).matchAll(/\*\*([A-Z]{2,5}-\d+(?:-\d+)?)\*\*/g)) ids.add(m[1]!);
  }
  return ids;
}

describe('ARC-26: Chromium はファイルごとに 1 回起動し、テストごとに新しいページを開く', () => {
  const files = browserTestFiles(ROOT);

  it('ブラウザを使うテストのファイルで、Chromium を起動する箇所が 1 つだけで、全体の前処理（beforeAll）の中にある', () => {
    expect(files.length).toBeGreaterThan(0);
    const wrong = files
      .map((f) => ({ file: f, launches: browserLaunches(f, read(f)) }))
      .filter(({ launches }) => launches.length !== 1 || launches[0]!.hook !== 'beforeAll');
    expect(wrong).toEqual([]);
  });

  it('ブラウザを使うテストのファイルで、ページを使うテストはどれも新しいページを開いている', () => {
    const reusing = files.flatMap((f) => testsReusingPage(f, read(f)).map((t) => `${f}:${t.line} ${t.name}`));
    expect(reusing).toEqual([]);
  });

  it('調べ方: テストの中や 2 回の起動、前処理で開いたページを使い回すテストを見つける', () => {
    const inTest = `it('a', async () => { const b = await ${LAUNCH}(exe); });`;
    expect(browserLaunches('x.ts', inTest)).toEqual([{ line: 1, hook: 'it' }]);
    const twice = `beforeAll(async () => { a = await ${LAUNCH}(exe); b = await ${LAUNCH}(exe); });`;
    expect(browserLaunches('x.ts', twice)).toHaveLength(2);
    const shared = [
      'let page;',
      `beforeAll(async () => { browser = await ${LAUNCH}(exe); page = await browser.newPage(); });`,
      "it('使い回す', async () => { await page.goto(url); });",
      "it('開く', async () => { const page = await openFresh(); await page.goto(url); });",
      "it('ページを使わない', () => { expect(1).toBe(1); });",
      'async function openFresh() { return open(); }',
      'const open = () => browser.newPage();',
    ].join('\n');
    expect(testsReusingPage('x.ts', shared).map((t) => t.name)).toEqual(['使い回す']);
    const perTest = `beforeEach(async () => { page = await browser.newPage(); });\nit('a', async () => { await page.goto(url); });`;
    expect(testsReusingPage('x.ts', perTest)).toEqual([]);
  });
});

describe('ARC-29: ブラウザで確かめる受け入れ条件は、表が示す 1 つのファイルだけが確かめる', () => {
  const rows = coverageTable(read(README));
  const files = browserTestFiles(ROOT);
  /** ブラウザを使うファイルごとの、テストの名前。 */
  const namesByFile = new Map(files.map((f) => [f, testCases(f, read(f)).map((t) => t.name)]));
  const problems = coverageProblems(rows, namesByFile);

  it(`${README} の表に受け入れ条件の ID とファイルの行があり、ID は重ならず、SPEC にある ID で、ファイルはブラウザを使うテストのファイル`, () => {
    expect(rows.length).toBeGreaterThan(50);
    const ids = rows.map((r) => r.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    const spec = specIds();
    expect(ids.filter((id) => !spec.has(id))).toEqual([]);
    expect(rows.filter((r) => !files.includes(r.file))).toEqual([]);
  });

  it('表のそれぞれの ID について、表が示すファイルに名前にその ID を含むテストがあり、ほかのブラウザを使うファイルにはない', () => {
    expect([...problems.missing, ...problems.elsewhere]).toEqual([]);
  });

  it('ブラウザを使うテストの名前にある受け入れ条件の ID は、どれも表に載っている', () => {
    expect(problems.unlisted).toEqual([]);
  });

  it('調べ方: テンプレートの名前・it.each・it.skipIf・囲む describe のテストの名前から ID を読み、表の行を読む', () => {
    const source = [
      "it('UI-1・UI-2: a', () => {});",
      'it(`MODE-16: ${via} で始め直す`, async () => {});',
      "it.each([1])('SCO-3: %s', () => {});",
      "it.skipIf(x)('PAD-9 / INP-1: b', () => {});",
      "describe('ARC-1: 囲む describe の名前もテストの名前に入る', () => { it('b', () => {}); });",
      "describe('ARC-2: テストのない describe', () => {});",
    ].join('\n');
    expect(testCases('x.ts', source).flatMap((t) => acceptanceIds(t.name))).toEqual(['UI-1', 'UI-2', 'MODE-16', 'SCO-3', 'PAD-9', 'INP-1', 'ARC-1']);
    expect(testCases('x.ts', source).at(-1)!.name).toBe('ARC-1: 囲む describe の名前もテストの名前に入る > b');
    const table = ['| ID | ファイル |', '|----|----|', '| UI-1 | `tests/acceptance/screens.acceptance.test.ts` |', '| 説明 | tests/x.test.ts |'].join('\n');
    expect(coverageTable(table)).toEqual([{ id: 'UI-1', file: 'tests/acceptance/screens.acceptance.test.ts' }]);
  });
});

describe('ARC-96-2・ARC-96-3: <接頭辞>-<Issue 番号>-<番号> の形の ID も、表とテストの名前で 1 つの ID として照らす', () => {
  const A = 'tests/ui/a-browser.test.ts';
  const B = 'tests/ui/b-browser.test.ts';
  const table = (...ids: string[]) =>
    ['| 受け入れ条件 | SPEC | テストのファイル |', '|----|----|----|', ...ids.map((id) => `| ${id} | [screens.md](x) | \`${A}\` |`)].join('\n');
  const namesOf = (sources: Record<string, string>) =>
    new Map(Object.entries(sources).map(([f, src]) => [f, testCases(f, src).map((t) => t.name)]));
  const check = (markdown: string, sources: Record<string, string>) => {
    const p = coverageProblems(coverageTable(markdown), namesOf(sources));
    return [...p.missing, ...p.elsewhere, ...p.unlisted];
  };
  const other = "it('UI-1: ほかのテスト', () => {});";

  it('ID の読み方: UI-999-1 は 1 つの ID で、UI-999 とは読まない（表の行もテストの名前も）', () => {
    expect(acceptanceIds('UI-999-1・UI-999・ARC-96-2 / UI-43: x')).toEqual(['UI-999-1', 'UI-999', 'ARC-96-2', 'UI-43']);
    expect(acceptanceIds('UI-999-1: x')).not.toContain('UI-999');
    expect(coverageTable(table('UI-999-1', '`UI-43`'))).toEqual([{ id: 'UI-999-1', file: A }, { id: 'UI-43', file: A }]);
  });

  it('ARC-96-2: 表に UI-999-1 の行があり、表が示すファイルにだけ名前に UI-999-1 を含むテストがあるとき、食い違いがない', () => {
    expect(check(table('UI-1', 'UI-999-1'), { [A]: `${other}\nit('UI-999-1: 新しい形の ID', () => {});`, [B]: "it('名前に ID がない', () => {});" })).toEqual([]);
    // describe に書いた ID も同じ。
    expect(check(table('UI-1', 'UI-999-1'), { [A]: `${other}\ndescribe('UI-999-1: d', () => { it('a', () => {}); });` })).toEqual([]);
  });

  it('ARC-96-2: 表に行がない・表が示すファイルにテストがない・ほかのファイルにもテストがあるときは、食い違いになる', () => {
    const withTest = { [A]: `${other}\nit('UI-999-1: 新しい形の ID', () => {});` };
    expect(check(table('UI-1'), withTest)).toEqual([`UI-999-1（${A}）`]);
    expect(check(table('UI-1', 'UI-999-1'), { [A]: other })).toEqual([`UI-999-1 が ${A} のテストの名前にない`]);
    expect(check(table('UI-1', 'UI-999-1'), { ...withTest, [B]: "it('UI-999-1: 別のファイル', () => {});" }))
      .toEqual([`UI-999-1 が ${B} のテストの名前にもある`]);
  });

  it('ARC-96-3: 表に UI-999 の行がなく、名前に UI-999-1 を含むテストだけがあるとき、UI-999 のテストとは扱わない', () => {
    const sources = { [A]: `${other}\nit('UI-999-1: 新しい形の ID', () => {});` };
    // 表に UI-999-1 の行もないとき、表にない ID として出るのは UI-999-1 で、UI-999 ではない。
    expect(coverageProblems(coverageTable(table('UI-1')), namesOf(sources)).unlisted).toEqual([`UI-999-1（${A}）`]);
    // 表に UI-999 の行を足すと、UI-999 のテストがないとして食い違いになる。
    expect(check(table('UI-1', 'UI-999-1', 'UI-999'), sources)).toEqual([`UI-999 が ${A} のテストの名前にない`]);
  });

  it('ARC-96-3: 表に UI-999-1 の行だけがあり、名前に UI-999 だけを含むテストがあるとき、UI-999-1 のテストがないとして食い違いになる', () => {
    expect(check(table('UI-1', 'UI-999-1'), { [A]: `${other}\nit('UI-999: 古い形の ID', () => {});` }))
      .toEqual([`UI-999-1 が ${A} のテストの名前にない`, `UI-999（${A}）`]);
  });
});

describe('ARC-96-1・ARC-96-4: 受け入れ条件の ID の決まりが書いてあり、前からある ID は付け替わっていない', () => {
  it('ARC-96-1: docs/spec/README.md に新しい ID の形と例、付け替えないこと、欠番にして再利用しないことがあり、CLAUDE.md にも新しい形がある', () => {
    const spec = read('docs/spec/README.md');
    expect(spec).toContain('`<接頭辞>-<Issue 番号>-<その Issue の中の番号>`');
    expect(spec).toContain('`UI-81-1`');
    expect(spec).toMatch(/新しい形に付け替えない/);
    expect(spec).toMatch(/欠番にして、どちらの形でも再利用しない/);
    const claude = read('CLAUDE.md');
    expect(claude).toContain('`<接頭辞>-<Issue 番号>-<その Issue の中の番号>`');
    expect(claude).toContain('`UI-81-1`');
  });

  it('ARC-96-4: 前からある <接頭辞>-<番号> の形の ID が、SPEC と表とテストの名前にそのまま残っている', () => {
    const spec = specIds();
    const rows = coverageTable(read(README));
    const old = rows.filter((r) => /^[A-Z]{2,5}-\d+$/.test(r.id));
    expect(old.length).toBeGreaterThan(50);
    expect(old.filter((r) => !spec.has(r.id))).toEqual([]);
    for (const id of ['ARC-29', 'UI-43', 'MODE-1']) expect(spec.has(id), id).toBe(true);
  });
});
