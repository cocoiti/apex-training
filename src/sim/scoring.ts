import { normalizeYaw, type Angles } from './angles';
import type { ShotRecord } from './gun';
import type { World } from './world';

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

/** 的の箱がないマップの的の半径（度）。 */
export const DEFAULT_TARGET_RADIUS = 1;

const RAD_TO_DEG = 180 / Math.PI;

/**
 * 弾ごとの角度のズレ（撃った順）。外れの弾（どの箱にも当たらず deviation がない）は、弾の向きと中心との差をズレとする。
 * 弾のレイは目の位置から飛ぶので、当たった弾の deviation も弾の向きと中心との差に一致する。
 */
export function shotDeviations(shots: readonly Pick<ShotRecord, 'angles' | 'deviation'>[], center: Angles): Angles[] {
  return shots.map(
    (s) => s.deviation ?? { yaw: normalizeYaw(s.angles.yaw - center.yaw), pitch: s.angles.pitch - center.pitch },
  );
}

/**
 * 的の半径（度）。マップの的の箱（kind が target）の幅と高さの小さいほうの半分を、目の位置から手前の面までの距離で見込む角度。
 * 的が複数あるときは最も近いもの、的がなければ DEFAULT_TARGET_RADIUS。
 */
export function targetRadius(world: Pick<World, 'boxes' | 'player'>): number {
  const eye = world.player.position;
  let best: { distance: number; radius: number } | undefined;
  for (const box of world.boxes) {
    if (box.kind !== 'target') continue;
    const toCenter = Math.hypot(box.center.x - eye.x, box.center.y - eye.y, box.center.z - eye.z);
    const distance = Math.max(toCenter - box.size.z / 2, Number.EPSILON);
    if (best && distance >= best.distance) continue;
    best = { distance, radius: Math.atan(Math.min(box.size.x, box.size.y) / 2 / distance) * RAD_TO_DEG };
  }
  return best?.radius ?? DEFAULT_TARGET_RADIUS;
}
