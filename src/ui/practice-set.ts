/** トップ画面の回数の選択肢（docs/spec/screens.md「トップ画面」）。最初の 1 を選んだ状態で開く。 */
export const PRACTICE_COUNTS = [1, 5, 10, 20] as const;

/** 短いリザルトを表示する時間（秒）。過ぎたら次の回を自動で始める（docs/spec/modes.md「連続練習（セット）」）。 */
export const INTERLUDE_SECONDS = 3;

/** 回数の選択肢の値を回数にする。選択肢にない値は 1（連続練習にしない）。 */
export function parsePracticeCount(value: string): number {
  const count = Number(value);
  return (PRACTICE_COUNTS as readonly number[]).includes(count) ? count : 1;
}

/** 最後まで終えた 1 回。 */
export interface RoundRecord {
  /** 回の番号（1 から）。 */
  readonly round: number;
  /** その回のモードの比べる指標の値（反復練習は平均ズレ、度）。求まらない回は null。 */
  readonly value: number | null;
  /** その回で自己ベストを更新したか。省いたときは更新していない。 */
  readonly bestUpdated?: boolean;
}

/** セットの状態。playing は回の練習中、interlude は短いリザルトの表示中、done はセットを終えた。 */
export type SetPhase = 'playing' | 'interlude' | 'done';

/**
 * 回数を決めた連続練習（docs/spec/modes.md「連続練習（セット）」）。回数が 1 のときは 1 回分の練習と同じで、短いリザルトを挟まない。
 * 回の練習そのもの（World・シミュレーション）は持たず、回の番号と終えた回の比べる指標の値と、短いリザルトの時間だけを持つ。
 * 時刻（now、秒）は短いリザルトの残り時間にだけ使い、呼び出し側の時計（performance.now() など）で渡す。
 */
export class PracticeSet {
  readonly count: number;
  private current = 1;
  private readonly finished: RoundRecord[] = [];
  private state: SetPhase = 'playing';
  private interludeEnd = 0;

  constructor(count: number) {
    this.count = Math.max(1, Math.floor(count));
  }

  /** 連続練習（回数が 2 以上）か。 */
  get isSet(): boolean {
    return this.count >= 2;
  }

  /** 今の回の番号（1 から）。短いリザルトの表示中は、終えた回の番号。 */
  get round(): number {
    return this.current;
  }

  get phase(): SetPhase {
    return this.state;
  }

  /** 最後まで終えた回。回の番号の順。打ち切った回は入らない。 */
  get rounds(): readonly RoundRecord[] {
    return this.finished;
  }

  /**
   * 今の回を最後まで終えた。最後の回なら done、そうでなければ短いリザルトを始めて interlude を返す。
   * 回数が 1 のときも done を返す（呼び出し側はリザルト画面を出す）。
   */
  completeRound(value: number | null, now: number, bestUpdated = false): SetPhase {
    if (this.state !== 'playing') return this.state;
    this.finished.push({ round: this.current, value, bestUpdated });
    if (this.finished.length >= this.count) {
      this.state = 'done';
    } else {
      this.state = 'interlude';
      this.interludeEnd = now + INTERLUDE_SECONDS;
    }
    return this.state;
  }

  /** 短いリザルトの残り時間（秒、0 以上）。表示中でなければ 0。 */
  interludeRemaining(now: number): number {
    return this.state === 'interlude' ? Math.max(this.interludeEnd - now, 0) : 0;
  }

  /** 短いリザルトの表示中で、表示する時間が過ぎたか。 */
  interludeElapsed(now: number): boolean {
    return this.state === 'interlude' && now >= this.interludeEnd;
  }

  /** 短いリザルトを終えて次の回にする。表示中でなければ何もしない。次の回にしたら true。 */
  next(): boolean {
    if (this.state !== 'interlude') return false;
    this.state = 'playing';
    this.current += 1;
    return true;
  }

  /**
   * セットをやめる。練習中の回は数に入れない。終えた回があれば summary（セットのまとめを出す）、なければ top（トップ画面に戻る）。
   */
  quit(): 'summary' | 'top' {
    this.state = 'done';
    return this.finished.length > 0 ? 'summary' : 'top';
  }
}
