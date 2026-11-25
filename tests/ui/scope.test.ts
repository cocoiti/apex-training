import { describe, expect, it } from 'vitest';
import { adsAfter, applyReticleColor, showAimDisplay, type ScopeElement } from '../../src/ui/scope';

function fakeScope() {
  const props = new Map<string, string>();
  const element: ScopeElement = { style: { setProperty: (name: string, value: string | null) => void props.set(name, value ?? '') } };
  return { element, props };
}

describe('ADS 中の照準の表示', () => {
  it('ads を押すとクロスヘアを隠してスコープを出し、離すと戻す', () => {
    const elements = { crosshair: { hidden: false }, scope: { hidden: true } };
    showAimDisplay(elements, true);
    expect(elements).toEqual({ crosshair: { hidden: true }, scope: { hidden: false } });
    showAimDisplay(elements, false);
    expect(elements).toEqual({ crosshair: { hidden: false }, scope: { hidden: true } });
  });

  it('レティクルの色はクロスヘアの色で、読めない色は既定の色にする', () => {
    const { element, props } = fakeScope();
    expect(applyReticleColor(element, '#F00')).toBe('#ff0000');
    expect(props.get('--reticle-color')).toBe('#ff0000');
    expect(applyReticleColor(element, 'red')).toBe('#77ccff');
    expect(applyReticleColor(element, undefined)).toBe('#77ccff');
  });

  it('ads の押下と解放だけが ads の状態を変える', () => {
    expect(adsAfter(false, { type: 'ads', pressed: true })).toBe(true);
    expect(adsAfter(true, { type: 'fire', pressed: false })).toBe(true);
    expect(adsAfter(true, { type: 'look', yaw: 1, pitch: 0 })).toBe(true);
    expect(adsAfter(true, { type: 'ads', pressed: false })).toBe(false);
  });
});
