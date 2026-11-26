import { describe, expect, it } from 'vitest';
import { SETTINGS_KEYS } from '../../src/ui/settings';
import { bindSettingsForm, type CheckElement, type FieldElement, type SettingsFormElements } from '../../src/ui/settings-form';
import { SafeStorage } from '../../src/ui/storage';

/** 値とイベントの登録だけを持つ入力欄。fire で登録された処理を呼ぶ。 */
class FakeField implements FieldElement, CheckElement {
  value = '';
  checked = false;
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  fire(type: string, event: Partial<KeyboardEvent> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as Event);
  }

  /** 文字を入力してから欄を離れる。 */
  type(text: string): void {
    this.value = text;
    this.fire('input');
    this.fire('change');
  }
}

function setup(initial: Record<string, string> = {}, storageFor?: (backing: Storage) => SafeStorage) {
  const items = new Map(Object.entries(initial));
  const backing = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  } as Storage;
  const newPage = storageFor ?? ((b: Storage) => new SafeStorage(() => b));
  const open = () => {
    const fields = {
      inputMethod: new FakeField(),
      fov: new FakeField(),
      crosshairShape: new FakeField(),
      crosshairColor: new FakeField(),
      ghost: new FakeField(),
      patternDisplay: new FakeField(),
      sound: new FakeField(),
      dpi: new FakeField(),
      sensitivity: new FakeField(),
      adsMultiplier: new FakeField(),
      cmPer360: { textContent: '' },
    };
    // 再読み込みと同じく、新しいページの SafeStorage で開く。
    bindSettingsForm(fields satisfies SettingsFormElements, newPage(backing));
    return fields;
  };
  return { items, open };
}

describe('設定画面', () => {
  it('UI-13: 何も変えずに開くと既定値が表示され、cm/360 は 34.6（MOU-4）', () => {
    const form = setup().open();
    expect(form.inputMethod.value).toBe('auto');
    expect(form.fov.value).toBe('90');
    expect(form.crosshairShape.value).toBe('dot');
    expect(form.crosshairColor.value).toBe('#77ccff');
    expect(form.ghost.checked).toBe(false);
    expect(form).not.toHaveProperty('correctionPanel');
    expect(form.patternDisplay.value).toBe('detailed');
    expect(form.sound.checked).toBe(true);
    expect(form.dpi.value).toBe('800');
    expect(form.sensitivity.value).toBe('1.5');
    expect(form.adsMultiplier.value).toBe('1.0');
    expect(form.cmPer360.textContent).toBe('34.6');
  });

  it('UI-75: 以前の補正のパネルの項目（OFF）と FOV 100 が保存されていても、FOV 100 を表示する', () => {
    const app = setup();
    app.items.set(SETTINGS_KEYS.common, JSON.stringify({ fov: 100, correctionPanel: false }));
    const form = app.open();
    expect(form.fov.value).toBe('100');
    expect(form.ghost.checked).toBe(false);
  });

  it('UI-2: 感度を変えて確定すると、保存の操作なしで読み直しても残っている', () => {
    const app = setup();
    app.open().sensitivity.type('2.25');
    expect(app.open().sensitivity.value).toBe('2.25');
  });

  it('Enter を押したときも確定して保存する', () => {
    const app = setup();
    const form = app.open();
    form.dpi.value = '1200';
    form.dpi.fire('keydown', { key: 'Enter' });
    expect(app.open().dpi.value).toBe('1200');
  });

  it('UI-11: FOV・クロスヘアの色と形・ゴースト表示・パターンの表示を変えると読み直しても残っている', () => {
    const app = setup();
    const form = app.open();
    form.fov.type('100');
    form.crosshairColor.value = '#FF8800';
    form.crosshairColor.fire('input');
    form.crosshairShape.value = 'cross';
    form.crosshairShape.fire('change');
    form.ghost.checked = true;
    form.ghost.fire('change');
    form.patternDisplay.value = 'simple';
    form.patternDisplay.fire('change');
    form.inputMethod.value = 'pad';
    form.inputMethod.fire('change');
    form.sound.checked = false;
    form.sound.fire('change');

    const reopened = app.open();
    expect(reopened.fov.value).toBe('100');
    expect(reopened.crosshairColor.value).toBe('#ff8800');
    expect(reopened.crosshairShape.value).toBe('cross');
    expect(reopened.ghost.checked).toBe(true);
    expect(reopened.patternDisplay.value).toBe('simple');
    expect(reopened.inputMethod.value).toBe('pad');
    expect(reopened.sound.checked).toBe(false);
  });

  it('UI-12: 範囲の外の数は端の値で保存し、欄の表示も揃える', () => {
    const app = setup();
    const form = app.open();
    form.fov.type('150');
    expect(form.fov.value).toBe('110');
    expect(app.open().fov.value).toBe('110');
    form.fov.type('50');
    expect(form.fov.value).toBe('70');
    expect(app.open().fov.value).toBe('70');
    form.dpi.type('50');
    expect(form.dpi.value).toBe('100');
    expect(app.open().dpi.value).toBe('100');
  });

  it('整数の項目に小数を入力すると四捨五入して保存する', () => {
    const app = setup();
    app.open().fov.type('95.5');
    expect(app.open().fov.value).toBe('96');
  });

  it('UI-14: 感度を空にするか数として読めない値を確定すると、直前の値のまま欄の表示も戻る', () => {
    const app = setup();
    const form = app.open();
    form.sensitivity.type('2.0');
    form.sensitivity.type('');
    expect(form.sensitivity.value).toBe('2.0');
    expect(app.open().sensitivity.value).toBe('2.0');
    form.sensitivity.type('abc');
    expect(form.sensitivity.value).toBe('2.0');
    expect(app.open().sensitivity.value).toBe('2.0');
  });

  it('MOU-12: DPI 1600・感度 1.0 で cm/360 は 26.0、ADS 倍率を 0.5 にしても変わらない', () => {
    const form = setup().open();
    form.dpi.type('1600');
    form.sensitivity.type('1.0');
    expect(form.cmPer360.textContent).toBe('26.0');
    form.adsMultiplier.type('0.5');
    expect(form.cmPer360.textContent).toBe('26.0');
  });

  it('cm/360 は確定する前の入力の途中でも、範囲に収めた値で表示する', () => {
    const form = setup().open();
    form.dpi.value = '1600';
    form.dpi.fire('input');
    expect(form.cmPer360.textContent).toBe('17.3');
    // 範囲の外（DPI 50）は 100 として計算する。
    form.dpi.value = '50';
    form.dpi.fire('input');
    expect(form.cmPer360.textContent).toBe('277.1');
    // 読めない入力の途中は保存された値で計算する。
    form.dpi.value = '';
    form.dpi.fire('input');
    expect(form.cmPer360.textContent).toBe('34.6');
  });

  it('UI-15: 壊れた設定の値が入っていても止まらずに既定値を表示する', () => {
    const form = setup({ [SETTINGS_KEYS.common]: '{oops', [SETTINGS_KEYS.mouse]: '}}' }).open();
    expect(form.fov.value).toBe('90');
    expect(form.crosshairColor.value).toBe('#77ccff');
    expect(form.dpi.value).toBe('800');
    expect(form.sensitivity.value).toBe('1.5');
    expect(form.cmPer360.textContent).toBe('34.6');
  });

  it('保存できない環境でも、ページを開いている間は変えた値が残る', () => {
    const failing = new SafeStorage(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const app = setup({}, () => failing);
    app.open().sensitivity.type('3.0');
    expect(app.open().sensitivity.value).toBe('3.0');
    expect(app.items.size).toBe(0);
  });
});
