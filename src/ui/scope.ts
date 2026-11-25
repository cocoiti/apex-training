import type { Action } from '../input/actions';
import { resolveCrosshair } from './crosshair';

/** 表示を切り替える要素（hidden を持つもの）。 */
export type ToggleElement = Pick<HTMLElement, 'hidden'>;

/** 腰撃ちのクロスヘア（index.html の .crosshair）とスコープの表示（.scope）。 */
export interface AimDisplayElements {
  readonly crosshair: ToggleElement;
  readonly scope: ToggleElement;
}

/** スコープの要素。レティクルの色は style.css の .scope が --reticle-color から読む。 */
export type ScopeElement = {
  readonly style: Pick<CSSStyleDeclaration, 'setProperty'>;
};

/**
 * ads を押している間はスコープの表示、離している間は腰撃ちのクロスヘアを出す（docs/spec/screens.md「ADS 中の照準」）。
 * 描画だけの切替で、カメラの視野角とシミュレーションには触れない。
 */
export function showAimDisplay(elements: AimDisplayElements, ads: boolean): void {
  elements.crosshair.hidden = ads;
  elements.scope.hidden = !ads;
}

/** レティクルの色をクロスヘアの色にする。形はクロスヘアの形によらず同じ（十字と点）。当てた色を返す。 */
export function applyReticleColor(element: ScopeElement, color: string | undefined): string {
  const resolved = resolveCrosshair(color === undefined ? {} : { color }).color;
  element.style.setProperty('--reticle-color', resolved);
  return resolved;
}

/** 入力のアクションから、ads を押しているかを求める。ads 以外のアクションでは変わらない。 */
export function adsAfter(held: boolean, action: Action): boolean {
  return action.type === 'ads' ? action.pressed : held;
}
