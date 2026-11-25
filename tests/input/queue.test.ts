import { describe, expect, it } from 'vitest';
import type { Action } from '../../src/input/actions';
import { InputQueue, inputFromTimedActions } from '../../src/input/queue';

const look = (yaw: number): Action => ({ type: 'look', yaw, pitch: 0 });

describe('入力のキュー', () => {
  it('終了時刻未満の入力を時刻の順に取り出し、終了時刻以上は残す', () => {
    const queue = new InputQueue();
    queue.push(0.2, look(2));
    queue.push(0.1, look(1));
    queue.push(0.3, look(3));
    expect(queue.take(0.3)).toEqual([look(1), look(2)]);
    expect(queue.size).toBe(1);
    expect(queue.take(0.31)).toEqual([look(3)]);
    expect(queue.size).toBe(0);
  });

  it('同じ時刻の入力は積んだ順に取り出す', () => {
    const queue = new InputQueue();
    queue.push(0.1, { type: 'fire', pressed: true });
    queue.push(0.1, { type: 'fire', pressed: false });
    queue.push(0.1, look(5));
    expect(queue.take(0.2)).toEqual([{ type: 'fire', pressed: true }, { type: 'fire', pressed: false }, look(5)]);
  });

  it('前のステップより前の時刻の入力が残っていたら、次の取り出しに含める（捨てない）', () => {
    const queue = new InputQueue();
    queue.take(0.5);
    queue.push(0.1, look(1));
    expect(queue.take(0.6)).toEqual([look(1)]);
  });

  it('時刻付きのアクションの列から入力の元を作れる', () => {
    const source = inputFromTimedActions([
      { time: 0.2, action: look(2) },
      { time: 0.1, action: look(1) },
    ]);
    expect(source.take(1)).toEqual([look(1), look(2)]);
  });
});
