import { t } from '../ui/i18n';
import type { Action } from './actions';

/** 練習で使う入力方式（今の入力方式、docs/spec/input.md「入力方式の切替」）。 */
export type InputMethod = 'mouse' | 'pad';

/** 設定で選ぶ入力方式。auto は最後に操作したデバイスの入力方式にする。 */
export type InputPreference = InputMethod | 'auto';

/** 入力方式を HUD などに出す文字（今の表示の言語）。 */
export function inputMethodLabel(method: InputMethod): string {
  return t(method === 'mouse' ? 'input.mouse' : 'input.pad');
}

export interface InputSwitchOptions {
  /** 設定で選んだ入力方式。呼ぶたびに今の値を返す。 */
  preference: () => InputPreference;
  /** 今の入力方式のデバイスのアクションと、切り替えたときの解放を積む。time を省いたときは呼び出し側で時刻を付ける。 */
  emit: (action: Action, time?: number) => void;
}

/**
 * マウスとパッドのうち、今の入力方式のデバイスのアクションだけを練習に通す（docs/spec/input.md「入力方式の切替」）。
 * デバイスは操作（マウスの移動・ボタンの押下、パッドのボタンの押下・デッドゾーンを超えた右スティック）を activity() で知らせ、
 * アクションを input() で渡す。自動のときは操作したデバイスに切り替え、切り替わる前のデバイスの fire・ads を離した状態にする。
 * 今の入力方式はページを開いている間だけ持ち、保存しない。
 */
export class InputSwitch {
  private readonly preference: () => InputPreference;
  private readonly emit: (action: Action, time?: number) => void;
  /** 最後に操作したデバイス。まだどちらも操作していないときはマウス。 */
  private lastOperated: InputMethod = 'mouse';
  /** 今の入力方式のデバイスから通した fire・ads のうち、押したままのもの。 */
  private held = { fire: false, ads: false };

  constructor(options: InputSwitchOptions) {
    this.preference = options.preference;
    this.emit = options.emit;
  }

  /** 今の入力方式。マウス・パッドに固定しているときはその入力方式、自動のときは最後に操作したデバイス。 */
  get current(): InputMethod {
    const preference = this.preference();
    return preference === 'auto' ? this.lastOperated : preference;
  }

  /** device を操作した。自動で今の入力方式と違えば切り替え、切り替わる前のデバイスの fire・ads を離す。 */
  activity(device: InputMethod, time?: number): void {
    const before = this.current;
    this.lastOperated = device;
    if (this.current === before) return;
    this.releaseHeld(time);
  }

  /** device のアクション。今の入力方式のデバイスのものだけを積み、ほかは捨てる。 */
  input(device: InputMethod, action: Action, time?: number): void {
    if (device !== this.current) return;
    if (action.type !== 'look') this.held[action.type] = action.pressed;
    this.emit(action, time);
  }

  /** 押したままの扱いを忘れる。練習を始めるとき（入力のキューを作り直すとき）に呼ぶ。 */
  resetHeld(): void {
    this.held = { fire: false, ads: false };
  }

  private releaseHeld(time?: number): void {
    for (const type of ['fire', 'ads'] as const) {
      if (!this.held[type]) continue;
      this.held[type] = false;
      this.emit({ type, pressed: false }, time);
    }
  }
}
