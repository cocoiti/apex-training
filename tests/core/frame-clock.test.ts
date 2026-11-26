import { describe, expect, it } from 'vitest';
import { ManualFrameClock, MANUAL_FRAME_SECONDS, RealFrameClock } from '../../src/core/frame-clock';
import { FixedStepLoop } from '../../src/core/loop';

/** 頼まれた描画を貯め、flush(time) で 1 回分の描画を行う（requestAnimationFrame の代わり）。 */
function fakeSchedule() {
  const runs: ((time: number) => void)[] = [];
  return {
    schedule: (run: (time: number) => void) => void runs.push(run),
    get waiting() {
      return runs.length;
    },
    flush(time = 0) {
      const now = runs.splice(0);
      for (const run of now) run(time);
    },
  };
}

describe('実時間の時計（RealFrameClock）', () => {
  it('時刻は nowMs を秒にしたもの', () => {
    let ms = 1500;
    const clock = new RealFrameClock(() => {}, () => ms);
    expect(clock.now()).toBe(1.5);
    ms = 2250;
    expect(clock.now()).toBe(2.25);
  });

  it('同じ描画で頼んだものは 1 回の予定にまとめ、描画の時刻を渡して呼び、呼ばれた中で頼んだものは次の描画に回す', () => {
    const raf = fakeSchedule();
    const clock = new RealFrameClock(raf.schedule, () => 0);
    const calls: string[] = [];
    const a = (t: number) => {
      calls.push(`a${t}@${clock.frameCount}`);
      clock.requestFrame(a);
    };
    clock.requestFrame(a);
    clock.requestFrame((t) => calls.push(`b${t}@${clock.frameCount}`));
    expect(raf.waiting).toBe(1);
    raf.flush(16);
    expect(calls).toEqual(['a16@1', 'b16@1']);
    expect(raf.waiting).toBe(1);
    raf.flush(33);
    expect(calls).toEqual(['a16@1', 'b16@1', 'a33@2']);
  });

  it('1 つの呼び出しが例外を投げても、同じ描画の残りは呼び、例外は投げ直す', () => {
    const raf = fakeSchedule();
    const clock = new RealFrameClock(raf.schedule, () => 0);
    const calls: string[] = [];
    clock.requestFrame(() => {
      throw new Error('パッドの失敗');
    });
    clock.requestFrame(() => {
      calls.push('b');
      clock.requestFrame(() => calls.push('b2'));
    });
    expect(() => raf.flush(16)).toThrow('パッドの失敗');
    expect(calls).toEqual(['b']);
    raf.flush(33);
    expect(calls).toEqual(['b', 'b2']);
  });

  it('2 つ以上が例外を投げたら AggregateError にまとめる', () => {
    const raf = fakeSchedule();
    const clock = new RealFrameClock(raf.schedule, () => 0);
    clock.requestFrame(() => {
      throw new Error('1');
    });
    clock.requestFrame(() => {
      throw new Error('2');
    });
    expect(() => raf.flush(16)).toThrow(AggregateError);
  });

  it('描画のたびに 3D を描く（draws が true）', () => {
    const raf = fakeSchedule();
    const clock = new RealFrameClock(raf.schedule, () => 0);
    const draws: boolean[] = [];
    clock.requestFrame(() => draws.push(clock.draws));
    raf.flush(16);
    expect(draws).toEqual([true]);
  });
});

describe('テストから進める時計（ManualFrameClock、clock=manual）', () => {
  it('advance で進めた分だけ時刻が進み、実時間では進まない', () => {
    const clock = new ManualFrameClock(undefined, 10);
    expect(clock.now()).toBe(10);
    clock.advance(0.5);
    expect(clock.now()).toBe(10.5);
    clock.advance(0);
    clock.advance(-1);
    expect(clock.now()).toBe(10.5);
  });

  it('advance は今の時刻のまま 1 回描画してから、描画の間隔（既定 1/60 秒）ごとに時刻を進めて描画を行い、描画の時刻はミリ秒', () => {
    const clock = new ManualFrameClock();
    const times: number[] = [];
    const tick = (t: number) => {
      times.push(t);
      clock.requestFrame(tick);
    };
    clock.requestFrame(tick);
    expect(clock.advance(0.1)).toBe(6);
    expect(times).toHaveLength(7);
    expect(times[0]).toBe(0);
    expect(times[1]).toBeCloseTo(MANUAL_FRAME_SECONDS * 1000, 9);
    expect(times.at(-1)).toBeCloseTo(100, 9);
    expect(clock.frameCount).toBe(7);
  });

  it('間隔で割り切れない時間は、最後の描画を残りの時間にする', () => {
    const clock = new ManualFrameClock();
    const times: number[] = [];
    const tick = (t: number) => {
      times.push(t);
      clock.requestFrame(tick);
    };
    clock.requestFrame(tick);
    clock.advance(0.25, 0.1);
    expect(times.map((t) => Math.round(t))).toEqual([0, 100, 200, 250]);
    expect(clock.now()).toBe(0.25);
  });

  it('描画の間隔は 0 より大きく、ループが 1 回の描画で進める上限（0.25 秒）までにする', () => {
    const clock = new ManualFrameClock();
    expect(() => clock.advance(1, 0)).toThrow();
    expect(() => clock.advance(1, 0.3)).toThrow();
    expect(clock.advance(1, 0.25)).toBe(4);
  });

  it('実際の描画（schedule）では時刻を進めずに描画を行う', () => {
    const raf = fakeSchedule();
    const clock = new ManualFrameClock(raf.schedule, 2);
    const times: number[] = [];
    const tick = (t: number) => {
      times.push(t);
      clock.requestFrame(tick);
    };
    clock.requestFrame(tick);
    raf.flush(99_999);
    raf.flush(123_456);
    expect(times).toEqual([2000, 2000]);
    expect(clock.now()).toBe(2);
  });

  it('advance の中の描画では 3D を描かず（draws が false）、実際の描画では描く', () => {
    const raf = fakeSchedule();
    const clock = new ManualFrameClock(raf.schedule);
    const draws: boolean[] = [];
    const tick = () => {
      draws.push(clock.draws);
      clock.requestFrame(tick);
    };
    clock.requestFrame(tick);
    clock.advance(0.05);
    expect(draws).toEqual([false, false, false, false]);
    expect(clock.draws).toBe(true);
    raf.flush();
    expect(draws).toEqual([false, false, false, false, true]);
  });

  it('advance の中で例外が出ても、そのあとの描画では 3D を描く', () => {
    const clock = new ManualFrameClock();
    clock.requestFrame(() => {
      throw new Error('描画の失敗');
    });
    expect(() => clock.advance(0.1)).toThrow('描画の失敗');
    expect(clock.draws).toBe(true);
  });

  it('advance の中で 1 つの呼び出しが例外を投げても、同じ描画の残りは呼ぶ', () => {
    const clock = new ManualFrameClock();
    const times: number[] = [];
    clock.requestFrame(() => {
      throw new Error('パッドの失敗');
    });
    const tick = (t: number) => {
      times.push(t);
      clock.requestFrame(tick);
    };
    clock.requestFrame(tick);
    expect(() => clock.advance(0.1)).toThrow('パッドの失敗');
    expect(times).toHaveLength(1);
    clock.advance(0.05);
    expect(times).toHaveLength(5);
  });

  it('固定ステップのループの時計にすると、2 秒進めたときに 2 秒分のステップが進む（実時間で待たない）', () => {
    const clock = new ManualFrameClock();
    let updates = 0;
    const loop = new FixedStepLoop({ timeSource: clock, update: () => (updates += 1), render: () => {} });
    const tick = () => {
      loop.frame();
      clock.requestFrame(tick);
    };
    clock.requestFrame(tick);
    clock.advance(1.9);
    expect(loop.stepCount).toBe(228);
    clock.advance(0.1);
    expect(loop.stepCount).toBe(240);
    expect(updates).toBe(240);
  });

  /**
   * 描画のたびにパッドを読み（ページの tick と同じく、ループの frame の前に読む）、押した・離した時刻をループの時計で記録し、
   * ステップごとにボタンを押していたステップの数を数える。between は、時計を止めている間に実際の描画を何回行うか。
   */
  function holdRun(between: number) {
    const raf = fakeSchedule();
    const clock = new ManualFrameClock(raf.schedule);
    let button = false;
    let read = false;
    let heldSteps = 0;
    const edges: [boolean, number][] = [];
    const loop = new FixedStepLoop({ timeSource: clock, update: () => (heldSteps += read ? 1 : 0), render: () => {} });
    const tick = () => {
      if (button !== read) edges.push([button, loop.currentTime()]);
      read = button;
      loop.frame();
      clock.requestFrame(tick);
    };
    clock.requestFrame(tick);
    clock.advance(0.1);
    const idle = () => {
      for (let i = 0; i < between; i += 1) raf.flush();
    };
    idle();
    button = true;
    idle();
    clock.advance(0.25);
    idle();
    button = false;
    idle();
    clock.advance(0.1);
    return { edges, heldSteps };
  }

  it('時計を止めている間に変えた入力は、実際の描画が間に入っても入らなくても、止めていた時刻で読まれ、押していたステップの数は進めた秒数で決まる（ARC-63）', () => {
    const none = holdRun(0);
    expect(none.edges.map(([on, t]) => [on, Math.round(t * 1000)])).toEqual([
      [true, 100],
      [false, 350],
    ]);
    // 0.25 秒（固定ステップ 1/120 秒の 30 ステップ）。
    expect(none.heldSteps).toBe(30);
    for (const between of [1, 5]) expect(holdRun(between), `実際の描画 ${between} 回`).toEqual(none);
  });
});
