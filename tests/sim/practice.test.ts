import { describe, expect, it } from 'vitest';
import { DEFAULT_FIXED_STEP } from '../../src/core/loop';
import { IDLE_END_TIME, PracticeEndRule } from '../../src/sim/practice';

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
