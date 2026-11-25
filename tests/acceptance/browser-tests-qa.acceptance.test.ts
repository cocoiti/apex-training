// docs/spec/architecture.md「テストの実行」「テストの網羅の分担」（ARC-26〜ARC-29）の受け入れテスト（QA）。
// 公開された入口（package.json の scripts、vite.config.ts が公開する browserTestFiles、tests/ のテストのコード、
// tests/acceptance/README.md の表、vitest の JSON の報告）だけを使う。
//
// - ARC-26・ARC-29: いつも流す。ブラウザを使うテストのファイルを TypeScript の構文木で調べる。
// - ARC-27・ARC-28: npm run test:browser を 1 回流すため 7 分ほどかかる。環境変数 APEX_ACCEPTANCE_TIMING=1 のときだけ流す。
//   ほかの作業ツリーでテストを流していないときに、次のように流す。
//   APEX_ACCEPTANCE_TIMING=1 npx vitest run --project unit tests/acceptance/browser-tests-qa.acceptance.test.ts
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { browserTestFiles } from '../../vite.config';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const TIMING = process.env.APEX_ACCEPTANCE_TIMING === '1' && !NESTED;
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const parse = (file: string, source: string) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const lineOf = (sf: ts.SourceFile, node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** 呼び出しの根の名前（it.skipIf(x)(...) や describe.each(t)(...) なら it・describe）と、その途中のプロパティの名前。 */
function calleeChain(call: ts.CallExpression): { root: string | undefined; props: string[] } {
  const props: string[] = [];
  let e: ts.Expression = call.expression;
  for (;;) {
    if (ts.isCallExpression(e)) e = e.expression;
    else if (ts.isPropertyAccessExpression(e)) {
      props.unshift(e.name.text);
      e = e.expression;
    } else break;
  }
  return { root: ts.isIdentifier(e) ? e.text : undefined, props };
}

const TEST_FNS = new Set(['it', 'test']);
const HOOKS = new Set(['beforeAll', 'beforeEach', 'afterAll', 'afterEach']);
const isTestCall = (c: ts.CallExpression) => {
  const { root, props } = calleeChain(c);
  return !!root && TEST_FNS.has(root) && !props.some((p) => p === 'todo');
};
const isDescribeCall = (c: ts.CallExpression) => calleeChain(c).root === 'describe';

/** テストや describe の名前の引数の文字（テンプレートの ${...} は空にする）。 */
function nameText(node: ts.Node | undefined): string {
  if (!node) return '';
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => ` ${s.literal.text}`).join('');
  return node.getText();
}

/** 呼び出しに渡された関数（最後の関数の引数）。 */
const callbackOf = (c: ts.CallExpression) =>
  [...c.arguments].reverse().find((a): a is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(a) || ts.isFunctionExpression(a));

interface TestCase { name: string; line: number; body: ts.Node; describes: ts.CallExpression[] }

/** ファイルのテスト（it・test）と、囲む describe の名前をつないだ名前。 */
function testsOf(sf: ts.SourceFile): TestCase[] {
  const out: TestCase[] = [];
  const visit = (node: ts.Node, names: string[], describes: ts.CallExpression[]) => {
    if (ts.isCallExpression(node) && (isTestCall(node) || isDescribeCall(node))) {
      const name = nameText(node.arguments[0]);
      const cb = callbackOf(node);
      if (isDescribeCall(node)) {
        if (cb) ts.forEachChild(cb, (n) => visit(n, [...names, name], [...describes, node]));
        return;
      }
      if (cb) out.push({ name: [...names, name].join(' > '), line: lineOf(sf, node), body: cb, describes });
      return;
    }
    ts.forEachChild(node, (n) => visit(n, names, describes));
  };
  visit(sf, [], []);
  return out;
}

const ID = /\b[A-Z]{2,5}-\d+\b/g;
const idsIn = (text: string) => [...text.matchAll(ID)].map((m) => m[0]);

/** 名前つきの関数（function 宣言と、関数を入れた const）の本体。 */
function localFunctions(sf: ts.SourceFile): Map<string, ts.Node> {
  const fns = new Map<string, ts.Node>();
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) fns.set(node.name.text, node.body);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) fns.set(node.name.text, node.initializer.body);
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.body) fns.set(node.name.text, node.body);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return fns;
}

/** node の中（呼んでいるファイルの中の関数もたどる）で pred を満たす呼び出しがあるか。 */
function reaches(node: ts.Node, fns: Map<string, ts.Node>, pred: (c: ts.CallExpression) => boolean, seen = new Set<string>()): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      if (pred(n)) return void (found = true);
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : undefined;
      if (name && fns.has(name) && !seen.has(name)) {
        seen.add(name);
        if (reaches(fns.get(name)!, fns, pred, seen)) return void (found = true);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

const methodName = (c: ts.CallExpression) => (ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : undefined);
const opensPage = (c: ts.CallExpression) => methodName(c) === 'newPage';
/** ページを動かす呼び出し（tests/helpers/browser.ts の Page の操作）。 */
const PAGE_OPS = new Set(['goto', 'evaluate', 'waitFor', 'send', 'frames', 'screenshot', 'stableScreenshot', 'clickSelector', 'click', 'moveMouse', 'advanceClock', 'advanceClockUntil', 'addInitScript', 'lockPointerBy']);
const usesPage = (c: ts.CallExpression) => PAGE_OPS.has(methodName(c) ?? '');

/** Chromium を起動する箇所（launchBrowser の呼び出し、または Chromium の実行ファイルを子のプロセスで動かす呼び出し）。 */
function chromiumLaunches(sf: ts.SourceFile): { line: number; hook: string | undefined }[] {
  const out: { line: number; hook: string | undefined }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      const spawnsChromium = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'].includes(name) &&
        /chrom/i.test(node.arguments[0]?.getText(sf) ?? '');
      if (name === 'launchBrowser' || spawnsChromium) {
        let hook: string | undefined;
        for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
          if (ts.isCallExpression(p)) {
            const root = calleeChain(p).root;
            if (root && (HOOKS.has(root) || TEST_FNS.has(root))) {
              hook = root;
              break;
            }
          }
        }
        out.push({ line: lineOf(sf, node), hook });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const browserFiles = browserTestFiles(ROOT);

describe('ARC-26: ブラウザを使うテストは Chromium をファイルごとに 1 回（全体の前処理で）起動し、テストごとに新しいページを開く', () => {
  it('ブラウザを使うテストのファイルがある', () => {
    expect(browserFiles.length).toBeGreaterThan(5);
  });

  it('どのファイルも Chromium を起動する箇所が 1 つだけで、それが beforeAll の中にある', () => {
    const wrong = browserFiles
      .map((file) => ({ file, launches: chromiumLaunches(parse(file, read(file))) }))
      .filter(({ launches }) => launches.length !== 1 || launches[0]!.hook !== 'beforeAll')
      .map(({ file, launches }) => `${file}: ${JSON.stringify(launches)}`);
    expect(wrong).toEqual([]);
  });

  it('どのファイルも beforeAll で開いたページを使い回さず、ページを使うテストは自分で（または beforeEach で）新しいページを開く', () => {
    const problems: string[] = [];
    for (const file of browserFiles) {
      const sf = parse(file, read(file));
      const fns = localFunctions(sf);
      // 前処理（beforeAll）で開いたページを、外側の変数に入れてテストで使い回さない（前処理の中だけで使うのはよい）。
      const visitHooks = (node: ts.Node) => {
        if (ts.isCallExpression(node) && calleeChain(node).root === 'beforeAll') {
          const cb = callbackOf(node);
          const assign = (n: ts.Node) => {
            if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && reaches(n.right, fns, opensPage)) {
              problems.push(`${file}:${lineOf(sf, n)} beforeAll で開いたページを外側の変数に入れている: ${n.getText(sf).slice(0, 80)}`);
            }
            ts.forEachChild(n, assign);
          };
          if (cb) assign(cb);
        }
        ts.forEachChild(node, visitHooks);
      };
      visitHooks(sf);
      const eachOpens = (describes: ts.CallExpression[]) => {
        const scopes: ts.Node[] = [sf, ...describes.map((d) => callbackOf(d)!).filter(Boolean)];
        return scopes.some((scope) => {
          let opens = false;
          const v = (n: ts.Node) => {
            if (opens) return;
            if (ts.isCallExpression(n) && calleeChain(n).root === 'beforeEach') {
              const cb = callbackOf(n);
              if (cb && reaches(cb, fns, opensPage)) opens = true;
              return;
            }
            if (ts.isCallExpression(n) && (isDescribeCall(n) || isTestCall(n)) && scope !== n) return;
            ts.forEachChild(n, v);
          };
          ts.forEachChild(scope, v);
          return opens;
        });
      };
      for (const t of testsOf(sf)) {
        if (!reaches(t.body, fns, usesPage)) continue;
        if (reaches(t.body, fns, opensPage) || eachOpens(t.describes)) continue;
        problems.push(`${file}:${t.line} ${t.name}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('調べ方の確認: テストの中の起動・2 回の起動・前処理のページの使い回しを見つける', () => {
    const inTest = parse('x.ts', `it('a', async () => { b = await launchBrowser(exe); });`);
    expect(chromiumLaunches(inTest)).toEqual([{ line: 1, hook: 'it' }]);
    const twice = parse('x.ts', `beforeAll(async () => { a = await launchBrowser(e); b = spawn(chromium, []); });`);
    expect(chromiumLaunches(twice)).toHaveLength(2);
    const shared = parse('x.ts', [
      `beforeAll(async () => { browser = await launchBrowser(e); page = await browser.newPage(); });`,
      `it('reuse', async () => { await page.goto(u); });`,
      `it('fresh', async () => { const p = await open(); await p.goto(u); });`,
      `async function open() { return browser.newPage(); }`,
    ].join('\n'));
    const fns = localFunctions(shared);
    const [reuse, fresh] = testsOf(shared);
    expect(reaches(reuse!.body, fns, opensPage)).toBe(false);
    expect(reaches(fresh!.body, fns, opensPage)).toBe(true);
    expect(reaches(reuse!.body, fns, usesPage)).toBe(true);
  });
});

/** README の表の行（受け入れ条件の ID と、テストのファイル）。 */
function tableRows(markdown: string): { id: string; file: string }[] {
  const rows: { id: string; file: string }[] = [];
  for (const line of markdown.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    const id = cells[1]!;
    const file = cells.slice(2).map((c) => c.match(/`?(tests\/[^`\s]+\.test\.ts)`?/)?.[1]).find(Boolean);
    if (/^[A-Z]{2,5}-\d+$/.test(id) && file) rows.push({ id, file });
  }
  return rows;
}

describe('ARC-29: tests/acceptance/README.md の表の ID は、表が示すファイルのテストの名前にあり、ほかのブラウザを使うファイルにはない', () => {
  const rows = tableRows(read('tests/acceptance/README.md'));
  const idsByFile = new Map(browserFiles.map((f) => [f, new Set(testsOf(parse(f, read(f))).flatMap((t) => idsIn(t.name)))]));

  it('表に行があり、同じ ID が 2 行にない', () => {
    expect(rows.length).toBeGreaterThan(10);
    const ids = rows.map((r) => r.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it('表が示すファイルはブラウザを使うテストのファイルで、名前にその ID を含むテストがある', () => {
    const missing = rows.filter((r) => !idsByFile.get(r.file)?.has(r.id)).map((r) => `${r.id} → ${r.file}`);
    expect(missing).toEqual([]);
  });

  it('ほかのブラウザを使うファイルに、名前に同じ ID を含むテストがない', () => {
    const dup = rows.flatMap((r) => browserFiles.filter((f) => f !== r.file && idsByFile.get(f)?.has(r.id)).map((f) => `${r.id} → ${f}`));
    expect(dup).toEqual([]);
  });

  it('調べ方の確認: describe の名前・テンプレート・it.skipIf・it.each から ID を読み、表の行を読む', () => {
    const sf = parse('x.ts', [
      "describe.skipIf(x)('ARC-1: d', () => { it('a', () => {}); });",
      'it(`MODE-16: ${v} b`, () => {});',
      "it.each([1])('SCO-3 %s', () => {});",
      "it.skipIf(y)('PAD-9・INP-1: c', async () => {});",
      "describe('UI-9: テストのない describe', () => {});",
    ].join('\n'));
    expect(testsOf(sf).flatMap((t) => idsIn(t.name))).toEqual(['ARC-1', 'MODE-16', 'SCO-3', 'PAD-9', 'INP-1']);
    expect(tableRows('| ID | SPEC | ファイル |\n|--|--|--|\n| UI-1 | [s](x) | `tests/acceptance/a.acceptance.test.ts` |\n| 説明 | x | y |'))
      .toEqual([{ id: 'UI-1', file: 'tests/acceptance/a.acceptance.test.ts' }]);
  });
});

// ---------------------------------------------------------------- ARC-27・ARC-28（実際に流す）

interface JsonReport { testResults: { name: string; assertionResults: { duration?: number | null; status: string }[] }[]; numFailedTests: number }

describe.skipIf(!TIMING)('ARC-27・ARC-28: npm run test:browser の所要時間と、ファイルごとのテストの時間の合計', () => {
  const work = mkdtempSync(join(tmpdir(), 'browser-tests-qa-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  let elapsed = 0;
  let report: JsonReport | undefined;
  let output = '';

  const run = async () => {
    if (report) return;
    const out = join(work, 'report.json');
    const started = Date.now();
    const code = await new Promise<number>((ok) => {
      const child = spawn('npm', ['run', 'test:browser', '--', '--reporter=json', `--outputFile=${out}`], {
        cwd: ROOT,
        env: { ...process.env, APEX_ACCEPTANCE_TIMING: '', FORCE_COLOR: '0' },
      });
      child.stdout.on('data', (d) => (output += String(d)));
      child.stderr.on('data', (d) => (output += String(d)));
      child.on('close', (c) => ok(c ?? 1));
    });
    elapsed = (Date.now() - started) / 1000;
    report = JSON.parse(readFileSync(out, 'utf8')) as JsonReport;
    console.log(`ARC-27 npm run test:browser: ${elapsed.toFixed(1)} 秒、終了コード ${code}、失敗 ${report.numFailedTests} 件`);
  };

  it('ARC-27: npm run test:browser が 415 秒以下で終わり、全件が通る', async () => {
    await run();
    expect(report!.numFailedTests, output.slice(-4000)).toBe(0);
    expect(elapsed).toBeLessThanOrEqual(415);
  }, 900_000);

  it('ARC-28: retry-sets-qa 61 秒・ghost-follow-qa 45 秒・pad-navigation-qa 39 秒・result-qa 37 秒・measured-weapons-qa 30 秒以下', async () => {
    await run();
    const limits: Record<string, number> = { 'retry-sets-qa': 61, 'ghost-follow-qa': 45, 'pad-navigation-qa': 39, 'result-qa': 37, 'measured-weapons-qa': 30 };
    const sums = Object.fromEntries(Object.keys(limits).map((k) => {
      const file = report!.testResults.find((r) => basename(r.name) === `${k}.acceptance.test.ts`);
      const sum = file ? file.assertionResults.reduce((s, a) => s + (a.duration ?? 0), 0) / 1000 : NaN;
      return [k, sum];
    }));
    console.log(`ARC-28 テストの時間の合計（秒）: ${JSON.stringify(sums)}`);
    console.log(`ARC-28 全ファイル: ${report!.testResults.map((r) => `${relative(ROOT, r.name)}=${(r.assertionResults.reduce((s, a) => s + (a.duration ?? 0), 0) / 1000).toFixed(1)}`).join(', ')}`);
    const over = Object.entries(limits).filter(([k, limit]) => !(sums[k]! <= limit)).map(([k, limit]) => `${k}: ${sums[k]} > ${limit}`);
    expect(over).toEqual([]);
  }, 900_000);
});
