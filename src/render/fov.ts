import type { Angles } from '../sim/angles';

/** FOV の既定の値（Apex の設定画面の値）。docs/spec/screens.md「FOV と画面への投影」。 */
export const DEFAULT_FOV = 90;

/** FOV の値を水平視野角とみなす画面の縦横比。 */
const BASE_ASPECT = 4 / 3;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** 視野角（度）。 */
export interface FieldOfView {
  readonly horizontal: number;
  readonly vertical: number;
}

/**
 * FOV の値と画面の縦横比（幅 ÷ 高さ）から視野角を求める。カメラと画面上の位置への換算の両方がこれを使う。
 * FOV の値を縦横比 4:3 での水平視野角とみなし、縦の視野角を保ったまま今の縦横比に広げる。
 * Apex の正確な換算式は未確認で、これは未確認の近似である（docs/roadmap.md）。
 */
export function fieldOfView(fov: number, aspect: number): FieldOfView {
  const halfTan = Math.tan((fov / 2) * DEG_TO_RAD);
  return {
    horizontal: 2 * Math.atan((halfTan * aspect) / BASE_ASPECT) * RAD_TO_DEG,
    vertical: 2 * Math.atan(halfTan / BASE_ASPECT) * RAD_TO_DEG,
  };
}

/** 画面の中心からの位置（ピクセル）。x は右、y は下が正（CSS の座標と同じ向き）。 */
export interface ScreenOffset {
  readonly x: number;
  readonly y: number;
}

/**
 * 照準の向きからのズレ（ヨーは右、ピッチは上が正、度）を、画面の中心からの位置に換算する。
 * 横は 幅の半分 × tan(ヨー) ÷ tan(水平視野角 / 2)、縦は高さの半分と縦の視野角で同じく求める。
 */
export function projectAngleOffset(offset: Angles, fov: number, width: number, height: number): ScreenOffset {
  const view = fieldOfView(fov, width / Math.max(height, 1));
  const tanHalf = (deg: number) => Math.tan((deg / 2) * DEG_TO_RAD);
  return {
    x: ((width / 2) * Math.tan(offset.yaw * DEG_TO_RAD)) / tanHalf(view.horizontal),
    y: (-(height / 2) * Math.tan(offset.pitch * DEG_TO_RAD)) / tanHalf(view.vertical),
  };
}
