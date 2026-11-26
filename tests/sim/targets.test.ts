import { describe, expect, it } from 'vitest';
import { FixedStepLoop } from '../../src/core/loop';
import { ManualTimeSource } from '../../src/core/time';
import { inputFromTimedActions } from '../../src/input/queue';
import { raycastScene } from '../../src/sim/hit';
import { Simulation } from '../../src/sim/simulation';
import { PracticeTargets, visibleInStep } from '../../src/sim/targets';
import { vec3 } from '../../src/sim/vec3';
import { createWorld, type World } from '../../src/sim/world';

const SIZE = vec3(1, 1, 0.2);

function emptyWorld(): World {
  return createWorld({ id: 'test', name: 'test', spawn: { position: vec3(0, 1.6, 0), aim: { yaw: 0, pitch: 0 } }, boxes: [] });
}

/** 毎秒 2 メートルで +X へ動く的。 */
const sliding = { id: 'slide', size: SIZE, position: (t: number) => vec3(2 * t, 1.6, -10) };

describe('練習の的の位置', () => {
  it('ARC-30: 左右に毎秒 2 メートルで動く的を置いて 1 秒進めると、中心の X が 2 メートル動いている', () => {
    const world = emptyWorld();
    world.targets.add(sliding);
    const start = world.targets.get('slide')!.center.x;
    const sim = new Simulation(world, inputFromTimedActions([]));
    sim.advance(1);
    expect(world.targets.get('slide')!.center.x - start).toBeCloseTo(2, 9);
  });

  it('ARC-30: 1/60 秒間隔と 1/144 秒間隔の描画で合計 1 秒を与えたときの的の位置が一致する', () => {
    const run = (hz: number) => {
      const world = emptyWorld();
      world.targets.add(sliding);
      const sim = new Simulation(world, inputFromTimedActions([]));
      const time = new ManualTimeSource();
      const loop = new FixedStepLoop({ timeSource: time, update: () => sim.step(), render: () => {} });
      for (let i = 0; i < hz; i += 1) {
        time.advance(1 / hz);
        loop.frame();
      }
      return { steps: sim.stepCount, target: world.targets.get('slide') };
    };
    expect(run(60)).toEqual(run(144));
  });

  it('各ステップの位置はそのステップの終わりの時刻で決め、直前のステップの位置を残す', () => {
    const world = emptyWorld();
    world.targets.add(sliding);
    const sim = new Simulation(world, inputFromTimedActions([]));
    sim.step();
    sim.step();
    const target = world.targets.get('slide')!;
    expect(target.center.x).toBeCloseTo(2 * 2 * sim.dt, 12);
    expect(target.previousCenter.x).toBeCloseTo(2 * sim.dt, 12);
  });

  it('位置の変わらない的は時刻によらず同じ位置', () => {
    const world = emptyWorld();
    world.targets.add({ id: 'still', size: SIZE, position: vec3(1, 2, -5) });
    new Simulation(world, inputFromTimedActions([])).advance(0.5);
    expect(world.targets.get('still')).toMatchObject({ center: vec3(1, 2, -5), previousCenter: vec3(1, 2, -5) });
  });
});

describe('練習の的の出現', () => {
  it('出現の時刻を含むステップから、消える時刻を含むステップの前まで出現している', () => {
    const dt = 1 / 120;
    const timing = { appearAt: 1, disappearAt: 2 };
    // 1 秒ちょうどから始まるステップ（終わり 1 + dt）で出現し、終わりが 2 秒ちょうどのステップまで出現している。
    expect(visibleInStep(timing, 1)).toBe(false);
    expect(visibleInStep(timing, 1 + dt)).toBe(true);
    expect(visibleInStep(timing, 2)).toBe(true);
    expect(visibleInStep(timing, 2 + dt)).toBe(false);
    expect(visibleInStep({ appearAt: 0, disappearAt: undefined }, dt)).toBe(true);
    expect(visibleInStep({ appearAt: 0, disappearAt: undefined }, 1e6)).toBe(true);
  });

  it('UI-98: 出現 1 秒・消える 2 秒の的は、0.5 秒・1.5 秒・2.5 秒のうち 1.5 秒のときだけ出現している', () => {
    const world = emptyWorld();
    world.targets.add({ id: 'pop', size: SIZE, position: vec3(0, 1.6, -10), appearAt: 1, disappearAt: 2 });
    const sim = new Simulation(world, inputFromTimedActions([]));
    const seen: boolean[] = [];
    for (const until of [0.5, 1.5, 2.5]) {
      while (sim.time < until - 1e-9) sim.step();
      seen.push(world.targets.get('pop')!.visible);
    }
    expect(seen).toEqual([false, true, false]);
  });

  it('出現していない的は照準と弾の当たりの対象（visible）に入らない', () => {
    const world = emptyWorld();
    world.targets.add({ id: 'later', size: SIZE, position: vec3(0, 1.6, -10), appearAt: 1 });
    const sim = new Simulation(world, inputFromTimedActions([]));
    sim.advance(0.5);
    expect(world.targets.visible).toEqual([]);
    sim.advance(1);
    expect(world.targets.visible.map((t) => t.id)).toEqual(['later']);
  });
});

describe('練習の的を足す・消す', () => {
  it('同じ識別子の的は足せない', () => {
    const targets = new PracticeTargets();
    targets.add({ id: 'a', size: SIZE, position: vec3(0, 0, 0) });
    expect(() => targets.add({ id: 'a', size: SIZE, position: vec3(1, 0, 0) })).toThrow();
  });

  it('消した的はなくなり、照準が乗っていた的なら乗っていないにする', () => {
    const targets = new PracticeTargets();
    targets.add({ id: 'a', size: SIZE, position: vec3(0, 0, 0) });
    targets.setAimed('a');
    expect(targets.isAimed('a')).toBe(true);
    expect(targets.remove('a')).toBe(true);
    expect(targets.remove('a')).toBe(false);
    expect(targets.all).toEqual([]);
    expect(targets.aimed).toBeUndefined();
  });

  it('練習の途中で足した的は、足した時刻の位置にする', () => {
    const world = emptyWorld();
    const sim = new Simulation(world, inputFromTimedActions([]));
    sim.advance(0.5);
    world.targets.add(sliding);
    const target = world.targets.get('slide')!;
    expect(target.center.x).toBeCloseTo(1, 9);
    expect(target.previousCenter).toEqual(target.center);
    expect(target.visible).toBe(true);
  });

  it('World は練習ごとに作り直すので、前の練習の的は残らない', () => {
    const first = emptyWorld();
    first.targets.add(sliding);
    expect(emptyWorld().targets.all).toEqual([]);
  });
});

describe('マップの箱と練習の的へのレイ', () => {
  const eye = vec3(0, 1.6, 0);
  const forward = vec3(0, 0, -1);
  const wall = { id: 'wall', kind: 'wall' as const, center: vec3(0, 1.6, -5), size: vec3(4, 4, 0.2) };

  it('目の位置からいちばん近いものに当たる', () => {
    const targets = new PracticeTargets();
    targets.add({ id: 'near', size: SIZE, position: vec3(0, 1.6, -3) });
    targets.update(1 / 120);
    const hit = raycastScene(eye, forward, [wall], targets.visible);
    expect(hit?.target?.id).toBe('near');
    expect(hit?.box).toBeUndefined();
    expect(hit?.position.z).toBeCloseTo(-2.9, 9);
  });

  it('的の手前に壁があれば壁に当たる', () => {
    const targets = new PracticeTargets();
    targets.add({ id: 'far', size: SIZE, position: vec3(0, 1.6, -8) });
    targets.update(1 / 120);
    const hit = raycastScene(eye, forward, [wall], targets.visible);
    expect(hit?.box?.id).toBe('wall');
    expect(hit?.target).toBeUndefined();
  });

  it('どれにも当たらなければ undefined', () => {
    expect(raycastScene(eye, vec3(0, 1, 0), [wall], [])).toBeUndefined();
  });
});
