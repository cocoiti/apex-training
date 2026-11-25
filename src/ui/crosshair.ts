/** クロスヘアの形。dot は中心の小さな点、cross は十字、circle は輪。 */
export type CrosshairShape = 'dot' | 'cross' | 'circle';

export const CROSSHAIR_SHAPES: readonly CrosshairShape[] = ['dot', 'cross', 'circle'];

export interface CrosshairStyle {
  readonly shape: CrosshairShape;
  /** `#rrggbb` の色。 */
  readonly color: string;
}

/** 既定のクロスヘア。docs/spec/screens.md「クロスヘア」。 */
export const DEFAULT_CROSSHAIR: CrosshairStyle = { shape: 'dot', color: '#77ccff' };

/** クロスヘアの要素。index.html の .crosshair。 */
export type CrosshairElement = {
  readonly dataset: DOMStringMap;
  readonly style: Pick<CSSStyleDeclaration, 'setProperty'>;
};

/** `#rgb` または `#rrggbb` を小文字の `#rrggbb` にする。それ以外は undefined。 */
export function normalizeColor(color: string): string | undefined {
  const value = color.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  if (/^#[0-9a-f]{3}$/.test(value)) return `#${[...value.slice(1)].map((c) => c + c).join('')}`;
  return undefined;
}

/**
 * クロスヘアの色と形を決める。指定のない項目や形・色として読めない値は既定にする。
 */
export function resolveCrosshair(style: Partial<{ shape: string; color: string }> = {}): CrosshairStyle {
  const shape = CROSSHAIR_SHAPES.find((s) => s === style.shape) ?? DEFAULT_CROSSHAIR.shape;
  const color = (style.color !== undefined && normalizeColor(style.color)) || DEFAULT_CROSSHAIR.color;
  return { shape, color };
}

/** クロスヘアの要素に色と形を当てる。見た目は style.css の .crosshair[data-shape] が決める。当てた値を返す。 */
export function applyCrosshair(
  element: CrosshairElement,
  style: Partial<{ shape: string; color: string }> = {},
): CrosshairStyle {
  const resolved = resolveCrosshair(style);
  element.dataset.shape = resolved.shape;
  element.style.setProperty('--crosshair-color', resolved.color);
  return resolved;
}
