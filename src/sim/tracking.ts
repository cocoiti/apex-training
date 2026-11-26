import type { Random } from '../core/random';
import { directionFromAngles, type Angles } from './angles';
import { vec3, type Vec3 } from './vec3';

/**
 * 追いエイムの的の動きと採点（docs/spec/modes.md「追いエイム」、docs/spec/scoring.md「追いエイムの採点」）。
 * 動きは練習の始めに種付きの乱数から区間の列として決め、位置は練習の開始からの時刻だけで決まる。
 * 決定の理由は docs/adr/2026-11-26-tracking-target-and-on-target-scoring.md。
 */

/** 練習の長さ（秒）。 */
export const TRACKING_DURATION = 20;

/** 目の位置から基準の点までの距離（メートル）。 */
export const TRACKING_DISTANCE = 8;

/** 基準の点から動く範囲の端までの距離（メートル）。 */
export const TRACKING_RANGE = 3;

/** 切り返しの間隔の範囲（秒）。 */
export const REVERSAL_MIN_INTERVAL = 0.5;
export const REVERSAL_MAX_INTERVAL = 1.5;

/** 乗り直したとみなす、乗っている状態が続く時間（秒）。 */
export const REACQUIRE_HOLD = 0.2;

/** 速さの id と的の速さ（メートル毎秒）。 */
export const TRACKING_SPEEDS = { slow: 1.5, normal: 3.0, fast: 4.5 } as const;

export type TrackingSpeedId = keyof typeof TRACKING_SPEEDS;

/** 浮動小数の誤差で、ちょうど端に着く時刻と切り返しの時刻を取り違えないための許容幅。 */
const EPSILON = 1e-9;

/** 一定の向きに動く区間。start の時刻に offset（基準の点からの左右の位置、右が正、メートル）にいて、direction の向きに動く。 */
interface Piece {
  readonly start: number;
  readonly offset: number;
  readonly direction: 1 | -1;
}

/** 切り返しの 1 つ。edge は動く範囲の端に着いて切り返したもの。 */
export interface Reversal {
  readonly time: number;
  readonly edge: boolean;
}

/** 追いエイムの的の動き。 */
export interface TrackingMotion {
  /** 基準の点（メートル）。 */
  readonly base: Vec3;
  /** 左右の線の右向きの単位ベクトル（水平）。 */
  readonly right: Vec3;
  /** 的の速さ（メートル毎秒）。 */
  readonly speed: number;
  /** 練習の長さまでの切り返し。時刻の順。 */
  readonly reversals: readonly Reversal[];
  /** 練習の開始からの時刻（秒）の、基準の点からの左右の位置（右が正、メートル）。 */
  offsetAt(time: number): number;
  /** 練習の開始からの時刻（秒）の、的の中心の位置（メートル）。 */
  positionAt(time: number): Vec3;
}

export interface TrackingMotionOptions {
  /** 目の位置。 */
  readonly eye: Vec3;
  /** 開始時の照準の向き。基準の点はこの向きに TRACKING_DISTANCE 進んだ点。 */
  readonly aim: Angles;
  /** 的の速さ（メートル毎秒）。 */
  readonly speed: number;
  /** 切り返しを決める時間（秒）。省くと TRACKING_DURATION。 */
  readonly duration?: number;
}

const interval = (random: Random) => REVERSAL_MIN_INTERVAL + random.next() * (REVERSAL_MAX_INTERVAL - REVERSAL_MIN_INTERVAL);

/**
 * 追いエイムの的の動きを決める。最初に動く向き・切り返しの間隔はすべて random から、この順に引く
 * （最初の向き、そのあと区間ごとの間隔）。同じ種・同じ速さなら同じ動きになる。
 */
export function createTrackingMotion(random: Random, options: TrackingMotionOptions): TrackingMotion {
  const duration = options.duration ?? TRACKING_DURATION;
  const { speed, eye, aim } = options;
  const forward = directionFromAngles(aim);
  const base = vec3(eye.x + forward.x * TRACKING_DISTANCE, eye.y + forward.y * TRACKING_DISTANCE, eye.z + forward.z * TRACKING_DISTANCE);
  const yaw = (aim.yaw * Math.PI) / 180;
  const right = vec3(Math.cos(yaw), 0, Math.sin(yaw));

  const pieces: Piece[] = [{ start: 0, offset: 0, direction: random.next() < 0.5 ? 1 : -1 }];
  const reversals: Reversal[] = [];
  let next = interval(random);
  for (;;) {
    const piece = pieces[pieces.length - 1]!;
    const timed = piece.start + next;
    const edgeAt = piece.start + (TRACKING_RANGE - piece.direction * piece.offset) / speed;
    const edge = edgeAt <= timed + EPSILON;
    const time = edge ? edgeAt : timed;
    if (time > duration + EPSILON) break;
    const offset = edge ? piece.direction * TRACKING_RANGE : piece.offset + piece.direction * speed * (time - piece.start);
    pieces.push({ start: time, offset, direction: piece.direction === 1 ? -1 : 1 });
    reversals.push({ time, edge });
    next = interval(random);
  }

  const offsetAt = (time: number): number => {
    let piece = pieces[0]!;
    for (const p of pieces) {
      if (p.start > time) break;
      piece = p;
    }
    const offset = piece.offset + piece.direction * speed * (time - piece.start);
    // 練習の長さより後は最後の区間を伸ばすだけなので、動く範囲の外に出ないよう収める。
    return Math.min(Math.max(offset, -TRACKING_RANGE), TRACKING_RANGE);
  };
  return {
    base,
    right,
    speed,
    reversals,
    offsetAt,
    positionAt: (time) => {
      const offset = offsetAt(time);
      return vec3(base.x + right.x * offset, base.y, base.z + right.z * offset);
    },
  };
}

/** 練習の 1 ステップの記録。 */
export interface TrackingStep {
  /** 照準が的に乗っていたか。 */
  readonly on: boolean;
  /** 照準の向きと、目の位置から的の中心への向きのなす角（度）。 */
  readonly offAngle: number;
}

/** 照準の向きと、目の位置から点への向きのなす角（度）。 */
export function angleToPoint(eye: Vec3, view: Angles, point: Vec3): number {
  const d = directionFromAngles(view);
  const x = point.x - eye.x;
  const y = point.y - eye.y;
  const z = point.z - eye.z;
  const length = Math.hypot(x, y, z);
  if (length === 0) return 0;
  const cos = (d.x * x + d.y * y + d.z * z) / length;
  return (Math.acos(Math.min(Math.max(cos, -1), 1)) * 180) / Math.PI;
}

/** 追いエイムの採点の結果。「なし」の指標は null。 */
export interface TrackingScore {
  /** 乗っていた割合（%）。ステップがないときは null。 */
  readonly onTargetRate: number | null;
  /** 外していたときのズレ（度）。 */
  readonly offTargetError: number | null;
  /** 乗り直すまでの時間（秒）。 */
  readonly reacquireTime: number | null;
}

/**
 * 追いエイムの採点（docs/spec/scoring.md「追いエイムの採点」）。steps は練習の各ステップの記録（ステップ i の終わりの時刻は (i + 1) × dt）、
 * reversals は練習中の切り返しの時刻（秒）。
 */
export function scoreTracking(steps: readonly TrackingStep[], reversals: readonly number[], dt: number): TrackingScore {
  const n = steps.length;
  if (n === 0) return { onTargetRate: null, offTargetError: null, reacquireTime: null };
  const onCount = steps.filter((s) => s.on).length;
  const off = steps.filter((s) => !s.on);
  const end = n * dt;
  return {
    onTargetRate: (onCount / n) * 100,
    offTargetError: off.length === 0 ? null : off.reduce((sum, s) => sum + s.offAngle, 0) / off.length,
    reacquireTime: reacquireTime(steps, reversals, dt, end),
  };
}

/** 乗り直すまでの時間の平均。練習の終わりの REACQUIRE_HOLD 前より後の切り返しは数えない。 */
function reacquireTime(steps: readonly TrackingStep[], reversals: readonly number[], dt: number, end: number): number | null {
  const hold = Math.max(1, Math.round(REACQUIRE_HOLD / dt - EPSILON));
  const counted = reversals.filter((r) => r <= end - REACQUIRE_HOLD + EPSILON);
  if (counted.length === 0) return null;
  // reversals は時刻の順なので、数える切り返しは先頭からの並びで、i 番目の次の切り返しは reversals[i + 1]。
  const times = counted.map((r, i) => {
    const limit = reversals[i + 1] ?? end;
    // 切り返しの時刻を含むステップ（[j × dt, (j + 1) × dt) に入るステップ）から探す。
    const first = Math.floor(r / dt + EPSILON);
    for (let j = first; j < steps.length; j += 1) {
      const at = (j + 1) * dt;
      if (at > limit + EPSILON) break;
      if (!steps[j]!.on) continue;
      if (j + hold > steps.length || !steps.slice(j, j + hold).every((s) => s.on)) continue;
      // 切り返しより前から乗っていて、そのまま乗り続けたときは 0 秒。
      if (j === first && j > 0 && steps[j - 1]!.on) return 0;
      return Math.max(0, at - r);
    }
    return limit - r;
  });
  return times.reduce((sum, t) => sum + t, 0) / times.length;
}

/** 撃った弾のうち練習の的に当たった弾の割合（%）。1 発も撃っていないときは null。 */
export function trackingHitRate(shots: readonly { readonly target?: string }[]): number | null {
  if (shots.length === 0) return null;
  return (shots.filter((s) => s.target !== undefined).length / shots.length) * 100;
}
