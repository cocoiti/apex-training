import { describe, expect, it } from 'vitest';
import { DEFAULT_FIXED_STEP } from '../../src/core/loop';
import type { TimedAction } from '../../src/input/actions';
import { inputFromTimedActions } from '../../src/input/queue';
import type { MapData } from '../../src/sim/map';
import { createPractice, IDLE_END_TIME, PracticeEndRule, practiceOutcome, replayRecording } from '../../src/sim/practice';
import { vec3 } from '../../src/sim/vec3';
import type { WeaponData } from '../../src/sim/weapon';

const dt = DEFAULT_FIXED_STEP;
const shot = { shot: 1, time: 0, angles: { yaw: 0, pitch: 0 }, position: null, deviation: null };

/** fire の状態と残弾・撃った数を与えて steps ステップ進め、終わった理由と何ステップ目かを返す。 */
function run(rule: PracticeEndRule, steps: number, state: { fire: boolean; ammo: number; shots: number }) {
  const gun = { ammo: state.ammo, shots: Array.from({ length: state.shots }, () => shot) };
  for (let i = 1; i <= steps; i += 1) {
    const reason = rule.step({ fire: state.fire }, gun, dt);
    if (reason) return { reason, step: i };
  }
  return undefined;
}

describe('練習の終わりの判定', () => {
  it('1 発も撃っていないあいだは、fire を離したまま 2 秒以上たっても終わらない（MODE-8）', () => {
    const rule = new PracticeEndRule();
    expect(run(rule, Math.round(10 / dt), { fire: false, ammo: 30, shots: 0 })).toBeUndefined();
  });

  it('残弾が 0 になったステップで終わる（MODE-6）', () => {
    const rule = new PracticeEndRule();
    expect(run(rule, 1, { fire: true, ammo: 0, shots: 30 })).toEqual({ reason: 'empty', step: 1 });
  });

  it('撃ったあと fire を離して、ちょうど 2 秒（240 ステップ）たったステップで終わる（MODE-7）', () => {
    const rule = new PracticeEndRule();
    expect(IDLE_END_TIME).toBe(2);
    expect(run(rule, 1000, { fire: false, ammo: 10, shots: 5 })).toEqual({ reason: 'idle', step: Math.round(2 / dt) });
  });

  it('2 秒たつ前に押し直すと、離してからの時間を数え直す（MODE-7）', () => {
    const rule = new PracticeEndRule();
    expect(run(rule, Math.round(1.9 / dt), { fire: false, ammo: 10, shots: 5 })).toBeUndefined();
    expect(run(rule, 10, { fire: true, ammo: 10, shots: 6 })).toBeUndefined();
    // 押し直したあとは、離してからまた 2 秒たつまで終わらない。
    expect(run(rule, Math.round(1.9 / dt), { fire: false, ammo: 9, shots: 7 })).toBeUndefined();
    expect(run(rule, Math.round(0.1 / dt), { fire: false, ammo: 9, shots: 7 })?.reason).toBe('idle');
  });

  it('押し続けているあいだは、時間がたっても終わらない', () => {
    const rule = new PracticeEndRule();
    expect(run(rule, Math.round(5 / dt), { fire: true, ammo: 10, shots: 3 })).toBeUndefined();
  });
});

const map: MapData = {
  id: 'test',
  name: 'test',
  spawn: { position: vec3(0, 1.6, 0), aim: { yaw: 0, pitch: 0 } },
  boxes: [{ id: 'wall', kind: 'wall', center: vec3(0, 1.6, -10.1), size: vec3(200, 200, 0.2) }],
};

const weapon: WeaponData = {
  id: 'w',
  name: 'w',
  category: 'AR',
  version: 'test',
  source: 'test',
  rpm: 600,
  magSize: 5,
  pattern: Array.from({ length: 5 }, () => ({ dx: 0.1, dy: 0.3 })),
  randomness: 0.1,
} as WeaponData;

const actions: TimedAction[] = [
  { time: 0, action: { type: 'fire', pressed: true } },
  { time: 0.15, action: { type: 'look', yaw: 0, pitch: -0.5 } },
];

describe('練習のシミュレーション', () => {
  it('マップから World を作り、種で作った乱数の Gun をステップごとに進める', () => {
    const practice = createPractice({ map, weapon, input: inputFromTimedActions(actions), seed: 3 });
    expect(practice.seed).toBe(3);
    expect(practice.world.player.aim).toEqual({ yaw: 0, pitch: 0 });
    practice.sim.advance(1);
    expect(practice.gun.shots).toHaveLength(5);
  });

  it('結果は撃った弾すべてのズレで採点する', () => {
    const practice = createPractice({ map, weapon, input: inputFromTimedActions(actions), seed: 3 });
    practice.sim.advance(1);
    const outcome = practiceOutcome(practice, 1);
    expect(outcome.shots).toHaveLength(5);
    expect(outcome.score.shots).toBe(5);
  });

  it('再生は撃ち切るまで進め、練習と同じ弾痕と採点結果になる', () => {
    const practice = createPractice({ map, weapon, input: inputFromTimedActions(actions), seed: 3 });
    practice.sim.advance(2);
    const replayed = replayRecording({ seed: 3, actions }, { map, weapon, targetRadius: 1 });
    expect(replayed.shots).toEqual(practice.gun.shots);
    expect(replayed.score).toEqual(practiceOutcome(practice, 1).score);
  });

  it('外れの弾も弾の向きと中心との差で採点に入れ、的の半径は省略するとマップの的から求める', () => {
    // 壁だけのマップ。照準を大きく右に振ると壁から外れ、外れの弾が出る。
    const narrow: MapData = {
      ...map,
      boxes: [{ id: 'wall', kind: 'wall', center: vec3(0, 1.6, -10.1), size: vec3(2, 2, 0.2) }],
    };
    const swing: TimedAction[] = [
      { time: 0, action: { type: 'fire', pressed: true } },
      { time: 0.15, action: { type: 'look', yaw: 30, pitch: 0 } },
    ];
    const practice = createPractice({ map: narrow, weapon, input: inputFromTimedActions(swing), seed: 3 });
    practice.sim.advance(2);
    expect(practice.gun.shots.some((s) => s.deviation === null)).toBe(true);
    const outcome = practiceOutcome(practice);
    expect(outcome.score.shots).toBe(5);
    expect(outcome).toEqual(practiceOutcome(practice, 1));
    const replayed = replayRecording({ seed: 3, actions: swing }, { map: narrow, weapon });
    expect(replayed.score).toEqual(outcome.score);
  });

  it('アクションのない記録の再生は 1 ステップで止まり、弾は出ない', () => {
    const replayed = replayRecording({ seed: 1, actions: [] }, { map, weapon, targetRadius: 1 });
    expect(replayed.practice.sim.stepCount).toBe(1);
    expect(replayed.shots).toEqual([]);
  });
});
