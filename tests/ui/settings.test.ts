import { describe, expect, it } from 'vitest';
import { DEFAULT_MOUSE_SETTINGS } from '../../src/input/mouse-sensitivity';
import {
  clampToRange,
  DEFAULT_COMMON_SETTINGS,
  DPI_RANGE,
  formatNumberValue,
  FOV_RANGE,
  loadCommonSettings,
  loadMouseSettings,
  parseNumberInput,
  saveCommonSettings,
  saveMouseSettings,
  SENSITIVITY_RANGE,
  SETTINGS_KEYS,
} from '../../src/ui/settings';
import { SafeStorage } from '../../src/ui/storage';

/** 読み書きだけの localStorage の代わり。 */
function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const backing = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  } as Storage;
  return { items, storage: new SafeStorage(() => backing), reopen: () => new SafeStorage(() => backing) };
}

describe('設定の値と範囲', () => {
  it('UI-13: 何も保存されていなければ既定値', () => {
    const { storage } = memoryStorage();
    expect(loadCommonSettings(storage)).toEqual({
      inputMethod: 'auto',
      fov: 90,
      crosshairShape: 'dot',
      crosshairColor: '#77ccff',
      ghost: false,
      correctionPanel: true,
      patternDisplay: 'detailed',
      sound: true,
    });
    expect(loadMouseSettings(storage)).toEqual({ dpi: 800, sensitivity: 1.5, adsMultiplier: 1 });
  });

  it('範囲の外は近いほうの端にし、整数の項目は四捨五入する', () => {
    expect(clampToRange(150, FOV_RANGE)).toBe(110);
    expect(clampToRange(50, FOV_RANGE)).toBe(70);
    expect(clampToRange(50, DPI_RANGE)).toBe(100);
    expect(clampToRange(99.6, FOV_RANGE)).toBe(100);
    expect(clampToRange(0.05, SENSITIVITY_RANGE)).toBe(0.1);
    expect(clampToRange(2.345, SENSITIVITY_RANGE)).toBe(2.345);
    expect(clampToRange(Number.NaN, FOV_RANGE)).toBeUndefined();
  });

  it('空や数として読めない入力は値にしない', () => {
    expect(parseNumberInput('', SENSITIVITY_RANGE)).toBeUndefined();
    expect(parseNumberInput('   ', SENSITIVITY_RANGE)).toBeUndefined();
    expect(parseNumberInput('abc', SENSITIVITY_RANGE)).toBeUndefined();
    expect(parseNumberInput('Infinity', SENSITIVITY_RANGE)).toBeUndefined();
    expect(parseNumberInput(' 2.5 ', SENSITIVITY_RANGE)).toBe(2.5);
    expect(parseNumberInput('150', FOV_RANGE)).toBe(110);
  });

  it('小数の項目は整数でも小数第 1 位まで表示する', () => {
    expect(formatNumberValue(1, SENSITIVITY_RANGE)).toBe('1.0');
    expect(formatNumberValue(1.25, SENSITIVITY_RANGE)).toBe('1.25');
    expect(formatNumberValue(800, DPI_RANGE)).toBe('800');
  });
});

describe('設定の保存と読み出し', () => {
  it('UI-2・UI-11: 保存した値を読み直しても残っている', () => {
    const { storage, reopen } = memoryStorage();
    saveCommonSettings(storage, { fov: 104, crosshairShape: 'circle', crosshairColor: '#ff0000', ghost: true, correctionPanel: false, patternDisplay: 'simple' });
    saveMouseSettings(storage, { sensitivity: 2.2 });
    expect(loadCommonSettings(reopen())).toEqual({
      ...DEFAULT_COMMON_SETTINGS,
      fov: 104,
      crosshairShape: 'circle',
      crosshairColor: '#ff0000',
      ghost: true,
      correctionPanel: false,
      patternDisplay: 'simple',
    });
    expect(loadMouseSettings(reopen())).toEqual({ ...DEFAULT_MOUSE_SETTINGS, sensitivity: 2.2 });
  });

  it('共通の区分とマウスの区分は別のキーに JSON で保存する', () => {
    const { storage, items } = memoryStorage();
    saveCommonSettings(storage, { sound: false });
    saveMouseSettings(storage, { dpi: 1600 });
    expect(JSON.parse(items.get(SETTINGS_KEYS.common) ?? '')).toMatchObject({ sound: false, fov: 90 });
    expect(JSON.parse(items.get(SETTINGS_KEYS.mouse) ?? '')).toEqual({ dpi: 1600, sensitivity: 1.5, adsMultiplier: 1 });
  });

  it('保存するときも範囲に収める', () => {
    const { storage, reopen } = memoryStorage();
    expect(saveCommonSettings(storage, { fov: 150 }).fov).toBe(110);
    expect(saveMouseSettings(storage, { dpi: 50 }).dpi).toBe(100);
    expect(loadCommonSettings(reopen()).fov).toBe(110);
  });

  it('UI-15: JSON として読めない値が入っていれば既定値', () => {
    const { storage } = memoryStorage({ [SETTINGS_KEYS.common]: '{broken', [SETTINGS_KEYS.mouse]: 'not json' });
    expect(loadCommonSettings(storage)).toEqual(DEFAULT_COMMON_SETTINGS);
    expect(loadMouseSettings(storage)).toEqual(DEFAULT_MOUSE_SETTINGS);
    const arrays = memoryStorage({ [SETTINGS_KEYS.common]: '[1,2]', [SETTINGS_KEYS.mouse]: 'null' });
    expect(loadCommonSettings(arrays.storage)).toEqual(DEFAULT_COMMON_SETTINGS);
    expect(loadMouseSettings(arrays.storage)).toEqual(DEFAULT_MOUSE_SETTINGS);
  });

  it('読めない項目だけを範囲に収めた値か既定値にし、ほかの項目はそのまま使う', () => {
    const { storage } = memoryStorage({
      [SETTINGS_KEYS.common]: JSON.stringify({ fov: 200, crosshairShape: 'star', crosshairColor: '#ABC', ghost: 'no', correctionPanel: 1, patternDisplay: 'rough', sound: false }),
      [SETTINGS_KEYS.mouse]: JSON.stringify({ dpi: '1600', sensitivity: 3 }),
    });
    expect(loadCommonSettings(storage)).toEqual({
      inputMethod: 'auto',
      fov: 110,
      crosshairShape: 'dot',
      crosshairColor: '#aabbcc',
      ghost: false,
      correctionPanel: true,
      patternDisplay: 'detailed',
      sound: false,
    });
    expect(loadMouseSettings(storage)).toEqual({ dpi: 800, sensitivity: 3, adsMultiplier: 1 });
  });
});
