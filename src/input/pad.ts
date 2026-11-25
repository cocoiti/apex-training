import type { Action, LookAction } from './actions';
import { lookRate, type PadSettings } from './pad-curve';

/** Gamepad API の Gamepad のうち、読み取りに使う部分。テストでは素のオブジェクトで代用する。 */
export interface GamepadLike {
  readonly connected: boolean;
  readonly mapping: string;
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly value: number; readonly pressed: boolean }[];
}

/** 標準配置の番号（docs/spec/pad.md）。 */
export const STANDARD_LAYOUT = {
  lookX: 2,
  lookY: 3,
  fire: 7,
  ads: 6,
} as const;

/** R2 / RT と L2 / LT を押している状態とみなすアナログ値の既定のしきい値。 */
export const DEFAULT_TRIGGER_THRESHOLD = 0.5;

/** ブラウザが報告する配置が標準配置か。 */
export function isStandardMapping(pad: Pick<GamepadLike, 'mapping'>): boolean {
  return pad.mapping === 'standard';
}

/** つながっているパッドのうち最初のものを返す。navigator.getGamepads() の結果を渡す。 */
export function firstConnectedGamepad(pads: readonly (GamepadLike | null)[]): GamepadLike | null {
  return pads.find((pad): pad is GamepadLike => pad !== null && pad.connected) ?? null;
}

export interface PadInputOptions {
  /** fire・ads を積む。時刻は呼び出し側で付ける。 */
  emit: (action: Action) => void;
  settings: () => Readonly<PadSettings>;
  triggerThreshold?: number;
}

/**
 * パッドの値をポーリングで読み、fire・ads の押下と解放を積み、固定ステップごとの look を作る。
 * poll() は描画のたびに最新の値を読む。step() は固定ステップごとに、最後に読んだスティックの値から
 * 回転速度を求め、ステップの長さを掛けた角度を返す。回転量はステップの数だけで決まり、描画の間隔によらない。
 */
export class PadInput {
  private readonly emit: (action: Action) => void;
  private readonly settings: () => Readonly<PadSettings>;
  private readonly threshold: number;
  private stick = { x: 0, y: 0 };
  private held = { fire: false, ads: false };
  private connected = false;

  constructor(options: PadInputOptions) {
    this.emit = options.emit;
    this.settings = options.settings;
    this.threshold = options.triggerThreshold ?? DEFAULT_TRIGGER_THRESHOLD;
  }

  /** 標準配置のパッドを読んでいるか。 */
  get active(): boolean {
    return this.connected;
  }

  /**
   * パッドの最新の値を読む。null（外れた）や標準配置でないパッドのときは、look を止め、fire・ads を離した状態にする。
   * 標準配置でないパッドの割り当ては docs/spec/pad.md のボタン割り当て画面の Issue で足す。
   */
  poll(pad: GamepadLike | null): void {
    if (!pad || !pad.connected || !isStandardMapping(pad)) {
      this.connected = false;
      this.stick = { x: 0, y: 0 };
      this.setHeld('fire', false);
      this.setHeld('ads', false);
      return;
    }
    this.connected = true;
    // Gamepad API の上下は下が正。ピッチは上が正なので反転する（0 を -0 にしない）。
    this.stick = {
      x: pad.axes[STANDARD_LAYOUT.lookX] ?? 0,
      y: 0 - (pad.axes[STANDARD_LAYOUT.lookY] ?? 0),
    };
    this.setHeld('fire', this.triggerPressed(pad, STANDARD_LAYOUT.fire));
    this.setHeld('ads', this.triggerPressed(pad, STANDARD_LAYOUT.ads));
  }

  /** 1 固定ステップ分の look。動かないときは undefined。ADS 中はパッドの L2 / LT の状態で判断する。 */
  step(dt: number): LookAction | undefined {
    const rate = lookRate(this.stick.x, this.stick.y, this.settings(), this.held.ads);
    if (rate.yaw === 0 && rate.pitch === 0) return undefined;
    return { type: 'look', yaw: rate.yaw * dt, pitch: rate.pitch * dt };
  }

  private triggerPressed(pad: GamepadLike, index: number): boolean {
    const button = pad.buttons[index];
    return button !== undefined && button.value >= this.threshold;
  }

  private setHeld(type: 'fire' | 'ads', pressed: boolean): void {
    if (this.held[type] === pressed) return;
    this.held[type] = pressed;
    this.emit({ type, pressed });
  }
}
