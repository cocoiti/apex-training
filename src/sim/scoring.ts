import type { Angles } from './angles';

/** 偏りのしきい値（度）。コメントを出すかどうかを分ける。 */
export const BIAS_THRESHOLD = 0.5;

/** グルーピング半径に入れる弾痕の割合。 */
const GROUPING_RATIO = 0.95;

/** 区間の数（前半・中盤・後半）。 */
const SEGMENT_COUNT = 3;

/** 採点のコメント。縦と横で 1 つずつ、縦・横の順に並ぶ。 */
export type ScoreComment = '下げすぎ' | '下げ不足' | '横の補正不足' | 'よくまとまっている';

/** 採点の結果。null は「なし」。 */
export interface ScoreResult {
  /** 撃った弾の数。 */
  readonly shots: number;
  /** ズレの大きさの平均（度）。 */
  readonly meanDeviation: number | null;
  /** 弾痕の 95% が入る、重心を中心とした円の半径（度）。 */
  readonly groupingRadius: number | null;
  /** ズレの大きさが的の半径以下の弾の割合（%）。 */
  readonly hitRate: number | null;
  /** 前半・中盤・後半のそれぞれの平均ズレ（度）。弾が入らない区間は null。 */
  readonly segments: readonly [number | null, number | null, number | null];
  /** 水平のズレの絶対値の平均（度）。 */
  readonly horizontalSpread: number | null;
  /** 垂直のズレの絶対値の平均（度）。 */
  readonly verticalSpread: number | null;
  /** 横ブレ ÷ 縦ブレ。縦ブレが 0 のときは null。 */
  readonly spreadRatio: number | null;
  readonly comments: readonly ScoreComment[];
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** n 発を撃った順に 3 つに分けたときの、k 番目の区間の発の番号の範囲 [start, end)。 */
export function segmentRange(n: number, k: number): readonly [number, number] {
  return [Math.floor((k * n) / SEGMENT_COUNT), Math.floor(((k + 1) * n) / SEGMENT_COUNT)];
}

function groupingRadius(deviations: readonly Angles[]): number {
  const cx = deviations.reduce((sum, d) => sum + d.yaw, 0) / deviations.length;
  const cy = deviations.reduce((sum, d) => sum + d.pitch, 0) / deviations.length;
  const distances = deviations.map((d) => Math.hypot(d.yaw - cx, d.pitch - cy)).sort((a, b) => a - b);
  return distances[Math.ceil(GROUPING_RATIO * deviations.length) - 1] ?? 0;
}

function selectComments(meanVertical: number, horizontalSpread: number): ScoreComment[] {
  const comments: ScoreComment[] = [];
  if (meanVertical <= -BIAS_THRESHOLD) comments.push('下げすぎ');
  else if (meanVertical >= BIAS_THRESHOLD) comments.push('下げ不足');
  if (horizontalSpread >= BIAS_THRESHOLD) comments.push('横の補正不足');
  if (comments.length === 0) comments.push('よくまとまっている');
  return comments;
}

/**
 * 撃った順の弾ごとの角度のズレ（yaw が水平、pitch が垂直、度。右と上が正）と的の半径（度）から採点する。
 * 同じ入力なら同じ結果になる。
 */
export function score(deviations: readonly Angles[], targetRadius: number): ScoreResult {
  const n = deviations.length;
  if (n === 0) {
    return {
      shots: 0,
      meanDeviation: null,
      groupingRadius: null,
      hitRate: null,
      segments: [null, null, null],
      horizontalSpread: null,
      verticalSpread: null,
      spreadRatio: null,
      comments: [],
    };
  }

  const distances = deviations.map((d) => Math.hypot(d.yaw, d.pitch));
  const segment = (k: number): number | null => mean(distances.slice(...segmentRange(n, k)));
  const horizontalSpread = mean(deviations.map((d) => Math.abs(d.yaw))) ?? 0;
  const verticalSpread = mean(deviations.map((d) => Math.abs(d.pitch))) ?? 0;
  const meanVertical = mean(deviations.map((d) => d.pitch)) ?? 0;

  return {
    shots: n,
    meanDeviation: mean(distances),
    groupingRadius: groupingRadius(deviations),
    hitRate: (distances.filter((d) => d <= targetRadius).length / n) * 100,
    segments: [segment(0), segment(1), segment(2)],
    horizontalSpread,
    verticalSpread,
    spreadRatio: verticalSpread === 0 ? null : horizontalSpread / verticalSpread,
    comments: selectComments(meanVertical, horizontalSpread),
  };
}
