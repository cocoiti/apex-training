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
    const sinceFrame = Math.min(Math.max(this.timeSource.now() - this.lastNow, 0), this.maxFrameTime);
    return this.steps * this.step + this.accumulator + sinceFrame;
  }

  /** 1 回の描画。進めたステップの数を返す。 */
  frame(): number {
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
