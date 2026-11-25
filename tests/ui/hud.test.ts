import { describe, expect, it } from 'vitest';
import { formatElapsed, hudTexts, renderHud } from '../../src/ui/hud';

describe('HUD', () => {
  it.each([
    [0, '0.0 秒'],
    [0.05, '0.0 秒'],
    [1.25, '1.2 秒'],
    [1.99, '1.9 秒'],
    [2, '2.0 秒'],
    [12.3, '12.3 秒'],
    [-1, '0.0 秒'],
  ])('経過時間 %s 秒は「%s」と表示する（小数第 1 位まで、切り捨て）', (seconds, text) => {
    expect(formatElapsed(seconds)).toBe(text);
  });

  it('固定ステップの時刻の誤差で 0.1 秒の境目を切り捨てすぎない', () => {
    const dt = 1 / 120;
    expect(formatElapsed(36 * dt)).toBe('0.3 秒');
    expect(formatElapsed(1200 * dt)).toBe('10.0 秒');
  });

  it('武器名・残弾と装弾数・経過時間・入力方式の文字にする', () => {
    expect(hudTexts({ weaponName: 'L-STAR', ammo: 23, magSize: 24, elapsed: 0.4, inputMethod: 'mouse' })).toEqual({
      weapon: 'L-STAR',
      ammo: '残弾 23 / 24',
      time: '0.4 秒',
      input: 'マウス',
    });
    expect(hudTexts({ weaponName: 'L-STAR', ammo: 23, magSize: 24, elapsed: 0.4, inputMethod: 'pad' }).input).toBe('パッド');
  });

  it('要素の文字を書き換える', () => {
    const elements = { weapon: { textContent: '' }, ammo: { textContent: '' }, time: { textContent: '' }, input: { textContent: '' } };
    renderHud(elements, { weaponName: 'R-301', ammo: 28, magSize: 28, elapsed: 0, inputMethod: 'mouse' });
    expect(elements).toEqual({
      weapon: { textContent: 'R-301' },
      ammo: { textContent: '残弾 28 / 28' },
      time: { textContent: '0.0 秒' },
      input: { textContent: 'マウス' },
    });
    renderHud(elements, { weaponName: 'R-301', ammo: 27, magSize: 28, elapsed: 0.1, inputMethod: 'pad' });
    expect(elements.ammo.textContent).toBe('残弾 27 / 28');
    expect(elements.input.textContent).toBe('パッド');
  });
});
