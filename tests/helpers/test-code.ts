// テストのコードを調べ、決まったポート番号での待ち受け（ARC-18）と、ブラウザを使うテストの固定の時間の sleep（ARC-22）を探す
// （docs/spec/architecture.md「テストの実行」）。コードの文字列（ページで評価するスクリプトも含む）を行ごとに見る。
// コメントと it.each などの見本の表（.each(...) の引数）は調べない。そこに書いた番号や sleep の書き方は、待ち受けや待ちではない。
import ts from 'typescript';

export interface TestCodeViolation {
  file: string;
  /** 1 始まりの行番号。 */
  line: number;
  reason: string;
  text: string;
}

/** 0 以外のポート番号（1〜5 桁で、0 から始まらない数）。 */
const PORT = String.raw`[1-9]\d{0,4}\b`;

/** サーバーの待ち受けやブラウザの遠隔操作に、決まったポート番号を渡している書き方。 */
const FIXED_PORT_PATTERNS: [RegExp, string][] = [
  [new RegExp(String.raw`\.listen\(\s*${PORT}`), 'listen に決まったポート番号を渡している'],
  [new RegExp(String.raw`\bport\s*:\s*${PORT}`, 'i'), 'port に決まった番号を指定している'],
  [new RegExp(String.raw`\b[A-Z_]*PORT\s*=\s*${PORT}`), 'ポート番号の定数に決まった番号を入れている'],
  [new RegExp(String.raw`remote-debugging-port[=\s]+${PORT}`), 'DevTools のポートに決まった番号を指定している'],
  [new RegExp(String.raw`--port[=\s]+${PORT}`), '--port に決まった番号を指定している'],
  [new RegExp(String.raw`launchBrowser\([^)]*,\s*${PORT}`), 'launchBrowser に決まったポート番号を渡している'],
  [new RegExp(String.raw`serveStatic\([^)]*,[^)]*,\s*${PORT}`), 'serveStatic に決まったポート番号を渡している'],
  [new RegExp(String.raw`(?:localhost|127\.0\.0\.1|0\.0\.0\.0):${PORT}`), 'URL に決まったポート番号を書いている'],
];

/** 決まった時間だけ待つ sleep の書き方。 */
const FIXED_SLEEP_PATTERNS: [RegExp, string][] = [
  // new Promise((r) => setTimeout(r, 300)) のように、Promise の resolve をそのまま setTimeout に渡すもの。
  [/setTimeout\(\s*[A-Za-z_$][\w$]*\s*,/, 'resolve を setTimeout に渡して決まった時間だけ待っている'],
  // setTimeout(() => resolve(), 300) のように、resolve を呼ぶだけのもの。
  [/setTimeout\(\s*\(\s*\)\s*=>\s*[A-Za-z_$][\w$]*\(\s*\)\s*,/, 'resolve を呼ぶだけの setTimeout で決まった時間だけ待っている'],
  // pause(300) / sleep(300) / delay(300) のような、時間だけを待つ関数（loop.pause() のようなメソッドは除く）。
  [/(?<![.\w$])(?:pause|sleep|delay|wait)\s*\(\s*[^)\s]/, '時間だけを待つ関数を呼んでいる'],
  [/['"](?:node:)?timers\/promises['"]/, 'timers/promises（決まった時間を待つ setTimeout）を使っている'],
];

/**
 * source のコメントと .each(...) の引数を空白に置き換えたもの（改行は残すので行番号は変わらない）。
 * 調べ方の見本や説明に書いた書き方を、実際のコードと取り違えないようにする。
 * strings なら、文字列とテンプレートの中身も空白にする（調べ方の見本を文字列で持つテストを、実際の呼び出しと取り違えない）。
 */
export function codeOnly(source: string, { strings = false }: { strings?: boolean } = {}): string {
  const ranges: [number, number][] = [];
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node) => {
    if (strings && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))) {
      ranges.push([node.getStart(sf) + 1, node.getEnd() - 1]);
      return;
    }
    for (const r of [...(ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []), ...(ts.getTrailingCommentRanges(source, node.getEnd()) ?? [])]) {
      ranges.push([r.pos, r.end]);
    }
    if (ts.isCallExpression(node)) {
      const e = node.expression;
      if (ts.isPropertyAccessExpression(e) && e.name.text === 'each' && node.arguments.length > 0) {
        ranges.push([node.arguments.pos, node.arguments.end]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const chars = source.split('');
  for (const [from, to] of ranges) {
    for (let i = from; i < to; i += 1) if (chars[i] !== '\n') chars[i] = ' ';
  }
  return chars.join('');
}

function scan(file: string, source: string, patterns: [RegExp, string][]): TestCodeViolation[] {
  const out: TestCodeViolation[] = [];
  const original = source.split('\n');
  codeOnly(source).split('\n').forEach((text, i) => {
    for (const [pattern, reason] of patterns) {
      if (pattern.test(text)) out.push({ file, line: i + 1, reason, text: (original[i] ?? text).trim() });
    }
  });
  return out;
}

/** ARC-18: サーバーの待ち受けやブラウザの遠隔操作に、決まったポート番号（0 以外の数）を渡している箇所。 */
export function findFixedPorts(file: string, source: string): TestCodeViolation[] {
  return scan(file, source, FIXED_PORT_PATTERNS);
}

/** ARC-22: 固定の時間だけ待つ sleep（決まった ms の setTimeout を待つだけの処理）の箇所。 */
export function findFixedSleeps(file: string, source: string): TestCodeViolation[] {
  return scan(file, source, FIXED_SLEEP_PATTERNS);
}

/**
 * 練習の入力（照準のスティック・fire / ADS のボタン・マウスのボタン）を倒す・押す書き方。照準の移動量や撃つ弾の数が、
 * 戻す・離すまでの長さで変わる入力だけを見る（A / B などの画面の操作のボタンや、キーボードのキーは押し始めだけが操作になる）。
 * 標準配置の右スティックは軸 2・3、R2 はボタン 7、L2 はボタン 6。
 */
const HOLD_PATTERNS: RegExp[] = [
  /(?<![\w$])(?:__)?btn\(\s*(?:\w+\s*,\s*)?(?:\$\{\s*)?(?:R2|L2|7|6)(?:\s*\})?\s*,\s*(?:true|1)\s*\)/,
  /__button\(\s*(?:\d+\s*,\s*)?(?:7|6)\s*,(?!\s*0\s*\))\s*[^)\s][^)]*\)/,
  /__setR2\((?!\s*0\s*\))\s*[^)\s][^)]*\)/,
  /__fire\(\s*true\s*\)/,
  /axes\[\s*[23]\s*\]\s*=\s*(?:-?(?:0*[1-9][\d.]*|0?\.\d*[1-9]\d*)|\$\{)/,
  /__axis\(\s*(?:\d+\s*,\s*)?[23]\s*,(?!\s*0\s*\))\s*[^)\s][^)]*\)/,
  /__look\(\s*(?!0\s*,\s*0\s*\))(?:-?[\d.]+|\$\{)[^)]*\)/,
  /mouseButton\([^)]*'mousePressed'(?!\s*\|)|\bbutton\(\s*'mousePressed'\s*\)|type:\s*'mousePressed'(?!\s*\|)/,
];

/** 倒した入力を戻す・押した入力を離す書き方。 */
const RELEASE_PATTERNS: RegExp[] = [
  /(?<![\w$])(?:__)?btn\(\s*(?:\w+\s*,\s*)?(?:\$\{\s*)?(?:R2|L2|7|6)(?:\s*\})?\s*,\s*(?:false|0)\s*\)/,
  /__button\(\s*(?:\d+\s*,\s*)?(?:7|6)\s*,\s*0\s*\)/,
  /__setR2\(\s*0\s*\)/,
  /__fire\(\s*false\s*\)/,
  /axes\[\s*[23]\s*\]\s*=\s*0\b(?!\.\d*[1-9])/,
  /__axis\(\s*(?:\d+\s*,\s*)?[23]\s*,\s*0\s*\)/,
  /__look\(\s*0\s*,\s*0\s*\)/,
  /__releaseAll\(/,
  /mouseButton\([^)]*'mouseReleased'|\bbutton\(\s*'mouseReleased'\s*\)|type:\s*'mouseReleased'/,
];

/** ページの時計を決まった秒数だけ進める書き方（clock=manual）。 */
const CLOCK_ADVANCE = /\badvanceClock(?:Until)?\(|__apexTestClock\.advance\(|__clock\.step\(/;
/** ページに clock=manual の時計があるかで振る舞いを変える書き方。 */
const DEPENDS_ON_CLOCK = /!!\s*window\.__apexTestClock|window\.__apexTestClock\s*\?/;
/** 時間がたつのを待つ書き方（描画を待つ・条件が真になるまで待つ）。時計を進めずにこれで待つと、実時間で長さが決まる。 */
const WAIT = /\.frames\(|\bwaitFor\(|\bwaitUntil\(|\bstableScreenshot\(|__frame\(|__nextFrame\(|requestAnimationFrame/;
/** 実時間の時刻やタイマー。時計を進めずにこれで待つと、長さが実時間で決まる。 */
const REAL_TIME = /performance\.now\(\)|Date\.now\(\)|setTimeout\(/;

/**
 * ファイルの中で定義した関数（function 宣言と、関数を入れた const・let）のうち、本体が pattern に当たるものの名前。
 * 本体から呼ぶ関数も辿る（決まるまで繰り返す）。
 */
function helpersMatching(source: string, pattern: RegExp, exclude?: RegExp): Set<string> {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bodies = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) bodies.set(node.name.text, node.body.getText(sf));
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) bodies.set(node.name.text, init.body.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const names = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, body] of bodies) {
      if (names.has(name)) continue;
      const calls = [...names].some((n) => new RegExp(String.raw`(?<![\w$.])${n}\(`).test(body));
      const code = codeOnly(body);
      if ((pattern.test(code) || calls) && !(exclude && exclude.test(code))) {
        names.add(name);
        changed = true;
      }
    }
  }
  return names;
}

/**
 * ファイルの中で定義した、ページのスクリプトを組み立てて呼ぶ関数（`const axis = (page, pad, a, v) => page.evaluate(\`window.__axis(${pad}, ${a}, ${v})\`)` など）の呼び出しのうち、
 * 呼び出しに書いた引数を本体のテンプレートの `${引数の名前}` に入れると倒す・押す書き方か、戻す・離す書き方になるもの。
 * 本体だけで倒す・押す書き方や戻す・離す書き方になる関数は、本体の行で見るので除く。倒すと戻すの両方になる呼び出し（押してすぐ離す関数）も除く。
 * 返すのは、行（0 始まり）ごとの、行の中の位置と種類。
 */
function wrapperEvents(source: string, code: string): Map<number, { at: number; kind: 'hold' | 'release' }[]> {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const any = (patterns: RegExp[], text: string) => patterns.some((re) => re.test(text));
  const wrappers = new Map<string, { params: ({ name: string; init: string | undefined } | undefined)[]; body: string }>();
  const addWrapper = (name: string, fn: ts.SignatureDeclaration & { body?: ts.Node }) => {
    if (!fn.body) return;
    const body = codeOnly(fn.body.getText(sf));
    if (!/\$\{/.test(body) || any(HOLD_PATTERNS, body) || any(RELEASE_PATTERNS, body)) return;
    const params = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? { name: p.name.text, init: p.initializer?.getText(sf) } : undefined));
    wrappers.set(name, { params, body });
  };
  const collect = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) addWrapper(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) addWrapper(node.name.text, init);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const out = new Map<number, { at: number; kind: 'hold' | 'release' }[]>();
  if (wrappers.size === 0) return out;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const w = wrappers.get(node.expression.text);
      const start = node.getStart(sf);
      // .each(...) の見本の表の中の呼び出しは見ない（codeOnly で空白になっている）。
      if (w && code[start] === source[start]) {
        let expanded = w.body;
        w.params.forEach((p, i) => {
          const value = node.arguments[i]?.getText(sf) ?? p?.init;
          if (!p || value === undefined) return;
          expanded = expanded.replace(new RegExp(String.raw`\$\{\s*${p.name}\s*\}`, 'g'), value);
        });
        const hold = any(HOLD_PATTERNS, expanded);
        const release = any(RELEASE_PATTERNS, expanded);
        if (hold !== release) {
          const { line, character } = sf.getLineAndCharacterOfPosition(start);
          out.set(line, [...(out.get(line) ?? []), { at: character, kind: hold ? 'hold' : 'release' }]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const callOf = (names: Set<string>): RegExp | undefined =>
  names.size === 0 ? undefined : new RegExp(String.raw`(?<![\w$.])(?:${[...names].join('|')})\(`);

/**
 * ARC-68: 練習の入力（スティック・fire / ADS のボタン・マウスのボタン）を倒している・押している長さを、実時間や描画の回数で決めている箇所。
 * 倒す・押す書き方から、戻す・離す書き方までを 1 つの「押している間」とし、その間にページの時計を進めず
 * （advanceClock・advanceClockUntil がなく）に、実時間の時刻やタイマー（performance.now()・Date.now()・setTimeout）で待つか、
 * 描画や条件を待っているものを、倒す・押す行で示す。
 * 時計を進めている押している間は clock=manual のページなので、間に実時間で待っても長さは進めた秒数だけで決まり、示さない。
 * ファイルの中で定義した関数は、本体に当たる書き方があればその書き方と見なす（clock=manual かどうかで待ち方を変える関数は、
 * 時計を進める関数と見なさない）。ページのスクリプトをテンプレートで組み立てる関数（`axis(page, 1, 2, 0.5)` など）は、
 * 呼び出しに書いた引数を本体に入れた書き方で、倒す・押すか戻す・離すかを決める。
 * コードの文字列（ページで評価するスクリプト）も行ごとに見る。コメントと .each(...) の見本の表は見ない。
 */
export function findRealTimeHolds(file: string, source: string): TestCodeViolation[] {
  const original = source.split('\n');
  const code = codeOnly(source);
  const lines = code.split('\n');
  const wrapped = wrapperEvents(source, code);
  // ファイルの中の関数を呼んでいるところは、その本体の書き方と見なす。
  const advanceHelper = callOf(helpersMatching(source, CLOCK_ADVANCE, DEPENDS_ON_CLOCK));
  const realTimeHelper = callOf(helpersMatching(source, REAL_TIME));
  const waitHelper = callOf(helpersMatching(source, WAIT));
  const test = (re: RegExp | undefined, text: string) => !!re && re.test(text);
  const out: TestCodeViolation[] = [];
  let hold: { line: number; advanced: boolean; waited: boolean; realTime: boolean } | undefined;
  const close = () => {
    if (!hold) return;
    // 時計を進めていれば clock=manual のページなので、押している間に実時間で待っても長さは変わらない（ARC-67 の確かめ方）。
    const reason = hold.advanced
      ? undefined
      : hold.realTime
        ? '押している間の長さを実時間（performance.now・Date.now・setTimeout）で決めている'
        : hold.waited
          ? '押している間に、ページの時計を進めずに描画や条件を待っている（長さが実時間や描画の回数で決まる）'
          : undefined;
    if (reason) out.push({ file, line: hold.line, reason, text: (original[hold.line - 1] ?? '').trim() });
    hold = undefined;
  };
  lines.forEach((text, i) => {
    // 同じ行に押す・離すが並ぶときは、書いた順に見る。
    const events: { at: number; kind: 'hold' | 'release' }[] = [];
    for (const re of HOLD_PATTERNS) {
      const g = new RegExp(re.source, 'g');
      for (let m = g.exec(text); m; m = g.exec(text)) events.push({ at: m.index, kind: 'hold' });
    }
    for (const re of RELEASE_PATTERNS) {
      const g = new RegExp(re.source, 'g');
      for (let m = g.exec(text); m; m = g.exec(text)) events.push({ at: m.index, kind: 'release' });
    }
    events.push(...(wrapped.get(i) ?? []));
    events.sort((a, b) => a.at - b.at);
    let from = 0;
    const scanSpan = (span: string) => {
      if (!hold) return;
      if (CLOCK_ADVANCE.test(span) || test(advanceHelper, span)) hold.advanced = true;
      if (WAIT.test(span) || test(waitHelper, span)) hold.waited = true;
      if (REAL_TIME.test(span) || test(realTimeHelper, span)) hold.realTime = true;
    };
    for (const e of events) {
      scanSpan(text.slice(from, e.at));
      from = e.at;
      if (e.kind === 'hold') {
        if (!hold) hold = { line: i + 1, advanced: false, waited: false, realTime: false };
      } else {
        close();
      }
    }
    scanSpan(text.slice(from));
  });
  close();
  return out;
}
