import type { PadSettings, SimpleCurve } from '../input/pad-curve';
import {
  effectivePadSettings,
  formatNumberValue,
  loadPadSettings,
  PAD_RANGES,
  PAD_SETTING_KEYS,
  parseNumberInput,
  savePadSettings,
  SIMPLE_LEVEL_RANGE,
  type PadSectionSettings,
  type PadSettingsMode,
} from './settings';
import { onCommit, type CheckElement, type FieldElement } from './settings-form';
import type { SafeStorage } from './storage';

/** 変更できなくできる入力欄。 */
export interface LockableField extends FieldElement {
  disabled: boolean;
}

/** 設定画面のパッドの区分の要素。index.html の #settings-form の中のパッドの項目。 */
export interface PadSettingsFormElements {
  readonly mode: FieldElement;
  readonly advanced: Readonly<Record<keyof PadSettings, LockableField>>;
  readonly simpleLook: FieldElement;
  readonly simpleAds: FieldElement;
  readonly simpleCurve: FieldElement;
  readonly vibration: CheckElement;
}

type Storage = Pick<SafeStorage, 'get' | 'set'>;

/** 画面に入り直したときなど、保存された値を表示し直す。 */
export interface PadFormBinding {
  refresh(): void;
}

/**
 * 設定画面のパッドの区分に保存された値を出し、変えるとすぐに保存する（docs/spec/pad.md「パッドの設定画面」）。
 * 簡易設定のあいだは詳細設定の欄に対応表で置き換えた値を出して変更できなくし、詳細設定に戻すと保存した詳細設定の値を出す。
 * 数の項目は入力を確定したときに範囲に収めて保存し、数として読めない入力や空の入力は保存せずに直前の値に戻す。
 */
export function bindPadSettingsForm(elements: PadSettingsFormElements, storage: Storage): PadFormBinding {
  const show = (pad: PadSectionSettings) => {
    elements.mode.value = pad.mode;
    const shown = effectivePadSettings(pad);
    for (const key of PAD_SETTING_KEYS) {
      const field = elements.advanced[key];
      field.value = formatNumberValue(shown[key], PAD_RANGES[key]);
      field.disabled = pad.mode === 'simple';
    }
    elements.simpleLook.value = String(pad.simpleLook);
    elements.simpleAds.value = String(pad.simpleAds);
    elements.simpleCurve.value = pad.simpleCurve;
    elements.vibration.checked = pad.vibration;
  };
  const save = (patch: Partial<PadSectionSettings>) => show(savePadSettings(storage, patch));

  elements.mode.addEventListener('change', () => save({ mode: elements.mode.value as PadSettingsMode }));
  elements.simpleCurve.addEventListener('change', () => save({ simpleCurve: elements.simpleCurve.value as SimpleCurve }));
  for (const key of ['simpleLook', 'simpleAds'] as const) {
    elements[key].addEventListener('change', () => {
      const value = parseNumberInput(elements[key].value, SIMPLE_LEVEL_RANGE);
      save(value === undefined ? {} : { [key]: value });
    });
  }
  elements.vibration.addEventListener('change', () => save({ vibration: elements.vibration.checked }));
  for (const key of PAD_SETTING_KEYS) {
    const field = elements.advanced[key];
    onCommit(field, () => {
      // 簡易設定のあいだは欄を変更できない。念のため、変わっても保存しない。
      if (loadPadSettings(storage).mode === 'simple') return show(loadPadSettings(storage));
      const value = parseNumberInput(field.value, PAD_RANGES[key]);
      save(value === undefined ? {} : { [key]: value });
    });
  }

  const refresh = () => show(loadPadSettings(storage));
  refresh();
  return { refresh };
}

/**
 * キャリブレーション画面のデッドゾーンの欄（docs/spec/pad.md「キャリブレーション」）。パッドの設定のデッドゾーンと同じ値を変える。
 * 簡易設定のときは変更できず、簡易設定のカーブのデッドゾーンを出す。onChange には円の大きさに使う今のデッドゾーン（%）を渡す。
 * 入力の途中でも読める値ならすぐに渡し、保存は入力を確定したときに行う。
 */
export function bindCalibrationDeadzone(field: LockableField, storage: Storage, onChange: (deadzone: number) => void): PadFormBinding {
  const show = (pad: PadSectionSettings) => {
    const { deadzone } = effectivePadSettings(pad);
    field.value = formatNumberValue(deadzone, PAD_RANGES.deadzone);
    field.disabled = pad.mode === 'simple';
    onChange(deadzone);
  };
  onCommit(field, () => {
    const saved = loadPadSettings(storage);
    const value = saved.mode === 'simple' ? undefined : parseNumberInput(field.value, PAD_RANGES.deadzone);
    show(value === undefined ? saved : savePadSettings(storage, { deadzone: value }));
  });
  field.addEventListener('input', () => {
    const saved = loadPadSettings(storage);
    const value = parseNumberInput(field.value, PAD_RANGES.deadzone);
    if (saved.mode !== 'simple' && value !== undefined) onChange(value);
  });
  const refresh = () => show(loadPadSettings(storage));
  refresh();
  return { refresh };
}
