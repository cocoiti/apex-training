// docs/spec/architecture.md「種付きの乱数」「テストのための乱数の種の固定」の ARC-49・ARC-51 を、テストのコードを調べて確かめる
// QA の受け入れテスト。QA が SPEC だけから書いたもの。tests/ 以下の TypeScript を構文木で読み、実装やほかの調べる道具には依存しない。
// ブラウザを使うテストのファイルは、tests/helpers/browser.ts を import するファイル（CLAUDE.md）。
// ARC-50（失敗したときに種が出る）は、Chromium でページを開く必要があるので seed-query-qa.acceptance.test.ts で確かめる。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const TESTS = join(ROOT, 'tests');

function listTs(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return listTs(p);
    return p.endsWith('.ts') ? [relative(ROOT, p).split('\\').join('/')] : [];
  });
}
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const parse = (f: string, s: string) => ts.createSourceFile(f, s, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** tests/helpers/browser.ts を import するか。 */
function importsBrowser(sf: ts.SourceFile): boolean {
  return sf.statements.some(
    (s) => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && /(?:^|\/)helpers\/browser(?:\.ts)?$/.test(s.moduleSpecifier.text),
  );
}

const ALL = listTs(TESTS);
const browserFiles = ALL.filter((f) => f.endsWith('.test.ts') && importsBrowser(parse(f, read(f))));
const nonBrowserFiles = ALL.filter((f) => !browserFiles.includes(f));

/** 種を付けずに開いてよい（種を付けないときの振る舞い ARC-47・ARC-48 を確かめる）ファイル。 */
const UNSEEDED_ALLOWED = ['tests/acceptance/fixed-seed-qa.acceptance.test.ts', 'tests/acceptance/seed-query-qa.acceptance.test.ts'];

interface Finding {
  file: string;
  line: number;
  why: string;
  text: string;
}
const at = (file: string, sf: ts.SourceFile, node: ts.Node, why: string): Finding => {
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
  return { file, line: line + 1, why, text: (sf.text.split('\n')[line] ?? '').trim() };
};

/** ファイルの中の const の初期化の式（名前ごとに最初のもの）。 */
function consts(sf: ts.SourceFile): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclarationList(n) && n.flags & ts.NodeFlags.Const) {
      for (const d of n.declarations) if (ts.isIdentifier(d.name) && d.initializer && !out.has(d.name.text)) out.set(d.name.text, d.initializer);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
const strip = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) ? strip(e.expression) : e);
function follow(e: ts.Expression, c: Map<string, ts.Expression>, depth = 0): ts.Expression {
  const s = strip(e);
  if (depth < 6 && ts.isIdentifier(s) && c.has(s.text)) return follow(c.get(s.text)!, c, depth + 1);
  return s;
}
/** テストのコードに書いた数（数の字面か、それを入れた const。条件式ならどちらの枝も）。 */
function writtenNumber(e: ts.Expression, c: Map<string, ts.Expression>): boolean {
  const v = follow(e, c);
  if (ts.isConditionalExpression(v)) return writtenNumber(v.whenTrue, c) && writtenNumber(v.whenFalse, c);
  if (ts.isPrefixUnaryExpression(v) && v.operator === ts.SyntaxKind.MinusToken) return writtenNumber(v.operand, c);
  if (ts.isBinaryExpression(v)) return writtenNumber(v.left, c) && writtenNumber(v.right, c);
  return ts.isNumericLiteral(v);
}

/**
 * ARC-49 の調べ: ページの URL の作り方。
 * - appUrl(…) の 4 番目の引数（クエリ）に seed があり、その値はテストのコードに書いた数（NO_SEED は UNSEEDED_ALLOWED だけ）。
 * - テンプレートで /apex-training/ のページ（BASE のあとが空・#・?）の URL を作るとき、テストが立てたサーバー（127.0.0.1・localhost）の
 *   ページの URL を文字列で書くときは seed= を含む（公開先の URL を比べる文字列は、テストが開くページではないので見ない）。
 * - Page.navigate を直接送るときも同じ（URL の式を上の規則で見る）。
 */
function unseededPages(file: string, source: string): Finding[] {
  const sf = parse(file, source);
  const c = consts(sf);
  const out: Finding[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'appUrl') {
      const q = n.arguments[3] ? follow(n.arguments[3], c) : undefined;
      if (!q || !ts.isObjectLiteralExpression(q)) out.push(at(file, sf, n, 'appUrl のクエリに書いた種が読めない'));
      else {
        const p = q.properties.find((x) => x.name && x.name.getText(sf) === 'seed');
        const value = p && ts.isPropertyAssignment(p) ? p.initializer : p && ts.isShorthandPropertyAssignment(p) ? p.name : undefined;
        if (!value) out.push(at(file, sf, n, 'appUrl に seed がない'));
        else if (ts.isIdentifier(strip(value)) && (strip(value) as ts.Identifier).text === 'NO_SEED') {
          if (!UNSEEDED_ALLOWED.includes(file)) out.push(at(file, sf, n, 'NO_SEED で種を付けずに開いている'));
        } else if (!writtenNumber(value, c)) out.push(at(file, sf, n, '種の値がテストのコードに書いた数でない'));
      }
    }
    if (ts.isTemplateExpression(n)) {
      n.templateSpans.forEach((span, i) => {
        if (!ts.isIdentifier(span.expression) || span.expression.text !== 'BASE') return;
        const hasOrigin = i > 0 || /https?:\/\//.test(n.head.text);
        const rest = span.literal.text;
        const isPage = (i === n.templateSpans.length - 1 && rest === '') || /^[#?]/.test(rest);
        if (hasOrigin && isPage && !n.getText(sf).includes('seed=')) out.push(at(file, sf, n, 'ページの URL に seed= がない'));
      });
    }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /https?:\/\/(?:127\.0\.0\.1|localhost)[^\s'"]*\/apex-training\/(?:[#?]|$)/.test(n.text) && !n.text.includes('seed=')) {
      out.push(at(file, sf, n, 'ページの URL の文字列に seed= がない'));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** 実行のたびに変わる値を作る式か（new Date は引数がないときだけ）。 */
function changingSource(n: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(n)) {
    const t = n.getText();
    if (/^Math\.random$|\.getRandomValues$|^Date\.now$|^performance\.now$|\.hrtime$|\.randomUUID$|\.randomInt$|\.randomBytes$/.test(t)) return t;
  }
  if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Date' && (n.arguments?.length ?? 0) === 0) return 'new Date()';
  if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ['createSeed', 'randomInt', 'randomUUID', 'randomBytes'].includes(n.expression.text)) {
    return `${n.expression.text}()`;
  }
  return undefined;
}

const SEED_NAME = /seed|random|rng/i;
const SEED_SINKS = ['createRandom', 'RecordingInput', 'replayRecording', 'createPractice', 'PracticeSession', 'replayInput'];

/** 式 n の値が、種や乱数の元として使われる所に入るか（祖先を文の手前まで見る）。 */
function feedsSeed(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n.parent; p && !ts.isBlock(p) && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && SEED_NAME.test(p.name.text)) return true;
    if (ts.isPropertyAssignment(p) && SEED_NAME.test(p.name.getText())) return true;
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && SEED_NAME.test(p.left.getText())) return true;
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p !== n) {
      const callee = p.expression.getText().split('.').pop() ?? '';
      if (SEED_SINKS.includes(callee) || SEED_NAME.test(callee)) return true;
    }
  }
  return false;
}

/** 囲む it / test の名前。 */
function testName(n: ts.Node): string | undefined {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && /^(?:it|test)\b/.test(p.expression.getText()) && p.arguments[0] && ts.isStringLiteralLike(p.arguments[0])) return p.arguments[0].text;
  }
  return undefined;
}

/** 練習の種を選ぶ処理そのものを確かめるテスト（選んだ種の範囲と、選ぶたびに変わること）の名前。 */
const SEED_CHOICE_TEST = /種.*(?:0 以上 2³² 未満|選|決める|変わる)/;

/** ARC-51 の調べ: 実行のたびに変わる値から種を作っている箇所。 */
function changingSeeds(file: string, source: string): Finding[] {
  const sf = parse(file, source);
  const out: Finding[] = [];
  const visit = (n: ts.Node) => {
    const src = changingSource(n);
    if (src) {
      const name = testName(n);
      const choice = src === 'createSeed()' && name !== undefined && SEED_CHOICE_TEST.test(name);
      // createSeed は練習の種を選ぶ処理なので、それを確かめるテストの外で呼べば、値の使い道によらず違反とする。
      if (!choice && (src === 'createSeed()' || feedsSeed(n))) out.push(at(file, sf, n, `${src} から種を作っている（テスト: ${name ?? 'なし'}）`));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('ARC-49: ブラウザを使うテストは練習を始めるページを seed を付けて開き、使った種の値をテストのコードに書く', () => {
  it('ブラウザを使うテストのファイルが見つかる（調べ方の前提）', () => {
    expect(browserFiles.length).toBeGreaterThan(10);
    expect(browserFiles).toContain('tests/acceptance/flick-browser-qa.acceptance.test.ts');
    expect(nonBrowserFiles).toContain('tests/input/recording.test.ts');
  });

  it('ブラウザを使うテストのコードに、ページの URL を seed なしで作る箇所や、書いた数でない種がない', () => {
    const found = browserFiles.flatMap((f) => unseededPages(f, read(f)));
    expect(found, found.map((x) => `${x.file}:${x.line} ${x.why}: ${x.text}`).join('\n')).toEqual([]);
  });

  it('ページを開く（goto・Page.navigate）ブラウザのテストのファイルは、どれも種を付けた URL を作る箇所を持つ', () => {
    const missing = browserFiles.filter((f) => {
      const s = read(f);
      if (!/\.goto\(|Page\.navigate/.test(s)) return false;
      return !/\bappUrl\(/.test(s) && !/seed=/.test(s);
    });
    expect(missing).toEqual([]);
  });

  it('種を付けずに開くファイルは、種を付けないときの振る舞いを確かめるものだけ', () => {
    const usesNoSeed = browserFiles.filter((f) => /\bseed:\s*NO_SEED\b/.test(read(f)));
    expect(usesNoSeed.filter((f) => !UNSEEDED_ALLOWED.includes(f))).toEqual([]);
  });

  it.each([
    ["page.goto(appUrl(origin, BASE, '#/', { render: false }));", 'seed がない'],
    ["page.goto(appUrl(origin, BASE, '#/', { seed: Date.now() }));", '時刻'],
    ["page.goto(appUrl(origin, BASE, '#/', { seed: NO_SEED }));", 'NO_SEED'],
    ["const o = { render: false };\npage.goto(appUrl(origin, BASE, '#/', o));", 'const のクエリに seed がない'],
    ['page.goto(`${origin}${BASE}?render=off#/`);', 'テンプレート'],
    ["page.goto('http://127.0.0.1:1/apex-training/#/');", '文字列'],
  ])('調べ方の確認: %s（%s）を見つける', (line) => {
    expect(unseededPages('tests/acceptance/x.acceptance.test.ts', line)).toHaveLength(1);
  });

  it.each([
    "const SEED = 7;\npage.goto(appUrl(origin, BASE, '#/', { render: false, seed: SEED }));",
    "const SEED = 7;\nconst Q = { seed: SEED };\npage.goto(appUrl(origin, BASE, '#/', Q));",
    'page.goto(`${origin}${BASE}?seed=12#/`);',
    'fetch(`${origin}${BASE}assets/x.js`);',
  ])('調べ方の確認: 種を付けた URL とページでない URL は見つけない: %s', (line) => {
    expect(unseededPages('tests/acceptance/x.acceptance.test.ts', line)).toEqual([]);
  });
});

describe('ARC-51: ブラウザを使わないテストは、練習やシミュレーションの乱数の種を実行のたびに変わる値から作らない', () => {
  it('ブラウザを使わないテストのコードに、Math.random・crypto.getRandomValues・時刻・練習の種を選ぶ処理から種を作る箇所がない', () => {
    const found = nonBrowserFiles.flatMap((f) => changingSeeds(f, read(f)));
    expect(found, found.map((x) => `${x.file}:${x.line} ${x.why}: ${x.text}`).join('\n')).toEqual([]);
  });

  it('練習の種を選ぶ処理（createSeed）を呼ぶのは、その処理そのものを確かめるテストだけ', () => {
    const callers = nonBrowserFiles.flatMap((f) => {
      const sf = parse(f, read(f));
      const out: string[] = [];
      const visit = (n: ts.Node) => {
        if (changingSource(n) === 'createSeed()') out.push(`${f} > ${testName(n) ?? '(テストの外)'}`);
        ts.forEachChild(n, visit);
      };
      visit(sf);
      return out;
    });
    for (const c of callers) expect(c).toMatch(SEED_CHOICE_TEST);
  });

  it.each([
    'const r = createRandom(Date.now());',
    'const r = createRandom(Math.floor(Math.random() * 2 ** 32));',
    'const input = new RecordingInput(createSeed());',
    'const seed = crypto.getRandomValues(new Uint32Array(1))[0];',
    'const startSeed = performance.now();',
    'const s = new PracticeSession({ world, mode, input, seed: Date.now() });',
    'const random = createRandom(new Date().getTime());',
    "it('ほか', () => { const x = createSeed(); });",
  ])('調べ方の確認: %s を見つける', (line) => {
    expect(changingSeeds('tests/x.test.ts', line)).toHaveLength(1);
  });

  it.each([
    'const r = createRandom(42);',
    'const started = Date.now();',
    "const NOW = new Date('2026-11-25T05:00:00.000Z');",
    "it('種は 0 以上 2³² 未満の整数にする', () => { const seed = createSeed(); });",
  ])('調べ方の確認: %s は見つけない', (line) => {
    expect(changingSeeds('tests/x.test.ts', line)).toEqual([]);
  });
});
