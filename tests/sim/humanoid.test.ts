// 人型の板の的（docs/spec/architecture.md「練習の的」「人型の板の的」「照準と的の当たり」）を、ブラウザなしで確かめる。
import { describe, expect, it } from 'vitest';
import range from '../../src/data/maps/range.json';
import { inputFromTimedActions } from '../../src/input/queue';
import { directionFromAngles } from '../../src/sim/angles';
import { Gun } from '../../src/sim/gun';
import { anglesToPoint, raycastScene } from '../../src/sim/hit';
import {
  HUMANOID_GAP,
  HUMANOID_HEIGHT,
  HUMANOID_OUTLINE,
  HUMANOID_THICKNESS,
  HUMANOID_WIDTH,
  humanoidPlate,
  placeHumanoid,
  placeHumanoidSubtending,
} from '../../src/sim/humanoid';
import { parseMap } from '../../src/sim/map';
import { createRandom } from '../../src/core/random';
import { Simulation } from '../../src/sim/simulation';
import { insideOutline, PracticeTargets, type PracticeTarget } from '../../src/sim/targets';
import { vec3, type Vec3 } from '../../src/sim/vec3';
import type { WeaponData } from '../../src/sim/weapon';
import { createWorld, type World } from '../../src/sim/world';

const EYE = vec3(0, 1.6, 0);

/** 中心を center に置いた人型の板。 */
function plateAt(center: Vec3, scale = 1): PracticeTarget {
  const targets = new PracticeTargets();
  targets.add({ id: 'dummy', plate: humanoidPlate(scale), position: center });
  targets.update(1 / 120);
  return targets.get('dummy')!;
}

/** 照準を板の正面の面の上の点（板の中心からの相対的な位置 (x, y)）に向けたとき、板に乗っているか（マップの箱はない）。 */
const aimedAt = (target: PracticeTarget, x: number, y: number) => {
  const point = vec3(target.center.x + x, target.center.y + y, target.center.z);
  return raycastScene(EYE, directionFromAngles(anglesToPoint(EYE, point)), [], [target])?.target?.id === target.id;
};

function rangeWorld(): World {
  const parsed = parseMap(range);
  if (!parsed.ok) throw new Error('マップを読めない');
  return createWorld(parsed.map);
}

describe('人型の板の輪郭', () => {
  it('縮尺 1 の輪郭は SPEC の表の 16 個の頂点で、右半分を下から、左半分を上から並べ、幅 0.45・高さ 0.75・厚み 0.01 メートル', () => {
    expect(HUMANOID_OUTLINE).toHaveLength(16);
    expect(HUMANOID_OUTLINE.slice(0, 8).map((p) => [p.x, p.y])).toEqual([
      [0.225, -0.3],
      [0.225, 0.1],
      [0.17, 0.17],
      [0.05, 0.2],
      [0.05, 0.25],
      [0.08, 0.28],
      [0.08, 0.42],
      [0.05, 0.45],
    ]);
    HUMANOID_OUTLINE.slice(8).forEach((p, i) => {
      const mirror = HUMANOID_OUTLINE[7 - i]!;
      expect([p.x, p.y]).toEqual([-mirror.x, mirror.y]);
    });
    const plate = humanoidPlate(1);
    const xs = plate.outline.map((p) => p.x);
    const ys = plate.outline.map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(HUMANOID_WIDTH, 12);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(HUMANOID_HEIGHT, 12);
    expect(plate.thickness).toBe(HUMANOID_THICKNESS);
    expect(HUMANOID_THICKNESS).toBe(0.01);
  });

  it('ARC-64: 縮尺 0.5 の板の輪郭の頂点は縮尺 1 の値の 0.5 倍で、厚みは 0.01 メートルのまま。区域の線も縮尺に比例する', () => {
    const one = humanoidPlate(1);
    const half = humanoidPlate(0.5);
    expect(half.outline).toHaveLength(one.outline.length);
    half.outline.forEach((p, i) => {
      expect(p.x).toBeCloseTo(one.outline[i]!.x * 0.5, 12);
      expect(p.y).toBeCloseTo(one.outline[i]!.y * 0.5, 12);
    });
    expect(half.thickness).toBe(0.01);
    expect(one.zones!.map((z) => [z.id, z.center.x, z.center.y, z.width, z.height])).toEqual([
      ['head', 0, 0.35, 0.1, 0.12],
      ['torso', 0, 0, 0.15, 0.2],
    ]);
    half.zones!.forEach((z, i) => {
      const w = one.zones![i]!;
      expect(z.center.y).toBeCloseTo(w.center.y * 0.5, 12);
      expect(z.width).toBeCloseTo(w.width * 0.5, 12);
      expect(z.height).toBeCloseTo(w.height * 0.5, 12);
    });
  });

  it('輪郭の内側と線の上は内側、外側は外側（凹んだ所の頭と肩のあいだも外側）', () => {
    const outline = HUMANOID_OUTLINE;
    for (const [x, y] of [[0, 0], [0.225, 0], [0.225, -0.3], [0, 0.45], [0.05, 0.22], [-0.2, 0.05]] as const) expect(insideOutline(outline, x, y)).toBe(true);
    for (const [x, y] of [[0.13, 0.25], [-0.13, 0.25], [0.2251, 0], [0, 0.4501], [0, -0.3001], [0.09, 0.35]] as const) expect(insideOutline(outline, x, y)).toBe(false);
  });
});

describe('人型の板の当たり', () => {
  it('ARC-63: 10 メートル先の縮尺 1 の板で、中心・頭の中心・右肩の内側・胴の右下の角の内側は乗っていて、頭と肩のあいだ・右の辺のすぐ外・頭の上・胴の下では乗っていない', () => {
    const target = plateAt(vec3(0, 1.6, -10));
    for (const [x, y] of [[0, 0], [0, 0.35], [0.2, 0.05], [0.21, -0.28]] as const) expect(aimedAt(target, x, y), `(${x}, ${y})`).toBe(true);
    for (const [x, y] of [[0.13, 0.25], [0.24, 0], [0, 0.47], [0, -0.32]] as const) expect(aimedAt(target, x, y), `(${x}, ${y})`).toBe(false);
  });

  it('ARC-74: 8 メートル先で右に 3 メートルずらした板（約 20 度斜め）でも、輪郭の内側は乗っていて、すぐ外は乗っていない', () => {
    const target = plateAt(vec3(3, 1.6, -8));
    expect((Math.atan2(3, 8) * 180) / Math.PI).toBeCloseTo(20.6, 1);
    for (const [x, y] of [[0, 0], [0, 0.35], [0.2, 0.05]] as const) expect(aimedAt(target, x, y), `(${x}, ${y})`).toBe(true);
    for (const [x, y] of [[0.13, 0.25], [-0.13, 0.25], [0.245, 0], [-0.245, 0]] as const) expect(aimedAt(target, x, y), `(${x}, ${y})`).toBe(false);
  });

  it('ARC-75: 輪郭の内側への向きの当たりは板の正面の面の上にあり、マップの箱より手前なら板に当たる。輪郭の外を通ると奥の壁に当たる', () => {
    const center = vec3(0.5, 1.7, -9);
    const target = plateAt(center);
    const wall = { id: 'wall', kind: 'wall' as const, center: vec3(0, 1.6, -12), size: vec3(20, 20, 0.2) };
    const hit = raycastScene(EYE, directionFromAngles(anglesToPoint(EYE, vec3(center.x + 0.1, center.y + 0.1, center.z))), [wall], [target]);
    expect(hit?.target?.id).toBe('dummy');
    expect(hit?.part).toBeUndefined();
    expect(hit?.position.z).toBe(center.z);
    const gap = raycastScene(EYE, directionFromAngles(anglesToPoint(EYE, vec3(center.x + 0.13, center.y + 0.25, center.z))), [wall], [target]);
    expect(gap?.box?.id).toBe('wall');
    expect(gap?.target).toBeUndefined();
  });

  it('板の後ろの側（奥）から来たレイと、手前に壁があるレイは板に当たらない', () => {
    const target = plateAt(vec3(0, 1.6, -10));
    // 板より奥の点から手前に向けたレイ（後ろの面）。
    expect(raycastScene(vec3(0, 1.6, -11), vec3(0, 0, 1), [], [target])).toBeUndefined();
    const near = { id: 'near', kind: 'wall' as const, center: vec3(0, 1.6, -5), size: vec3(2, 2, 0.2) };
    expect(raycastScene(EYE, vec3(0, 0, -1), [near], [target])?.box?.id).toBe('near');
  });
});

describe('人型の板の置き方', () => {
  it('縮尺 1 の板を開始時の照準のレイの上に、正面の面をマップの箱のいちばん手前の面より 0.05 メートル手前にして置く（range では 9.85 メートル先）', () => {
    const world = rangeWorld();
    const placed = placeHumanoid(world, world.center, 1);
    const front = Math.max(...world.boxes.map((b) => b.center.z + b.size.z / 2));
    expect(placed.scale).toBe(1);
    expect(placed.center.z).toBeCloseTo(front + HUMANOID_GAP, 12);
    expect(placed.distance).toBeCloseTo(9.85, 12);
    expect(placed.center.x).toBeCloseTo(0, 12);
    expect(placed.center.y).toBeCloseTo(1.6, 12);
    const seen = anglesToPoint(world.player.position, placed.center);
    expect(seen.yaw).toBeCloseTo(world.center.yaw, 12);
    expect(seen.pitch).toBeCloseTo(world.center.pitch, 12);
  });

  it('板の幅の見込み角を決めて置くと、縮尺は板の幅が 2 × L × tan(見込み角 ÷ 2) になる値で、正面の面の位置は縮尺によらない', () => {
    const world = rangeWorld();
    const placed = placeHumanoidSubtending(world, { yaw: 12, pitch: -3 }, 2);
    const front = Math.max(...world.boxes.map((b) => b.center.z + b.size.z / 2));
    expect(placed.center.z).toBeCloseTo(front + HUMANOID_GAP, 12);
    const eye = world.player.position;
    const distance = Math.hypot(placed.center.x - eye.x, placed.center.y - eye.y, placed.center.z - eye.z);
    expect(placed.distance).toBeCloseTo(distance, 12);
    expect(HUMANOID_WIDTH * placed.scale).toBeCloseTo(2 * distance * Math.tan(Math.PI / 180), 12);
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
    world.targets.add({ id: 'dummy', plate: humanoidPlate(1), position: placeHumanoid(world, world.center).center, keepsImpacts });
    const sim = new Simulation(world, inputFromTimedActions([{ time: 0, action: { type: 'fire', pressed: true } }]));
    const gun = new Gun(zero, createRandom(1));
    sim.addStepHook((w, dt) => gun.step(w, dt));
    for (let i = 0; i < 60; i += 1) sim.step();
    return gun.shots;
  };

  it('ARC-65: 弾痕を残す板の的に当たった弾は的の識別子を持ち、板の正面の上の当たった点を弾痕の位置として記録する', () => {
    const shots = shoot(true);
    expect(shots).toHaveLength(3);
    for (const shot of shots) {
      expect(shot.target).toBe('dummy');
      expect(shot.impactOnTarget).toBe(true);
      expect(shot.position!.z).toBeCloseTo(-9.85, 12);
      expect(shot.deviation!.yaw).toBeCloseTo(0, 12);
      expect(shot.deviation!.pitch).toBeCloseTo(0, 12);
    }
  });

  it('ARC-65: 弾痕を残さない的に当たった弾は的の識別子だけを持ち、弾痕を残す印を持たない', () => {
    const shots = shoot(false);
    expect(shots.every((s) => s.target === 'dummy' && s.impactOnTarget === undefined)).toBe(true);
  });
});
