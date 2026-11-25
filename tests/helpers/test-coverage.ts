// ブラウザを使うテストのファイルの作りを TypeScript の構文木で調べる道具（docs/spec/architecture.md「テストの実行」
// 「テストの網羅の分担」、ARC-26・ARC-29）。テストの名前と、Chromium の起動・ページを開く箇所を読む。
import ts from 'typescript';

/** 受け入れ条件の ID（ARC-23、UI-5 など）。 */
export const ACCEPTANCE_ID = /\b[A-Z]{2,5}-\d+\b/g;

/** 名前の中の受け入れ条件の ID（重なりなし、出た順）。 */
export function acceptanceIds(text: string): string[] {
  return [...new Set(text.match(ACCEPTANCE_ID) ?? [])];
}

const parse = (file: string, source: string) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** it / test / beforeAll などの呼び出しの、元の名前（it.each(...)(...)・it.skipIf(...)(...) の it も）。 */
function rootName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return rootName(expression.expression);
  if (ts.isCallExpression(expression)) return rootName(expression.expression);
  return undefined;
}

/** 名前の引数の文字列（テンプレートは ${...} を除いた文字の部分）。 */
function staticText(node: ts.Expression | undefined): string {
  if (!node) return '';
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
  return '';
}

/** テスト（it / test）の呼び出し。 */
export interface TestCase {
  /** 囲む describe の名前とテストの名前を「 > 」でつないだもの（Vitest が表示するテストの名前と同じ並び）。 */
  name: string;
  /** 1 始まりの行番号。 */
  line: number;
  /** テストの本体（最後の関数の引数）。 */
  body: ts.Node | undefined;
}

function isTestCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  // it.each([...])・it.skipIf(x) のように、呼んだ結果をさらに呼ぶものは外側の呼び出しを 1 つのテストとする。
  if (ts.isCallExpression(node.parent) && node.parent.expression === node) return false;
  const name = rootName(node.expression);
  return (name === 'it' || name === 'test') && node.arguments.length > 0;
}

const lastFunction = (call: ts.CallExpression) =>
  [...call.arguments].reverse().find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));

function isDescribeCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || (ts.isCallExpression(node.parent) && node.parent.expression === node)) return false;
  return rootName(node.expression) === 'describe' && node.arguments.length > 0;
}

/** source のテスト（it / test）の名前（囲む describe の名前を含む）と本体。 */
export function testCases(file: string, source: string): TestCase[] {
  const sf = parse(file, source);
  const out: TestCase[] = [];
  const visit = (node: ts.Node, scope: string[]) => {
    if (isTestCall(node)) {
      out.push({
        name: [...scope, staticText(node.arguments[0])].join(' > '),
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        body: lastFunction(node),
      });
    }
    const inner = isDescribeCall(node) ? [...scope, staticText(node.arguments[0])] : scope;
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(sf, []);
  return out;
}

/** node の中に、名前が name の関数・メソッドの呼び出しがあるか。 */
function calls(node: ts.Node, names: ReadonlySet<string>): boolean {
  let hit = false;
  const visit = (n: ts.Node) => {
    if (hit) return;
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : undefined;
      if (name && names.has(name)) hit = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

/** node の中に識別子 name が出てくるか。 */
function mentions(node: ts.Node, names: ReadonlySet<string>): boolean {
  let hit = false;
  const visit = (n: ts.Node) => {
    if (hit) return;
    if (ts.isIdentifier(n) && names.has(n.text)) hit = true;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

/** Chromium の起動（launchBrowser の呼び出し）の箇所と、それを囲むフック（beforeAll など）の名前。 */
export interface BrowserLaunch {
  line: number;
  /** 起動を囲む最も内側のテストの関数の呼び出しの名前（beforeAll・it など）。どれにも囲まれていなければ undefined。 */
  hook: string | undefined;
}

export function browserLaunches(file: string, source: string): BrowserLaunch[] {
  const sf = parse(file, source);
  const out: BrowserLaunch[] = [];
  const hooks = new Set(['beforeAll', 'beforeEach', 'afterAll', 'afterEach', 'it', 'test', 'describe']);
  const visit = (node: ts.Node, hook: string | undefined) => {
    let inner = hook;
    if (ts.isCallExpression(node)) {
      const name = rootName(node.expression);
      if (name && hooks.has(name) && name !== 'describe') inner = name;
      if (ts.isIdentifier(node.expression) && node.expression.text === 'launchBrowser') {
        out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, hook });
      }
    }
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(sf, undefined);
  return out;
}

/**
 * ページ（タブ）を使うのに、自分で新しいページを開かないテスト（ARC-26）。
 * 新しいページを開くとは、本体が newPage を呼ぶか、newPage を（呼び出しをたどって）呼ぶ同じファイルの関数を呼ぶこと。
 * beforeEach で新しいページを開くファイルでは、すべてのテストが開いているとみなす。
 * ページを使うとは、本体に page・browser の名前（Page の値）が出てくること。
 */
export function testsReusingPage(file: string, source: string): TestCase[] {
  const sf = parse(file, source);
  // 同じファイルの関数（function 宣言と、関数を入れた const）。
  const functions = new Map<string, ts.Node>();
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) functions.set(node.name.text, node.body);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      functions.set(node.name.text, node.initializer.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const openers = new Set(['newPage']);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, body] of functions) {
      if (!openers.has(name) && calls(body, openers)) {
        openers.add(name);
        changed = true;
      }
    }
  }
  let opensInBeforeEach = false;
  const findHooks = (node: ts.Node) => {
    if (ts.isCallExpression(node) && rootName(node.expression) === 'beforeEach') {
      const fn = lastFunction(node);
      if (fn && calls(fn, openers)) opensInBeforeEach = true;
    }
    ts.forEachChild(node, findHooks);
  };
  findHooks(sf);
  if (opensInBeforeEach) return [];
  const pageNames = new Set(['page', 'browser']);
  return testCases(file, source).filter((t) => t.body && mentions(t.body, pageNames) && !calls(t.body, openers));
}

/** tests/acceptance/README.md の表の行（受け入れ条件の ID と、それを確かめるテストのファイル）。 */
export interface CoverageRow {
  id: string;
  file: string;
}

/** README の表から、1 列目が受け入れ条件の ID で、`tests/...test.ts` のファイルを含む行を読む。 */
export function coverageTable(markdown: string): CoverageRow[] {
  const rows: CoverageRow[] = [];
  for (const line of markdown.split('\n')) {
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.length < 2) continue;
    const id = cells[0]!.match(/^`?([A-Z]{2,5}-\d+)`?$/)?.[1];
    const file = line.match(/tests\/[\w./-]+\.test\.ts/)?.[0];
    if (id && file) rows.push({ id, file });
  }
  return rows;
}
