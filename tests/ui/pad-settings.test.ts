import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAD_SECTION_SETTINGS,
  effectivePadSettings,
  loadMouseSettings,
  loadPadMappings,
  loadPadSettings,
  PAD_MAPPING_KEY,
  saveMouseSettings,
  savePadMapping,
  savePadSettings,
  SETTINGS_KEYS,
} from '../../src/ui/settings';
import { SafeStorage } from '../../src/ui/storage';

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const backing = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  } as Storage;
  return { items, storage: new SafeStorage(() => backing), reopen: () => new SafeStorage(() => backing) };
}

const layout = { fire: 1, ads: 0, lookX: { axis: 2, invert: false }, lookY: { axis: 5, invert: true } };

describe('パッドの区分の設定', () => {
  it('UI-24: 何も保存されていなければ詳細設定の既定値と振動 ON', () => {
    const { storage } = memoryStorage();
    expect(loadPadSettings(storage)).toEqual({
      mode: 'advanced',
      deadzone: 10,
      outerThreshold: 2,
      responseCurve: 2,
      yaw: 300,
      pitch: 260,
      adsYaw: 90,
      adsPitch: 78,
      simpleLook: 4,
      simpleAds: 4,
      simpleCurve: 'classic',
      vibration: true,
    });
  });

  it('UI-25: パッドの区分は apex-training:settings:pad に保存し、マウスの区分は変わらない', () => {
    const { items, storage, reopen } = memoryStorage();
    saveMouseSettings(storage, { dpi: 1600 });
    savePadSettings(storage, { mode: 'simple', simpleLook: 2, vibration: false });
    expect(SETTINGS_KEYS.pad).toBe('apex-training:settings:pad');
    expect(JSON.parse(items.get(SETTINGS_KEYS.pad) ?? '{}')).toMatchObject({ mode: 'simple', simpleLook: 2, vibration: false });
    const page = reopen();
    expect(loadPadSettings(page)).toMatchObject({ mode: 'simple', simpleLook: 2, vibration: false });
    expect(loadMouseSettings(page)).toEqual({ dpi: 1600, sensitivity: 1.5, adsMultiplier: 1 });
  });

  it('範囲の外の数は近いほうの端、小数は四捨五入、型の違う値や選べない値は既定値にする', () => {
    const { storage } = memoryStorage({
      [SETTINGS_KEYS.pad]: JSON.stringify({
        mode: 'alc',
        deadzone: 45,
        outerThreshold: -3,
        responseCurve: 7.6,
        yaw: '200',
        pitch: 900,
        simpleLook: 9,
        simpleAds: 0,
        simpleCurve: 'steep',
        vibration: 'off',
      }),
    });
    expect(loadPadSettings(storage)).toEqual({
      ...DEFAULT_PAD_SECTION_SETTINGS,
      deadzone: 30,
      outerThreshold: 0,
      responseCurve: 8,
      pitch: 500,
      simpleLook: 6,
      simpleAds: 1,
    });
  });

  it('壊れた JSON は既定値にする', () => {
    const { storage } = memoryStorage({ [SETTINGS_KEYS.pad]: '{' });
    expect(loadPadSettings(storage)).toEqual(DEFAULT_PAD_SECTION_SETTINGS);
  });

  it('PAD-23: 簡易設定を選んでも詳細設定の値は残り、換算には対応表の値を使う', () => {
    const { storage } = memoryStorage();
    savePadSettings(storage, { yaw: 150, deadzone: 5 });
    const simple = savePadSettings(storage, { mode: 'simple' });
    expect(simple.yaw).toBe(150);
    expect(effectivePadSettings(simple)).toEqual({
      yaw: 300,
      pitch: 260,
      adsYaw: 90,
      adsPitch: 78,
      responseCurve: 8,
      deadzone: 10,
      outerThreshold: 2,
    });
    const advanced = savePadSettings(storage, { mode: 'advanced' });
    expect(effectivePadSettings(advanced)).toMatchObject({ yaw: 150, deadzone: 5 });
  });
});

describe('パッドのボタン割り当ての保存', () => {
  it('PAD-21: パッドの名前ごとに apex-training:pad-mapping に保存し、読み直しても残る。消すと戻る', () => {
    const { items, storage, reopen } = memoryStorage();
    expect(PAD_MAPPING_KEY).toBe('apex-training:pad-mapping');
    savePadMapping(storage, 'odd pad', layout);
    savePadMapping(storage, 'other pad', { ...layout, fire: 4 });
    expect(JSON.parse(items.get(PAD_MAPPING_KEY) ?? '{}')).toEqual({ 'odd pad': layout, 'other pad': { ...layout, fire: 4 } });
    expect(loadPadMappings(reopen())['odd pad']).toEqual(layout);
    savePadMapping(storage, 'odd pad', undefined);
    expect(loadPadMappings(reopen())).toEqual({ 'other pad': { ...layout, fire: 4 } });
  });

  it('形の合わない割り当ては使わず、ほかのパッドの割り当ては使う', () => {
    const { storage } = memoryStorage({
      [PAD_MAPPING_KEY]: JSON.stringify({
        good: layout,
        noAxis: { fire: 1, ads: 0, lookX: { axis: 2 }, lookY: { axis: 3, invert: false } },
        negative: { ...layout, fire: -1 },
        text: 'x',
      }),
    });
    expect(loadPadMappings(storage)).toEqual({ good: layout });
    expect(loadPadMappings(memoryStorage({ [PAD_MAPPING_KEY]: '[1]' }).storage)).toEqual({});
  });
});
