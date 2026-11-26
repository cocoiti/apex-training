import type { ModeIcon } from '../modes/types';

/**
 * トップ画面のモードのカードのアイコン（docs/spec/screens.md「モードの選択」）。画像のファイルを読み込まず、
 * 自作の SVG の図をその場で作る。線と塗りは currentColor で、カードの文字の色に合わせる。
 */

/** アイコンの図の 1 つの形。tag は SVG の要素名、attrs はその属性。 */
export interface IconShape {
  readonly tag: 'circle' | 'path' | 'line';
  readonly attrs: Readonly<Record<string, string | number>>;
}

/** アイコンの座標の範囲（viewBox は 0 0 32 32）。 */
export const ICON_SIZE = 32;

const dot = (cx: number, cy: number, r = 1.6): IconShape => ({ tag: 'circle', attrs: { cx, cy, r, fill: 'currentColor' } });
const ring = (cx: number, cy: number, r: number): IconShape => ({ tag: 'circle', attrs: { cx, cy, r, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 } });
const stroke = (d: string, dashed = false): IconShape => ({
  tag: 'path',
  attrs: { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...(dashed ? { 'stroke-dasharray': '3 3' } : {}) },
});

/** 左右に動く的（輪と中心の点、左右の矢印）。 */
const TRACK: readonly IconShape[] = [ring(16, 16, 6), dot(16, 16), stroke('M2 16h5M4.5 13.5 2 16l2.5 2.5'), stroke('M30 16h-5M27.5 13.5 30 16l-2.5 2.5')];

/** アイコンの形ごとの図。 */
export const MODE_ICON_SHAPES: Readonly<Record<ModeIcon, readonly IconShape[]>> = {
  // リコイルの弾の並び（下から上へ跳ね、左右に揺れる）と照準の十字。
  spray: [dot(16, 26), dot(15, 21), dot(17, 16.5), dot(14.5, 12), dot(18, 8), dot(16, 4), stroke('M6 26h4M8 24v4')],
  track: TRACK,
  // 動く的と、的に向かう弾の並び。
  'track-spray': [...TRACK, dot(12, 28, 1.3), dot(14, 25, 1.3), dot(16, 22.5, 1.3)],
  // 離れた的へ跳ぶ照準（左下の照準から右上の的への破線の矢印）。
  flick: [ring(24, 8, 5), dot(24, 8), stroke('M5 27h6M8 24v6'), stroke('M11 22 19 13', true), stroke('M14.5 13H19v4.5')],
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** アイコンの SVG を作る。読み上げでは名前と重ならないよう飾りとして扱う。 */
export function createModeIcon(doc: Document, icon: ModeIcon): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${ICON_SIZE} ${ICON_SIZE}`);
  svg.setAttribute('class', 'card-icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.icon = icon;
  for (const shape of MODE_ICON_SHAPES[icon]) {
    const element = doc.createElementNS(SVG_NS, shape.tag);
    for (const [name, value] of Object.entries(shape.attrs)) element.setAttribute(name, String(value));
    svg.append(element);
  }
  return svg;
}
