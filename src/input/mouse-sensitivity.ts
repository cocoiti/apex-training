/**
 * マウスの感度の換算と cm/360 の式（docs/spec/mouse.md「感度の換算」）。DOM に頼らない計算だけを置く。
 */

/** Apex の感度の換算の係数（度 / カウント / 感度）。 */
export const DEGREES_PER_COUNT = 0.022;

/** 1 インチの cm。 */
const CM_PER_INCH = 2.54;

export interface MouseSettings {
  dpi: number;
  /** Apex の「マウス感度」。 */
  sensitivity: number;
  /** Apex の「ADS 感度の倍率」。 */
  adsMultiplier: number;
}

export const DEFAULT_MOUSE_SETTINGS: Readonly<MouseSettings> = { dpi: 800, sensitivity: 1.5, adsMultiplier: 1 };

/** 1 カウントあたりの角度（度）。ADS 中は ADS 倍率を掛ける。 */
export function degreesPerCount(settings: Readonly<MouseSettings>, ads: boolean): number {
  return settings.sensitivity * (ads ? settings.adsMultiplier : 1) * DEGREES_PER_COUNT;
}

/** マウスの移動量（カウント）を照準の角度の変化（度）にする。右と前（画面の上）が正。 */
export function countsToLook(
  movementX: number,
  movementY: number,
  settings: Readonly<MouseSettings>,
  ads: boolean,
): { yaw: number; pitch: number } {
  const k = degreesPerCount(settings, ads);
  // movementY は下が正。ピッチは上が正なので反転する（0 を -0 にしない）。
  return { yaw: movementX * k, pitch: 0 - movementY * k };
}

/** cm/360 = 360 ÷ (DPI × 感度 × 0.022) × 2.54。DPI か感度が 0 以下なら Infinity。 */
export function cmPer360(dpi: number, sensitivity: number): number {
  const degreesPerInch = dpi * sensitivity * DEGREES_PER_COUNT;
  if (!(degreesPerInch > 0)) return Infinity;
  return (360 / degreesPerInch) * CM_PER_INCH;
}

/** cm/360 の表示（小数 1 桁）。求められないときは「—」。 */
export function formatCmPer360(cm: number): string {
  return Number.isFinite(cm) ? cm.toFixed(1) : '—';
}
