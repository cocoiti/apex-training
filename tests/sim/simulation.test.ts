import { describe, expect, it } from 'vitest';
import { FixedStepLoop } from '../../src/core/loop';
import { ManualTimeSource } from '../../src/core/time';
import type { TimedAction } from '../../src/input/actions';
import { inputFromTimedActions } from '../../src/input/queue';
import { vec3 } from '../../src/sim/vec3';
import { Simulation } from '../../src/sim/simulation';
import { createWorld, type World } from '../../src/sim/world';

function emptyWorld(yaw = 0, pitch = 0): World {
  return createWorld({ id: 'test', name: 'test', spawn: { position: vec3(0, 1.6, 0), aim: { yaw, pitch } }, boxes: [] });
}

const lookSequence: TimedAction[] = [
  { time: 0.1, action: { type: 'look', yaw: 10, pitch: 0 } },
  { time: 0.2, action: { type: 'look', yaw: 0, pitch: -5 } },
];

describe('シミュレーション', () => {
  it('ARC-7: ヨー 0・ピッチ 0 から look の列を流して 0.5 秒進めると、ヨー 10 度・ピッチ -5 度になる', () => {
    const world = emptyWorld();
    const sim = new Simulation(world, inputFromTimedActions(lookSequence));
    sim.advance(0.5);
    expect(sim.stepCount).toBe(60);
    expect(world.player.aim.yaw).toBeCloseTo(10, 12);
    expect(world.player.aim.pitch).toBeCloseTo(-5, 12);
  });

  it('入力はその時刻を含むステップで消費される', () => {
    const world = emptyWorld();
    const sim = new Simulation(world, inputFromTimedActions(lookSequence));
    sim.advance(0.1); // 12 ステップ: [0, 0.1) まで
    expect(world.player.aim.yaw).toBe(0);
    sim.step(); // [0.1, 0.10833…)
    expect(world.player.aim.yaw).toBe(10);
  });

  it('1 ステップの look は足し合わせ、fire・ads は最後に消費した状態になる', () => {
    const world = emptyWorld();
    const sim = new Simulation(
      world,
      inputFromTimedActions([
        { time: 0, action: { type: 'look', yaw: 1, pitch: 0.5 } },
        { time: 0.001, action: { type: 'fire', pressed: true } },
        { time: 0.002, action: { type: 'look', yaw: 2, pitch: 0.5 } },
        { time: 0.003, action: { type: 'fire', pressed: false } },
        { time: 0.004, action: { type: 'ads', pressed: true } },
      ]),
    );
    sim.step();
    expect(world.player.aim).toEqual({ yaw: 3, pitch: 1 });
    expect(world.player.fire).toBe(false);
    expect(world.player.ads).toBe(true);
  });

  it('previousViewAngles は直前のステップの開始時点の照準の向き', () => {
    const world = emptyWorld();
    const sim = new Simulation(world, inputFromTimedActions([{ time: 0, action: { type: 'look', yaw: 4, pitch: 0 } }]));
    sim.step();
    expect(sim.previousViewAngles).toEqual({ yaw: 0, pitch: 0 });
    sim.step();
    expect(sim.previousViewAngles).toEqual({ yaw: 4, pitch: 0 });
  });

  it('同じ入力なら 60Hz と 144Hz の描画で同じ照準になる', () => {
    const run = (hz: number) => {
      const world = emptyWorld();
      const sim = new Simulation(
        world,
        inputFromTimedActions(
          Array.from({ length: 50 }, (_, i) => ({ time: i * 0.013, action: { type: 'look', yaw: 0.7, pitch: -0.3 } }) as const),
        ),
      );
      const time = new ManualTimeSource();
      const loop = new FixedStepLoop({ timeSource: time, update: () => sim.step(), render: () => {} });
      for (let i = 0; i < hz; i += 1) {
        time.advance(1 / hz);
        loop.frame();
      }
      return { steps: sim.stepCount, aim: world.player.aim };
    };
    expect(run(60)).toEqual(run(144));
  });
});
