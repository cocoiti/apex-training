import { describe, expect, it } from 'vitest';
import { RecordingInput } from '../../src/input/recording';
import { PracticeSession } from '../../src/modes/session';
import type { TrainingMode } from '../../src/modes/types';
import { aimAtShots, aimTrajectory } from '../../src/sim/trajectory';
import { vec3 } from '../../src/sim/vec3';
import { uncorrectedPattern, type WeaponData } from '../../src/sim/weapon';
import { createWorld } from '../../src/sim/world';

const DT = 1 / 120;

describe('照準の軌道', () => {
  it('アクションがない記録の軌道は時刻 0 の開始時の照準だけ', () => {
    expect(aimTrajectory({ actions: [] }, { yaw: 3, pitch: -2 })).toEqual([{ time: 0, yaw: 3, pitch: -2 }]);
  });

  it('ステップの終わりごとに 1 点で、最後のアクションを消費するステップの終わりまで続く', () => {
    const points = aimTrajectory({ actions: [{ time: 0.02, action: { type: 'look', yaw: 1, pitch: 0 } }] }, { yaw: 0, pitch: 0 });
    // 0.02 秒の入力は [2/120, 3/120) のステップ（3 つ目）で消費される。
    expect(points.map((p) => p.time)).toEqual([0, DT, 2 * DT, 3 * DT]);
    expect(points.map((p) => p.yaw)).toEqual([0, 0, 0, 1]);
  });

  it('fire・ads は照準を変えないが、最後のアクションなら軌道はそのステップまで続く', () => {
    const points = aimTrajectory(
      {
        actions: [
          { time: 0, action: { type: 'look', yaw: 2, pitch: 0 } },
          { time: 0.03, action: { type: 'fire', pressed: true } },
        ],
      },
      { yaw: 0, pitch: 0 },
    );
    expect(points).toHaveLength(5);
    expect(points.at(-1)).toEqual({ time: 4 * DT, yaw: 2, pitch: 0 });
  });

  it('ピッチの範囲とヨーの正規化はシミュレーションと同じ', () => {
    const points = aimTrajectory(
      {
        actions: [
          { time: 0, action: { type: 'look', yaw: 190, pitch: 100 } },
        ],
      },
      { yaw: 0, pitch: 0 },
    );
    expect(points.at(-1)).toEqual({ time: DT, yaw: -170, pitch: 89 });
  });

  it('リコイルのオフセットを含まない（利用者の照準だけ）', () => {
    // fire を押しても照準の軌道は動かない。
    const points = aimTrajectory(
      {
        actions: [
          { time: 0, action: { type: 'fire', pressed: true } },
          { time: 0.5, action: { type: 'fire', pressed: false } },
        ],
      },
      { yaw: 0, pitch: 0 },
    );
    expect(points.every((p) => p.yaw === 0 && p.pitch === 0)).toBe(true);
  });
});

describe('各弾の発射時の照準', () => {
  const scoredMode: TrainingMode = {
    id: 'test',
    name: 'テスト',
    category: 'recoil',
    order: 0,
    setup() {},
    step: () => true,
    result: () => ({ scored: true }),
    teardown() {},
  };

  it('練習で撃った各弾の照準（弾の向き − リコイルの累積）と、開始時の照準からの差で一致する', () => {
    const start = { yaw: 30, pitch: 5 };
    const world = createWorld({
      id: 't',
      name: 't',
      spawn: { position: vec3(0, 1.6, 0), aim: start },
      boxes: [],
    });
    const magSize = 12;
    const weapon: WeaponData = {
      id: 'w',
      name: 'w',
      category: 'AR',
      version: 'v',
      source: 's',
      rpm: 777,
      magSize,
      pattern: Array.from({ length: magSize }, (_, i) => ({ dx: (i % 3) - 1, dy: 0.4 })),
      randomness: 0,
    };
    const input = new RecordingInput(1);
    const session = new PracticeSession({ world, weapon, mode: scoredMode, input, seed: 1 });
    input.push(0, { type: 'fire', pressed: true });
    // 描画のたびに積むように、ステップの途中の時刻で照準を動かす。
    for (let i = 0; i < 200 && !session.ended; i += 1) {
      input.push(session.sim.time + DT * 0.3, { type: 'look', yaw: 0.05, pitch: -0.03 });
      session.step();
    }
    const shots = session.gun.shots;
    expect(shots).toHaveLength(magSize);
    const pattern = uncorrectedPattern(weapon, magSize);
    const expected = shots.map((s, i) => ({
      yaw: s.angles.yaw - (pattern[i]?.yaw ?? 0) - start.yaw,
      pitch: s.angles.pitch - (pattern[i]?.pitch ?? 0) - start.pitch,
    }));
    const aim = aimAtShots(input.recording(), shots, start, session.sim.dt);
    aim.forEach((a, i) => {
      expect(a.yaw).toBeCloseTo(expected[i]?.yaw ?? NaN, 9);
      expect(a.pitch).toBeCloseTo(expected[i]?.pitch ?? NaN, 9);
    });
  });

  it('記録の最後のアクションのあとに撃った弾は、軌道の最後の照準', () => {
    const recording = { actions: [{ time: 0, action: { type: 'look', yaw: 1, pitch: 2 } } as const] };
    expect(aimAtShots(recording, [{ time: 0 }, { time: 5 }], { yaw: 0, pitch: 0 })).toEqual([
      { yaw: 1, pitch: 2 },
      { yaw: 1, pitch: 2 },
    ]);
  });

  it('弾がなければ空', () => {
    expect(aimAtShots({ actions: [] }, [], { yaw: 0, pitch: 0 })).toEqual([]);
  });
});
