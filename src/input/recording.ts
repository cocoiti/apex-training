import type { Action, TimedAction } from './actions';
import { InputQueue, inputFromTimedActions, type InputSource } from './queue';

/**
 * 入力の記録（docs/spec/input.md「記録の形」）。1 回の練習の、時刻付きのアクションの列（積んだ順）と乱数の種。
 * 記録はページの中（メモリ）だけで使い、ファイル・クリップボード・外部には出さない。
 */
export interface InputRecording {
  /** 乱数の種。0 以上 2³² 未満の整数。 */
  readonly seed: number;
  /** 時刻（練習の開始からの秒）付きのアクションの列。積んだ順。 */
  readonly actions: readonly TimedAction[];
}

/** 練習の乱数の種を 1 つ決める。0 以上 2³² 未満の整数。 */
export function createSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}

function copyAction(action: Action): Action {
  return { ...action };
}

/**
 * 積んだアクションを記録しながら、シミュレーションに流す入力の元。
 * シミュレーションに積むアクションはすべてここを通すので、記録には積んだものが積んだ順にすべて入る。
 */
export class RecordingInput implements InputSource {
  readonly seed: number;
  private readonly queue = new InputQueue();
  private readonly actions: TimedAction[] = [];

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  push(time: number, action: Action): void {
    this.actions.push({ time, action: copyAction(action) });
    this.queue.push(time, action);
  }

  take(endTime: number): Action[] {
    return this.queue.take(endTime);
  }

  /** ここまでの記録の写し。あとから積んだアクションは含まない。 */
  recording(): InputRecording {
    return { seed: this.seed, actions: this.actions.map(({ time, action }) => ({ time, action: copyAction(action) })) };
  }
}

/** 記録を時刻の順にそのまま流す、再生の入力の元。 */
export function replayInput(recording: InputRecording): InputSource {
  return inputFromTimedActions(recording.actions);
}
