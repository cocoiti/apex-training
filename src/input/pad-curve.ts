/**
 * パッドのスティックの傾きから視点の回転速度（度/秒）を求める式と、詳細設定・簡易設定の値（docs/spec/pad.md）。
 * Apex 内部の式は非公開のため近似で、実機と見比べて調整できるよう式と定数をこのファイルにまとめる。
 */

/** 詳細設定（ALC 相当）。デッドゾーンと外側しきい値は %。 */
export interface PadSettings {
  /** 中心付近の無効範囲（%、0〜30）。 */
  deadzone: number;
  /** 端の何 % を最大入力とするか（%、0〜30）。 */
  outerThreshold: number;
  /** 傾き→速度の曲線の強さ（0〜20）。0 でリニア。 */
  responseCurve: number;
  /** 腰撃ちの最大回転速度（度/秒）。 */
  yaw: number;
  pitch: number;
  /** ADS 中の最大回転速度（度/秒）。 */
  adsYaw: number;
  adsPitch: number;
}

export const DEFAULT_PAD_SETTINGS: Readonly<PadSettings> = {
  deadzone: 10,
  outerThreshold: 2,
  responseCurve: 2,
  yaw: 300,
  pitch: 260,
  adsYaw: 90,
  adsPitch: 78,
};

/** レスポンスカーブ c の指数は 1 + c ÷ CURVE_DIVISOR。 */
export const CURVE_DIVISOR = 8;

/**
 * 傾きの大きさ m（0〜1）を入力量（0〜1）にする。
 * t = (m − d) ÷ (1 − o − d) を 0〜1 に収め、入力量 = t ^ (1 + c ÷ 8)。
 */
export function stickAmount(magnitude: number, settings: Readonly<PadSettings>): number {
  const d = settings.deadzone / 100;
  const o = settings.outerThreshold / 100;
  const m = Math.min(Math.max(magnitude, 0), 1);
  if (m <= d) return 0;
  const span = 1 - o - d;
  if (span <= 0 || m >= 1 - o) return 1;
  const t = Math.min(Math.max((m - d) / span, 0), 1);
  return t ** (1 + settings.responseCurve / CURVE_DIVISOR);
}

/** 視点の回転速度（度/秒）。ヨーは右が正、ピッチは上が正。 */
export interface LookRate {
  yaw: number;
  pitch: number;
}

/**
 * 右スティックの値 (x, y) から回転速度を求める。x は右が正、y は上が正（Gamepad API の上下は反転して渡す）。
 * 向きは倒した向きのまま、大きさだけを入力量に置き換える。
 */
export function lookRate(x: number, y: number, settings: Readonly<PadSettings>, ads: boolean): LookRate {
  const raw = Math.hypot(x, y);
  const amount = stickAmount(raw, settings);
  if (amount === 0) return { yaw: 0, pitch: 0 };
  const maxYaw = ads ? settings.adsYaw : settings.yaw;
  const maxPitch = ads ? settings.adsPitch : settings.pitch;
  return { yaw: amount * (x / raw) * maxYaw, pitch: amount * (y / raw) * maxPitch };
}

/** 右スティックの位置。x は右が正、y は上が正で、中心が (0, 0)、倒し切った位置の大きさが 1。 */
export interface StickPosition {
  x: number;
  y: number;
}

/**
 * カーブの逆（docs/spec/pad.md「カーブの逆」）。回転速度 rate（度/秒）を出すスティックの位置を、lookRate の式の逆で求める。
 * 最大回転速度より速いときは同じ向きに倒し切った位置にする。最大回転速度が 0 の軸の成分は 0 として扱う。
 */
export function stickPosition(rate: Readonly<LookRate>, settings: Readonly<PadSettings>, ads: boolean): StickPosition {
  const maxYaw = ads ? settings.adsYaw : settings.yaw;
  const maxPitch = ads ? settings.adsPitch : settings.pitch;
  const u = maxYaw === 0 ? 0 : rate.yaw / maxYaw;
  const w = maxPitch === 0 ? 0 : rate.pitch / maxPitch;
  const raw = Math.hypot(u, w);
  if (raw === 0 || !Number.isFinite(raw)) return { x: 0, y: 0 };
  const q = Math.min(raw, 1);
  const d = settings.deadzone / 100;
  const o = settings.outerThreshold / 100;
  const t = q ** (1 / (1 + settings.responseCurve / CURVE_DIVISOR));
  const m = d + t * (1 - o - d);
  // 0 + x にして、成分が 0 のときに -0 にならないようにする。
  return { x: 0 + (u / raw) * m, y: 0 + (w / raw) * m };
}

/** 簡易設定（ALC OFF 相当）。 */
export type SimpleCurve = 'classic' | 'linear';

export interface SimplePadSettings {
  /** 視点感度（1〜6）。 */
  look: number;
  /** ADS 感度（1〜6）。 */
  ads: number;
  curve: SimpleCurve;
}

export const DEFAULT_SIMPLE_PAD_SETTINGS: Readonly<SimplePadSettings> = { look: 4, ads: 4, curve: 'classic' };

/** 視点感度 1〜6 → 腰撃ちの最大回転速度（度/秒）。 */
const LOOK_TABLE: readonly { yaw: number; pitch: number }[] = [
  { yaw: 120, pitch: 104 },
  { yaw: 180, pitch: 156 },
  { yaw: 240, pitch: 208 },
  { yaw: 300, pitch: 260 },
  { yaw: 360, pitch: 312 },
  { yaw: 420, pitch: 364 },
];

/** ADS 感度 1〜6 → ADS 中の最大回転速度（度/秒）。 */
const ADS_TABLE: readonly { yaw: number; pitch: number }[] = [
  { yaw: 45, pitch: 39 },
  { yaw: 60, pitch: 52 },
  { yaw: 75, pitch: 65 },
  { yaw: 90, pitch: 78 },
  { yaw: 105, pitch: 91 },
  { yaw: 120, pitch: 104 },
];

const CURVE_TABLE: Readonly<Record<SimpleCurve, { responseCurve: number; deadzone: number; outerThreshold: number }>> = {
  classic: { responseCurve: 8, deadzone: 10, outerThreshold: 2 },
  linear: { responseCurve: 0, deadzone: 10, outerThreshold: 2 },
};

function pick<T>(table: readonly T[], level: number): T {
  const index = Math.min(Math.max(Math.round(level), 1), table.length) - 1;
  const row = table[index];
  if (row === undefined) throw new Error(`対応表にない値: ${level}`);
  return row;
}

/** 簡易設定を詳細設定の値に置き換える。範囲外の感度は 1〜6 に収める。 */
export function simpleToAdvanced(simple: Readonly<SimplePadSettings>): PadSettings {
  const look = pick(LOOK_TABLE, simple.look);
  const ads = pick(ADS_TABLE, simple.ads);
  return {
    ...CURVE_TABLE[simple.curve],
    yaw: look.yaw,
    pitch: look.pitch,
    adsYaw: ads.yaw,
    adsPitch: ads.pitch,
  };
}
