import type { CompareMetric } from '../modes/types';
import { formatMetric, isBetter, SHOT_DEVIATION_METRIC } from './mode-scoring';
import type { InputMethod } from './personal-best';
import type { RoundRecord } from './practice-set';
import { escapeHtml } from './result-plot';

/** セットのまとめの一覧の 1 行。 */
export interface SetRoundRow {
  readonly round: number;
  /** その回の比べる指標の値。求まらない回は null。 */
  readonly value: number | null;
  /** いちばん良かった回か。 */
  readonly best: boolean;
}

/**
 * セットのまとめ（docs/spec/screens.md「セットのまとめ」）。モードの比べる指標（反復練習は平均ズレ）で並べ、
 * 値が求まらない回は、平均・いちばん良かった回・推移の図に入れない。
 */
export interface SetSummary {
  /** 比べる指標。 */
  readonly metric: CompareMetric;
  /** 選んだ回数。 */
  readonly count: number;
  /** 最後まで終えた回。回の番号の順。 */
  readonly rounds: readonly SetRoundRow[];
  /** 各回の比べる指標の平均。対象の回がないときは null。 */
  readonly average: number | null;
  /** 比べる指標が最も良い回（同じなら番号の小さい回）。対象の回がないときは null。 */
  readonly best: { readonly round: number; readonly value: number } | null;
  /** どれかの回で自己ベストを更新したか。シェアの文に使う。 */
  readonly bestUpdated: boolean;
}

/** 終えた回からセットのまとめを作る。metric はモードの比べる指標で、省くと平均ズレ（小さいほど良い）。 */
export function summarizeSet(rounds: readonly RoundRecord[], count: number, metric: CompareMetric = SHOT_DEVIATION_METRIC): SetSummary {
  const scored = rounds.filter((r): r is RoundRecord & { value: number } => r.value !== null);
  let best: SetSummary['best'] = null;
  for (const r of scored) {
    if (best === null || isBetter(metric, r.value, best.value)) best = { round: r.round, value: r.value };
  }
  const average = scored.length === 0 ? null : scored.reduce((sum, r) => sum + r.value, 0) / scored.length;
  return {
    metric,
    count,
    rounds: rounds.map((r) => ({ round: r.round, value: r.value, best: best !== null && r.round === best.round })),
    average,
    best,
    bestUpdated: rounds.some((r) => r.bestUpdated === true),
  };
}

const INPUT_LABELS: Readonly<Record<InputMethod, string>> = { mouse: 'マウス', pad: 'パッド' };

/**
 * 見出しの 1 行。武器・モード・入力方式と、終えた回の数と選んだ回数（例: 「L-STAR / 反復練習 / マウス — 3 / 5 回」）。
 * 武器を使わないモードでは武器の名前を undefined にし、モード・入力方式から書く。練習の選択肢を持つモードでは、モードのあとに
 * option（例: 「速さ: ふつう」）を書く。
 */
export function setSummaryHeading(weaponName: string | undefined, modeName: string, input: InputMethod, summary: SetSummary, option?: string): string {
  const names = [...(weaponName === undefined ? [] : [weaponName]), modeName, ...(option === undefined ? [] : [option]), INPUT_LABELS[input]].join(' / ');
  return `${names} — ${summary.rounds.length} / ${summary.count} 回`;
}

export function setAverageText(summary: SetSummary): string {
  return `セットの平均 ${formatMetric(summary.metric, summary.average)}`;
}

export function setBestText(summary: SetSummary): string {
  const best = summary.best;
  return best === null ? 'いちばん良かった回 なし' : `いちばん良かった回 ${best.round} 回目（${formatMetric(summary.metric, best.value)}）`;
}

/** 各回の比べる指標の一覧の HTML（li の並び）。いちばん良かった回に印（data-best と「★」）を付ける。 */
export function setRoundsHtml(summary: SetSummary): string {
  return summary.rounds
    .map((r) => {
      const mark = r.best ? ' data-best="true"' : '';
      const star = r.best ? ' <span class="set-best-mark">★</span>' : '';
      return `<li data-round="${r.round}"${mark}><span class="set-round-number">${r.round} 回目</span> ${escapeHtml(formatMetric(summary.metric, r.value))}${star}</li>`;
    })
    .join('');
}

/** 推移の図の大きさ（SVG の座標）。 */
const WIDTH = 320;
const HEIGHT = 180;
const PAD = { left: 40, right: 12, top: 12, bottom: 24 } as const;
/** 縦軸の最小の上限。比べる指標の値がどれも小さくても点が底に張り付かないようにする。 */
const MIN_Y_MAX = 0.5;
const MARGIN = 1.15;

function num(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded === 0 ? 0 : rounded);
}

/**
 * 比べる指標（反復練習は平均ズレ）の推移の図（SVG を含む figure の HTML）。横軸は回の番号（1 から選んだ回数まで）、
 * 縦軸は比べる指標の値（0 が下）。値が求まらない回は点を打たない。対象の回がないときは軸だけを描く。
 */
export function setTrendPlotHtml(summary: SetSummary): string {
  const points = summary.rounds.filter((r): r is SetRoundRow & { value: number } => r.value !== null);
  const yMax = Math.max(...points.map((p) => p.value * MARGIN), MIN_Y_MAX);
  const unit = escapeHtml(summary.metric.unit);
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (round: number) => PAD.left + (summary.count <= 1 ? plotWidth / 2 : ((round - 1) / (summary.count - 1)) * plotWidth);
  const y = (value: number) => PAD.top + (1 - value / yMax) * plotHeight;
  const bottom = PAD.top + plotHeight;
  const coords = points.map((p) => `${num(x(p.round))},${num(y(p.value))}`);
  const parts = [
    `<line class="plot-axis" x1="${PAD.left}" y1="${num(bottom)}" x2="${WIDTH - PAD.right}" y2="${num(bottom)}" />`,
    `<line class="plot-axis" x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${num(bottom)}" />`,
    `<text class="plot-label" x="${PAD.left - 4}" y="${num(bottom)}" text-anchor="end">0${unit}</text>`,
    `<text class="plot-label" x="${PAD.left - 4}" y="${PAD.top + 8}" text-anchor="end">${yMax.toFixed(2)}${unit}</text>`,
    `<text class="plot-label" x="${num(x(1))}" y="${HEIGHT - 6}" text-anchor="middle">1</text>`,
  ];
  if (summary.count > 1) {
    parts.push(`<text class="plot-label" x="${num(x(summary.count))}" y="${HEIGHT - 6}" text-anchor="middle">${summary.count}</text>`);
  }
  parts.push(`<polyline class="plot-series plot-trend" points="${coords.join(' ')}" />`);
  const dots = points.map((p) => `<circle cx="${num(x(p.round))}" cy="${num(y(p.value))}" r="4" data-round="${p.round}" />`).join('');
  parts.push(`<g class="plot-series plot-trend" data-series="mean" data-count="${points.length}">${dots}</g>`);
  const title = escapeHtml(`${summary.metric.label}の推移`);
  return (
    `<figure class="plot plot-set" data-plot="trend">` +
    `<figcaption>${title}</figcaption>` +
    `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${title}">${parts.join('')}</svg>` +
    `</figure>`
  );
}

/** セットのまとめの要素。index.html の #set-* の要素。 */
export interface SetSummaryElements {
  readonly heading: Pick<HTMLElement, 'textContent'>;
  readonly rounds: Pick<HTMLElement, 'innerHTML'>;
  readonly plot: Pick<HTMLElement, 'innerHTML'>;
  readonly average: Pick<HTMLElement, 'textContent'>;
  readonly best: Pick<HTMLElement, 'textContent'>;
}

/** セットのまとめの要素を書き換える。 */
export function renderSetSummary(elements: SetSummaryElements, heading: string, summary: SetSummary): void {
  elements.heading.textContent = heading;
  elements.rounds.innerHTML = setRoundsHtml(summary);
  elements.plot.innerHTML = setTrendPlotHtml(summary);
  elements.average.textContent = setAverageText(summary);
  elements.best.textContent = setBestText(summary);
}
