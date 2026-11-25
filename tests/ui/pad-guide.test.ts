import { describe, expect, it } from 'vitest';
import { DEFAULT_PAD_SETTINGS, stickPosition, type PadSettings } from '../../src/input/pad-curve';
import { UNKNOWN_PAD_NAME } from '../../src/input/pad-layout';
import { padGuideState, padGuideVisible, renderPadGuide } from '../../src/ui/pad-guide';

const classic: PadSettings = { ...DEFAULT_PAD_SETTINGS, deadzone: 10, outerThreshold: 2, responseCurve: 8 };

function fakeDot() {
  const vars = new Map<string, string>();
  const attrs = new Map<string, string>();
  return {
    vars,
    attrs,
    style: { setProperty: (name: string, value: string) => void vars.set(name, value) },
    setAttribute: (name: string, value: string) => void attrs.set(name, value),
  };
}

function elements() {
  return { root: { hidden: true }, ideal: fakeDot(), current: fakeDot(), name: { textContent: '' } };
}

describe('ガイドを表示するか', () => {
  it('PAD-17: ゴーストの位置があって（反復練習）、今の入力方式がパッドなら、ゴースト表示の設定によらず表示する', () => {
    expect(padGuideVisible({ ghostShown: true, inputMethod: 'pad' })).toBe(true);
  });

  it('PAD-18: 入力方式がマウス、ゴーストの位置がない（センター維持・撃ち切った）ときは表示しない', () => {
    expect(padGuideVisible({ ghostShown: true, inputMethod: 'mouse' })).toBe(false);
    expect(padGuideVisible({ ghostShown: false, inputMethod: 'pad' })).toBe(false);
  });
});

describe('ガイドに出すもの', () => {
  it('PAD-17: 理想の位置は理想の補正速度をカーブの逆で直した位置、今の位置はスティックの値のまま', () => {
    const idealRate = { yaw: -20, pitch: -60 };
    const state = padGuideState({ idealRate, ads: false, settings: classic, stick: { x: 0.05, y: -0.3 }, name: 'DualSense' });
    expect(state.ideal).toEqual(stickPosition(idealRate, classic, false));
    expect(state.current).toEqual({ x: 0.05, y: -0.3 });
    expect(state.name).toBe('DualSense');
  });

  it('ADS 中は ADS の最大回転速度で直す', () => {
    const idealRate = { yaw: 0, pitch: -30 };
    const state = padGuideState({ idealRate, ads: true, settings: classic, stick: { x: 0, y: 0 }, name: undefined });
    expect(state.ideal).toEqual(stickPosition(idealRate, classic, true));
  });

  it('名前が分からないときは「パッド」、今の位置は円の縁に収める', () => {
    const state = padGuideState({ idealRate: { yaw: 0, pitch: 0 }, ads: false, settings: classic, stick: { x: 1, y: 1 }, name: undefined });
    expect(state.name).toBe(UNKNOWN_PAD_NAME);
    expect(state.current.x).toBeCloseTo(Math.SQRT1_2, 12);
    expect(state.current.y).toBeCloseTo(Math.SQRT1_2, 12);
    expect(state.ideal).toEqual({ x: 0, y: 0 });
  });
});

describe('ガイドの要素', () => {
  it('点を右と上が正の % で置き、名前を書いて表示する。state がなければ隠す', () => {
    const e = elements();
    renderPadGuide(e, { ideal: { x: 0.54, y: 0 }, current: { x: -0.125, y: 0.5 }, name: 'Xbox Wireless Controller' });
    expect(e.root.hidden).toBe(false);
    expect(e.ideal.vars.get('--x')).toBe('54');
    expect(e.ideal.vars.get('--y')).toBe('0');
    expect(e.ideal.attrs.get('data-x')).toBe('54');
    expect(e.current.vars.get('--x')).toBe('-12.5');
    expect(e.current.attrs.get('data-y')).toBe('50');
    expect(e.name.textContent).toBe('Xbox Wireless Controller');

    renderPadGuide(e, undefined);
    expect(e.root.hidden).toBe(true);
  });
});
