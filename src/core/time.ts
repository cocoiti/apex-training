/** 経過時間の元。秒で今の時刻を返す。描画のループはこれを差し替えてテストする。 */
export interface TimeSource {
  now(): number;
}

/** テスト用の時間の元。advance() で進めた分だけ時刻が進む。 */
export class ManualTimeSource implements TimeSource {
  private current: number;

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(seconds: number): void {
    this.current += seconds;
  }
}
