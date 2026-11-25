import type { Angles } from '../sim/angles';

/** 図の 1 つの系列。points は点を打ち、line は撃った順に線で結ぶ。座標は角度（度、右と上が正）。 */
export interface PlotSeries {
  /** data-series と凡例の色の名前。 */
  readonly name: string;
  /** 凡例の文言。 */
  readonly label: string;
  readonly kind: 'points' | 'line';
  readonly points: readonly Angles[];
}

export interface Plot {
  /** data-plot の名前。 */
  readonly name: string;
  readonly title: string;
  readonly series: readonly PlotSeries[];
  /** 中心を原点に重ねる円の半径（度）。的の半径に使う。 */
  readonly circle?: number;
}

/** 図の範囲の最小の半分の幅（度）。弾が中心に集まっていても点が重なりきらないようにする。 */
const MIN_EXTENT = 1;
/** 図の端に残す余白の割合。 */
const MARGIN = 1.15;

/** SVG の座標の数。小数第 4 位までにし、-0 は 0 にする。 */
function num(value: number): string {
  const rounded = Math.round(value * 10000) / 10000;
  return String(rounded === 0 ? 0 : rounded);
}

/** HTML に埋める文言のエスケープ。 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 図の範囲の半分の幅（度）。すべての点と円が入り、MIN_EXTENT より狭くならない。 */
export function plotExtent(plot: Pick<Plot, 'series' | 'circle'>): number {
  let max = plot.circle ?? 0;
  for (const series of plot.series) {
    for (const p of series.points) max = Math.max(max, Math.abs(p.yaw), Math.abs(p.pitch));
  }
  return Math.max(max * MARGIN, MIN_EXTENT);
}

/**
 * 図を SVG を含む figure の HTML にする。中心を原点に、右を +x、上を +y として描く（SVG の y は下が正なので反転する）。
 * 数と固定の文言だけを書くので、表示する文言はエスケープしてから埋める。
 */
export function plotHtml(plot: Plot): string {
  const e = plotExtent(plot);
  const dot = e * 0.025;
  const parts: string[] = [
    `<line class="plot-axis" x1="${num(-e)}" y1="0" x2="${num(e)}" y2="0" />`,
    `<line class="plot-axis" x1="0" y1="${num(-e)}" x2="0" y2="${num(e)}" />`,
  ];
  if (plot.circle !== undefined) parts.push(`<circle class="plot-target" cx="0" cy="0" r="${num(plot.circle)}" />`);
  for (const series of plot.series) {
    const attrs = `class="plot-series plot-${escapeHtml(series.name)}" data-series="${escapeHtml(series.name)}" data-count="${series.points.length}"`;
    if (series.kind === 'line') {
      const points = series.points.map((p) => `${num(p.yaw)},${num(-p.pitch)}`).join(' ');
      parts.push(`<polyline ${attrs} points="${points}" />`);
    } else {
      const dots = series.points.map((p) => `<circle cx="${num(p.yaw)}" cy="${num(-p.pitch)}" r="${num(dot)}" />`).join('');
      parts.push(`<g ${attrs}>${dots}</g>`);
    }
  }
  const legend = plot.series
    .map((s) => `<span class="plot-legend plot-${escapeHtml(s.name)}">${escapeHtml(s.label)}</span>`)
    .join('');
  return (
    `<figure class="plot" data-plot="${escapeHtml(plot.name)}">` +
    `<figcaption>${escapeHtml(plot.title)}</figcaption>` +
    `<svg viewBox="${num(-e)} ${num(-e)} ${num(2 * e)} ${num(2 * e)}" role="img" aria-label="${escapeHtml(plot.title)}">${parts.join('')}</svg>` +
    `<p class="plot-legends">${legend}</p>` +
    `</figure>`
  );
}
