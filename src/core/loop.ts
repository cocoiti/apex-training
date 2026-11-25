import type { TimeSource } from './time';

/** シミュレーションの既定の固定ステップ（秒）。 */
export const DEFAULT_FIXED_STEP = 1 / 120;

/** 1 回の描画で進める経過時間の上限（秒）。長く止まったあとにステップを大量に進めない。 */
export const MAX_FRAME_TIME = 0.25;

/**
 * 浮動小数の誤差で、ちょうど 1 ステップ分たまったのに足りないと判定しないための許容幅（秒）。
 * 1/60 秒を 60 回足しても 120 ステップ進むようにする。
 */
const EPSILON = 1e-9;

export interface FixedStepLoopOptions {
  timeSource: TimeSource;
  /** 1 ステップ進める。dt は固定ステップ（秒）。 */
  update: (dt: number) => void;
  /** 描画する。alpha は補間の係数（0 以上 1 未満）。 */
  render: (alpha: number) => void;
  step?: number;
  maxFrameTime?: number;
}

/**
 * 蓄積方式の固定ステップのループ。frame() を描画のたびに呼ぶ。
 * 前回からの経過時間を蓄え、固定ステップ以上たまっている間 update を呼び、残りを補間の係数として render に渡す。
 */
export class FixedStepLoop {
  readonly step: number;
  private readonly maxFrameTime: number;
  private readonly timeSource: TimeSource;
  private readonly update: (dt: number) => void;
  private readonly render: (alpha: number) => void;
  private lastNow: number;
  private accumulator = 0;
  private steps = 0;
  private stopped = false;

  constructor(options: FixedStepLoopOptions) {
    this.step = options.step ?? DEFAULT_FIXED_STEP;
    this.maxFrameTime = options.maxFrameTime ?? MAX_FRAME_TIME;
    this.timeSource = options.timeSource;
    this.update = options.update;
    this.render = options.render;
    this.lastNow = this.timeSource.now();
  }

  /** これまでに進めたステップの数。 */
  get stepCount(): number {
    return this.steps;
  }

  /**
   * ループの時計での今の時刻（秒）。進めたステップの時間と、描画のあとに経過した時間（上限つき）の和。
   * 入力の発生時刻はこの時計で付ける。
   */
  currentTime(): number {
    if (this.stopped) return this.steps * this.step + this.accumulator;
    const sinceFrame = Math.min(Math.max(this.timeSource.now() - this.lastNow, 0), this.maxFrameTime);
    return this.steps * this.step + this.accumulator + sinceFrame;
  }

  /** 止めているか。 */
  get paused(): boolean {
    return this.stopped;
  }

  /**
   * ループを止める。止めるまでの経過時間（上限つき）は蓄え、止めている間は時刻が進まず、frame() は描画だけを行う。
   * 止めている間の入力の時刻は止めた時刻になる。
   */
  pause(): void {
    if (this.stopped) return;
    const now = this.timeSource.now();
    this.accumulator += Math.min(Math.max(now - this.lastNow, 0), this.maxFrameTime);
    this.lastNow = now;
    this.stopped = true;
  }

  /** 止めたループを再開する。止めていた間の時間は数えない。 */
  resume(): void {
    if (!this.stopped) return;
    this.lastNow = this.timeSource.now();
    this.stopped = false;
  }

  /** 1 回の描画。進めたステップの数を返す。止めているときは描画だけを行い 0 を返す。 */
  frame(): number {
    if (this.stopped) {
      this.render(Math.min(this.accumulator / this.step, 1 - Number.EPSILON));
      return 0;
    }
    const now = this.timeSource.now();
    const elapsed = Math.min(Math.max(now - this.lastNow, 0), this.maxFrameTime);
    this.lastNow = now;
    this.accumulator += elapsed;

    let advanced = 0;
    while (this.accumulator + EPSILON >= this.step) {
      this.update(this.step);
      this.accumulator = Math.max(this.accumulator - this.step, 0);
      this.steps += 1;
      advanced += 1;
    }

    this.render(Math.min(this.accumulator / this.step, 1 - Number.EPSILON));
    return advanced;
  }
}
