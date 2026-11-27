// 反復練習の人型の板（docs/spec/modes.md「反復練習」）と、すべてのモードの的が人型の板であること（MODE-58）を、ブラウザなしで確かめる。
import { describe, expect, it } from 'vitest';
import range from '../../../src/data/maps/range.json';
import { inputFromTimedActions } from '../../../src/input/queue';
import ghostMode, { DRILL_DUMMY_ID } from '../../../src/modes/recoil/ghost';
import { modes } from '../../../src/modes/registry';
import { PracticeSession } from '../../../src/modes/session';
import { modeUsesWeapon } from '../../../src/modes/types';
import { ImpactMarks, IMPACT_NAME } from '../../../src/render/impacts';
import { ViewScene } from '../../../src/render/scene';
import { PRACTICE_TARGET_NAME, PRACTICE_TARGET_PART_NAME, PRACTICE_TARGET_PLATE_NAME, TargetMarks } from '../../../src/render/targets';
import { directionFromAngles } from '../../../src/sim/angles';
import { anglesToPoint } from '../../../src/sim/hit';
import { HUMANOID_OUTLINE, humanoidPlate } from '../../../src/sim/humanoid';
import { parseMap } from '../../../src/sim/map';
import { scoreShots } from '../../../src/sim/scoring';
import type { RecoilStep, WeaponData } from '../../../src/sim/weapon';
import { createWorld, type World } from '../../../src/sim/world';

function rangeWorld(): World {
  const parsed = parseMap(range);
  if (!parsed.ok) throw new Error('マップを読めない');
  return createWorld(parsed.map);
}

function weapon(pattern: (i: number) => RecoilStep, magSize = 20): WeaponData {
  return {
    id: 'test',
    name: 'テスト武器',
    category: 'AR',
    version: 'v',
    source: '仮データ',
    rpm: 600,
    magSize,
    pattern: Array.from({ length: magSize }, (_, i) => pattern(i)),
    randomness: 0,
    measured: true,
  };
}

/** 照準を動かさずに fire を押し続け、練習が終わるまで進める。 */
function fireMag(w: WeaponData) {
  const world = rangeWorld();
  const session = new PracticeSession({ world, weapon: w, mode: ghostMode, input: inputFromTimedActions([{ time: 0, action: { type: 'fire', pressed: true } }]), seed: 1 });
  for (let i = 0; i < 2000 && !session.ended; i += 1) session.step();
  return { session, world };
}

describe('反復練習の人型の板', () => {
  it('壁の手前に縮尺 1 の人型の板を 1 枚置き、板は動かず、弾痕を残してリングを描く練習の的', () => {
    const world = rangeWorld();
    const session = new PracticeSession({ world, weapon: weapon(() => ({ dx: 0, dy: 0 })), mode: ghostMode, input: inputFromTimedActions([]), seed: 1 });
    session.step();
    const first = world.targets.get(DRILL_DUMMY_ID)!;
    for (let i = 0; i < 240; i += 1) session.step();
    const dummy = world.targets.get(DRILL_DUMMY_ID)!;
    expect(world.targets.all).toHaveLength(1);
    expect(dummy.plate).toEqual(humanoidPlate(1));
    expect(dummy.parts).toEqual([]);
    expect(dummy.visible).toBe(true);
    expect(dummy.keepsImpacts).toBe(true);
    expect(dummy.rings).toBe(true);
    expect(dummy.center).toEqual(first.center);
    // 板の中心は開始時の照準（採点の中心）のレイの上、9.85 メートル先。正面の面はマップの箱のいちばん手前の面より 0.05 メートル手前。
    const eye = world.player.position;
    const seen = anglesToPoint(eye, dummy.center);
    expect(seen.yaw).toBeCloseTo(world.center.yaw, 12);
    expect(seen.pitch).toBeCloseTo(world.center.pitch, 12);
    expect(Math.hypot(dummy.center.x - eye.x, dummy.center.y - eye.y, dummy.center.z - eye.z)).toBeCloseTo(9.85, 9);
    const front = Math.max(...world.boxes.map((b) => b.center.z + b.size.z / 2));
    expect(dummy.center.z).toBeCloseTo(front + 0.05, 12);
  });

  it('MODE-63: randomness 0・pattern がすべて 0 の武器を照準を動かさずに 1 マガジン撃つと、全弾の弾痕が板の胴の中心の上に表示され、平均ズレが 0.00°', () => {
    const { session, world } = fireMag(weapon(() => ({ dx: 0, dy: 0 })));
    const shots = session.shots;
    expect(shots).toHaveLength(20);
    const dummy = world.targets.get(DRILL_DUMMY_ID)!;
    // 胴の中心は板の中心（輪郭の座標の原点）。
    const torso = dummy.center;
    for (const shot of shots) {
      expect(shot.target).toBe(DRILL_DUMMY_ID);
      expect(shot.position!.x).toBeCloseTo(torso.x, 9);
      expect(shot.position!.y).toBeCloseTo(torso.y, 9);
      expect(shot.position!.z).toBeCloseTo(torso.z, 9);
    }
    const view = new ViewScene(world);
    const impacts = new ImpactMarks(view.layer);
    impacts.sync(shots, world.player.position);
    expect(view.layer.group.children.filter((o) => o.name === IMPACT_NAME)).toHaveLength(20);
    const score = scoreShots(shots, world);
    expect(score.meanDeviation!.toFixed(2)).toBe('0.00');
  });

  it('MODE-64: 上向きの pattern で弾が板より上に出ると、板に当たった弾の弾痕は板の正面の上に、上の弾は壁の上に表示され、ズレは弾の向きから求めた値', () => {
    const { session, world } = fireMag(weapon(() => ({ dx: 0, dy: 0.5 })));
    const shots = session.shots;
    const onDummy = shots.filter((s) => s.target === DRILL_DUMMY_ID);
    const onWall = shots.filter((s) => s.target === undefined && s.position !== null);
    expect(onDummy.length).toBeGreaterThan(0);
    expect(onWall.length).toBeGreaterThan(0);
    const dummy = world.targets.get(DRILL_DUMMY_ID)!;
    const front = dummy.center.z;
    for (const shot of onDummy) expect(shot.position!.z).toBeCloseTo(front, 9);
    for (const shot of onWall) expect(shot.position!.z).toBeCloseTo(-10, 9);
    // 板の上の弾が壁に当たったあとで、板に当たる弾はない（上へ上がり続ける）。
    expect(shots.findIndex((s) => s.target === undefined)).toBe(onDummy.length);
    for (const shot of shots) {
      const want = { yaw: shot.angles.yaw - world.center.yaw, pitch: shot.angles.pitch - world.center.pitch };
      expect(shot.deviation!.yaw).toBeCloseTo(want.yaw, 9);
      expect(shot.deviation!.pitch).toBeCloseTo(want.pitch, 9);
      // 弾痕の位置は弾の向きのレイの上。
      const dir = directionFromAngles(shot.angles);
      const eye = world.player.position;
      const t = (shot.position!.z - eye.z) / dir.z;
      expect(shot.position!.y).toBeCloseTo(eye.y + dir.y * t, 9);
    }
    const view = new ViewScene(world);
    const impacts = new ImpactMarks(view.layer);
    impacts.sync(shots, world.player.position);
    const marks = view.layer.group.children.filter((o) => o.name === IMPACT_NAME);
    expect(marks).toHaveLength(onDummy.length + onWall.length);
    expect(marks.filter((m) => m.position.z > front).length).toBe(onDummy.length);
  });
});

describe('MODE-58: すべてのモードの的は人型の板', () => {
  it.each(modes.map((m) => m.id))('%s を始めると（フリックは 1 個目の的が出たあと）、頭・肩・胴の輪郭の人型の板が表示され、箱の人形や 1 つの箱だけの的は表示されない', (id) => {
    const mode = modes.find((m) => m.id === id)!;
    const world = rangeWorld();
    const w = modeUsesWeapon(mode) ? weapon(() => ({ dx: 0, dy: 0 })) : undefined;
    const session = new PracticeSession<WeaponData | undefined>({ world, weapon: w, mode, input: inputFromTimedActions([]), seed: 1 });
    for (let i = 0; i < 1000 && world.targets.visible.length === 0; i += 1) session.step();
    const view = new ViewScene(world);
    const marks = new TargetMarks(view.layer);
    marks.update(world.targets.all, 0, world.targets.aimed, world);
    const shown = marks.shown;
    expect(shown.length).toBeGreaterThan(0);
    for (const group of shown) {
      expect(group.name).toBe(PRACTICE_TARGET_NAME);
      expect(group.children.filter((o) => o.name === PRACTICE_TARGET_PART_NAME)).toEqual([]);
      const plates = group.children.filter((o) => o.name === PRACTICE_TARGET_PLATE_NAME);
      expect(plates).toHaveLength(1);
      const outline = plates[0]!.userData.outline as { x: number; y: number }[];
      expect(outline).toHaveLength(HUMANOID_OUTLINE.length);
      // 輪郭は縮尺 1 の頂点の縮尺倍（頭と肩の形がそのまま）。
      const scale = outline[0]!.x / HUMANOID_OUTLINE[0]!.x;
      outline.forEach((p, i) => {
        expect(p.x).toBeCloseTo(HUMANOID_OUTLINE[i]!.x * scale, 12);
        expect(p.y).toBeCloseTo(HUMANOID_OUTLINE[i]!.y * scale, 12);
      });
    }
  });
});
