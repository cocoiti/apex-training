// 受け入れテストの期待値として、docs/spec/weapons.md「簡易版のパターン」の定義どおりに簡易版のパターンを求める。
// 実装（src/sim/）には依存せず、SPEC の文だけから書く（総当たりで、区切りの本数を 1 本から順に増やす）。

export type Deg = [number, number]; // [ヨー, ピッチ]（度）

export interface OracleSegment {
  from: number;
  to: number;
  label: string;
}

export interface OraclePattern {
  vertices: number[];
  /** 頂点の位置（度）。 */
  points: Deg[];
  segments: OracleSegment[];
  /** i 番目は簡易版での i 発目の位置（0 は原点）。 */
  positions: Deg[];
  maxError: number;
}

/** 許容差と区切りの本数の上限（SPEC の値）。 */
export const TOLERANCE = 1.0;
export const MAX_SEGMENTS = 5;

/** 0 発目（原点）と 1〜magSize 発目の理想の補正軌道（1〜i 発目の pattern の合計の反転）。 */
export function idealPoints(w: { magSize: number; pattern: { dx: number; dy: number }[] }): Deg[] {
  const out: Deg[] = [[0, 0]];
  let yaw = 0;
  let pitch = 0;
  for (let k = 0; k < w.magSize; k += 1) {
    yaw -= w.pattern[k]!.dx;
    pitch -= w.pattern[k]!.dy;
    out.push([yaw, pitch]);
  }
  return out;
}

/** a 発目と b 発目の点を結ぶ直線の上で、i 発目を (i − a) : (b − i) に内分した位置。 */
export function along(p: Deg[], a: number, b: number, i: number): Deg {
  const t = (i - a) / (b - a);
  return [p[a]![0] + (p[b]![0] - p[a]![0]) * t, p[a]![1] + (p[b]![1] - p[a]![1]) * t];
}

/** 頂点の列から、簡易版での各発の位置（0〜n 発目）。 */
export function positionsOf(p: Deg[], vertices: number[]): Deg[] {
  const out: Deg[] = [[0, 0]];
  for (let s = 0; s + 1 < vertices.length; s += 1) {
    const a = vertices[s]!;
    const b = vertices[s + 1]!;
    for (let i = a + 1; i <= b; i += 1) out.push(along(p, a, b, i));
  }
  return out;
}

const NAMES = ['右', '右上', '上', '左上', '左', '左下', '下', '右下'];
const ARROWS = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'];

/** 区切りの言葉（「<a+1>〜<b> 発: <矢印> <向き>」）。 */
export function labelOf(p: Deg[], a: number, b: number): string {
  const dx = p[b]![0] - p[a]![0];
  const dy = p[b]![1] - p[a]![1];
  let dir: string;
  if (Math.hypot(dx, dy) < 0.1) dir = '・ 動かさない';
  else {
    const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const k = ((Math.round(deg / 45) % 8) + 8) % 8;
    dir = `${ARROWS[k]} ${NAMES[k]}`;
  }
  const range = a + 1 === b ? `${b}` : `${a + 1}〜${b}`;
  return `${range} 発: ${dir}`;
}

/** SPEC の折れ線の選び方で簡易版のパターンを求める。 */
export function oracleSimplePattern(w: { magSize: number; pattern: { dx: number; dy: number }[] }): OraclePattern {
  const p = idealPoints(w);
  const n = w.magSize;
  // cost[a][b]: a〜b 発目の区切りが受け持つ発（a+1〜b）の差の最大。
  const cost: number[][] = [];
  for (let a = 0; a < n; a += 1) {
    cost[a] = [];
    for (let b = a + 1; b <= n; b += 1) {
      let m = 0;
      for (let i = a + 1; i <= b; i += 1) {
        const q = along(p, a, b, i);
        m = Math.max(m, Math.hypot(q[0] - p[i]![0], q[1] - p[i]![1]));
      }
      cost[a]![b] = m;
    }
  }
  let overall: { vertices: number[]; err: number } | undefined;
  for (let k = 1; k <= MAX_SEGMENTS; k += 1) {
    if (k - 1 > n - 1) break;
    let best: { vertices: number[]; err: number } | undefined;
    // 間の頂点 k-1 個を 1〜n-1 から発の番号の順に、辞書順で並べて調べる（同じ差なら先に見つけたものが残る）。
    const inner: number[] = [];
    const walk = (start: number, left: number) => {
      if (left === 0) {
        const v = [0, ...inner, n];
        let e = 0;
        for (let s = 0; s + 1 < v.length; s += 1) e = Math.max(e, cost[v[s]!]![v[s + 1]!]!);
        if (!best || e < best.err) best = { vertices: v, err: e };
        return;
      }
      for (let x = start; x <= n - left; x += 1) {
        inner.push(x);
        walk(x + 1, left - 1);
        inner.pop();
      }
    };
    walk(1, k - 1);
    if (!best) continue;
    const b = best as { vertices: number[]; err: number };
    if (!overall || b.err < overall.err) overall = b;
    if (b.err <= TOLERANCE) {
      overall = b;
      break;
    }
  }
  const vertices = overall!.vertices;
  const segments: OracleSegment[] = [];
  for (let s = 0; s + 1 < vertices.length; s += 1) {
    segments.push({ from: vertices[s]!, to: vertices[s + 1]!, label: labelOf(p, vertices[s]!, vertices[s + 1]!) });
  }
  return { vertices, points: vertices.map((v) => p[v]!), segments, positions: positionsOf(p, vertices), maxError: overall!.err };
}
