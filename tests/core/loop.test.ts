import { describe, expect, it } from 'vitest';
import { DEFAULT_FIXED_STEP, FixedStepLoop, MAX_FRAME_TIME } from '../../src/core/loop';
import { ManualTimeSource } from '../../src/core/time';

function createLoop(step = DEFAULT_FIXED_STEP) {
  const time = new ManualTimeSource();
  const alphas: number[] = [];
  let updates = 0;
  const dts: number[] = [];
  const loop = new FixedStepLoop({
    timeSource: time,
    step,
    update: (dt) => {
      updates += 1;
      dts.push(dt);
    },
    render: (alpha) => alphas.push(alpha),
  });
  return { time, loop, alphas, dts, updates: () => updates };
}

describe('固定ステップのループ', () => {
  it('既定の固定ステップは 1/120 秒、1 回の描画の上限は 0.25 秒', () => {
    expect(DEFAULT_FIXED_STEP).toBe(1 / 120);
    expect(MAX_FRAME_TIME).toBe(0.25);
  });

  it.each([
    ['60Hz', 60],
    ['144Hz', 144],
  ])('ARC-5: %s 相当の描画で合計 1 秒を与えると 120 ステップ進み、補間の係数は 0 以上 1 未満', (_label, hz) => {
    const { time, loop, alphas, dts, updates } = createLoop();
    for (let i = 0; i < hz; i += 1) {
      time.advance(1 / hz);
      loop.frame();
    }
    expect(updates()).toBe(120);
    expect(loop.stepCount).toBe(120);
    expect(alphas).toHaveLength(hz);
    for (const alpha of alphas) {
      expect(alpha).toBeGreaterThanOrEqual(0);
      expect(alpha).toBeLessThan(1);
    }
    expect(new Set(dts)).toEqual(new Set([1 / 120]));
  });

  it('ARC-6: 1 回の描画で 1 秒の経過を与えると 30 ステップ（0.25 秒分）だけ進む', () => {
    const { time, loop, updates } = createLoop();
    time.advance(1);
    expect(loop.frame()).toBe(30);
    expect(updates()).toBe(30);
  });

  it('固定ステップに満たない経過は蓄え、補間の係数として渡す', () => {
    const { time, loop, alphas, updates } = createLoop(0.01);
    time.advance(0.004);
    loop.frame();
    expect(updates()).toBe(0);
    expect(alphas[0]).toBeCloseTo(0.4);
    time.advance(0.008);
    loop.frame();
    expect(updates()).toBe(1);
    expect(alphas[1]).toBeCloseTo(0.2);
  });

  it('時刻が戻ったときは経過 0 として扱う', () => {
    const { time, loop, updates } = createLoop();
    time.advance(-1);
    expect(loop.frame()).toBe(0);
    expect(updates()).toBe(0);
  });

  it('currentTime は進めたステップの時間と、描画のあとの経過の和', () => {
    const { time, loop } = createLoop(0.01);
    time.advance(0.025);
    loop.frame();
    expect(loop.currentTime()).toBeCloseTo(0.025);
    time.advance(0.003);
    expect(loop.currentTime()).toBeCloseTo(0.028);
    time.advance(10);
    expect(loop.currentTime()).toBeCloseTo(0.025 + MAX_FRAME_TIME);
  });
});
