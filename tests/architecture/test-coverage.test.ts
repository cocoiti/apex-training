// ブラウザを使うテストの作りと網羅の分担（docs/spec/architecture.md「テストの実行」「テストの網羅の分担」、ARC-26・ARC-29）の確認。
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserTestFiles } from '../../vite.config';
import { acceptanceIds, browserLaunches, coverageTable, testCases, testsReusingPage } from '../helpers/test-coverage';

const ROOT = resolve(__dirname, '../..');
/** 見本のコードの Chromium を起動する関数の名前（このファイル自身がブラウザを使うテストと見なされないよう、組み立てて作る）。 */
const LAUNCH = ['launch', 'Browser'].join('');
const README = 'tests/acceptance/README.md';
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

/** docs/spec/ に **ID** として書かれた受け入れ条件の ID。 */
function specIds(): Set<string> {
  const ids = new Set<string>();
  for (const f of readdirSync(join(ROOT, 'docs/spec')).filter((x) => x.endsWith('.md'))) {
    for (const m of read(`docs/spec/${f}`).matchAll(/\*\*([A-Z]{2,5}-\d+)\*\*/g)) ids.add(m[1]!);
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
  /** ブラウザを使うファイルごとの、テストの名前に含まれる ID。 */
  const idsByFile = new Map(files.map((f) => [f, new Set(testCases(f, read(f)).flatMap((t) => acceptanceIds(t.name)))]));

  it(`${README} の表に受け入れ条件の ID とファイルの行があり、ID は重ならず、SPEC にある ID で、ファイルはブラウザを使うテストのファイル`, () => {
    expect(rows.length).toBeGreaterThan(50);
    const ids = rows.map((r) => r.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    const spec = specIds();
    expect(ids.filter((id) => !spec.has(id))).toEqual([]);
    expect(rows.filter((r) => !files.includes(r.file))).toEqual([]);
  });

  it('表のそれぞれの ID について、表が示すファイルに名前にその ID を含むテストがあり、ほかのブラウザを使うファイルにはない', () => {
    const missing = rows.filter((r) => !idsByFile.get(r.file)?.has(r.id)).map((r) => `${r.id} が ${r.file} のテストの名前にない`);
    const elsewhere = rows.flatMap((r) =>
      files.filter((f) => f !== r.file && idsByFile.get(f)?.has(r.id)).map((f) => `${r.id} が ${f} のテストの名前にもある`),
    );
    expect([...missing, ...elsewhere]).toEqual([]);
  });

  it('ブラウザを使うテストの名前にある受け入れ条件の ID は、どれも表に載っている', () => {
    const listed = new Set(rows.map((r) => r.id));
    const unlisted = [...idsByFile].flatMap(([f, ids]) => [...ids].filter((id) => !listed.has(id)).map((id) => `${id}（${f}）`));
    expect(unlisted).toEqual([]);
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
