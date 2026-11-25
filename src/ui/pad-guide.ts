import type { InputMethod } from '../input/input-switch';
import { stickPosition, type LookRate, type PadSettings, type StickPosition } from '../input/pad-curve';

/** パッドの名前が分からないときの表示。 */
export const UNKNOWN_PAD_NAME = 'パッド';

/**
 * ガイドを表示するか（docs/spec/pad.md「練習中のガイド」）。設定のゴースト表示が ON で、ゴーストを表示している
 * （ゴースト追従で、撃ち切っておらず、練習が終わっていない）あいだ、今の入力方式がパッドなら表示する。
 */
export function padGuideVisible(state: { readonly showGhost: boolean; readonly ghostShown: boolean; readonly inputMethod: InputMethod }): boolean {
  return state.showGhost && state.ghostShown && state.inputMethod === 'pad';
}

/** ガイドに出すもの（docs/spec/pad.md「練習中のガイド」）。 */
export interface PadGuideState {
  /** 理想の位置。今の理想の補正速度をカーブの逆で直したスティックの位置。 */
  readonly ideal: StickPosition;
  /** 今の位置。今の右スティックの値（デッドゾーンをかける前）。 */
  readonly current: StickPosition;
  /** 入力に使っているパッドの名前。 */
  readonly name: string;
}

export interface PadGuideInput {
  /** 今の理想の補正速度（度/秒）。 */
  readonly idealRate: Readonly<LookRate>;
  /** 今 ADS 中か。ADS 中は ADS の最大回転速度でカーブの逆を求める。 */
  readonly ads: boolean;
  /** その練習に当てたパッドの設定。 */
  readonly settings: Readonly<PadSettings>;
  /** 今の右スティックの値。右と上が正。 */
  readonly stick: StickPosition;
  /** 入力に使っているパッドの名前（Gamepad API の id）。分からないときは undefined。 */
  readonly name: string | undefined;
}

/** 理想の補正速度と今のスティックの値から、ガイドに出すものを作る。今の位置は可動範囲の円（大きさ 1）に収める。 */
export function padGuideState(input: PadGuideInput): PadGuideState {
  const { x, y } = input.stick;
  const size = Math.hypot(x, y);
  const current = size > 1 ? { x: x / size, y: y / size } : { x, y };
  return {
    ideal: stickPosition(input.idealRate, input.settings, input.ads),
    current,
    name: input.name ?? UNKNOWN_PAD_NAME,
  };
}

/** 点の要素。位置は style.css の .pad-guide-dot が --x・--y（右と上が正の %）から読み、data-x・data-y にも同じ値を書く。 */
export interface PadGuideDot {
  readonly style: Pick<CSSStyleDeclaration, 'setProperty'>;
  setAttribute(name: string, value: string): void;
}

/** ガイドの要素。index.html の .pad-guide の要素。 */
export interface PadGuideElements {
  readonly root: Pick<HTMLElement, 'hidden'>;
  readonly ideal: PadGuideDot;
  readonly current: PadGuideDot;
  readonly name: Pick<HTMLElement, 'textContent'>;
}

/** 位置の数。小数第 2 位までの %、-0 は 0 にする。 */
function percent(value: number): string {
  const rounded = Math.round(value * 10000) / 100;
  return String(rounded === 0 ? 0 : rounded);
}

function placeDot(dot: PadGuideDot, position: StickPosition): void {
  const x = percent(position.x);
  const y = percent(position.y);
  dot.style.setProperty('--x', x);
  dot.style.setProperty('--y', y);
  dot.setAttribute('data-x', x);
  dot.setAttribute('data-y', y);
}

/** ガイドを表示する。state がなければ隠す。表示だけで、シミュレーションと入力の記録には触れない。 */
export function renderPadGuide(elements: PadGuideElements, state: PadGuideState | undefined): void {
  if (!state) {
    elements.root.hidden = true;
    return;
  }
  placeDot(elements.ideal, state.ideal);
  placeDot(elements.current, state.current);
  if (elements.name.textContent !== state.name) elements.name.textContent = state.name;
  elements.root.hidden = false;
}
