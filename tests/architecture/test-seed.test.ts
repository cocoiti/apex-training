// テストの乱数の種（docs/spec/architecture.md「種付きの乱数」「テストのための乱数の種の固定」、ARC-49〜ARC-51）の確認。
// ブラウザを使うテストはページを固定の種で開き（ARC-49）、失敗したときに使った種が出て（ARC-50）、
// ブラウザを使わないテストは実行のたびに変わる値から種を作らない（ARC-51）。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { browserTestFiles, usesChromium } from '../../vite.config';
import { codeOnly } from '../helpers/test-code';
import { findChangingSeeds, findUnseededPages, SEED_CHOICE_TESTS, UNSEEDED_PAGE_FILES } from '../helpers/test-seed';

const ROOT = resolve(__dirname, '../..');
const SELF = relative(ROOT, __filename).split('\\').join('/');

/** tests/ 以下の TypeScript のファイル（テストと道具）。 */
function testCodeFiles(): string[] {
  const out = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'tests'], { cwd: ROOT, encoding: 'utf8' });
  return out.stdout.split('\n').filter((f) => f.endsWith('.ts'));
}
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

describe('ARC-49: ブラウザを使うテストは、ページを固定の種で開き、種の値をテストのコードに書く', () => {
  it('ブラウザを使うテストのコードに、ページの URL を種を付けずに作っている箇所がなく、種の値はテストのコードに書いた数', () => {
    const files = browserTestFiles(ROOT);
    expect(files.length).toBeGreaterThan(10);
    expect(files.flatMap((f) => findUnseededPages(f, read(f)))).toEqual([]);
  });

  it('ページを開くブラウザのテストのファイルは、どれも appUrl で種を付けた URL を作る', () => {
    for (const f of browserTestFiles(ROOT)) {
      const code = codeOnly(read(f), { strings: true });
      if (/\.goto\(/.test(code)) expect(/\bappUrl\(/.test(code), f).toBe(true);
    }
  });

  it('種を付けずに開いてよいファイルは、種を付けないときの振る舞い（ARC-47・ARC-48）を確かめるブラウザのテストだけ', () => {
    expect(UNSEEDED_PAGE_FILES).toHaveLength(1);
    for (const f of UNSEEDED_PAGE_FILES) {
      const source = read(f);
      expect(usesChromium(source), f).toBe(true);
      expect(source).toMatch(/ARC-47/);
      expect(source).toMatch(/ARC-48/);
    }
  });

  it.each([
    ["page.goto(appUrl(origin, BASE, '#/', { render: false }));", 'seed がない'],
    ["page.goto(appUrl(origin, BASE, '#/'));", 'クエリがない'],
    ["page.goto(appUrl(origin, BASE, '#/', options));", 'クエリが引数で種が分からない'],
    ["page.goto(appUrl(origin, BASE, '#/', { ...options }));", '広げただけ'],
    ["page.goto(appUrl(origin, BASE, '#/', { seed: Date.now() }));", '時刻の種'],
    ["page.goto(appUrl(origin, BASE, '#/', { seed: opts.seed }));", '引数の種'],
    ["page.goto(appUrl(origin, BASE, '#/', { seed: NO_SEED }));", 'NO_SEED'],
    ['page.goto(`${origin}${BASE}`);', 'テンプレート'],
    ['page.goto(`${origin}${BASE}#/settings`);', 'テンプレートと hash'],
    ['const url = `${staticOrigin}${BASE}?render=off#/`;', 'テンプレートとクエリ'],
  ])('種を付けずにページを開く書き方を見つける: %s（%s）', (line) => {
    expect(findUnseededPages('tests/x.test.ts', `const a = 1;\n${line}\n`)).toMatchObject([{ file: 'tests/x.test.ts', line: 2 }]);
  });

  it.each([
    "const SEED = 12345;\npage.goto(appUrl(origin, BASE, '#/', { render: false, seed: SEED }));",
    "page.goto(appUrl(origin, BASE, '#/', { seed: 7 }));",
    "const SEED = 1;\nconst APP = { render: false, manualClock: true, seed: SEED };\npage.goto(appUrl(origin, BASE, '#/', APP));",
    "const SEED = 1;\npage.goto(appUrl(origin, BASE, '#/', { ...options, seed: SEED }));",
    "const A = 1;\nconst B = 2;\npage.goto(appUrl(origin, BASE, '#/', { seed: other ? B : A }));",
    'page.goto(`${origin}${BASE}?seed=12345#/`);',
    'page.goto(`${origin}${BASE}${RESET_PAGE}`);',
    'page.goto(`${origin}${BASE}assets/${js}`);',
    'const top = `${BASE}#/`;',
  ])('種を付けた URL と、ページでない URL は見つけない: %s', (source) => {
    expect(findUnseededPages('tests/x.test.ts', source)).toEqual([]);
  });

  it('NO_SEED は種を付けないときの振る舞いを確かめるファイルだけが使える', () => {
    const source = "page.goto(appUrl(origin, BASE, '#/', { render: false, seed: NO_SEED }));";
    expect(findUnseededPages(UNSEEDED_PAGE_FILES[0]!, source)).toEqual([]);
    expect(findUnseededPages('tests/acceptance/other.acceptance.test.ts', source)).toHaveLength(1);
  });
});

describe('ARC-50: 固定の種で流すブラウザのテストが失敗したとき、使った種が失敗のメッセージに出る', () => {
  const work = mkdtempSync(join(tmpdir(), 'test-seed-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('ブラウザの道具でページを開いたテストが失敗すると、メッセージにそのテストで開いた種が出て、通ったテストには何も足さない', () => {
    // ブラウザの道具（tests/helpers/browser.ts）を import した、わざと失敗するテストのファイルを別の Vitest で流す。
    // ページを開く Page.goto は URL を seed-report の noteOpenedUrl に渡すので、ここでは Chromium の代わりに直接渡す。
    const helpers = join(ROOT, 'tests', 'helpers');
    const fixture = [
      `import { beforeAll, expect, it } from 'vitest';`,
      `import { appUrl } from ${JSON.stringify(join(helpers, 'browser.ts'))};`,
      `import { noteOpenedUrl } from ${JSON.stringify(join(helpers, 'seed-report.ts'))};`,
      `const SEED = 4242;`,
      `const open = (seed: number) => noteOpenedUrl(appUrl('http://example.test', '/apex-training/', '#/', { render: false, seed }));`,
      `beforeAll(() => open(777));`,
      `it('使い回すページ', () => { expect(1).toBe(2); });`,
      `it('開いたページ', () => { open(SEED); expect('a').toBe('b'); });`,
      `it('通るテスト', () => { open(SEED); expect(1).toBe(1); });`,
    ].join('\n');
    writeFileSync(join(work, 'seed-fixture.test.ts'), fixture);
    writeFileSync(join(work, 'vitest.config.mjs'), `export default { test: { include: ['seed-fixture.test.ts'] } };`);
    const report = join(work, 'report.json');
    const out = spawnSync('npx', ['vitest', 'run', '--root', work, '--config', join(work, 'vitest.config.mjs'), '--reporter', 'default', '--reporter', 'json', '--outputFile.json', report], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    expect(out.status, out.stdout + out.stderr).toBe(1);
    // 画面に出す報告（default）にも、使った種が出る。
    expect(out.stdout + out.stderr).toContain('seed=4242');
    const json = JSON.parse(readFileSync(report, 'utf8')) as {
      testResults: { assertionResults: { title: string; status: string; failureMessages: string[] }[] }[];
    };
    const results = new Map(json.testResults.flatMap((r) => r.assertionResults).map((a) => [a.title, a]));
    expect(results.get('使い回すページ')?.status).toBe('failed');
    expect(results.get('使い回すページ')?.failureMessages.join('\n')).toContain('seed=777');
    expect(results.get('開いたページ')?.failureMessages.join('\n')).toContain('seed=4242');
    expect(results.get('開いたページ')?.failureMessages.join('\n')).not.toContain('seed=777');
    expect(results.get('通るテスト')?.status).toBe('passed');
  });
});

describe('ARC-51: ブラウザを使わないテストは、練習やシミュレーションの乱数の種を実行のたびに変わる値から作らない', () => {
  it('ブラウザを使わないテストのコードに、種や乱数の元を Math.random・crypto.getRandomValues・時刻・練習の種を選ぶ処理から作っている箇所がない', () => {
    const browser = new Set(browserTestFiles(ROOT));
    const files = testCodeFiles().filter((f) => f !== SELF && !browser.has(f) && !f.startsWith('tests/helpers/'));
    expect(files.length).toBeGreaterThan(10);
    expect(files.flatMap((f) => findChangingSeeds(f, read(f)))).toEqual([]);
  });

  it('除く「練習の種を選ぶ処理そのものを確かめるテスト」は、今あるファイルのテストで、種を選ぶ処理を呼んでいる', () => {
    for (const { file, test } of SEED_CHOICE_TESTS) {
      const source = read(file);
      expect(source, file).toContain(test);
      expect(source, file).toMatch(/\bcreateSeed\(\)/);
    }
  });

  it.each([
    'const r = createRandom(Date.now());',
    'const r = createRandom(Math.floor(Math.random() * 2 ** 32));',
    'const input = new RecordingInput(createSeed());',
    'const seed = crypto.getRandomValues(new Uint32Array(1))[0];',
    'const startSeed = performance.now();',
    'const session = new PracticeSession({ world, mode, input, seed: createSeed() });',
    'const context = { random: { next: Math.random } };',
    'const random = createRandom(new Date().getTime());',
  ])('実行のたびに変わる種を見つける: %s', (line) => {
    expect(findChangingSeeds('tests/x.test.ts', `const a = 1;\n${line}\n`)).toMatchObject([{ file: 'tests/x.test.ts', line: 2 }]);
  });

  it.each([
    'const r = createRandom(42);',
    'const SEED = 12345;\nconst input = new RecordingInput(SEED);',
    'const session = new PracticeSession({ world, mode, input, seed: 7 });',
    "const seed = { 'apex-training:settings': '{}' };",
    'const at = Date.now();',
  ])('決まった種と、種でない時刻は見つけない: %s', (source) => {
    expect(findChangingSeeds('tests/x.test.ts', source)).toEqual([]);
  });

  it('練習の種を選ぶ処理そのものを確かめるテストの中は除き、ほかのテストでは見つける', () => {
    const { file, test } = SEED_CHOICE_TESTS[0]!;
    const source = `it(${JSON.stringify(test)}, () => { const seed = createSeed(); });\nit('ほか', () => { const seed = createSeed(); });`;
    expect(findChangingSeeds(file, source)).toMatchObject([{ line: 2 }]);
  });
});
