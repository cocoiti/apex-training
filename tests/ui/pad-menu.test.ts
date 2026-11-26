import { describe, expect, it } from 'vitest';
import {
  backTarget,
  CROSSHAIR_COLOR_STEPS,
  moveFocus,
  NAV_SCREENS,
  NUMBER_STEPS,
  relocateFocus,
  stepChoice,
  stepColor,
  stepNumber,
} from '../../src/ui/pad-menu';

const step = (id: string) => {
  const found = NUMBER_STEPS[id];
  if (!found) throw new Error(`幅がない: ${id}`);
  return found;
};

describe('パッドで項目を移動できる画面と戻る先', () => {
  it('トップ・設定・履歴・キャリブレーション・ボタン割り当てで移動し、リザルト・セットのまとめ・プレイでは移動しない', () => {
    expect([...NAV_SCREENS].sort()).toEqual(['history', 'settings', 'settings-pad', 'settings-pad-mapping', 'top']);
  });

  it('UI-49: 設定・履歴はトップへ、キャリブレーション・ボタン割り当ては設定へ戻り、トップでは何もしない', () => {
    expect(backTarget('settings')).toBe('top');
    expect(backTarget('history')).toBe('top');
    expect(backTarget('settings-pad')).toBe('settings');
    expect(backTarget('settings-pad-mapping')).toBe('settings');
    expect(backTarget('top')).toBeUndefined();
  });
});

describe('数の入力欄の左右', () => {
  it('UI-44: FOV は幅 1 で、90 から右を 5 回で 95', () => {
    let value = '90';
    for (let i = 0; i < 5; i += 1) value = stepNumber(value, step('setting-fov'), 1) ?? value;
    expect(value).toBe('95');
  });

  it('UI-45: FOV 110 で右を押しても 110、感度 1.5 で左を押すと 1.4', () => {
    expect(stepNumber('110', step('setting-fov'), 1)).toBe('110');
    expect(stepNumber('70', step('setting-fov'), -1)).toBe('70');
    expect(stepNumber('1.5', step('setting-sensitivity'), -1)).toBe('1.4');
    expect(stepNumber('0.1', step('setting-sensitivity'), -1)).toBe('0.1');
    expect(stepNumber('0.9', step('setting-ads-multiplier'), 1)).toBe('1.0');
  });

  it('SPEC の幅で増減する', () => {
    expect(stepNumber('800', step('setting-dpi'), 1)).toBe('900');
    expect(stepNumber('32000', step('setting-dpi'), 1)).toBe('32000');
    expect(stepNumber('10', step('setting-pad-deadzone'), 1)).toBe('11');
    expect(stepNumber('2', step('setting-pad-outer-threshold'), -1)).toBe('1');
    expect(stepNumber('20', step('setting-pad-response-curve'), 1)).toBe('20');
    expect(stepNumber('300', step('setting-pad-yaw'), 1)).toBe('310');
    expect(stepNumber('260', step('setting-pad-pitch'), -1)).toBe('250');
    expect(stepNumber('495', step('setting-pad-ads-yaw'), 1)).toBe('500');
    expect(stepNumber('5', step('setting-pad-ads-pitch'), -1)).toBe('0');
    expect(stepNumber('0', step('calibration-deadzone-input'), -1)).toBe('0');
    expect(stepNumber('50', step('setting-volume'), 1)).toBe('60');
    expect(stepNumber('95', step('setting-volume'), 1)).toBe('100');
    expect(stepNumber('10', step('setting-volume'), -1)).toBe('0');
    expect(stepNumber('0', step('setting-volume'), -1)).toBe('0');
  });

  it('数として読めない値は変えない', () => {
    expect(stepNumber('', step('setting-fov'), 1)).toBeUndefined();
    expect(stepNumber('abc', step('setting-fov'), 1)).toBeUndefined();
  });
});

describe('クロスヘアの色の左右', () => {
  it('UI-50: #77ccff で右を押すと #ffffff', () => {
    expect(stepColor('#77ccff', 1)).toBe('#ffffff');
  });

  it('並びの端で止まり、並びにない色は右で最初、左で最後の色になる', () => {
    expect(stepColor('#77ccff', -1)).toBe('#77ccff');
    expect(stepColor('#ff8800', 1)).toBe('#ff8800');
    expect(stepColor('#123456', 1)).toBe(CROSSHAIR_COLOR_STEPS[0]);
    expect(stepColor('#123456', -1)).toBe('#ff8800');
    expect(stepColor('#FFFFFF', 1)).toBe('#ff0000');
  });
});

describe('選択肢の欄の左右', () => {
  it('前・次の選択肢を選び、最初と最後で止まり、選べない選択肢は飛ばす', () => {
    expect(stepChoice(0, [true, true, true], 1)).toBe(1);
    expect(stepChoice(0, [true, true, true], -1)).toBe(0);
    expect(stepChoice(2, [true, true, true], 1)).toBe(2);
    expect(stepChoice(0, [true, false, true], 1)).toBe(2);
    expect(stepChoice(0, [true, false], 1)).toBe(0);
  });
});

describe('フォーカスの移動', () => {
  const items = ['weapon', 'mode', 'count', 'start'];

  it('UI-47: フォーカスがないときは最初の項目に置き、次へ移り、最後の項目で止まる', () => {
    expect(moveFocus(items, undefined, 1)).toBe('weapon');
    expect(moveFocus(items, undefined, -1)).toBe('weapon');
    expect(moveFocus(items, 'weapon', 1)).toBe('mode');
    expect(moveFocus(items, 'start', 1)).toBe('start');
    expect(moveFocus(items, 'weapon', -1)).toBe('weapon');
    expect(moveFocus([], undefined, 1)).toBeUndefined();
  });

  it('UI-51: 使えなくなった項目からは項目の順で次の使える項目、なければ前の使える項目へ移す', () => {
    const all = ['mode', 'deadzone', 'yaw', 'vibration'];
    const disabled = new Set(['deadzone', 'yaw']);
    const usable = (item: string) => !disabled.has(item);
    expect(relocateFocus(all, usable, 'deadzone')).toBe('vibration');
    expect(relocateFocus(all, (item) => item === 'mode', 'yaw')).toBe('mode');
    expect(relocateFocus(all, () => false, 'yaw')).toBeUndefined();
    expect(relocateFocus(all, usable, 'gone')).toBeUndefined();
  });
});
