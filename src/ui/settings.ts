import { DEFAULT_MOUSE_SETTINGS, type MouseSettings } from '../input/mouse-sensitivity';
import { DEFAULT_FOV } from '../render/fov';
import { CROSSHAIR_SHAPES, DEFAULT_CROSSHAIR, normalizeColor, type CrosshairShape } from './crosshair';
import type { SafeStorage } from './storage';

/**
 * 設定の共通とマウスの区分の値・範囲・保存と読み出し（docs/spec/screens.md「設定項目」「設定の保存と読み出し」）。
 * DOM に頼らない。画面との結び付けは settings-form.ts。
 */

/** 入力方式の選択（docs/spec/input.md「入力方式の切替」）。 */
export type InputMethod = 'mouse' | 'pad' | 'auto';

export const INPUT_METHODS: readonly InputMethod[] = ['mouse', 'pad', 'auto'];

/** 共通の区分。入力方式によらず 1 つを共有する。 */
export interface CommonSettings {
  inputMethod: InputMethod;
  fov: number;
  crosshairShape: CrosshairShape;
  /** `#rrggbb` の色。 */
  crosshairColor: string;
  ghost: boolean;
  sound: boolean;
}

export const DEFAULT_COMMON_SETTINGS: Readonly<CommonSettings> = {
  inputMethod: 'auto',
  fov: DEFAULT_FOV,
  crosshairShape: DEFAULT_CROSSHAIR.shape,
  crosshairColor: DEFAULT_CROSSHAIR.color,
  ghost: true,
  sound: true,
};

/** 数の項目の入力できる範囲。integer なら四捨五入する。 */
export interface NumberRange {
  readonly min: number;
  readonly max: number;
  readonly integer: boolean;
}

export const FOV_RANGE: NumberRange = { min: 70, max: 110, integer: true };
export const DPI_RANGE: NumberRange = { min: 100, max: 32000, integer: true };
export const SENSITIVITY_RANGE: NumberRange = { min: 0.1, max: 10, integer: false };
export const ADS_MULTIPLIER_RANGE: NumberRange = { min: 0.1, max: 5, integer: false };

/** マウスの区分の各項目の範囲。 */
export const MOUSE_RANGES: Readonly<Record<keyof MouseSettings, NumberRange>> = {
  dpi: DPI_RANGE,
  sensitivity: SENSITIVITY_RANGE,
  adsMultiplier: ADS_MULTIPLIER_RANGE,
};

/** 保存のキー。マウスとパッドの区分は入力方式ごとに別のキーにする（docs/spec/input.md「入力方式ごとの保存」）。 */
export const SETTINGS_KEYS = {
  common: 'apex-training:settings:common',
  mouse: 'apex-training:settings:mouse',
} as const;

/** 数を範囲に収める。整数の項目は四捨五入する。有限の数でなければ undefined。 */
export function clampToRange(value: number, range: NumberRange): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const rounded = range.integer ? Math.round(value) : value;
  return Math.min(range.max, Math.max(range.min, rounded));
}

/** 入力欄の文字列を数として読み、範囲に収める。空や数として読めない入力は undefined（保存しない）。 */
export function parseNumberInput(text: string, range: NumberRange): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  return clampToRange(Number(trimmed), range);
}

/** 入力欄に出す数。小数の項目は整数でも「1.0」のように小数第 1 位まで出す。 */
export function formatNumberValue(value: number, range: NumberRange): string {
  if (range.integer) return String(value);
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

/** 保存の JSON を読む。JSON として読めないか、オブジェクトでなければ空のオブジェクト。 */
function readRecord(storage: Pick<SafeStorage, 'get'>, key: string): Record<string, unknown> {
  const text = storage.get(key);
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function numberOr(value: unknown, range: NumberRange, fallback: number): number {
  return (typeof value === 'number' ? clampToRange(value, range) : undefined) ?? fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return choices.find((c) => c === value) ?? fallback;
}

/** 保存された値から共通の区分を作る。読めない項目だけを範囲に収めた値か既定値にする。 */
export function sanitizeCommonSettings(record: Readonly<Record<string, unknown>>): CommonSettings {
  const d = DEFAULT_COMMON_SETTINGS;
  const color = typeof record.crosshairColor === 'string' ? normalizeColor(record.crosshairColor) : undefined;
  return {
    inputMethod: oneOf(record.inputMethod, INPUT_METHODS, d.inputMethod),
    fov: numberOr(record.fov, FOV_RANGE, d.fov),
    crosshairShape: oneOf(record.crosshairShape, CROSSHAIR_SHAPES, d.crosshairShape),
    crosshairColor: color ?? d.crosshairColor,
    ghost: booleanOr(record.ghost, d.ghost),
    sound: booleanOr(record.sound, d.sound),
  };
}

/** 保存された値からマウスの区分を作る。読めない項目だけを範囲に収めた値か既定値にする。 */
export function sanitizeMouseSettings(record: Readonly<Record<string, unknown>>): MouseSettings {
  const d = DEFAULT_MOUSE_SETTINGS;
  return {
    dpi: numberOr(record.dpi, DPI_RANGE, d.dpi),
    sensitivity: numberOr(record.sensitivity, SENSITIVITY_RANGE, d.sensitivity),
    adsMultiplier: numberOr(record.adsMultiplier, ADS_MULTIPLIER_RANGE, d.adsMultiplier),
  };
}

export function loadCommonSettings(storage: Pick<SafeStorage, 'get'>): CommonSettings {
  return sanitizeCommonSettings(readRecord(storage, SETTINGS_KEYS.common));
}

export function loadMouseSettings(storage: Pick<SafeStorage, 'get'>): MouseSettings {
  return sanitizeMouseSettings(readRecord(storage, SETTINGS_KEYS.mouse));
}

/** 共通の区分の一部を変えて保存する。値は範囲に収めてから保存し、保存した区分を返す。 */
export function saveCommonSettings(
  storage: Pick<SafeStorage, 'get' | 'set'>,
  patch: Readonly<Partial<CommonSettings>>,
): CommonSettings {
  const next = sanitizeCommonSettings({ ...loadCommonSettings(storage), ...patch });
  storage.set(SETTINGS_KEYS.common, JSON.stringify(next));
  return next;
}

/** マウスの区分の一部を変えて保存する。値は範囲に収めてから保存し、保存した区分を返す。 */
export function saveMouseSettings(
  storage: Pick<SafeStorage, 'get' | 'set'>,
  patch: Readonly<Partial<MouseSettings>>,
): MouseSettings {
  const next = sanitizeMouseSettings({ ...loadMouseSettings(storage), ...patch });
  storage.set(SETTINGS_KEYS.mouse, JSON.stringify(next));
  return next;
}
