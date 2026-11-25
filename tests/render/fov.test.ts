import { describe, expect, it } from 'vitest';
import { DEFAULT_FOV, fieldOfView, projectAngleOffset } from '../../src/render/fov';

describe('FOV の値から視野角への換算', () => {
  it('既定の FOV は 90', () => {
    expect(DEFAULT_FOV).toBe(90);
  });

  it('FOV 90・16:9 は水平約 106.3 度、縦約 73.7 度', () => {
    const view = fieldOfView(90, 16 / 9);
    expect(view.horizontal).toBeCloseTo(106.26, 2);
    expect(view.vertical).toBeCloseTo(73.74, 2);
  });

  it('FOV 90・4:3 は水平 90 度で、FOV の値そのもの', () => {
    expect(fieldOfView(90, 4 / 3).horizontal).toBeCloseTo(90, 9);
    expect(fieldOfView(110, 4 / 3).horizontal).toBeCloseTo(110, 9);
  });

  it('縦の視野角は縦横比によらない', () => {
    expect(fieldOfView(100, 21 / 9).vertical).toBeCloseTo(fieldOfView(100, 1).vertical, 9);
  });
});

describe('角度のズレから画面上の位置への換算', () => {
  const W = 1920;
  const H = 1080;

  it('ズレがないときは中心', () => {
    const p = projectAngleOffset({ yaw: 0, pitch: 0 }, 90, W, H);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(0, 9);
  });

  it('水平視野角の半分のズレは画面の端', () => {
    const half = fieldOfView(90, W / H).horizontal / 2;
    expect(projectAngleOffset({ yaw: half, pitch: 0 }, 90, W, H).x).toBeCloseTo(W / 2, 6);
    const vhalf = fieldOfView(90, W / H).vertical / 2;
    // 上へのズレは画面の上（y が負）。
    expect(projectAngleOffset({ yaw: 0, pitch: vhalf }, 90, W, H).y).toBeCloseTo(-H / 2, 6);
  });

  it('水平 2 度のズレは FOV 110 のほうが FOV 70 より中心に近い', () => {
    const narrow = projectAngleOffset({ yaw: 2, pitch: 0 }, 70, W, H);
    const wide = projectAngleOffset({ yaw: 2, pitch: 0 }, 110, W, H);
    expect(wide.x).toBeGreaterThan(0);
    expect(Math.abs(wide.x)).toBeLessThan(Math.abs(narrow.x));
  });
});
