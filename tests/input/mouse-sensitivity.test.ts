import { describe, expect, it } from 'vitest';
import {
  cmPer360,
  countsToLook,
  DEFAULT_MOUSE_SETTINGS,
  DEGREES_PER_COUNT,
  degreesPerCount,
  formatCmPer360,
} from '../../src/input/mouse-sensitivity';

describe('マウスの感度の換算', () => {
  it('係数は 0.022 度 / カウント / 感度、既定値は DPI 800・感度 1.5・ADS 倍率 1.0', () => {
    expect(DEGREES_PER_COUNT).toBe(0.022);
    expect(DEFAULT_MOUSE_SETTINGS).toEqual({ dpi: 800, sensitivity: 1.5, adsMultiplier: 1 });
  });

  it('MOU-4: DPI 800・感度 1.5 の cm/360 は 34.6', () => {
    expect(cmPer360(800, 1.5)).toBeCloseTo(34.636, 3);
    expect(formatCmPer360(cmPer360(800, 1.5))).toBe('34.6');
  });

  it('cm/360 は DPI と感度に反比例し、0 以下では求められない', () => {
    expect(cmPer360(1600, 1.5)).toBeCloseTo(cmPer360(800, 1.5) / 2, 9);
    expect(cmPer360(800, 3)).toBeCloseTo(cmPer360(800, 1.5) / 2, 9);
    expect(cmPer360(0, 1.5)).toBe(Infinity);
    expect(cmPer360(800, -1)).toBe(Infinity);
    expect(formatCmPer360(Infinity)).toBe('—');
  });

  it('MOU-5: 感度 2.0 で水平に 1000 カウントはヨー 44 度', () => {
    const look = countsToLook(1000, 0, { ...DEFAULT_MOUSE_SETTINGS, sensitivity: 2 }, false);
    expect(look.yaw).toBeCloseTo(44, 9);
    expect(Object.is(look.pitch, 0)).toBe(true);
  });

  it('MOU-6: 感度 2.0・ADS 倍率 0.5 の ADS 中は 1000 カウントでヨー 22 度、腰撃ちでは 44 度', () => {
    const settings = { dpi: 800, sensitivity: 2, adsMultiplier: 0.5 };
    expect(countsToLook(1000, 0, settings, true).yaw).toBeCloseTo(22, 9);
    expect(countsToLook(1000, 0, settings, false).yaw).toBeCloseTo(44, 9);
    expect(degreesPerCount(settings, true)).toBeCloseTo(0.022, 12);
  });

  it('MOU-10: 感度 2.0 で前に 1000 カウント（movementY が -1000）はピッチが 44 度増える', () => {
    const look = countsToLook(0, -1000, { ...DEFAULT_MOUSE_SETTINGS, sensitivity: 2 }, false);
    expect(look.pitch).toBeCloseTo(44, 9);
    expect(look.yaw).toBe(0);
  });

  it('MOU-11: 既定値では水平に 1000 カウントでヨーが 33 度変わる', () => {
    expect(countsToLook(1000, 0, DEFAULT_MOUSE_SETTINGS, false).yaw).toBeCloseTo(33, 9);
    expect(countsToLook(1000, 0, DEFAULT_MOUSE_SETTINGS, true).yaw).toBeCloseTo(33, 9);
  });
});
