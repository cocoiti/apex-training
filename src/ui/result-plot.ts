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

/** 推移の図の 1 点。time は練習の開始からの秒、value は −1〜1 の値（上が正）。 */
export interface TracePoint {
  readonly time: number;
  readonly value: number;
}

/** 推移の図の 1 つの系列。時刻の順に線で結ぶ。 */
export interface TraceSeries {
  readonly name: string;
  readonly label: string;
  readonly points: readonly TracePoint[];
}

/** 横軸が時刻（秒）、縦軸が −100〜100% の推移の図。 */
export interface TracePlot {
  readonly name: string;
  readonly title: string;
  readonly series: readonly TraceSeries[];
}

/** 推移の図の縦軸の半分の幅（%）。 */
const TRACE_HALF_HEIGHT = 100;
/** 推移の図の横軸の最小の幅（秒）。点が 1 つでも図の幅が 0 にならないようにする。 */
const MIN_TRACE_DURATION = 0.1;

/** 推移の図の横軸の幅（秒）。すべての点の時刻が入り、MIN_TRACE_DURATION より狭くならない。 */
export function traceDuration(plot: Pick<TracePlot, 'series'>): number {
  let max = 0;
  for (const series of plot.series) {
    for (const p of series.points) max = Math.max(max, p.time);
  }
  return Math.max(max, MIN_TRACE_DURATION);
}

/**
 * 推移の図を SVG を含む figure の HTML にする。左端が時刻 0、縦の中心が 0% で上が正（SVG の y は下が正なので反転する）。
 * 横と縦の縮尺は違うので、SVG は図の箱いっぱいに伸ばし、線の太さは CSS で縮尺によらず保つ。
 */
export function tracePlotHtml(plot: TracePlot): string {
  const w = traceDuration(plot);
  const h = TRACE_HALF_HEIGHT;
  const parts: string[] = [
    `<line class="plot-axis" x1="0" y1="0" x2="${num(w)}" y2="0" />`,
    `<line class="plot-axis" x1="0" y1="${num(-h)}" x2="0" y2="${num(h)}" />`,
  ];
  for (const series of plot.series) {
    const attrs = `class="plot-series plot-${escapeHtml(series.name)}" data-series="${escapeHtml(series.name)}" data-count="${series.points.length}"`;
    const points = series.points.map((p) => `${num(p.time)},${num(-p.value * h)}`).join(' ');
    parts.push(`<polyline ${attrs} points="${points}" />`);
  }
  const legend = plot.series
    .map((s) => `<span class="plot-legend plot-${escapeHtml(s.name)}">${escapeHtml(s.label)}</span>`)
    .join('');
  return (
    `<figure class="plot plot-trace" data-plot="${escapeHtml(plot.name)}">` +
    `<figcaption>${escapeHtml(plot.title)}</figcaption>` +
    `<svg viewBox="0 ${num(-h)} ${num(w)} ${num(2 * h)}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(plot.title)}">${parts.join('')}</svg>` +
    `<p class="plot-legends">${legend}</p>` +
    `</figure>`
  );
}
