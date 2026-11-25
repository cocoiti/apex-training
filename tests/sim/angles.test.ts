import { describe, expect, it } from 'vitest';
import { clampPitch, directionFromAngles, normalizeYaw } from '../../src/sim/angles';
import { applyLook, createPlayer } from '../../src/sim/player';
import { vec3 } from '../../src/sim/vec3';

function expectVec(actual: { x: number; y: number; z: number }, x: number, y: number, z: number) {
  expect(actual.x).toBeCloseTo(x, 12);
  expect(actual.y).toBeCloseTo(y, 12);
  expect(actual.z).toBeCloseTo(z, 12);
}

describe('座標系と角度', () => {
  it('ARC-8: ヨー 0 度・ピッチ 0 度の方向ベクトルは (0, 0, -1)', () => {
    expectVec(directionFromAngles({ yaw: 0, pitch: 0 }), 0, 0, -1);
  });

  it('ARC-8: ヨー 90 度・ピッチ 0 度の方向ベクトルは (1, 0, 0)', () => {
    expectVec(directionFromAngles({ yaw: 90, pitch: 0 }), 1, 0, 0);
  });

  it('ARC-8: ヨー 0 度・ピッチ 0 度からピッチ 90 度の入力を与えるとピッチは 89 度になる', () => {
    const player = createPlayer(vec3(0, 0, 0), { yaw: 0, pitch: 0 });
    applyLook(player, { yaw: 0, pitch: 90 });
    expect(player.aim.pitch).toBe(89);
  });

  it('ピッチが正なら上（+Y）を向く', () => {
    expect(directionFromAngles({ yaw: 0, pitch: 30 }).y).toBeGreaterThan(0);
  });

  it('ピッチは -89 度〜+89 度に収める', () => {
    expect(clampPitch(-120)).toBe(-89);
    expect(clampPitch(45)).toBe(45);
  });

  it.each([
    [0, 0],
    [180, 180],
    [-180, 180],
    [190, -170],
    [-190, 170],
    [540, 180],
    [-359, 1],
  ])('ヨー %d 度は %d 度に正規化する', (input, expected) => {
    expect(normalizeYaw(input)).toBeCloseTo(expected, 12);
  });
});
