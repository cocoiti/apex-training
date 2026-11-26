// テストのコードを TypeScript の構文木で調べ、練習の乱数の種の決め方を確かめる道具（docs/spec/architecture.md「種付きの乱数」
// 「テストのための乱数の種の固定」、ARC-49・ARC-51）。コメントは構文木に入らないので、説明に書いた書き方は見ない。
import ts from 'typescript';
import type { TestCodeViolation } from './test-code';

/**
 * 種を付けずにページを開いてよい（appUrl に NO_SEED を渡してよい）ブラウザのテストのファイル。種を付けないときの振る舞い
 * （練習ごとに種を選ぶ・画面に種が出ない、ARC-47・ARC-48）を確かめるファイルだけ。
 */
export const UNSEEDED_PAGE_FILES: readonly string[] = ['tests/acceptance/fixed-seed-qa.acceptance.test.ts'];

/**
 * 練習の種を選ぶ処理そのもの（選ぶたびに値が変わること、選んだ値の範囲）を確かめるテスト。ファイルとテストの名前（it の最初の引数）。
 * この中だけは、選んだ種（createSeed など）を使ってよい（ARC-51 の除外）。
 */
export const SEED_CHOICE_TESTS: readonly { file: string; test: string }[] = [
  { file: 'tests/input/recording.test.ts', test: '種は 0 以上 2³² 未満の整数にする' },
  { file: 'tests/acceptance/input-recording-qa.acceptance.test.ts', test: '練習の開始時に決める種は 0 以上 2³² 未満の整数で、練習ごとに変わる' },
];

/** 実行のたびに変わる値（乱数・時刻・練習の種を選ぶ処理）の書き方。 */
const CHANGING_VALUE = /\bMath\.random\b|\bgetRandomValues\b|\brandomUUID\b|\brandomInt\b|\brandomBytes\b|\bDate\.now\b|\bnew Date\b|\bperformance\.now\b|\bprocess\.hrtime\b|\bcreateSeed\s*\(/;

const parse = (file: string, source: string) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function violation(file: string, sf: ts.SourceFile, node: ts.Node, reason: string): TestCodeViolation {
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
  const text = sf.text.split('\n')[line] ?? '';
  return { file, line: line + 1, reason, text: text.trim() };
}

/** ファイルの中の const の名前と初期化の式（どの深さでも。名前が重なったら最初のもの）。 */
function constInitializers(sf: ts.SourceFile): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const) !== 0) {
      for (const d of node.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && !out.has(d.name.text)) out.set(d.name.text, d.initializer);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const unwrap = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) ? unwrap(e.expression) : e;

/** 識別子なら const の初期化の式まで辿る（辿れなければそのまま）。 */
function resolve(e: ts.Expression, consts: Map<string, ts.Expression>, depth = 0): ts.Expression {
  const u = unwrap(e);
  if (depth < 5 && ts.isIdentifier(u)) {
    const init = consts.get(u.text);
    if (init) return resolve(init, consts, depth + 1);
  }
  return u;
}

/** このファイルに書いた数（数の字面、数を入れた const、どちらの枝もそうである条件式）か。 */
function isWrittenNumber(e: ts.Expression, consts: Map<string, ts.Expression>): boolean {
  const v = resolve(e, consts);
  if (ts.isConditionalExpression(v)) return isWrittenNumber(v.whenTrue, consts) && isWrittenNumber(v.whenFalse, consts);
  return ts.isNumericLiteral(v);
}

/** 呼び出しの名前（appUrl(...)・createRandom(...)・new RecordingInput(...) の識別子）。 */
function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

/**
 * ARC-49: ブラウザを使うテストのファイルで、ページの URL を種を付けずに作っている箇所。
 * - appUrl の 4 番目の引数（クエリ）に seed がない、または seed の値がこのファイルに書いた数（数の字面か、数を入れた const）でない。
 *   （どちらの枝も書いた数の条件式はよい）。NO_SEED は UNSEEDED_PAGE_FILES のファイルだけが使える。
 * - origin のあとに BASE をつないだテンプレート（`${origin}${BASE}#/` など）で、ページの URL を seed= を付けずに作っている。
 */
export function findUnseededPages(file: string, source: string): TestCodeViolation[] {
  const sf = parse(file, source);
  const consts = constInitializers(sf);
  const allowNoSeed = UNSEEDED_PAGE_FILES.includes(file);
  const out: TestCodeViolation[] = [];

  const checkSeedValue = (value: ts.Expression) => {
    const v = unwrap(value);
    if (ts.isIdentifier(v) && v.text === 'NO_SEED') {
      if (!allowNoSeed) out.push(violation(file, sf, value, '種を付けずに（NO_SEED で）ページを開いている'));
      return;
    }
    if (!isWrittenNumber(v, consts)) out.push(violation(file, sf, value, '種の値がテストのコードに書いた数（数か、数を入れた const）でない'));
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && calleeName(node.expression) === 'appUrl') {
      const query = node.arguments[3];
      const literal = query ? resolve(query, consts) : undefined;
      if (!literal) out.push(violation(file, sf, node, 'appUrl に種（seed）を渡していない'));
      else if (!ts.isObjectLiteralExpression(literal)) out.push(violation(file, sf, query!, 'appUrl のクエリがこのファイルに書いたオブジェクトでなく、種が分からない'));
      else {
        const seed = literal.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText(sf) === 'seed');
        if (!seed) out.push(violation(file, sf, query!, 'appUrl のクエリに種（seed）がない'));
        else if (ts.isShorthandPropertyAssignment(seed)) checkSeedValue(seed.name);
        else if (ts.isPropertyAssignment(seed)) checkSeedValue(seed.initializer);
      }
    }
    if (ts.isTemplateExpression(node)) {
      const spans = node.templateSpans;
      spans.forEach((span, i) => {
        if (!ts.isIdentifier(span.expression) || span.expression.text !== 'BASE') return;
        const before = i > 0 || /https?:\/\//.test(node.head.text);
        const rest = span.literal.text;
        const isLast = i === spans.length - 1;
        // BASE のあとが何もないか、# か ? で続くもの（ページそのもの）。BASE のあとに資産のパスやほかの値が続くものは見ない。
        const page = (isLast && rest === '') || rest.startsWith('#') || rest.startsWith('?');
        if (before && page && !node.getText(sf).includes('seed=')) out.push(violation(file, sf, node, 'ページの URL を seed を付けずに作っている'));
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** node を囲む it / test の名前（最初の引数の文字列）。囲むテストがなければ undefined。 */
function enclosingTestName(node: ts.Node): string | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n)) {
      let callee: ts.Expression = n.expression;
      while (ts.isPropertyAccessExpression(callee) || ts.isCallExpression(callee)) callee = callee.expression;
      const first = n.arguments[0];
      if (ts.isIdentifier(callee) && (callee.text === 'it' || callee.text === 'test') && first && ts.isStringLiteralLike(first)) return first.text;
    }
  }
  return undefined;
}

/** 種や乱数の元を入れる名前（seed・startSeed・random など）。 */
const SEED_NAME = /^(?:seed|\w*Seed|random|\w*Random)$/;

/**
 * ARC-51: ブラウザを使わないテストのコードで、練習やシミュレーションの乱数の種（または乱数の元）を、実行のたびに変わる値から作っている箇所。
 * createRandom・new RecordingInput の引数、seed・random などの名前の変数とプロパティの値に、Math.random・crypto.getRandomValues・
 * 時刻・createSeed を使っているもの。SEED_CHOICE_TESTS のテストの中は除く。
 */
export function findChangingSeeds(file: string, source: string): TestCodeViolation[] {
  const sf = parse(file, source);
  const exempt = new Set(SEED_CHOICE_TESTS.filter((t) => t.file === file).map((t) => t.test));
  const out: TestCodeViolation[] = [];
  const check = (at: ts.Node, value: ts.Node | undefined, what: string) => {
    if (!value || !CHANGING_VALUE.test(value.getText(sf))) return;
    const test = enclosingTestName(at);
    if (test !== undefined && exempt.has(test)) return;
    out.push(violation(file, sf, at, `${what}を実行のたびに変わる値から作っている`));
  };
  const visit = (node: ts.Node) => {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) {
      const name = calleeName(node.expression);
      if (name === 'createRandom' || name === 'RecordingInput') for (const arg of node.arguments) check(node, arg, `${name} の種`);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && SEED_NAME.test(node.name.text)) check(node, node.initializer, `${node.name.text} の値`);
    if (ts.isPropertyAssignment(node) && SEED_NAME.test(node.name.getText(sf))) check(node, node.initializer, `${node.name.getText(sf)} の値`);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // 変数の値と、その中の createRandom の引数のように、同じ行で重なって見つけたものは 1 つにする。
  return out.filter((v, i) => out.findIndex((w) => w.line === v.line) === i);
}
