import { normalizeYaw, type Angles } from './angles';
import type { Box } from './map';
import { vec3, type Vec3 } from './vec3';

/** レイと箱の最も近い交点。 */
export interface RayHit {
  readonly box: Box;
  /** 交点の位置（メートル）。 */
  readonly position: Vec3;
  /** 始点からの距離（メートル。方向が長さ 1 のとき）。 */
  readonly distance: number;
}

const AXES = ['x', 'y', 'z'] as const;

/** レイと軸に平行な箱の交差（スラブ法）。始点より前（t > 0）の最初の交点の t を返す。始点が箱の中なら出口。 */
function intersectBox(origin: Vec3, dir: Vec3, box: Box): number | undefined {
  let tNear = -Infinity;
  let tFar = Infinity;
  for (const axis of AXES) {
    const min = box.center[axis] - box.size[axis] / 2;
    const max = box.center[axis] + box.size[axis] / 2;
    const o = origin[axis];
    const d = dir[axis];
    if (d === 0) {
      if (o < min || o > max) return undefined;
      continue;
    }
    let t1 = (min - o) / d;
    let t2 = (max - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tNear = Math.max(tNear, t1);
    tFar = Math.min(tFar, t2);
    if (tNear > tFar) return undefined;
  }
  if (tFar <= 0) return undefined;
  return tNear > 0 ? tNear : tFar;
}

/** 始点から方向（長さ 1）へ飛ばしたレイが最初に当たる箱と交点。どれにも当たらなければ undefined。 */
export function raycastBoxes(origin: Vec3, dir: Vec3, boxes: readonly Box[]): RayHit | undefined {
  let best: RayHit | undefined;
  for (const box of boxes) {
    const t = intersectBox(origin, dir, box);
    if (t === undefined || (best && t >= best.distance)) continue;
    best = { box, distance: t, position: vec3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t) };
  }
  return best;
}

const RAD_TO_DEG = 180 / Math.PI;

/** 目の位置から見た点の向き（ヨー・ピッチ、度）。directionFromAngles の逆。 */
export function anglesToPoint(eye: Vec3, point: Vec3): Angles {
  const x = point.x - eye.x;
  const y = point.y - eye.y;
  const z = point.z - eye.z;
  return { yaw: Math.atan2(x, -z) * RAD_TO_DEG, pitch: Math.atan2(y, Math.hypot(x, z)) * RAD_TO_DEG };
}

/** 角度のズレ。点を目の位置から見た向きと中心の向きとの差（水平・垂直、度。右と上が正）。 */
export function angularDeviation(eye: Vec3, point: Vec3, center: Angles): Angles {
  const seen = anglesToPoint(eye, point);
  return { yaw: normalizeYaw(seen.yaw - center.yaw), pitch: seen.pitch - center.pitch };
}
