// 人形の的（docs/spec/architecture.md「人形の的」「照準と的の当たり」）を、ブラウザなしで確かめる。
import { describe, expect, it } from 'vitest';
import range from '../../src/data/maps/range.json';
import { inputFromTimedActions } from '../../src/input/queue';
import { directionFromAngles } from '../../src/sim/angles';
import { Gun } from '../../src/sim/gun';
import { anglesToPoint, raycastScene } from '../../src/sim/hit';
import {
  HUMANOID_DEPTH,
  HUMANOID_GAP,
  HUMANOID_HEIGHT,
  HUMANOID_TORSO_WIDTH,
  HUMANOID_WIDTH,
  humanoidParts,
  placeHumanoid,
  placeHumanoidSubtending,
} from '../../src/sim/humanoid';
import { parseMap } from '../../src/sim/map';
import { createRandom } from '../../src/core/random';
import { Simulation } from '../../src/sim/simulation';
import { partCenter, PracticeTargets, type PracticeTarget } from '../../src/sim/targets';
import { vec3, type Vec3 } from '../../src/sim/vec3';
import type { WeaponData } from '../../src/sim/weapon';
import { createWorld, type World } from '../../src/sim/world';

const EYE = vec3(0, 1.6, 0);

/** 目の位置から 10 メートル先に中心を置いた人形。 */
function dummyAt(center: Vec3, scale = 1): PracticeTarget {
  const targets = new PracticeTargets();
  targets.add({ id: 'dummy', parts: humanoidParts(scale), position: center });
  targets.update(1 / 120);
  return targets.get('dummy')!;
}

/** 照準を point に向けたとき、人形に乗っているか（手前にも奥にもマップの箱はない）。 */
const aimedAt = (target: PracticeTarget, point: Vec3) => raycastScene(EYE, directionFromAngles(anglesToPoint(EYE, point)), [], [target])?.target?.id === target.id;

const part = (target: PracticeTarget, id: string) => target.parts.find((p) => p.id === id)!;

function rangeWorld(): World {
  const parsed = parseMap(range);
  if (!parsed.ok) throw new Error('マップを読めない');
  return createWorld(parsed.map);
}

describe('人形の部分の箱', () => {
  it('縮尺 1 の人形は頭・胴・左右の腕・左右の脚の 6 つの箱で、高さ 1.8・幅 0.82・奥行き 0.25 メートル、前後の面がそろう', () => {
    const parts = humanoidParts(1);
    expect(parts.map((p) => [p.id, p.size.x, p.size.y, p.offset.x, p.offset.y])).toEqual([
      ['head', 0.25, 0.25, 0, 0.4],
      ['torso', 0.5, 0.55, 0, 0],
      ['rightArm', 0.12, 0.6, 0.35, -0.025],
      ['leftArm', 0.12, 0.6, -0.35, -0.025],
      ['rightLeg', 0.2, 1.0, 0.13, -0.775],
      ['leftLeg', 0.2, 1.0, -0.13, -0.775],
    ]);
    expect(parts.every((p) => p.size.z === HUMANOID_DEPTH && p.offset.z === 0)).toBe(true);
    const top = Math.max(...parts.map((p) => p.offset.y + p.size.y / 2));
    const bottom = Math.min(...parts.map((p) => p.offset.y - p.size.y / 2));
    const right = Math.max(...parts.map((p) => p.offset.x + p.size.x / 2));
    const left = Math.min(...parts.map((p) => p.offset.x - p.size.x / 2));
    expect(top - bottom).toBeCloseTo(HUMANOID_HEIGHT, 12);
    expect(right - left).toBeCloseTo(HUMANOID_WIDTH, 12);
    expect(parts.find((p) => p.id === 'torso')!.size.x).toBe(HUMANOID_TORSO_WIDTH);
  });

  it('ARC-64: 縮尺 0.5 の人形の部分の箱の大きさと中心からの相対的な位置は、縮尺 1 の値の 0.5 倍', () => {
    const one = humanoidParts(1);
    const half = humanoidParts(0.5);
    expect(half.map((p) => p.id)).toEqual(one.map((p) => p.id));
    half.forEach((p, i) => {
      const q = one[i]!;
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(p.size[axis]).toBeCloseTo(q.size[axis] * 0.5, 12);
        expect(p.offset[axis]).toBeCloseTo(q.offset[axis] * 0.5, 12);
      }
    });
  });

  it('ARC-63: 10 メートル先の縮尺 1 の人形で、中心・頭・右腕・右脚の中心に向けると乗っていて、脇の下・脚のあいだ・頭の右で肩より上・右端より外では乗っていない', () => {
    const center = vec3(0, 1.6, -10);
    const target = dummyAt(center);
    const at = (id: string) => partCenter(center, part(target, id));
    for (const point of [center, at('head'), at('rightArm'), at('rightLeg')]) expect(aimedAt(target, point)).toBe(true);
    const torso = part(target, 'torso');
    const arm = part(target, 'rightArm');
    const head = part(target, 'head');
    const armpit = vec3(center.x + (torso.size.x / 2 + (arm.offset.x - arm.size.x / 2)) / 2, center.y, center.z);
    const legs = vec3(center.x, at('rightLeg').y, center.z);
    const besideHead = vec3(center.x + head.size.x / 2 + 0.1, at('head').y, center.z);
    const outside = vec3(center.x + HUMANOID_WIDTH / 2 + 0.05, center.y, center.z);
    for (const point of [armpit, legs, besideHead, outside]) expect(aimedAt(target, point)).toBe(false);
  });

  it('ARC-63: 照準と弾の当たりは、マップの箱と人形の部分の箱のうち目の位置からいちばん近いものになり、当たった部分の箱を持つ', () => {
    const center = vec3(0, 1.6, -10);
    const target = dummyAt(center);
    const wall = { id: 'wall', kind: 'wall' as const, center: vec3(0, 1.6, -12), size: vec3(20, 20, 0.2) };
    const hit = raycastScene(EYE, directionFromAngles(anglesToPoint(EYE, center)), [wall], [target]);
    expect(hit?.target?.id).toBe('dummy');
    expect(hit?.part?.id).toBe('torso');
    expect(hit?.position.z).toBeCloseTo(center.z + HUMANOID_DEPTH / 2, 12);
    // 脇の下の空きを通った照準は、奥の壁に当たる。
    const gap = raycastScene(EYE, directionFromAngles(anglesToPoint(EYE, vec3(0.27, 1.6, -10))), [wall], [target]);
    expect(gap?.box?.id).toBe('wall');
    expect(gap?.target).toBeUndefined();
  });
});

describe('人形の置き方', () => {
  it('縮尺 1 の人形を開始時の照準のレイの上に、後ろの面をマップの箱のいちばん手前の面より 0.05 メートル手前にして置く（range では約 9.7 メートル先）', () => {
    const world = rangeWorld();
    const placed = placeHumanoid(world, world.center, 1);
    const front = Math.max(...world.boxes.map((b) => b.center.z + b.size.z / 2));
    expect(placed.scale).toBe(1);
    expect(placed.center.z - HUMANOID_DEPTH / 2).toBeCloseTo(front + HUMANOID_GAP, 12);
    expect(placed.distance).toBeCloseTo(9.725, 12);
    expect(placed.center.x).toBeCloseTo(0, 12);
    expect(placed.center.y).toBeCloseTo(1.6, 12);
    const seen = anglesToPoint(world.player.position, placed.center);
    expect(seen.yaw).toBeCloseTo(world.center.yaw, 12);
    expect(seen.pitch).toBeCloseTo(world.center.pitch, 12);
  });

  it('胴の幅の見込み角を決めて置くと、縮尺は胴の幅が 2 × L × tan(見込み角 ÷ 2) になる値で、奥行きも縮尺に合わせて後ろの面がそろう', () => {
    const world = rangeWorld();
    const placed = placeHumanoidSubtending(world, { yaw: 12, pitch: -3 }, 2);
    const front = Math.max(...world.boxes.map((b) => b.center.z + b.size.z / 2));
    expect(placed.center.z - (HUMANOID_DEPTH * placed.scale) / 2).toBeCloseTo(front + HUMANOID_GAP, 12);
    const eye = world.player.position;
    const distance = Math.hypot(placed.center.x - eye.x, placed.center.y - eye.y, placed.center.z - eye.z);
    expect(placed.distance).toBeCloseTo(distance, 12);
    expect(HUMANOID_TORSO_WIDTH * placed.scale).toBeCloseTo(2 * distance * Math.tan(Math.PI / 180), 12);
  });
});

describe('弾痕を残す練習の的', () => {
  const zero: WeaponData = {
    id: 'zero',
    name: 'zero',
    category: 'ar',
    version: 'test',
    source: 'test',
    rpm: 600,
    magSize: 3,
    randomness: 0,
    measured: true,
    pattern: Array.from({ length: 3 }, () => ({ dx: 0, dy: 0 })),
  };

  const shoot = (keepsImpacts: boolean) => {
    const world = rangeWorld();
    world.targets.add({ id: 'dummy', parts: humanoidParts(1), position: placeHumanoid(world, world.center).center, keepsImpacts });
    const sim = new Simulation(world, inputFromTimedActions([{ time: 0, action: { type: 'fire', pressed: true } }]));
    const gun = new Gun(zero, createRandom(1));
    sim.addStepHook((w, dt) => gun.step(w, dt));
    for (let i = 0; i < 60; i += 1) sim.step();
    return gun.shots;
  };

  it('ARC-65: 弾痕を残す的に当たった弾は的の識別子を持ち、当たった点を弾痕の位置として記録する', () => {
    const shots = shoot(true);
    expect(shots).toHaveLength(3);
    for (const shot of shots) {
      expect(shot.target).toBe('dummy');
      expect(shot.impactOnTarget).toBe(true);
      expect(shot.position!.z).toBeCloseTo(-9.6, 12);
      expect(shot.deviation!.yaw).toBeCloseTo(0, 12);
      expect(shot.deviation!.pitch).toBeCloseTo(0, 12);
    }
  });

  it('ARC-65: 弾痕を残さない的に当たった弾は的の識別子だけを持ち、弾痕を残す印を持たない', () => {
    const shots = shoot(false);
    expect(shots.every((s) => s.target === 'dummy' && s.impactOnTarget === undefined)).toBe(true);
  });
});
