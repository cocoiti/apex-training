import { describe, expect, it } from 'vitest';
import { interpolateAngles } from '../../src/render/scene';

describe('照準の向きの補間', () => {
  it('補間の係数に応じて間を取る', () => {
    expect(interpolateAngles({ yaw: 0, pitch: 0 }, { yaw: 10, pitch: -4 }, 0.25)).toEqual({ yaw: 2.5, pitch: -1 });
  });

  it('ヨーは ±180 度をまたぐとき近い側を回る', () => {
    const mid = interpolateAngles({ yaw: 170, pitch: 0 }, { yaw: -170, pitch: 0 }, 0.5);
    expect(mid.yaw).toBeCloseTo(180, 9);
  });
});
