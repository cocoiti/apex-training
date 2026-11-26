import { describe, expect, it } from 'vitest';
import { MODE_ICONS } from '../../src/modes/types';
import { ICON_SIZE, MODE_ICON_SHAPES } from '../../src/ui/mode-icons';

describe('モードのカードのアイコン', () => {
  it('UI-112: アイコンの形ごとに図を持ち、形どうしで図が違う', () => {
    expect(Object.keys(MODE_ICON_SHAPES).sort()).toEqual([...MODE_ICONS].sort());
    const drawn = MODE_ICONS.map((icon) => JSON.stringify(MODE_ICON_SHAPES[icon]));
    expect(new Set(drawn).size).toBe(MODE_ICONS.length);
    for (const icon of MODE_ICONS) expect(MODE_ICON_SHAPES[icon].length, icon).toBeGreaterThan(0);
  });

  it('UI-119: 図は SVG の形だけで描き、画像や外部の資産を参照せず、線と塗りは文字の色（currentColor）にする', () => {
    for (const icon of MODE_ICONS) {
      for (const shape of MODE_ICON_SHAPES[icon]) {
        expect(['circle', 'path', 'line']).toContain(shape.tag);
        const text = JSON.stringify(shape.attrs);
        expect(text).not.toMatch(/url\(|href|https?:/);
        for (const paint of [shape.attrs.fill, shape.attrs.stroke]) if (paint !== undefined && paint !== 'none') expect(paint).toBe('currentColor');
      }
    }
  });

  it('円の中心は図の範囲の中にある', () => {
    for (const icon of MODE_ICONS) {
      for (const shape of MODE_ICON_SHAPES[icon].filter((s) => s.tag === 'circle')) {
        const { cx, cy } = shape.attrs as { cx: number; cy: number };
        expect(cx).toBeGreaterThanOrEqual(0);
        expect(cx).toBeLessThanOrEqual(ICON_SIZE);
        expect(cy).toBeGreaterThanOrEqual(0);
        expect(cy).toBeLessThanOrEqual(ICON_SIZE);
      }
    }
  });
});
