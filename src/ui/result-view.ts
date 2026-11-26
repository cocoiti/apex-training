import { DEFAULT_PAD_SETTINGS, stickPosition, type PadSettings } from '../input/pad-curve';
import { padDisplayName } from '../input/pad-layout';
import type { InputRecording } from '../input/recording';
import type { PracticeResult } from '../modes/session';
import { scoreShots, shotDeviations, targetRadius, type ScoreResult } from '../sim/scoring';
import { aimAtShots, lookRateTrace } from '../sim/trajectory';
import { idealCorrection } from '../sim/weapon';
import type { World } from '../sim/world';
import { personalBestKey, recordPersonalBest, type InputMethod, type PersonalBestOutcome } from './personal-best';
import { recordHistory } from './practice-history';
import { escapeHtml, plotHtml, tracePlotHtml, type Plot, type TracePlot } from './result-plot';
import { resultSummaryText } from './result-summary';
import type { SafeStorage } from './storage';
import { weakSection, weakSectionText } from './weak-section';

/** 練習が終わったときにリザルト画面が受け取るもの（docs/spec/scoring.md「リザルト画面」）。 */
export interface FinishedPractice {
  readonly result: PracticeResult;
  /** その練習の入力の記録。自分の照準の軌道を求める。 */
  readonly recording: Pick<InputRecording, 'actions'>;
  /** その練習の World。中心（開始時の照準）と、的の半径を求める的の箱と目の位置を使う。 */
  readonly world: Pick<World, 'boxes' | 'player' | 'center'>;
  readonly input: InputMethod;
  /** 固定ステップの長さ（秒）。 */
  readonly dt: number;
  /** その練習に当てたパッドの設定。右スティックの入力推移をカーブの逆で求める。省いたときは既定値。 */
  readonly padSettings?: Readonly<PadSettings>;
}

/** 右スティックの入力推移のグラフ（docs/spec/pad.md「リザルトの入力推移のグラフ」）。 */
export interface PadTraceView {
  /** 見出し。使ったパッドの名前を含む。 */
  readonly title: string;
  /** 左右の成分と上下の成分の図。 */
  readonly plots: readonly TracePlot[];
}

/** 指標の 1 行。 */
export interface MetricRow {
  readonly label: string;
  readonly value: string;
}

/** リザルト画面に出すもの。 */
export interface ResultView {
  readonly summary: string;
  readonly metrics: readonly MetricRow[];
  readonly comments: readonly string[];
  /** 自己ベストの表示。 */
  readonly best: string;
  /** 平均ズレ（度）。「なし」のときは null。連続練習の短いリザルトとセットのまとめに使う。 */
  readonly meanDeviation: number | null;
  /** 命中率（%）。「なし」のときは null。シェアの文に使う。 */
  readonly hitRate: number | null;
  /** この練習で自己ベストを更新したか。 */
  readonly bestUpdated: boolean;
  readonly plots: readonly Plot[];
  /** 右スティックの入力推移のグラフ。練習の入力方式がパッドのときだけ。マウスのときは null。 */
  readonly padTrace: PadTraceView | null;
  /** 苦手な区間の 1 行。苦手な区間が「なし」のときは null。 */
  readonly weakSection: string | null;
}

/** リザルト画面の苦手な区間の行の見出し。 */
export const WEAK_SECTION_LABEL = 'この武器の苦手な区間';

export function formatDegrees(value: number | null): string {
  return value === null ? 'なし' : `${value.toFixed(2)}°`;
}

export function formatPercent(value: number | null): string {
  return value === null ? 'なし' : `${value.toFixed(1)}%`;
}

export function formatRatio(value: number | null): string {
  return value === null ? 'なし' : value.toFixed(2);
}

/** 指標の行（docs/spec/scoring.md「指標」の順）。「なし」の指標は「なし」と表示する。 */
export function metricRows(result: ScoreResult): MetricRow[] {
  const [first, middle, last] = result.segments;
  return [
    { label: '平均ズレ', value: formatDegrees(result.meanDeviation) },
    { label: 'グルーピング半径', value: formatDegrees(result.groupingRadius) },
    { label: '命中率', value: formatPercent(result.hitRate) },
    {
      label: '区間ごとのズレ',
      value: `前半 ${formatDegrees(first)} / 中盤 ${formatDegrees(middle)} / 後半 ${formatDegrees(last)}`,
    },
    {
      label: '横ブレ / 縦ブレ',
      value: `${formatDegrees(result.horizontalSpread)} / ${formatDegrees(result.verticalSpread)}（比 ${formatRatio(result.spreadRatio)}）`,
    },
  ];
}

/** 自己ベストの表示。更新したら「自己ベスト更新」、しなかったら保存してある自己ベストの平均ズレ。 */
export function personalBestText(outcome: PersonalBestOutcome): string {
  if (outcome.updated) return '自己ベスト更新';
  return `自己ベスト 平均ズレ ${formatDegrees(outcome.best?.meanError ?? null)}`;
}

/**
 * 右スティックの入力推移のグラフを作る。入力の記録を再生して固定ステップごとの自分の回転速度と理想の補正速度を求め、
 * どちらもカーブの逆でスティックの位置に直す。ADS の状態はステップごとに記録の ads から決める。
 */
export function padTraceView(
  practice: Pick<FinishedPractice, 'recording' | 'dt' | 'padSettings'> & { readonly result: Pick<PracticeResult, 'weapon' | 'padName'> },
): PadTraceView {
  const settings = practice.padSettings ?? DEFAULT_PAD_SETTINGS;
  const trace = lookRateTrace(practice.recording, practice.result.weapon, practice.dt).map((point) => ({
    time: point.time,
    stick: stickPosition(point.rate, settings, point.ads),
    ideal: stickPosition(point.ideal, settings, point.ads),
  }));
  const plot = (name: string, title: string, axis: 'x' | 'y'): TracePlot => ({
    name,
    title,
    series: [
      { name: 'ideal', label: '理想', points: trace.map((p) => ({ time: p.time, value: p.ideal[axis] })) },
      { name: 'stick', label: '自分', points: trace.map((p) => ({ time: p.time, value: p.stick[axis] })) },
    ],
  });
  const name = padDisplayName(practice.result.padName);
  return {
    title: `右スティックの入力推移（${name}）`,
    plots: [plot('stick-x', '左右（右が正、%）', 'x'), plot('stick-y', '上下（上が正、%）', 'y')],
  };
}

/**
 * 練習の結果を採点し、自己ベストと比べて保存し、履歴に足し、リザルト画面に出すものを作る。
 * 保存は SafeStorage を通すので、保存できない環境でも投げない。
 */
export function completePractice(
  practice: FinishedPractice,
  storage: Pick<SafeStorage, 'get' | 'set'>,
  now: Date,
): ResultView {
  const { result, world } = practice;
  const summary = resultSummaryText(result);
  const deviations = shotDeviations(result.shots, world.center);
  const shotSeries = { name: 'shots', label: '弾痕', kind: 'points', points: deviations } as const;

  const radius = targetRadius(world);
  const scored = scoreShots(result.shots, world, radius);
  const key = personalBestKey(practice.input, result.weapon.id, result.mode.id);
  const outcome = recordPersonalBest(storage, key, scored, now);
  // 履歴は自己ベストとは別のキーに足す（docs/spec/scoring.md「練習の履歴」）。
  const history = recordHistory(storage, { input: practice.input, weaponId: result.weapon.id, modeId: result.mode.id }, scored, now);
  // 苦手な区間は今の練習を足したあとの履歴から求める（docs/spec/scoring.md「リザルト画面」）。
  const weak = weakSection(history);
  const aim = aimAtShots(practice.recording, result.shots, world.center, practice.dt);
  const ideal = idealCorrection(result.weapon).slice(0, result.shots.length);
  return {
    summary,
    metrics: metricRows(scored),
    comments: scored.comments,
    best: personalBestText(outcome),
    meanDeviation: scored.meanDeviation,
    hitRate: scored.hitRate,
    bestUpdated: outcome.updated,
    padTrace: result.inputMethod === 'pad' ? padTraceView(practice) : null,
    weakSection: weak ? `${WEAK_SECTION_LABEL}: ${weakSectionText(weak)}` : null,
    plots: [
      { name: 'scatter', title: '弾痕の散布図', series: [shotSeries], circle: radius },
      {
        name: 'trajectory',
        title: '照準の軌道',
        series: [
          { name: 'ideal', label: '理想の軌道', kind: 'line', points: ideal },
          { name: 'aim', label: '自分の照準', kind: 'line', points: aim },
        ],
      },
    ],
  };
}

/** リザルト画面の要素。index.html の #result-* の要素。 */
export interface ResultElements {
  readonly summary: Pick<HTMLElement, 'textContent'>;
  readonly metrics: Pick<HTMLElement, 'innerHTML'>;
  readonly comments: Pick<HTMLElement, 'textContent'>;
  readonly best: Pick<HTMLElement, 'textContent'>;
  /** 苦手な区間の行。「なし」のときは隠す。 */
  readonly weakSection: Pick<HTMLElement, 'textContent' | 'hidden'>;
  readonly plots: Pick<HTMLElement, 'innerHTML'>;
  /** 右スティックの入力推移のグラフの要素。グラフがないときは隠す。 */
  readonly padTrace: Pick<HTMLElement, 'innerHTML' | 'hidden'>;
}

/** リザルト画面の要素を書き換える。 */
export function renderResult(elements: ResultElements, view: ResultView): void {
  elements.summary.textContent = view.summary;
  elements.metrics.innerHTML = view.metrics
    .map((row) => `<dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd>`)
    .join('');
  elements.comments.textContent = view.comments.join(' / ');
  elements.best.textContent = view.best;
  elements.weakSection.textContent = view.weakSection ?? '';
  elements.weakSection.hidden = view.weakSection === null;
  elements.plots.innerHTML = view.plots.map(plotHtml).join('');
  const trace = view.padTrace;
  elements.padTrace.hidden = trace === null;
  elements.padTrace.innerHTML = trace
    ? `<h3 class="result-pad-title">${escapeHtml(trace.title)}</h3><div class="result-plots">${trace.plots.map(tracePlotHtml).join('')}</div>`
    : '';
}
