import type { Action, TimedAction } from './actions';

/** シミュレーションが各ステップで入力を取り出す元。 */
export interface InputSource {
  /**
   * 時刻が endTime 未満の入力をすべて取り出す。並びは時刻の順で、同じ時刻なら積んだ順。
   * ステップの開始より前の時刻の入力が残っていても、ここで一緒に取り出す（捨てない）。
   */
  take(endTime: number): Action[];
}

/** 時刻付きの入力のキュー。デバイスの入力を積み、シミュレーションが take() で消費する。 */
export class InputQueue implements InputSource {
  private pending: { time: number; order: number; action: Action }[] = [];
  private nextOrder = 0;

  push(time: number, action: Action): void {
    this.pending.push({ time, order: this.nextOrder, action });
    this.nextOrder += 1;
  }

  get size(): number {
    return this.pending.length;
  }

  take(endTime: number): Action[] {
    const taken = this.pending.filter((entry) => entry.time < endTime);
    if (taken.length === 0) return [];
    this.pending = this.pending.filter((entry) => entry.time >= endTime);
    taken.sort((a, b) => a.time - b.time || a.order - b.order);
    return taken.map((entry) => entry.action);
  }
}

/** 時刻付きのアクションの列をそのまま流す入力の元。テストと再生で使う。 */
export function inputFromTimedActions(actions: readonly TimedAction[]): InputQueue {
  const queue = new InputQueue();
  for (const { time, action } of actions) queue.push(time, action);
  return queue;
}
