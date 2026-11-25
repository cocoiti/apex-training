import type { Action, LookAction } from './actions';
import { lookRate, type PadSettings, type StickPosition } from './pad-curve';
import { isStandardMapping, padName, STANDARD_PAD_LAYOUT, type PadLayout } from './pad-layout';

export { isStandardMapping } from './pad-layout';

/** Gamepad API の Gamepad のうち、読み取りに使う部分。テストでは素のオブジェクトで代用する。 */
export interface GamepadLike {
  readonly connected: boolean;
  /** パッドの名前（Gamepad API の id）。 */
  readonly id?: string;
  readonly mapping: string;
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly value: number; readonly pressed: boolean }[];
}

/** 標準配置の、画面の操作に使うボタンの番号（docs/spec/pad.md）。fire・ads・右スティックは STANDARD_PAD_LAYOUT。 */
export const STANDARD_LAYOUT = {
  /** A / ×。画面の操作（やり直す・次へ・もう一度）に使い、アクションにはしない（src/input/screen-controls.ts）。 */
  confirm: 0,
  /** B / ○。画面の操作（やめる・武器変更）に使い、アクションにはしない。 */
  back: 1,
} as const;

/** R2 / RT と L2 / LT を押している状態とみなすアナログ値の既定のしきい値。 */
export const DEFAULT_TRIGGER_THRESHOLD = 0.5;

/** つながっているパッドのうち最初のものを返す。navigator.getGamepads() の結果を渡す。 */
export function firstConnectedGamepad(pads: readonly (GamepadLike | null)[]): GamepadLike | null {
  return pads.find((pad): pad is GamepadLike => pad !== null && pad.connected) ?? null;
}

export interface PadInputOptions {
  /** fire・ads を積む。時刻は呼び出し側で付ける。 */
  emit: (action: Action) => void;
  settings: () => Readonly<PadSettings>;
  triggerThreshold?: number;
  /**
   * パッドの操作。ボタンを押し始めたとき（R2 / RT と L2 / LT はしきい値以上に押し始めたとき）と、右スティックが
   * デッドゾーンの内側から外へ出たときに、そのときのアクションを積む前に呼ぶ（docs/spec/input.md「入力方式の切替」）。
   */
  onActivity?: () => void;
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
  private readonly onActivity: () => void;
  private stick = { x: 0, y: 0 };
  private held = { fire: false, ads: false };
  private connected = false;
  private padName: string | undefined;
  /** 読んでいるパッドの配置。 */
  private layout: PadLayout = STANDARD_PAD_LAYOUT;
  /** 前に読んだときに押していたボタンの番号。 */
  private pressedButtons = new Set<number>();
  /** 前に読んだときに右スティックがデッドゾーンの外にあったか。 */
  private stickOutside = false;

  constructor(options: PadInputOptions) {
    this.emit = options.emit;
    this.settings = options.settings;
    this.threshold = options.triggerThreshold ?? DEFAULT_TRIGGER_THRESHOLD;
    this.onActivity = options.onActivity ?? (() => {});
  }

  /** 入力に使うパッドを読んでいるか。 */
  get active(): boolean {
    return this.connected;
  }

  /** 読んでいるパッドの名前（Gamepad API の id）。読んでいないとき、名前が空のときは undefined。 */
  get name(): string | undefined {
    return this.connected ? this.padName : undefined;
  }

  /** 最後に読んだ右スティックの値（デッドゾーンをかける前）。右と上が正。読んでいないときは中心。 */
  get stickValue(): StickPosition {
    return { ...this.stick };
  }

  /**
   * パッドの最新の値を読む。layout はそのパッドの配置（標準配置か保存したボタン割り当て）で、省くと標準配置のパッドだけを読む。
   * null（外れた・使えるパッドがない）や、配置のない標準配置でないパッドのときは、look を止め、fire・ads を離した状態にする。
   */
  poll(pad: GamepadLike | null, layout?: PadLayout): void {
    const use = layout ?? (pad && isStandardMapping(pad) ? STANDARD_PAD_LAYOUT : undefined);
    if (!pad || !pad.connected || !use) {
      this.connected = false;
      this.padName = undefined;
      this.stick = { x: 0, y: 0 };
      this.pressedButtons = new Set();
      this.stickOutside = false;
      this.setHeld('fire', false);
      this.setHeld('ads', false);
      return;
    }
    this.connected = true;
    this.padName = padName(pad.id);
    this.layout = use;
    this.stick = { x: readAxis(pad, use.lookX), y: readUp(pad, use.lookY) };
    if (this.detectActivity(pad)) this.onActivity();
    this.setHeld('fire', this.triggerPressed(pad, use.fire));
    this.setHeld('ads', this.triggerPressed(pad, use.ads));
  }

  /** 1 固定ステップ分の look。動かないときは undefined。ADS 中はパッドの L2 / LT の状態で判断する。 */
  step(dt: number): LookAction | undefined {
    const rate = lookRate(this.stick.x, this.stick.y, this.settings(), this.held.ads);
    if (rate.yaw === 0 && rate.pitch === 0) return undefined;
    return { type: 'look', yaw: rate.yaw * dt, pitch: rate.pitch * dt };
  }

  /** ボタンを押し始めたか、右スティックがデッドゾーンの外へ出たか。押している・外にある状態は次の判定のために覚える。 */
  private detectActivity(pad: GamepadLike): boolean {
    const pressed = new Set<number>();
    pad.buttons.forEach((button, index) => {
      if (this.buttonPressed(pad, index, button)) pressed.add(index);
    });
    const newlyPressed = [...pressed].some((index) => !this.pressedButtons.has(index));
    this.pressedButtons = pressed;
    const outside = Math.hypot(this.stick.x, this.stick.y) > this.settings().deadzone / 100;
    const stickMoved = outside && !this.stickOutside;
    this.stickOutside = outside;
    return newlyPressed || stickMoved;
  }

  /** fire・ads のボタン（R2 / RT と L2 / LT、割り当てたボタン）はしきい値以上、ほかのボタンは pressed で押しているとみなす。 */
  private buttonPressed(pad: GamepadLike, index: number, button: GamepadLike['buttons'][number]): boolean {
    if (index === this.layout.fire || index === this.layout.ads) return this.triggerPressed(pad, index);
    return button.pressed;
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

/** 右スティックの左右の値。右が正。 */
function readAxis(pad: GamepadLike, binding: PadLayout['lookX']): number {
  const value = pad.axes[binding.axis] ?? 0;
  // 0 を -0 にしない。
  return binding.invert ? 0 - value : value;
}

/** 右スティックの上下の値。上が正（Gamepad API の上下は下が正なので、反転しないときに符号を変える）。 */
function readUp(pad: GamepadLike, binding: PadLayout['lookY']): number {
  const value = pad.axes[binding.axis] ?? 0;
  return binding.invert ? value : 0 - value;
}
