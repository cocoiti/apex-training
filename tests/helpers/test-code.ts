// テストのコードを調べ、決まったポート番号での待ち受け（ARC-18）と、ブラウザを使うテストの固定の時間の sleep（ARC-22）を探す
// （docs/spec/architecture.md「テストの実行」）。コードの文字列（ページで評価するスクリプトも含む）を行ごとに見る。

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

function scan(file: string, source: string, patterns: [RegExp, string][]): TestCodeViolation[] {
  const out: TestCodeViolation[] = [];
  source.split('\n').forEach((text, i) => {
    for (const [pattern, reason] of patterns) {
      if (pattern.test(text)) out.push({ file, line: i + 1, reason, text: text.trim() });
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
