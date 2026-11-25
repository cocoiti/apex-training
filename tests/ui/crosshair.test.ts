import { describe, expect, it } from 'vitest';
import { applyCrosshair, DEFAULT_CROSSHAIR, normalizeColor, resolveCrosshair, type CrosshairElement } from '../../src/ui/crosshair';

function fakeElement() {
  const props = new Map<string, string>();
  const element: CrosshairElement = {
    dataset: {},
    style: { setProperty: (name: string, value: string | null) => void props.set(name, value ?? '') },
  };
  return { element, props };
}

describe('クロスヘア', () => {
  it('既定は点で、色は #77ccff', () => {
    expect(DEFAULT_CROSSHAIR).toEqual({ shape: 'dot', color: '#77ccff' });
    const { element, props } = fakeElement();
    expect(applyCrosshair(element)).toEqual(DEFAULT_CROSSHAIR);
    expect(element.dataset.shape).toBe('dot');
    expect(props.get('--crosshair-color')).toBe('#77ccff');
  });

  it('色と形を指定し直すと、その色と形になる', () => {
    const { element, props } = fakeElement();
    applyCrosshair(element);
    applyCrosshair(element, { shape: 'cross', color: '#FF0000' });
    expect(element.dataset.shape).toBe('cross');
    expect(props.get('--crosshair-color')).toBe('#ff0000');
  });

  it('読めない形や色は既定にする', () => {
    expect(resolveCrosshair({ shape: 'star', color: 'red' })).toEqual(DEFAULT_CROSSHAIR);
    expect(resolveCrosshair({ shape: 'circle' })).toEqual({ shape: 'circle', color: '#77ccff' });
  });

  it('色は #rgb も受け取り、#rrggbb にする', () => {
    expect(normalizeColor('#7cf')).toBe('#77ccff');
    expect(normalizeColor(' #A1B2C3 ')).toBe('#a1b2c3');
    expect(normalizeColor('#12345')).toBeUndefined();
  });
});
