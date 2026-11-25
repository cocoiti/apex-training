import type { Angles } from './angles';
import { idealCorrection, type WeaponData } from './weapon';

/**
 * 簡易版のパターン（docs/spec/weapons.md「簡易版のパターン」）。理想の補正軌道を 5 本以下の直線を結んだ折れ線で近似する。
 * 武器データの magSize と pattern だけから求め、乱数・入力・設定に依存しない。覚えるための表示（補正のパネル）だけに使う。
 */

/** 許容差（度）。どの発も簡易版での位置と理想の補正軌道との差をこれ以下にしたい。 */
export const SIMPLE_PATTERN_TOLERANCE = 1.0;
/** 区切りの本数の上限。 */
export const SIMPLE_PATTERN_MAX_SEGMENTS = 5;
/** 区切りの長さがこれより短いと「動かさない」にする（度）。 */
const STILL_LENGTH = 0.1;

/** 8 方位。右を 0 として反時計回りに 45 度ずつ。 */
const DIRECTIONS = [
  { arrow: '→', name: '右' },
  { arrow: '↗', name: '右上' },
  { arrow: '↑', name: '上' },
  { arrow: '↖', name: '左上' },
  { arrow: '←', name: '左' },
  { arrow: '↙', name: '左下' },
  { arrow: '↓', name: '下' },
  { arrow: '↘', name: '右下' },
] as const;

/** 簡易版の折れ線の 1 本の直線。from 発目〜to 発目の頂点を結び、from+1〜to 発目を受け持つ。 */
export interface SimpleSegment {
  /** 始点の頂点の発（0 は原点）。 */
  readonly from: number;
  /** 終点の頂点の発。 */
  readonly to: number;
  /** 照準を動かす向きの矢印（↑ ↗ → ↘ ↓ ↙ ← ↖、動かさないときは・）。 */
  readonly arrow: string;
  /** 向きの名前（上・右上・…、動かさないときは「動かさない」）。 */
  readonly direction: string;
  /** 区切りの言葉（例:「1〜8 発: ↓ 下」）。 */
  readonly label: string;
}

export interface SimplePattern {
  /** 頂点の発の番号。先頭は 0、末尾は magSize。 */
  readonly vertices: readonly number[];
  /** 頂点の位置（原点と各頂点の発の理想の補正軌道）。vertices と同じ順。 */
  readonly points: readonly Angles[];
  readonly segments: readonly SimpleSegment[];
  /** i 番目は簡易版での i 発目の位置（0 は原点）。要素数は magSize + 1。 */
  readonly positions: readonly Angles[];
  /** 1〜magSize 発目の簡易版での位置と理想の補正軌道との差の最大（度）。 */
  readonly maxError: number;
}

/** a 発目と b 発目の点を結ぶ直線の上で、i 発目の位置（(i − a) : (b − i) に内分した位置）。 */
function along(points: readonly Angles[], a: number, b: number, i: number): Angles {
  const p = points[a] as Angles;
  const q = points[b] as Angles;
  const t = (i - a) / (b - a);
  return { yaw: p.yaw + (q.yaw - p.yaw) * t, pitch: p.pitch + (q.pitch - p.pitch) * t };
}

/** a 発目〜b 発目の区切りが受け持つ発（a+1〜b）の差の最大。 */
function segmentError(points: readonly Angles[], a: number, b: number): number {
  let max = 0;
  for (let i = a + 1; i <= b; i++) {
    const s = along(points, a, b, i);
    const p = points[i] as Angles;
    max = Math.max(max, Math.hypot(s.yaw - p.yaw, s.pitch - p.pitch));
  }
  return max;
}

/** 区切りの向き。右を 0 度として反時計回りに測った角度を 45 度で割って四捨五入した方位。 */
function heading(from: Angles, to: Angles): { arrow: string; direction: string } {
  const dyaw = to.yaw - from.yaw;
  const dpitch = to.pitch - from.pitch;
  if (Math.hypot(dyaw, dpitch) < STILL_LENGTH) return { arrow: '・', direction: '動かさない' };
  const sector = Math.round((Math.atan2(dpitch, dyaw) * 180) / Math.PI / 45);
  const d = DIRECTIONS[((sector % 8) + 8) % 8] as (typeof DIRECTIONS)[number];
  return { arrow: d.arrow, direction: d.name };
}

/**
 * 頂点の選び方。区切りの本数 k ごとに、最大の差が最も小さい折れ線（同じなら頂点の発の番号を前から比べて小さいもの）を求め、
 * 許容差以下になった最初の k を使う。上限の本数でも収まらなければ、最大の差が最も小さい（同じなら本数の少ない）ものを使う。
 * rest[k][a] は a 発目から magSize 発目までを k 本で結ぶときの最大の差の最小で、後ろから求め、頂点は前から小さい順に選ぶ。
 */
function chooseVertices(points: readonly Angles[], n: number): { vertices: number[]; maxError: number } {
  const error: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  for (let a = 0; a < n; a++) for (let b = a + 1; b <= n; b++) (error[a] as number[])[b] = segmentError(points, a, b);
  const at = (table: number[][], i: number, j: number) => (table[i] as number[])[j] as number;

  const maxK = Math.min(SIMPLE_PATTERN_MAX_SEGMENTS, n);
  // rest[k][a]: a 発目から n 発目までをちょうど k 本で結ぶときの最大の差の最小。結べないときは Infinity。
  const rest: number[][] = [new Array<number>(n + 1).fill(Infinity)];
  (rest[0] as number[])[n] = 0;
  for (let k = 1; k <= maxK; k++) {
    const row = new Array<number>(n + 1).fill(Infinity);
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b <= n; b++) row[a] = Math.min(row[a] as number, Math.max(at(error, a, b), at(rest, k - 1, b)));
    }
    rest.push(row);
  }

  let bestK = 1;
  for (let k = 1; k <= maxK; k++) {
    const value = at(rest, k, 0);
    if (value <= SIMPLE_PATTERN_TOLERANCE) {
      bestK = k;
      break;
    }
    if (value < at(rest, bestK, 0)) bestK = k;
  }

  const target = at(rest, bestK, 0);
  const vertices = [0];
  let a = 0;
  for (let k = bestK; k >= 1; k--) {
    // 最大の差が target を超えない、いちばん前の次の頂点を選ぶ（rest と同じ計算なので等しさで比べられる）。
    let next = n;
    for (let b = a + 1; b <= n; b++) {
      if (Math.max(at(error, a, b), at(rest, k - 1, b)) <= target) {
        next = b;
        break;
      }
    }
    vertices.push(next);
    a = next;
  }
  return { vertices, maxError: target };
}

/** 武器データから簡易版のパターンを求める。同じ magSize と pattern なら常に同じ結果になる。 */
export function simplePattern(weapon: Pick<WeaponData, 'pattern' | 'magSize'>): SimplePattern {
  const ideal = idealCorrection(weapon).slice(0, weapon.magSize);
  const points: Angles[] = [{ yaw: 0, pitch: 0 }, ...ideal];
  const n = points.length - 1;
  if (n < 1) return { vertices: [0], points: [points[0] as Angles], segments: [], positions: points, maxError: 0 };

  const { vertices, maxError } = chooseVertices(points, n);
  const positions: Angles[] = [points[0] as Angles];
  const segments: SimpleSegment[] = [];
  for (let s = 1; s < vertices.length; s++) {
    const from = vertices[s - 1] as number;
    const to = vertices[s] as number;
    for (let i = from + 1; i <= to; i++) positions.push(i === to ? (points[to] as Angles) : along(points, from, to, i));
    const { arrow, direction } = heading(points[from] as Angles, points[to] as Angles);
    const shots = from + 1 === to ? `${to}` : `${from + 1}〜${to}`;
    segments.push({ from, to, arrow, direction, label: `${shots} 発: ${arrow} ${direction}` });
  }
  return { vertices, points: vertices.map((v) => points[v] as Angles), segments, positions, maxError };
}
