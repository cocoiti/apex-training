import { vec3, type Vec3 } from './vec3';

/** 照準の角度（度）。ヨーは右が正、ピッチは上が正。 */
export interface Angles {
  readonly yaw: number;
  readonly pitch: number;
}

export const PITCH_LIMIT = 89;

/** ピッチを -89 度〜+89 度に収める。 */
export function clampPitch(pitch: number): number {
  return Math.min(Math.max(pitch, -PITCH_LIMIT), PITCH_LIMIT);
}

/** ヨーを -180 度より大きく +180 度以下に正規化する。 */
export function normalizeYaw(yaw: number): number {
  const wrapped = ((((yaw + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/** 角度を範囲に収める。 */
export function normalizeAngles(yaw: number, pitch: number): Angles {
  return { yaw: normalizeYaw(yaw), pitch: clampPitch(pitch) };
}

/** 角度に変化を足して範囲に収める。 */
export function addAngles(base: Angles, delta: Angles): Angles {
  return normalizeAngles(base.yaw + delta.yaw, base.pitch + delta.pitch);
}

const DEG_TO_RAD = Math.PI / 180;

/** 角度から長さ 1 の方向ベクトルを求める。ヨー 0・ピッチ 0 は -Z、ヨーが正なら +X、ピッチが正なら +Y を向く。 */
export function directionFromAngles({ yaw, pitch }: Angles): Vec3 {
  const y = yaw * DEG_TO_RAD;
  const p = pitch * DEG_TO_RAD;
  const cosP = Math.cos(p);
  return vec3(Math.sin(y) * cosP, Math.sin(p), -Math.cos(y) * cosP);
}
