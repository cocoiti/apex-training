// docs/spec/architecture.md「テストのための描画の省略と時計の差し替え」の ARC-64 を、テストのコードを調べて確かめる
// QA の受け入れテスト。QA が SPEC だけから書いたもの。tests/ 以下の TypeScript を構文木で読み、実装やほかの調べる道具
// （tests/helpers/test-code.ts など）には依存しない。
// ブラウザを使うテストのファイルは、tests/helpers/browser.ts を import するファイル（CLAUDE.md）。
//
// 調べ方: 文の並び（関数の本体・ブロック）ごとに、練習の入力（fire / ADS のボタン、右スティック、マウスのボタン）を
// 倒す・押す文から、戻す・離す文（なければ並びの終わり）までを「押している間」とする。押している間に時計を進める
// （advanceClock・advanceClockUntil）文がなく、実時間や描画の回数で待つ文（決まった ms のタイマー、performance.now()・
// Date.now() の時刻、requestAnimationFrame、Page.frames・Page.waitFor・waitUntil など）があれば、押している長さを
// 実時間や描画の回数で決めている箇所とする。
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

function importsBrowser(sf: ts.SourceFile): boolean {
  return sf.statements.some(
    (s) => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && /(?:^|\/)helpers\/browser(?:\.ts)?$/.test(s.moduleSpecifier.text),
  );
}

const NUM = String.raw`-?\d*\.?\d+`;
const NONZERO = String.raw`-?(?:0*[1-9]\d*(?:\.\d+)?|0*\.\d*[1-9]\d*|\d+\.\d*[1-9]\d*)`;
/** 練習の入力を倒す・押す。 */
const PRESS: RegExp[] = [
  /['"`]mousePressed['"`]/, // マウスのボタン（DevTools の Input.dispatchMouseEvent）
  /__fire\(\s*(?:true|1)\s*\)/,
  /__ads\(\s*(?:true|1)\s*\)/,
  /__(?:btn|button)\(\s*(?:\$\{\s*)?(?:6|7|R2|L2|FIRE|ADS)\s*\}?\s*,\s*(?:true|1|0?\.\d*[1-9]\d*)\s*\)/,
  /__(?:btn|button)\(\s*\d+\s*,\s*(?:6|7)\s*,\s*(?:true|1|0?\.\d*[1-9]\d*)\s*\)/, // (pad, button, value)
  new RegExp(String.raw`__look\(\s*(?:${NONZERO}\s*,\s*${NUM}|${NUM}\s*,\s*${NONZERO})\s*\)`),
  new RegExp(String.raw`__(?:axis|stick)\(\s*(?:\d+\s*,\s*)?[23]\s*,\s*${NONZERO}\s*\)`),
  /buttons\[\s*[67]\s*\]\s*=\s*\{[^}]*pressed:\s*true/,
  new RegExp(String.raw`axes\[\s*[23]\s*\]\s*=\s*${NONZERO}\b`),
];
/** 練習の入力を戻す・離す。 */
const RELEASE: RegExp[] = [
  /['"`]mouseReleased['"`]/,
  /__fire\(\s*(?:false|0)\s*\)/,
  /__ads\(\s*(?:false|0)\s*\)/,
  /__(?:btn|button)\(\s*(?:\$\{\s*)?(?:6|7|R2|L2|FIRE|ADS)\s*\}?\s*,\s*(?:false|0)\s*\)/,
  /__(?:btn|button)\(\s*\d+\s*,\s*(?:6|7)\s*,\s*(?:false|0)\s*\)/,
  /__look\(\s*0\s*,\s*0\s*\)/,
  /__(?:axis|stick)\(\s*(?:\d+\s*,\s*)?[23]\s*,\s*0\s*\)/,
  /__releaseAll\(/,
  /buttons\[\s*[67]\s*\]\s*=\s*\{[^}]*pressed:\s*false/,
  /axes\[\s*[23]\s*\]\s*=\s*0\b/,
];
/** 時計を進める（clock=manual）。 */
const CLOCK = /\badvanceClock(?:Until)?\s*\(/;
/** 実時間や描画の回数で待つ。 */
const REAL_TIME: [RegExp, string][] = [
  [/\bsetTimeout\s*\(/, '決まった ms のタイマー（setTimeout）'],
  [/\bsetInterval\s*\(/, '決まった ms のタイマー（setInterval）'],
  [/timers\/promises/, '決まった ms のタイマー（timers/promises）'],
  [/\b(?:sleep|delay|pause|waitForTimeout)\s*\(/, '決まった時間の sleep'],
  [/performance\.now\s*\(/, 'performance.now() の時刻'],
  [/Date\.now\s*\(/, 'Date.now() の時刻'],
  [/requestAnimationFrame\s*\(/, '描画の回数（requestAnimationFrame）'],
  [/\.frames\s*\(/, '描画の回数（Page.frames）'],
  [/\.waitFor\s*\(/, '実時間で条件を待つ（Page.waitFor）'],
  [/\bwaitUntil\s*\(/, '実時間で条件を待つ（waitUntil）'],
];

/** コメントを空白に置き換えた文字（位置は変えない）。 */
function blankComments(sf: ts.SourceFile): string {
  const chars = sf.text.split('');
  const seen = new Set<number>();
  const blank = (ranges: readonly ts.CommentRange[] | undefined) => {
    for (const r of ranges ?? []) {
      if (seen.has(r.pos)) continue;
      seen.add(r.pos);
      for (let i = r.pos; i < r.end; i += 1) if (chars[i] !== '\n') chars[i] = ' ';
    }
  };
  const visit = (n: ts.Node) => {
    blank(ts.getLeadingCommentRanges(sf.text, n.pos));
    blank(ts.getTrailingCommentRanges(sf.text, n.end));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return chars.join('');
}

/** 文の並び（関数の本体・ブロック、式の本体のアロー関数）の範囲。 */
function sequences(sf: ts.SourceFile): [number, number][] {
  const out: [number, number][] = [];
  const visit = (n: ts.Node) => {
    const statements = ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n) ? n.statements : undefined;
    if (statements && statements.length > 0) out.push([statements[0]!.getStart(sf), statements[statements.length - 1]!.end]);
    if (ts.isArrowFunction(n) && !ts.isBlock(n.body)) out.push([n.body.getStart(sf), n.body.end]);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const matches = (text: string, patterns: RegExp[], from: number, to: number): number[] => {
  const out: number[] = [];
  for (const p of patterns) {
    const m = new RegExp(p.source, 'g');
    m.lastIndex = from;
    for (let r = m.exec(text); r && r.index < to; r = m.exec(text)) out.push(r.index);
  }
  return [...new Set(out)].sort((a, b) => a - b);
};

interface Hold {
  line: number;
  /** 押している間に時計を進めたか。 */
  clock: boolean;
  /** 押している間の実時間・描画の回数の待ち。 */
  realTime: string[];
}

/** source の中の、練習の入力を押している間（押した所を含む最も内側の文の並びの中で、次に離すまで。離さなければ並びの終わりまで）。 */
export function holds(file: string, source: string): Hold[] {
  const sf = parse(file, source);
  const text = blankComments(sf);
  const seqs = sequences(sf);
  const out: Hold[] = [];
  for (const press of matches(text, PRESS, 0, text.length)) {
    const inner = seqs.filter(([a, b]) => a <= press && press < b).sort((x, y) => x[1] - x[0] - (y[1] - y[0]))[0];
    if (!inner) continue;
    const release = matches(text, RELEASE, press + 1, inner[1])[0];
    const span = text.slice(press, release ?? inner[1]);
    out.push({
      line: sf.getLineAndCharacterOfPosition(press).line + 1,
      clock: CLOCK.test(span),
      realTime: REAL_TIME.filter(([re]) => re.test(span)).map(([, why]) => why),
    });
  }
  return out;
}

/** 押している長さを実時間や描画の回数で決めている箇所。 */
export function realTimeHolds(file: string, source: string): { file: string; line: number; why: string[] }[] {
  return holds(file, source)
    .filter((h) => !h.clock && h.realTime.length > 0)
    .map((h) => ({ file, line: h.line, why: h.realTime }));
}

const ALL = listTs(TESTS);
const browserFiles = ALL.filter((f) => f.endsWith('.test.ts') && importsBrowser(parse(f, read(f))));

describe('ARC-64（QA）: ブラウザを使うテストは、スティックを倒している長さやボタンを押している長さを実時間や描画の回数で決めない', () => {
  it('調べる道具が、実時間・描画の回数で決めた押す長さを見つけ、時計を進めて決めた長さは見つけない（調べ方の確かめ）', () => {
    const bad: [string, string][] = [
      ['決まった ms のタイマー', `async function f(page) { await page.evaluate('window.__fire(true)'); await new Promise((r) => setTimeout(r, 500)); await page.evaluate('window.__fire(false)'); }`],
      ['performance.now() の時刻', 'async function f(page) { await page.evaluate("window.__look(0.4, 0)"); const t = await page.evaluate("performance.now()"); await page.waitFor(`performance.now() > ${t + 250}`); await page.evaluate("window.__look(0, 0)"); }'],
      ['描画の回数', `async function f(page) { await page.evaluate('window.__btn(7, true)'); await page.frames(30); await page.evaluate('window.__btn(7, false)'); }`],
      ['マウスのボタン', `async function f(page) { await page.send('Input.dispatchMouseEvent', { type: 'mousePressed' }); await page.frames(10); await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased' }); }`],
      ['ページの中で待つ', "async function f(page) { await page.evaluate(`window.__fire(true); new Promise((r) => setTimeout(() => { window.__fire(false); r(); }, 300))`); }"],
      ['スティックの軸', `async function f(page) { await page.evaluate('window.__axis(0, 2, 0.8)'); await page.frames(20); await page.evaluate('window.__axis(0, 2, 0)'); }`],
    ];
    for (const [why, code] of bad) expect(realTimeHolds('bad.test.ts', code), why).toHaveLength(1);

    const good: [string, string][] = [
      ['時計を秒数で進める', `async function f(page) { await page.evaluate('window.__fire(true)'); await page.advanceClock(0.25); await page.evaluate('window.__fire(false)'); }`],
      ['時計を条件まで進める', `async function f(page) { await page.evaluate('window.__btn(7, true)'); await page.advanceClockUntil('window.__ammo() === 0'); await page.frames(2); await page.evaluate('window.__btn(7, false)'); }`],
      ['待ちのないクリック', `async function f(page) { await page.send('Input.dispatchMouseEvent', { type: 'mousePressed' }); await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased' }); await page.frames(2); }`],
      ['メニューの A ボタン', `async function f(page) { await page.evaluate('window.__btn(0, true)'); await page.frames(2); await page.evaluate('window.__btn(0, false)'); }`],
      ['離したあとの待ち', `async function f(page) { await page.evaluate('window.__fire(false)'); await page.frames(5); }`],
      ['コメントの中の語', `async function f(page) { await page.evaluate('window.__fire(true)'); // performance.now() で待たない\n await page.advanceClock(1); await page.evaluate('window.__fire(false)'); }`],
    ];
    for (const [why, code] of good) expect(realTimeHolds('good.test.ts', code), why).toEqual([]);
  });

  it('ブラウザを使うテストのファイルを調べ、押している間を十分な数だけ見つける（調べた対象が空でない）', () => {
    expect(browserFiles.length).toBeGreaterThan(20);
    const found = browserFiles.flatMap((f) => holds(f, read(f)).map((h) => ({ f, ...h })));
    // 撃つ・スティックを倒す・マウスのボタンを押すテストは多くのファイルにある。
    expect(found.length).toBeGreaterThan(30);
    expect(new Set(found.map((h) => h.f)).size).toBeGreaterThan(10);
    // 押している間に時計を進めている箇所も見つかる。
    expect(found.filter((h) => h.clock).length).toBeGreaterThan(10);
  });

  it('ブラウザを使うテストのコードに、押している長さを実時間（決まった ms のタイマー、performance.now() の時刻まで待つ処理）や描画の回数で決めている箇所がない', () => {
    const found = browserFiles.flatMap((f) => realTimeHolds(f, read(f)));
    expect(found.map((v) => `${v.file}:${v.line} ${v.why.join('・')}`)).toEqual([]);
  });
});
