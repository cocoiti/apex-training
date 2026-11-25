import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import range from '../../src/data/maps/range.json';
import { fieldOfView } from '../../src/render/fov';
import { ViewScene } from '../../src/render/scene';
import { viewAngles } from '../../src/sim/player';
import { loadWorld, type World } from '../../src/sim/world';
import type { CrosshairElement } from '../../src/ui/crosshair';
import { applyPracticeSettings } from '../../src/ui/practice-settings';
import { saveCommonSettings, saveMouseSettings, savePadSettings } from '../../src/ui/settings';
import { SafeStorage } from '../../src/ui/storage';

function memoryStorage(): SafeStorage {
  const items = new Map<string, string>();
  const backing = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  } as Storage;
  return new SafeStorage(() => backing);
}

function fakeCrosshair() {
  const props = new Map<string, string>();
  const element: CrosshairElement = {
    dataset: {},
    style: { setProperty: (name: string, value: string | null) => void props.set(name, value ?? '') },
  };
  return { element, props };
}

function rangeWorld(): World {
  const result = loadWorld(range);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.world;
}

/** 的の箱の画面上の幅（正規化デバイス座標）。開始時の照準で見たとき。 */
function targetWidthOnScreen(view: ViewScene, world: World): number {
  view.update(world, viewAngles(world.player));
  const target = world.boxes.find((b) => b.kind === 'target');
  if (!target) throw new Error('的がない');
  const front = target.center.z + target.size.z / 2;
  const left = new THREE.Vector3(target.center.x - target.size.x / 2, target.center.y, front).project(view.camera);
  const right = new THREE.Vector3(target.center.x + target.size.x / 2, target.center.y, front).project(view.camera);
  return right.x - left.x;
}

describe('練習の始めに当てる設定', () => {
  it('設定画面で変えたクロスヘアの色と形が、プレイ画面のクロスヘアに当たる（UI-16）', () => {
    const storage = memoryStorage();
    saveCommonSettings(storage, { crosshairColor: '#ff0000', crosshairShape: 'cross' });
    const { element, props } = fakeCrosshair();
    applyPracticeSettings(storage, { view: { setFov: () => {} }, crosshair: element });
    expect(element.dataset.shape).toBe('cross');
    expect(props.get('--crosshair-color')).toBe('#ff0000');
  });

  it('FOV 110 で始めると、カメラの視野角は FOV 110 から求めた値になり、的が FOV 90 より小さく見える（UI-17）', () => {
    const world = rangeWorld();
    const narrow = new ViewScene(world);
    narrow.setAspect(16 / 9);
    applyPracticeSettings(memoryStorage(), { view: narrow, crosshair: null });
    const wideStorage = memoryStorage();
    saveCommonSettings(wideStorage, { fov: 110 });
    const wide = new ViewScene(world);
    wide.setAspect(16 / 9);
    applyPracticeSettings(wideStorage, { view: wide, crosshair: null });
    expect(narrow.camera.fov).toBeCloseTo(fieldOfView(90, 16 / 9).vertical, 9);
    expect(wide.camera.fov).toBeCloseTo(fieldOfView(110, 16 / 9).vertical, 9);
    expect(targetWidthOnScreen(wide, world)).toBeLessThan(targetWidthOnScreen(narrow, world));
  });

  it('ゴースト表示・パターンの表示とマウスの設定は、保存された値を返す（UI-4、UI-46）', () => {
    const storage = memoryStorage();
    const before = applyPracticeSettings(storage, { view: { setFov: () => {} }, crosshair: null });
    expect(before.ghost).toBe(false);
    expect(before).not.toHaveProperty('correctionPanel');
    expect(before.patternDisplay).toBe('detailed');
    saveCommonSettings(storage, { ghost: true, patternDisplay: 'simple' });
    saveMouseSettings(storage, { dpi: 1600 });
    const settings = applyPracticeSettings(storage, { view: { setFov: () => {} }, crosshair: null });
    expect(settings.ghost).toBe(true);
    expect(settings.patternDisplay).toBe('simple');
    expect(settings.mouse.dpi).toBe(1600);
  });

  it('音と音量は「開始」を押した時点の保存された値を返す', () => {
    const storage = memoryStorage();
    const before = applyPracticeSettings(storage, { view: { setFov: () => {} }, crosshair: null });
    expect(before.sound).toBe(true);
    expect(before.volume).toBe(50);
    saveCommonSettings(storage, { sound: false, volume: 20 });
    const after = applyPracticeSettings(storage, { view: { setFov: () => {} }, crosshair: null });
    expect(after.sound).toBe(false);
    expect(after.volume).toBe(20);
  });

  it('PAD-28: パッドの詳細設定で変えた値を、スティックの換算に使う値として返す', () => {
    const storage = memoryStorage();
    const before = applyPracticeSettings(storage, { view: { setFov: () => {} }, crosshair: null });
    expect(before.pad.yaw).toBe(300);
    expect(before.vibration).toBe(true);
    savePadSettings(storage, { yaw: 150, deadzone: 0, outerThreshold: 0, responseCurve: 0, vibration: false });
    const after = applyPracticeSettings(storage, { view: { setFov: () => {} }, crosshair: null });
    expect(after.pad).toEqual({ deadzone: 0, outerThreshold: 0, responseCurve: 0, yaw: 150, pitch: 260, adsYaw: 90, adsPitch: 78 });
    expect(after.vibration).toBe(false);
  });

  it('簡易設定のときは、対応表で置き換えた値を返す', () => {
    const storage = memoryStorage();
    savePadSettings(storage, { mode: 'simple', simpleLook: 2, simpleAds: 5, simpleCurve: 'linear', yaw: 150 });
    const { pad } = applyPracticeSettings(storage, { view: { setFov: () => {} }, crosshair: null });
    expect(pad).toEqual({ yaw: 180, pitch: 156, adsYaw: 105, adsPitch: 91, responseCurve: 0, deadzone: 10, outerThreshold: 2 });
  });
});
