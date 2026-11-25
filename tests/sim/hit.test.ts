import { describe, expect, it } from 'vitest';
import { directionFromAngles } from '../../src/sim/angles';
import { angularDeviation, anglesToPoint, raycastBoxes } from '../../src/sim/hit';
import type { Box } from '../../src/sim/map';
import { vec3 } from '../../src/sim/vec3';

const eye = vec3(0, 1.6, 0);
const wall: Box = { id: 'wall', kind: 'wall', center: vec3(0, 2.5, -10.1), size: vec3(12, 5, 0.2) };
const target: Box = { id: 'target', kind: 'target', center: vec3(0, 1.6, -9.95), size: vec3(0.6, 0.6, 0.1) };

describe('当たり判定', () => {
  it('最も近い箱の手前の面に当たる', () => {
    const hit = raycastBoxes(eye, directionFromAngles({ yaw: 0, pitch: 0 }), [wall, target]);
    expect(hit?.box.id).toBe('target');
    expect(hit?.position.z).toBeCloseTo(-9.9, 9);
    expect(hit?.distance).toBeCloseTo(9.9, 9);
  });

  it('的を外れた弾は奥の壁に当たる', () => {
    const hit = raycastBoxes(eye, directionFromAngles({ yaw: 5, pitch: 0 }), [target, wall]);
    expect(hit?.box.id).toBe('wall');
    expect(hit?.position.z).toBeCloseTo(-10, 9);
    expect(hit?.position.x).toBeCloseTo(10 * Math.tan((5 * Math.PI) / 180), 9);
  });

  it('どの箱にも当たらなければ undefined', () => {
    expect(raycastBoxes(eye, directionFromAngles({ yaw: 180, pitch: 0 }), [wall, target])).toBeUndefined();
    expect(raycastBoxes(eye, directionFromAngles({ yaw: 0, pitch: 60 }), [wall, target])).toBeUndefined();
    expect(raycastBoxes(eye, directionFromAngles({ yaw: 0, pitch: 0 }), [])).toBeUndefined();
  });
});

describe('角度のズレ', () => {
  it.each([
    [0, 0],
    [3, -2],
    [-1.5, 4.25],
  ])('ヨー %d・ピッチ %d の向きの点は、目の位置から見て同じ角度になる', (yaw, pitch) => {
    const d = directionFromAngles({ yaw, pitch });
    const point = vec3(eye.x + d.x * 7, eye.y + d.y * 7, eye.z + d.z * 7);
    const seen = anglesToPoint(eye, point);
    expect(seen.yaw).toBeCloseTo(yaw, 9);
    expect(seen.pitch).toBeCloseTo(pitch, 9);
  });

  it('中心との差を返し、ヨーは -180〜180 度に収める', () => {
    const d = directionFromAngles({ yaw: -179, pitch: 1 });
    const point = vec3(eye.x + d.x, eye.y + d.y, eye.z + d.z);
    const deviation = angularDeviation(eye, point, { yaw: 179, pitch: 0 });
    expect(deviation.yaw).toBeCloseTo(2, 9);
    expect(deviation.pitch).toBeCloseTo(1, 9);
  });
});
