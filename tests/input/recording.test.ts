import { describe, expect, it } from 'vitest';
import type { Action } from '../../src/input/actions';
import { createSeed, RecordingInput, replayInput } from '../../src/input/recording';

const look = (yaw: number, pitch = 0): Action => ({ type: 'look', yaw, pitch });

describe('入力の記録', () => {
  it('積んだアクションを時刻付きで積んだ順に記録し、種も持つ', () => {
    const input = new RecordingInput(7);
    input.push(0.2, look(2));
    input.push(0.1, { type: 'fire', pressed: true });
    input.push(0.1, { type: 'ads', pressed: true });
    expect(input.recording()).toEqual({
      seed: 7,
      actions: [
        { time: 0.2, action: look(2) },
        { time: 0.1, action: { type: 'fire', pressed: true } },
        { time: 0.1, action: { type: 'ads', pressed: true } },
      ],
    });
  });

  it('シミュレーションには入力のキューと同じ順で流し、取り出したあとも記録には残る', () => {
    const input = new RecordingInput(1);
    input.push(0.2, look(2));
    input.push(0.1, look(1));
    expect(input.take(0.3)).toEqual([look(1), look(2)]);
    expect(input.take(1)).toEqual([]);
    expect(input.recording().actions).toHaveLength(2);
  });

  it('記録は写しで、あとから積んだものや積んだアクションの書き換えの影響を受けない', () => {
    const input = new RecordingInput(1);
    const action = { type: 'look', yaw: 1, pitch: 0 } as { type: 'look'; yaw: number; pitch: number };
    input.push(0, action);
    const recording = input.recording();
    action.yaw = 99;
    input.push(0.5, look(3));
    expect(recording.actions).toEqual([{ time: 0, action: look(1) }]);
  });

  it('種は 0 以上 2³² 未満の整数にする', () => {
    expect(new RecordingInput(-1).seed).toBe(2 ** 32 - 1);
    for (let i = 0; i < 20; i += 1) {
      const seed = createSeed();
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(2 ** 32);
    }
  });

  it('再生の入力の元は記録を時刻の順に流す', () => {
    const source = replayInput({
      seed: 1,
      actions: [
        { time: 0.2, action: look(2) },
        { time: 0.1, action: look(1) },
      ],
    });
    expect(source.take(0.15)).toEqual([look(1)]);
    expect(source.take(1)).toEqual([look(2)]);
  });
});
