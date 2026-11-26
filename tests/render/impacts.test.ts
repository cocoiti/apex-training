import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import range from '../../src/data/maps/range.json';
import { IMPACT_LIFT, IMPACT_NAME, ImpactMarks } from '../../src/render/impacts';
import { ViewScene } from '../../src/render/scene';
import type { ShotRecord } from '../../src/sim/gun';
import { vec3, type Vec3 } from '../../src/sim/vec3';
import { loadWorld, type World } from '../../src/sim/world';

function rangeWorld(): World {
  const result = loadWorld(range);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.world;
}

function shot(n: number, position: Vec3 | null): ShotRecord {
  return { shot: n, patternShot: n, time: n * 0.1, angles: { yaw: 0, pitch: 0 }, position, deviation: position ? { yaw: 0, pitch: 0 } : null };
}

const eye = vec3(0, 1.6, 0);
const marks = (view: ViewScene) => view.layer.group.children.filter((o) => o.name === IMPACT_NAME);

describe('弾痕の表示', () => {
  it('当たった弾ごとに弾痕を 1 つ足し、外れた弾は表示しない', () => {
    const view = new ViewScene(rangeWorld());
    const impacts = new ImpactMarks(view.layer);
    const shots = [shot(1, vec3(0, 1.6, -9.9)), shot(2, null), shot(3, vec3(1, 2, -10))];
    impacts.sync(shots, eye);
    expect(marks(view)).toHaveLength(2);
  });

  it('ARC-40: 練習の的に当たった弾（target を持つ）の弾痕は表示しない', () => {
    const view = new ViewScene(rangeWorld());
    const impacts = new ImpactMarks(view.layer);
    impacts.sync([{ ...shot(1, vec3(0, 1.6, -5)), target: 'mover' }, shot(2, vec3(0, 1.6, -9.9))], eye);
    expect(marks(view)).toHaveLength(1);
  });

  it('ARC-65: 弾痕を残す練習の的に当たった弾（impactOnTarget を持つ）の弾痕は、当たった点に表示する', () => {
    const view = new ViewScene(rangeWorld());
    const impacts = new ImpactMarks(view.layer);
    impacts.sync([{ ...shot(1, vec3(0.1, 1.7, -9.6)), target: 'dummy', impactOnTarget: true }, { ...shot(2, vec3(0, 1.6, -5)), target: 'mover' }], eye);
    const shown = marks(view);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.position.x).toBeCloseTo(0.1, 2);
    expect(shown[0]!.position.y).toBeCloseTo(1.7, 2);
    expect(shown[0]!.position.z).toBeGreaterThan(-9.6);
  });

  it('同じ記録で何度呼んでも増えず、新しく撃った分だけ足し、前の弾痕は残る', () => {
    const view = new ViewScene(rangeWorld());
    const impacts = new ImpactMarks(view.layer);
    const shots = [shot(1, vec3(0, 1.6, -9.9))];
    impacts.sync(shots, eye);
    impacts.sync(shots, eye);
    expect(marks(view)).toHaveLength(1);
    const first = marks(view)[0];
    shots.push(shot(2, vec3(0.2, 1.7, -10)));
    impacts.sync(shots, eye);
    expect(marks(view)).toHaveLength(2);
    expect(marks(view)[0]).toBe(first);
  });

  it('弾痕は当たった位置から目の側へわずかに浮かせ、目の方を向く', () => {
    const view = new ViewScene(rangeWorld());
    const impacts = new ImpactMarks(view.layer);
    impacts.sync([shot(1, vec3(0, 1.6, -9.9))], eye);
    const mark = marks(view)[0]!;
    expect(mark.position.x).toBeCloseTo(0, 9);
    expect(mark.position.y).toBeCloseTo(1.6, 9);
    expect(mark.position.z).toBeCloseTo(-9.9 + IMPACT_LIFT, 9);
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(mark.quaternion);
    expect(normal.z).toBeCloseTo(1, 9);
  });

  it('clear で弾痕がすべて消え、次の記録は先頭から表示する。層のほかの表示物は残す', () => {
    const view = new ViewScene(rangeWorld());
    const other = new THREE.Object3D();
    view.layer.add(other);
    const impacts = new ImpactMarks(view.layer);
    impacts.sync([shot(1, vec3(0, 1.6, -9.9)), shot(2, vec3(0, 1.7, -9.9))], eye);
    impacts.clear();
    expect(marks(view)).toHaveLength(0);
    expect(view.layer.group.children).toEqual([other]);
    impacts.sync([shot(1, vec3(0, 1.6, -9.9))], eye);
    expect(marks(view)).toHaveLength(1);
  });

  it('弾痕を足し引きしても World は変わらない', () => {
    const world = rangeWorld();
    const before = JSON.stringify(world);
    const view = new ViewScene(world);
    const impacts = new ImpactMarks(view.layer);
    impacts.sync([shot(1, vec3(0, 1.6, -9.9))], world.player.position);
    impacts.clear();
    expect(JSON.stringify(world)).toBe(before);
  });
});
