import { cmPer360, formatCmPer360, type MouseSettings } from '../input/mouse-sensitivity';
import {
  FOV_RANGE,
  formatNumberValue,
  loadCommonSettings,
  loadMouseSettings,
  MOUSE_RANGES,
  parseNumberInput,
  saveCommonSettings,
  VOLUME_RANGE,
  saveMouseSettings,
  type CommonSettings,
  type InputMethod,
  type PatternDisplay,
} from './settings';
import type { SafeStorage } from './storage';
import { normalizeColor, type CrosshairShape } from './crosshair';

/** 入力欄の要素の、設定画面が使う部分。 */
export interface FieldElement {
  value: string;
  addEventListener(type: string, listener: (event: Event) => void): void;
}

/** ON/OFF の要素（チェックボックス）の、設定画面が使う部分。 */
export interface CheckElement {
  checked: boolean;
  addEventListener(type: string, listener: (event: Event) => void): void;
}

/** 設定画面の要素。index.html の #settings-form の中の各項目。 */
export interface SettingsFormElements {
  readonly inputMethod: FieldElement;
  readonly fov: FieldElement;
  readonly crosshairShape: FieldElement;
  readonly crosshairColor: FieldElement;
  readonly ghost: CheckElement;
  readonly patternDisplay: FieldElement;
  readonly sound: CheckElement;
  readonly volume: FieldElement;
  readonly dpi: FieldElement;
  readonly sensitivity: FieldElement;
  readonly adsMultiplier: FieldElement;
  readonly cmPer360: Pick<HTMLElement, 'textContent'>;
}

type Storage = Pick<SafeStorage, 'get' | 'set'>;

/** 入力を確定したとき（欄から離れたときか Enter を押したとき）に呼ぶ。 */
export function onCommit(field: FieldElement, commit: () => void): void {
  field.addEventListener('change', commit);
  field.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') commit();
  });
}

/**
 * 設定画面の各項目に保存された値を出し、変えるとすぐに保存する（docs/spec/screens.md「設定項目」）。
 * 選択肢と ON/OFF と色は変えたときに、数の項目は入力を確定したときに保存し、欄の表示を保存した値に揃える。
 * 数として読めない入力や空の入力は保存せず、欄の表示を直前の値に戻す。cm/360 は入力の途中でも範囲に収めた値で出す。
 */
export function bindSettingsForm(elements: SettingsFormElements, storage: Storage): void {
  const showCommon = (common: CommonSettings) => {
    elements.inputMethod.value = common.inputMethod;
    elements.fov.value = formatNumberValue(common.fov, FOV_RANGE);
    elements.crosshairShape.value = common.crosshairShape;
    elements.crosshairColor.value = common.crosshairColor;
    elements.ghost.checked = common.ghost;
    elements.patternDisplay.value = common.patternDisplay;
    elements.sound.checked = common.sound;
    elements.volume.value = formatNumberValue(common.volume, VOLUME_RANGE);
  };

  const mouseFields: Record<keyof MouseSettings, FieldElement> = {
    dpi: elements.dpi,
    sensitivity: elements.sensitivity,
    adsMultiplier: elements.adsMultiplier,
  };
  const mouseKeys = Object.keys(mouseFields) as (keyof MouseSettings)[];

  /** 入力中の欄の値を範囲に収めて読む。読めない欄は保存された値。 */
  const pendingMouse = (): MouseSettings => {
    const saved = loadMouseSettings(storage);
    const pending = { ...saved };
    for (const key of mouseKeys) pending[key] = parseNumberInput(mouseFields[key].value, MOUSE_RANGES[key]) ?? saved[key];
    return pending;
  };
  const showCmPer360 = () => {
    const { dpi, sensitivity } = pendingMouse();
    elements.cmPer360.textContent = formatCmPer360(cmPer360(dpi, sensitivity));
  };

  showCommon(loadCommonSettings(storage));
  const mouse = loadMouseSettings(storage);
  for (const key of mouseKeys) mouseFields[key].value = formatNumberValue(mouse[key], MOUSE_RANGES[key]);
  showCmPer360();

  const saveChoice = (field: FieldElement, patch: () => Partial<CommonSettings>) => {
    const save = () => showCommon(saveCommonSettings(storage, patch()));
    field.addEventListener('change', save);
  };
  saveChoice(elements.inputMethod, () => ({ inputMethod: elements.inputMethod.value as InputMethod }));
  saveChoice(elements.crosshairShape, () => ({ crosshairShape: elements.crosshairShape.value as CrosshairShape }));
  saveChoice(elements.patternDisplay, () => ({ patternDisplay: elements.patternDisplay.value as PatternDisplay }));
  // 色は選んでいる途中（input）でも保存する。色として読めない値は保存せず、直前の色に戻す。
  const saveColor = () => {
    const color = normalizeColor(elements.crosshairColor.value);
    showCommon(saveCommonSettings(storage, color === undefined ? {} : { crosshairColor: color }));
  };
  elements.crosshairColor.addEventListener('input', saveColor);
  elements.crosshairColor.addEventListener('change', saveColor);
  for (const key of ['ghost', 'sound'] as const) {
    elements[key].addEventListener('change', () => showCommon(saveCommonSettings(storage, { [key]: elements[key].checked })));
  }

  onCommit(elements.fov, () => {
    const fov = parseNumberInput(elements.fov.value, FOV_RANGE);
    showCommon(saveCommonSettings(storage, fov === undefined ? {} : { fov }));
  });
  onCommit(elements.volume, () => {
    const volume = parseNumberInput(elements.volume.value, VOLUME_RANGE);
    showCommon(saveCommonSettings(storage, volume === undefined ? {} : { volume }));
  });

  for (const key of mouseKeys) {
    const field = mouseFields[key];
    field.addEventListener('input', showCmPer360);
    onCommit(field, () => {
      const value = parseNumberInput(field.value, MOUSE_RANGES[key]);
      const saved = saveMouseSettings(storage, value === undefined ? {} : { [key]: value });
      field.value = formatNumberValue(saved[key], MOUSE_RANGES[key]);
      showCmPer360();
    });
  }
}
