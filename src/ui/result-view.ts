import { DEFAULT_PAD_SETTINGS, stickPosition, type PadSettings } from '../input/pad-curve';
import { padDisplayName } from '../input/pad-layout';
import type { InputRecording } from '../input/recording';
import type { PracticeResult } from '../modes/session';
import { modeUsesWeakSections, type CompareMetric } from '../modes/types';
import { scoreShots, shotDeviations, targetRadius, type ScoreComment, type ScoreResult } from '../sim/scoring';
import { aimAtShots, lookRateTrace } from '../sim/trajectory';
import { idealCorrection } from '../sim/weapon';
import type { World } from '../sim/world';
import { localize, t, type MessageKey } from './i18n';
import { compareMetric, formatMetric, NO_WEAPON_ID, SHOT_DEVIATION_METRIC } from './mode-scoring';
import {
  personalBestKey,
  recordBest,
  shotDeviationBestCandidate,
  type BestOutcome,
  type InputMethod,
  type PersonalBestOutcome,
} from './personal-best';
import { recordHistoryEntry, shotDeviationHistoryCandidate, type HistoryEntry, type HistorySelection } from './practice-history';
import { escapeHtml, plotHtml, tracePlotHtml, type Plot, type TracePlot } from './result-plot';
import { resultSummaryText } from './result-summary';
import { metricShareScore, shotDeviationShareScore } from './share';
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
  /** モードの比べる指標（反復練習は平均ズレ）。 */
  readonly metric: CompareMetric;
  /** 比べる指標の値（反復練習は平均ズレ、度）。求まらない（「なし」の）ときは null。連続練習の短いリザルトとセットのまとめに使う。 */
  readonly value: number | null;
  /** シェアの文の 3 行目（docs/spec/screens.md「シェアの文」）。 */
  readonly shareScore: string;
  /** この練習で自己ベストを更新したか。 */
  readonly bestUpdated: boolean;
  readonly plots: readonly Plot[];
  /** 右スティックの入力推移のグラフ。練習の入力方式がパッドのときだけ。マウスのときは null。 */
  readonly padTrace: PadTraceView | null;
  /** 苦手な区間の 1 行。苦手な区間が「なし」のときは null。 */
  readonly weakSection: string | null;
}

const COMMENT_KEYS: Readonly<Record<ScoreComment, MessageKey>> = {
  'over-pull': 'comment.overPull',
  'under-pull': 'comment.underPull',
  horizontal: 'comment.horizontal',
  grouped: 'comment.grouped',
};

/** 採点のコメントの言葉（例: 「下げすぎ」、英語は `Pulling down too much`）。 */
export function commentText(comment: ScoreComment): string {
  return t(COMMENT_KEYS[comment]);
}

export function formatDegrees(value: number | null): string {
  return value === null ? t('none') : `${value.toFixed(2)}°`;
}

export function formatPercent(value: number | null): string {
  return value === null ? t('none') : `${value.toFixed(1)}%`;
}

export function formatRatio(value: number | null): string {
  return value === null ? t('none') : value.toFixed(2);
}

/** 指標の行（docs/spec/scoring.md「指標」の順）。「なし」の指標は「なし」と表示する。 */
export function metricRows(result: ScoreResult): MetricRow[] {
  const [first, middle, last] = result.segments;
  return [
    { label: t('metric.meanError'), value: formatDegrees(result.meanDeviation) },
    { label: t('metric.groupingRadius'), value: formatDegrees(result.groupingRadius) },
    { label: t('metric.hitRate'), value: formatPercent(result.hitRate) },
    {
      label: t('metric.segments'),
      value: t('metric.segmentsValue', { first: formatDegrees(first), middle: formatDegrees(middle), last: formatDegrees(last) }),
    },
    {
      label: t('metric.spread'),
      value: t('metric.spreadValue', {
        horizontal: formatDegrees(result.horizontalSpread),
        vertical: formatDegrees(result.verticalSpread),
        ratio: formatRatio(result.spreadRatio),
      }),
    },
  ];
}

/**
 * 自己ベストの表示。更新したら「自己ベスト更新」、しなかったら保存してある自己ベストの比べる指標の値（既定は平均ズレ）。
 * outcome は弾痕のズレの採点の結果（best を持つ）か、比べる指標の値（value を持つ）。
 */
export function personalBestText(outcome: PersonalBestOutcome | BestOutcome, metric: CompareMetric = SHOT_DEVIATION_METRIC): string {
  if (outcome.updated) return t('best.updated');
  const value = 'value' in outcome ? outcome.value : (outcome.best?.meanError ?? null);
  return t('best.saved', { metric: metric.label, value: formatMetric(metric, value) });
}

/**
 * 右スティックの入力推移のグラフを作る。入力の記録を再生して固定ステップごとの自分の回転速度と理想の補正速度を求め、
 * どちらもカーブの逆でスティックの位置に直す。ADS の状態はステップごとに記録の ads から決める。
 */
export function padTraceView(
  practice: Pick<FinishedPractice, 'recording' | 'dt' | 'padSettings'> & { readonly result: Pick<PracticeResult, 'weapon' | 'padName'> },
): PadTraceView {
  const settings = practice.padSettings ?? DEFAULT_PAD_SETTINGS;
  // 理想の補正速度は武器のパターンから求めるので、武器を使わない練習では入力推移を求めない（呼び出し側がグラフを出さない）。
  const { weapon } = practice.result;
  const points = weapon ? lookRateTrace(practice.recording, weapon, practice.dt) : [];
  const trace = points.map((point) => ({
    time: point.time,
    stick: stickPosition(point.rate, settings, point.ads),
    ideal: stickPosition(point.ideal, settings, point.ads),
  }));
  const plot = (name: string, title: string, axis: 'x' | 'y'): TracePlot => ({
    name,
    title,
    series: [
      { name: 'ideal', label: t('result.ideal'), points: trace.map((p) => ({ time: p.time, value: p.ideal[axis] })) },
      { name: 'stick', label: t('result.own'), points: trace.map((p) => ({ time: p.time, value: p.stick[axis] })) },
    ],
  });
  const name = padDisplayName(practice.result.padName);
  return {
    title: t('result.padTrace', { name }),
    plots: [plot('stick-x', t('result.padTraceX'), 'x'), plot('stick-y', t('result.padTraceY'), 'y')],
  };
}

/** 練習の結果の、保存の組（入力方式・武器・モード・練習の選択肢の値）。 */
export function resultSelection(result: Pick<PracticeResult, 'weapon' | 'mode' | 'options'>, input: InputMethod): HistorySelection {
  const options = result.options.map((o) => o.id);
  return { input, weaponId: resultWeaponId(result), modeId: result.mode.id, ...(options.length > 0 ? { options } : {}) };
}

/** 保存のキーの武器の id。武器を使わないモードの練習では NO_WEAPON_ID（`-`）。 */
export function resultWeaponId(result: Pick<PracticeResult, 'weapon'>): string {
  return result.weapon?.id ?? NO_WEAPON_ID;
}

/**
 * 練習の結果をモードの採点の仕方で採点し、比べる指標で自己ベストと比べて保存し、履歴に足し、リザルト画面に出すものを作る
 * （docs/spec/scoring.md「モードごとの採点」）。採点の仕方を持たないモードは弾痕のズレの採点。
 * 保存は SafeStorage を通すので、保存できない環境でも投げない。
 */
export function completePractice(
  practice: FinishedPractice,
  storage: Pick<SafeStorage, 'get' | 'set'>,
  now: Date,
): ResultView {
  const { result } = practice;
  const scoring = result.mode.scoring;
  if (!scoring) return completeShotDeviation(practice, storage, now);
  const metric = compareMetric(result.mode);
  const scored = scoring.score({ shots: result.shots, duration: result.duration, modeResult: result.modeResult });
  const selection = resultSelection(result, practice.input);
  const candidate = { value: scored.value, fields: scored.fields ?? {} };
  const outcome = recordBest(storage, personalBestKey(selection.input, selection.weaponId, selection.modeId, selection.options), metric, candidate, now);
  recordHistoryEntry(storage, selection, metric, candidate, now);
  // 練習の選択肢を持つモードは、選んだ値（速さ、出る範囲と的の大きさ）も指標の行に並べる（docs/spec/scoring.md「追いエイムの採点」「フリックの採点」）。
  const option = result.options.map((o) => ({ label: localize(o.label), value: localize(o.name) }));
  return {
    summary: resultSummaryText(result),
    metrics: [...scored.metrics, ...option],
    comments: scored.comments ?? [],
    best: personalBestText(outcome, metric),
    metric,
    value: scored.value,
    shareScore: scored.share ?? metricShareScore(metric, scored.value),
    bestUpdated: outcome.updated,
    // 散布図・照準の軌道・入力推移のグラフ・苦手な区間は弾痕のズレの採点のモードだけのもの（SCO-41）。
    plots: [],
    padTrace: null,
    weakSection: null,
  };
}

/** 弾痕のズレの採点（反復練習）。指標と弾痕の散布図・照準の軌道、パッドのときは入力推移のグラフ、苦手な区間を出す。 */
function completeShotDeviation(practice: FinishedPractice, storage: Pick<SafeStorage, 'get' | 'set'>, now: Date): ResultView {
  const { result, world } = practice;
  const summary = resultSummaryText(result);
  const deviations = shotDeviations(result.shots, world.center);
  const shotSeries = { name: 'shots', label: t('result.shots'), kind: 'points', points: deviations } as const;

  const radius = targetRadius(world);
  const scored = scoreShots(result.shots, world, radius);
  const selection = resultSelection(result, practice.input);
  const key = personalBestKey(selection.input, selection.weaponId, selection.modeId, selection.options);
  const outcome = recordBest(storage, key, SHOT_DEVIATION_METRIC, shotDeviationBestCandidate(scored), now);
  // 履歴は自己ベストとは別のキーに足す（docs/spec/scoring.md「練習の履歴」）。
  const history = recordHistoryEntry(storage, selection, SHOT_DEVIATION_METRIC, shotDeviationHistoryCandidate(scored), now) as HistoryEntry[];
  // 苦手な区間は今の練習を足したあとの履歴から求める（docs/spec/scoring.md「リザルト画面」）。苦手な区間を使うモードだけ。
  const weak = modeUsesWeakSections(result.mode) ? weakSection(history) : null;
  const aim = aimAtShots(practice.recording, result.shots, world.center, practice.dt);
  const { weapon } = result;
  const ideal = weapon ? idealCorrection(weapon).slice(0, result.shots.length) : [];
  return {
    summary,
    metrics: metricRows(scored),
    comments: scored.comments.map(commentText),
    best: personalBestText(outcome),
    metric: SHOT_DEVIATION_METRIC,
    value: scored.meanDeviation,
    shareScore: shotDeviationShareScore(scored.meanDeviation, scored.hitRate),
    bestUpdated: outcome.updated,
    padTrace: result.inputMethod === 'pad' && weapon ? padTraceView(practice) : null,
    weakSection: weak ? t('result.weakSection', { text: weakSectionText(weak) }) : null,
    plots: [
      { name: 'scatter', title: t('result.scatter'), series: [shotSeries], circle: radius },
      {
        name: 'trajectory',
        title: t('result.trajectory'),
        series: [
          { name: 'ideal', label: t('result.idealPath'), kind: 'line', points: ideal },
          { name: 'aim', label: t('result.ownAim'), kind: 'line', points: aim },
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
