import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ja } from '../../src/ui/messages/ja';
import type { PadSettings } from '../../src/input/pad-curve';
import { bindCalibrationDeadzone, bindPadSettingsForm, type LockableField } from '../../src/ui/pad-settings-form';
import { loadMouseSettings, loadPadSettings, saveMouseSettings, SETTINGS_KEYS } from '../../src/ui/settings';
import type { CheckElement } from '../../src/ui/settings-form';
import { SafeStorage } from '../../src/ui/storage';

/** 値とイベントの登録だけを持つ入力欄。 */
class FakeField implements LockableField, CheckElement {
  value = '';
  checked = false;
  disabled = false;
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  fire(type: string, event: Partial<KeyboardEvent> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as Event);
  }

  /** 選ぶか、文字を入力してから欄を離れる。 */
  type(text: string): void {
    this.value = text;
    this.fire('input');
    this.fire('change');
  }
}

function setup() {
  const items = new Map<string, string>();
  const backing = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  } as Storage;
  const page = () => new SafeStorage(() => backing);
  const open = (storage = page()) => {
    const advanced: Record<keyof PadSettings, FakeField> = {
      deadzone: new FakeField(),
      outerThreshold: new FakeField(),
      responseCurve: new FakeField(),
      yaw: new FakeField(),
      pitch: new FakeField(),
      adsYaw: new FakeField(),
      adsPitch: new FakeField(),
    };
    const fields = {
      mode: new FakeField(),
      advanced,
      simpleLook: new FakeField(),
      simpleAds: new FakeField(),
      simpleCurve: new FakeField(),
      vibration: new FakeField(),
    };
    const binding = bindPadSettingsForm(fields, storage);
    return { ...fields, binding, storage };
  };
  return { items, open, page };
}

const values = (advanced: Record<keyof PadSettings, FakeField>) =>
  Object.fromEntries(Object.entries(advanced).map(([key, field]) => [key, field.value]));

describe('設定画面のパッドの区分', () => {
  it('UI-40: 何も変えずに開くと詳細設定で、詳細設定の既定値と振動 ON が表示される', () => {
    const form = setup().open();
    expect(form.mode.value).toBe('advanced');
    expect(values(form.advanced)).toEqual({
      deadzone: '10',
      outerThreshold: '2',
      responseCurve: '2',
      yaw: '300',
      pitch: '260',
      adsYaw: '90',
      adsPitch: '78',
    });
    expect(Object.values(form.advanced).every((field) => !field.disabled)).toBe(true);
    expect(form.vibration.checked).toBe(true);
    expect(form.simpleLook.value).toBe('4');
    expect(form.simpleAds.value).toBe('4');
    expect(form.simpleCurve.value).toBe('classic');
  });

  it('UI-41: 簡易設定・視点感度 2・振動 OFF にして読み直すと残っていて、マウスの区分は変わらない', () => {
    const app = setup();
    const first = app.open();
    saveMouseSettings(first.storage, { sensitivity: 2.5 });
    first.mode.type('simple');
    first.simpleLook.type('2');
    first.vibration.checked = false;
    first.vibration.fire('change');
    const again = app.open();
    expect(again.mode.value).toBe('simple');
    expect(again.simpleLook.value).toBe('2');
    expect(again.vibration.checked).toBe(false);
    expect(loadMouseSettings(again.storage)).toEqual({ dpi: 800, sensitivity: 2.5, adsMultiplier: 1 });
    expect(app.items.has(SETTINGS_KEYS.pad)).toBe(true);
  });

  it('PAD-28: 詳細設定のヨー速度を 150 にして確定すると保存する', () => {
    const app = setup();
    app.open().advanced.yaw.type('150');
    expect(loadPadSettings(app.page()).yaw).toBe(150);
    expect(app.open().advanced.yaw.value).toBe('150');
  });

  it('範囲の外は端の値、小数は四捨五入、読めない入力と空は保存せず直前の値に戻す', () => {
    const app = setup();
    const form = app.open();
    form.advanced.deadzone.type('45');
    expect(form.advanced.deadzone.value).toBe('30');
    form.advanced.responseCurve.type('7.6');
    expect(form.advanced.responseCurve.value).toBe('8');
    form.advanced.yaw.type('abc');
    expect(form.advanced.yaw.value).toBe('300');
    form.advanced.pitch.type('');
    expect(form.advanced.pitch.value).toBe('260');
    form.advanced.adsYaw.value = '120';
    form.advanced.adsYaw.fire('keydown', { key: 'Enter' });
    expect(loadPadSettings(app.page())).toMatchObject({ deadzone: 30, responseCurve: 8, yaw: 300, pitch: 260, adsYaw: 120 });
  });

  it('PAD-29: 簡易設定のあいだは詳細設定の欄に対応表の値を出して変更できず、詳細設定に戻すと前の値に戻る', () => {
    const form = setup().open();
    form.advanced.yaw.type('150');
    form.advanced.deadzone.type('5');
    form.mode.type('simple');
    form.simpleLook.type('2');
    form.simpleAds.type('5');
    form.simpleCurve.type('linear');
    expect(values(form.advanced)).toEqual({
      deadzone: '10',
      outerThreshold: '2',
      responseCurve: '0',
      yaw: '180',
      pitch: '156',
      adsYaw: '105',
      adsPitch: '91',
    });
    expect(Object.values(form.advanced).every((field) => field.disabled)).toBe(true);
    // 変更できない欄が変わっても保存しない。
    form.advanced.yaw.type('999');
    expect(form.advanced.yaw.value).toBe('180');
    form.mode.type('advanced');
    expect(form.advanced.yaw.value).toBe('150');
    expect(form.advanced.deadzone.value).toBe('5');
    expect(Object.values(form.advanced).every((field) => !field.disabled)).toBe(true);
  });

  it('refresh で、ほかの画面で変えた値を表示し直す', () => {
    const app = setup();
    const storage = app.page();
    const form = app.open(storage);
    const deadzone = new FakeField();
    bindCalibrationDeadzone(deadzone, storage, () => {});
    deadzone.type('20');
    expect(form.advanced.deadzone.value).toBe('10');
    form.binding.refresh();
    expect(form.advanced.deadzone.value).toBe('20');
  });
});

describe('キャリブレーション画面のデッドゾーン', () => {
  function calibration() {
    const app = setup();
    const storage = app.page();
    const field = new FakeField();
    const shown: number[] = [];
    const binding = bindCalibrationDeadzone(field, storage, (deadzone) => shown.push(deadzone));
    return { app, storage, field, shown, binding };
  }

  it('PAD-22: パッドの設定のデッドゾーンを出し、変えると保存して円の大きさに使う値を渡す', () => {
    const { app, field, shown } = calibration();
    expect(field.value).toBe('10');
    expect(shown).toEqual([10]);
    field.type('20');
    expect(shown.at(-1)).toBe(20);
    expect(loadPadSettings(app.page()).deadzone).toBe(20);
  });

  it('入力の途中でも読める値なら、保存する前に円の大きさに使う値を渡す', () => {
    const { app, field, shown } = calibration();
    field.value = '15';
    field.fire('input');
    expect(shown.at(-1)).toBe(15);
    expect(loadPadSettings(app.page()).deadzone).toBe(10);
  });

  it('簡易設定のときは変更できず、簡易設定のカーブのデッドゾーンを出す', () => {
    const app = setup();
    const form = app.open();
    form.advanced.deadzone.type('25');
    form.mode.type('simple');
    const field = new FakeField();
    const shown: number[] = [];
    bindCalibrationDeadzone(field, form.storage, (deadzone) => shown.push(deadzone));
    expect(field.value).toBe('10');
    expect(field.disabled).toBe(true);
    field.type('20');
    expect(field.value).toBe('10');
    expect(shown.every((value) => value === 10)).toBe(true);
    expect(loadPadSettings(form.storage).deadzone).toBe(25);
  });
});

describe('パッドの画面の文言とリンク（index.html）', () => {
  const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
  const section = (screen: string) => {
    const start = html.indexOf(`data-screen="${screen}"`);
    return html.slice(start, html.indexOf('</section>', start));
  };

  it('PAD-9: 設定画面のパッドの区分に、エイムアシストを再現しないことと完全一致ではないことを出す', () => {
    // 文言は辞書から出す（index.html は辞書のキーを持つ。docs/spec/architecture.md「画面の文言の辞書」）。
    const pad = section('settings').slice(section('settings').indexOf('<legend data-i18n="input.pad"></legend>'));
    expect(pad).toContain('data-i18n="settings.padNoAimAssist"');
    expect(pad).toContain('data-i18n="settings.padNotExact"');
    expect(pad).toContain('data-i18n="settings.padNoVibration"');
    expect(ja['settings.padNoAimAssist']).toBe('エイムアシストは再現しません。エイムアシストなしの素のリコイル制御を練習します');
    expect(ja['settings.padNotExact']).toBe('ゲームと完全に一致するものではなく、近い感覚で練習できます');
    expect(ja['settings.padNoVibration']).toBe('このパッドまたはブラウザは振動に対応していません');
  });

  it('UI-42: パッドの区分からキャリブレーションとボタン割り当てを開け、どちらからも設定画面に戻れる', () => {
    expect(section('settings')).toContain('href="#/settings/pad"');
    expect(section('settings')).toContain('href="#/settings/pad/mapping"');
    expect(section('settings-pad')).toContain('href="#/settings"');
    expect(section('settings-pad-mapping')).toContain('href="#/settings"');
  });
});
