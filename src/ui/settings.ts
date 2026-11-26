import { DEFAULT_MOUSE_SETTINGS, type MouseSettings } from '../input/mouse-sensitivity';
import {
  DEFAULT_PAD_SETTINGS,
  DEFAULT_SIMPLE_PAD_SETTINGS,
  simpleToAdvanced,
  type PadSettings,
  type SimpleCurve,
} from '../input/pad-curve';
import type { AxisBinding, PadLayout } from '../input/pad-layout';
import { DEFAULT_FOV } from '../render/fov';
import { CROSSHAIR_SHAPES, DEFAULT_CROSSHAIR, normalizeColor, type CrosshairShape } from './crosshair';
import type { SafeStorage } from './storage';

/**
 * 設定の共通・マウス・パッドの区分の値・範囲・保存と読み出し（docs/spec/screens.md「設定項目」「設定の保存と読み出し」）。
 * DOM に頼らない。画面との結び付けは settings-form.ts。
 */

/** 入力方式の選択（docs/spec/input.md「入力方式の切替」）。 */
export type InputMethod = 'mouse' | 'pad' | 'auto';

export const INPUT_METHODS: readonly InputMethod[] = ['mouse', 'pad', 'auto'];

/** 補正のパネルに描くパターン（docs/spec/screens.md「補正のパネル」）。detailed は理想の補正軌道、simple は簡易版のパターン。 */
export type PatternDisplay = 'detailed' | 'simple';

export const PATTERN_DISPLAYS: readonly PatternDisplay[] = ['detailed', 'simple'];

/** 共通の区分。入力方式によらず 1 つを共有する。 */
export interface CommonSettings {
  inputMethod: InputMethod;
  fov: number;
  crosshairShape: CrosshairShape;
  /** `#rrggbb` の色。 */
  crosshairColor: string;
  ghost: boolean;
  /** パターンの表示。補正のパネルの理想の線に使う。補正のパネルを出すか消すかの項目はない（docs/spec/screens.md「設定項目」）。 */
  patternDisplay: PatternDisplay;
  /** 音（docs/spec/screens.md「音」）。練習中と試聴の向きの音を鳴らすか。 */
  sound: boolean;
  /** 音量（0〜100 の整数）。音の大きさは音量に比例し、0 のときは鳴らさない。 */
  volume: number;
}

export const DEFAULT_COMMON_SETTINGS: Readonly<CommonSettings> = {
  inputMethod: 'auto',
  fov: DEFAULT_FOV,
  crosshairShape: DEFAULT_CROSSHAIR.shape,
  crosshairColor: DEFAULT_CROSSHAIR.color,
  ghost: false,
  patternDisplay: 'detailed',
  sound: true,
  volume: 50,
};

/** 数の項目の入力できる範囲。integer なら四捨五入する。 */
export interface NumberRange {
  readonly min: number;
  readonly max: number;
  readonly integer: boolean;
}

export const FOV_RANGE: NumberRange = { min: 70, max: 110, integer: true };
export const VOLUME_RANGE: NumberRange = { min: 0, max: 100, integer: true };
export const DPI_RANGE: NumberRange = { min: 100, max: 32000, integer: true };
export const SENSITIVITY_RANGE: NumberRange = { min: 0.1, max: 10, integer: false };
export const ADS_MULTIPLIER_RANGE: NumberRange = { min: 0.1, max: 5, integer: false };

/** マウスの区分の各項目の範囲。 */
export const MOUSE_RANGES: Readonly<Record<keyof MouseSettings, NumberRange>> = {
  dpi: DPI_RANGE,
  sensitivity: SENSITIVITY_RANGE,
  adsMultiplier: ADS_MULTIPLIER_RANGE,
};

/** パッドの設定の方式。simple は簡易設定（ALC OFF 相当）、advanced は詳細設定（ALC 相当）。 */
export type PadSettingsMode = 'simple' | 'advanced';

export const PAD_SETTINGS_MODES: readonly PadSettingsMode[] = ['simple', 'advanced'];

export const SIMPLE_CURVES: readonly SimpleCurve[] = ['classic', 'linear'];

/**
 * パッドの区分（docs/spec/pad.md「パッドの設定画面」）。詳細設定の項目はそのまま持ち、簡易設定の値は別に持つ。
 * 簡易設定を選んでいても詳細設定の値は消さない（詳細設定に戻すと元の値になる）。
 */
export interface PadSectionSettings extends PadSettings {
  mode: PadSettingsMode;
  /** 簡易設定の視点感度（1〜6）。 */
  simpleLook: number;
  /** 簡易設定の ADS 感度（1〜6）。 */
  simpleAds: number;
  simpleCurve: SimpleCurve;
  vibration: boolean;
}

export const DEFAULT_PAD_SECTION_SETTINGS: Readonly<PadSectionSettings> = {
  mode: 'advanced',
  ...DEFAULT_PAD_SETTINGS,
  simpleLook: DEFAULT_SIMPLE_PAD_SETTINGS.look,
  simpleAds: DEFAULT_SIMPLE_PAD_SETTINGS.ads,
  simpleCurve: DEFAULT_SIMPLE_PAD_SETTINGS.curve,
  vibration: true,
};

const PERCENT_RANGE: NumberRange = { min: 0, max: 30, integer: true };
const SPEED_RANGE: NumberRange = { min: 0, max: 500, integer: true };

/** 詳細設定の各項目の範囲（docs/spec/pad.md の詳細設定の表）。 */
export const PAD_RANGES: Readonly<Record<keyof PadSettings, NumberRange>> = {
  deadzone: PERCENT_RANGE,
  outerThreshold: PERCENT_RANGE,
  responseCurve: { min: 0, max: 20, integer: true },
  yaw: SPEED_RANGE,
  pitch: SPEED_RANGE,
  adsYaw: SPEED_RANGE,
  adsPitch: SPEED_RANGE,
};

export const PAD_SETTING_KEYS = Object.keys(PAD_RANGES) as (keyof PadSettings)[];

/** 簡易設定の視点感度・ADS 感度の範囲。 */
export const SIMPLE_LEVEL_RANGE: NumberRange = { min: 1, max: 6, integer: true };

/** 保存のキー。マウスとパッドの区分は入力方式ごとに別のキーにする（docs/spec/input.md「入力方式ごとの保存」）。 */
export const SETTINGS_KEYS = {
  common: 'apex-training:settings:common',
  mouse: 'apex-training:settings:mouse',
  pad: 'apex-training:settings:pad',
} as const;

/** パッドのボタン割り当ての保存のキー（docs/spec/pad.md「ボタン割り当て」）。設定の区分とは別に持つ。 */
export const PAD_MAPPING_KEY = 'apex-training:pad-mapping';

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

/**
 * 保存された値から共通の区分を作る。読めない項目だけを範囲に収めた値か既定値にする。
 * 今の項目にない項目（以前の補正のパネルの `correctionPanel` など）は読み飛ばし、返す区分に入れない（docs/spec/screens.md「設定の保存と読み出し」）。
 */
export function sanitizeCommonSettings(record: Readonly<Record<string, unknown>>): CommonSettings {
  const d = DEFAULT_COMMON_SETTINGS;
  const color = typeof record.crosshairColor === 'string' ? normalizeColor(record.crosshairColor) : undefined;
  return {
    inputMethod: oneOf(record.inputMethod, INPUT_METHODS, d.inputMethod),
    fov: numberOr(record.fov, FOV_RANGE, d.fov),
    crosshairShape: oneOf(record.crosshairShape, CROSSHAIR_SHAPES, d.crosshairShape),
    crosshairColor: color ?? d.crosshairColor,
    ghost: booleanOr(record.ghost, d.ghost),
    patternDisplay: oneOf(record.patternDisplay, PATTERN_DISPLAYS, d.patternDisplay),
    sound: booleanOr(record.sound, d.sound),
    volume: numberOr(record.volume, VOLUME_RANGE, d.volume),
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

/** 保存された値からパッドの区分を作る。読めない項目だけを範囲に収めた値か既定値にする。 */
export function sanitizePadSettings(record: Readonly<Record<string, unknown>>): PadSectionSettings {
  const d = DEFAULT_PAD_SECTION_SETTINGS;
  const advanced = {} as PadSettings;
  for (const key of PAD_SETTING_KEYS) advanced[key] = numberOr(record[key], PAD_RANGES[key], d[key]);
  return {
    mode: oneOf(record.mode, PAD_SETTINGS_MODES, d.mode),
    ...advanced,
    simpleLook: numberOr(record.simpleLook, SIMPLE_LEVEL_RANGE, d.simpleLook),
    simpleAds: numberOr(record.simpleAds, SIMPLE_LEVEL_RANGE, d.simpleAds),
    simpleCurve: oneOf(record.simpleCurve, SIMPLE_CURVES, d.simpleCurve),
    vibration: booleanOr(record.vibration, d.vibration),
  };
}

export function loadPadSettings(storage: Pick<SafeStorage, 'get'>): PadSectionSettings {
  return sanitizePadSettings(readRecord(storage, SETTINGS_KEYS.pad));
}

/** パッドの区分の一部を変えて保存する。値は範囲に収めてから保存し、保存した区分を返す。 */
export function savePadSettings(
  storage: Pick<SafeStorage, 'get' | 'set'>,
  patch: Readonly<Partial<PadSectionSettings>>,
): PadSectionSettings {
  const next = sanitizePadSettings({ ...loadPadSettings(storage), ...patch });
  storage.set(SETTINGS_KEYS.pad, JSON.stringify(next));
  return next;
}

/** スティックの換算に使う値。簡易設定のときは対応表で置き換えた値、詳細設定のときは詳細設定の値。 */
export function effectivePadSettings(pad: Readonly<PadSectionSettings>): PadSettings {
  if (pad.mode === 'simple') return simpleToAdvanced({ look: pad.simpleLook, ads: pad.simpleAds, curve: pad.simpleCurve });
  const advanced = {} as PadSettings;
  for (const key of PAD_SETTING_KEYS) advanced[key] = pad[key];
  return advanced;
}

/** パッドの名前（id）ごとのボタン割り当て。 */
export type PadMappings = Readonly<Record<string, PadLayout>>;

function indexOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function axisBinding(value: unknown): AxisBinding | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { axis, invert } = value as Record<string, unknown>;
  const index = indexOr(axis);
  return index === undefined || typeof invert !== 'boolean' ? undefined : { axis: index, invert };
}

/** 保存された割り当てを読む。形の合わないパッドの割り当ては使わない（ほかのパッドの割り当ては使う）。 */
export function sanitizePadMappings(record: Readonly<Record<string, unknown>>): Record<string, PadLayout> {
  const mappings: Record<string, PadLayout> = {};
  for (const [id, value] of Object.entries(record)) {
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as Record<string, unknown>;
    const fire = indexOr(entry.fire);
    const ads = indexOr(entry.ads);
    const lookX = axisBinding(entry.lookX);
    const lookY = axisBinding(entry.lookY);
    if (fire === undefined || ads === undefined || !lookX || !lookY) continue;
    mappings[id] = { fire, ads, lookX, lookY };
  }
  return mappings;
}

export function loadPadMappings(storage: Pick<SafeStorage, 'get'>): Record<string, PadLayout> {
  return sanitizePadMappings(readRecord(storage, PAD_MAPPING_KEY));
}

/** id のパッドの割り当てを保存する（layout が undefined なら消す）。保存したあとの割り当ての一覧を返す。 */
export function savePadMapping(
  storage: Pick<SafeStorage, 'get' | 'set'>,
  id: string,
  layout: PadLayout | undefined,
): Record<string, PadLayout> {
  const next = loadPadMappings(storage);
  if (layout) next[id] = layout;
  else delete next[id];
  storage.set(PAD_MAPPING_KEY, JSON.stringify(next));
  return next;
}
