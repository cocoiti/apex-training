import { MAX_FRAME_TIME } from './loop';
import type { TimeSource } from './time';

/** 描画のたびに呼ぶもの。time はミリ秒（requestAnimationFrame の時刻と同じ単位）。 */
export type FrameCallback = (time: number) => void;

/**
 * ページの時計と描画の予定。ページが時間で決めている振る舞い（固定ステップのループ、短いリザルトの残り時間、
 * パッドの方向の繰り返しなど）は、この時計の now() と、requestFrame で呼ばれる描画の時刻で決める
 * （docs/spec/architecture.md「テストのための描画の省略と時計の差し替え」）。
 */
export interface FrameClock extends TimeSource {
  /** 次の描画で cb を 1 回呼ぶ（requestAnimationFrame と同じく、続けるには呼ばれた中で頼み直す）。 */
  requestFrame(cb: FrameCallback): void;
  /** これまでに行った描画の回数。同じ描画の中では同じ値。 */
  readonly frameCount: number;
  /**
   * 今の描画で 3D を描くか。ManualFrameClock.advance() が時刻を進めるために行う描画の中では false で、
   * シミュレーションと HUD だけを進め、3D は次の実際の描画（requestAnimationFrame）で最後の状態を 1 回だけ描く。
   */
  readonly draws: boolean;
}

/**
 * 頼まれた描画の呼び出しを貯め、1 回の描画でまとめて呼ぶ。呼ばれた中で頼んだものは次の描画に回す。
 * 1 つが例外を投げても残りは呼ぶ（呼ばれなかったものは頼み直されず、そのループが止まるため）。
 * 例外は握りつぶさず、すべて呼んだあとに投げ直す（2 つ以上なら AggregateError にまとめる）。
 */
class FrameQueue {
  private pending: FrameCallback[] = [];
  count = 0;

  add(cb: FrameCallback): void {
    this.pending.push(cb);
  }

  run(time: number): void {
    const callbacks = this.pending;
    this.pending = [];
    this.count += 1;
    const errors: unknown[] = [];
    for (const cb of callbacks) {
      try {
        cb(time);
      } catch (e) {
        errors.push(e);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'frame callbacks threw');
  }
}

/** 描画の予定を頼む関数（ブラウザでは requestAnimationFrame）。 */
export type ScheduleFrame = (run: (time: number) => void) => void;

/** 実時間の時計。時刻は nowMs（ブラウザでは performance.now()）、描画は schedule（requestAnimationFrame）で行う。 */
export class RealFrameClock implements FrameClock {
  private readonly queue = new FrameQueue();
  private scheduled = false;

  constructor(
    private readonly schedule: ScheduleFrame,
    private readonly nowMs: () => number,
  ) {}

  now(): number {
    return this.nowMs() / 1000;
  }

  get frameCount(): number {
    return this.queue.count;
  }

  /** 実時間の時計では、描画のたびに 3D を描く。 */
  get draws(): boolean {
    return true;
  }

  requestFrame(cb: FrameCallback): void {
    this.queue.add(cb);
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule((time) => {
      this.scheduled = false;
      this.queue.run(time);
    });
  }
}

/** advance() で 1 回に進める描画の間隔の既定（秒）。60Hz の画面と同じ。 */
export const MANUAL_FRAME_SECONDS = 1 / 60;

/**
 * テストから進める時計（clock=manual）。時刻は実時間では進まず、advance() で進めた分だけ進む。
 * advance() は進める時間を描画の間隔ごとに区切り、区切りごとに描画を 1 回行うので、実時間で待たずに
 * その時間がたったときと同じ振る舞いになる。schedule を渡すと、実際の描画のたびにも時刻を進めずに描画を行う
 * （時計を進めない間も、押したボタンや画面の切替を HUD などに出す）。
 */
export class ManualFrameClock implements FrameClock {
  private readonly queue = new FrameQueue();
  private current: number;
  private scheduled = false;
  private advancing = false;

  constructor(
    private readonly schedule?: ScheduleFrame,
    startSeconds = 0,
  ) {
    this.current = startSeconds;
  }

  now(): number {
    return this.current;
  }

  get frameCount(): number {
    return this.queue.count;
  }

  /** advance() の中の描画では 3D を描かない（時刻を進めるたびに描くと、描画を確かめるテストが重くなる）。 */
  get draws(): boolean {
    return !this.advancing;
  }

  requestFrame(cb: FrameCallback): void {
    this.queue.add(cb);
    if (this.scheduled || !this.schedule) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      this.queue.run(this.current * 1000);
    });
  }

  /**
   * 時計を seconds 秒進める。frameSeconds ごとに時刻を進めて描画を 1 回行う。時刻を進めた描画の回数を返す。
   * 描画の間隔は、固定ステップのループが 1 回の描画で進める上限（MAX_FRAME_TIME）まで（それより長いと進めた時間を捨てるため）。
   * この描画の中では draws が false になり、3D は描かない（画面に出るのは、次の実際の描画で描く最後の状態）。
   *
   * 時刻を進める前に、今の時刻のまま描画を 1 回行う。テストが時計を止めている間に変えた入力（スティック・ボタン）は、
   * 実際の描画が間に入ったかどうかによらず、いつも止めていた時刻で読まれる。進めた時間のステップはすべてその入力で進むので、
   * 押していた長さは進めた秒数だけで決まり、実時間でどれだけ待ったかによらない（docs/spec/architecture.md、ARC-63）。
   */
  advance(seconds: number, frameSeconds = MANUAL_FRAME_SECONDS): number {
    if (!(frameSeconds > 0 && frameSeconds <= MAX_FRAME_TIME)) throw new Error(`the frame interval must be greater than 0 and at most ${MAX_FRAME_TIME} s`);
    if (!(seconds > 0)) return 0;
    const end = this.current + seconds;
    let frames = 0;
    this.advancing = true;
    try {
      this.queue.run(this.current * 1000);
      // 浮動小数の誤差で最後に極めて短い描画が残らないよう、残りが間隔の 1/1000 以下なら終わりに合わせる。
      while (end - this.current > frameSeconds * 1e-3) {
        this.current = Math.min(this.current + frameSeconds, end);
        if (end - this.current <= frameSeconds * 1e-3) this.current = end;
        this.queue.run(this.current * 1000);
        frames += 1;
      }
    } finally {
      this.advancing = false;
    }
    this.current = end;
    return frames;
  }
}
