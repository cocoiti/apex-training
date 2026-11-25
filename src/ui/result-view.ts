import type { InputRecording } from '../input/recording';
import type { PracticeResult } from '../modes/session';
import { scoreShots, shotDeviations, targetRadius, type ScoreResult } from '../sim/scoring';
import { aimAtShots } from '../sim/trajectory';
import { idealCorrection, uncorrectedPattern } from '../sim/weapon';
import type { World } from '../sim/world';
import { personalBestKey, recordPersonalBest, type InputMethod, type PersonalBestOutcome } from './personal-best';
import { recordHistory } from './practice-history';
import { escapeHtml, plotHtml, type Plot } from './result-plot';
import { resultSummaryText } from './result-summary';
import type { SafeStorage } from './storage';

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
}

/** 指標の 1 行。 */
export interface MetricRow {
  readonly label: string;
  readonly value: string;
}

/** リザルト画面に出すもの。 */
export interface ResultView {
  readonly summary: string;
  /** 採点するモードか。採点しないモードでは metrics・comments・best を出さない。 */
  readonly scored: boolean;
  readonly metrics: readonly MetricRow[];
  readonly comments: readonly string[];
  /** 自己ベストの表示。採点しないモードでは null。 */
  readonly best: string | null;
  readonly plots: readonly Plot[];
}

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
 * 練習の結果を採点し、採点するモードなら自己ベストと比べて保存し、履歴に足し、リザルト画面に出すものを作る。
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

  if (!result.modeResult.scored) {
    const pattern = uncorrectedPattern(result.weapon, result.shots.length);
    return {
      summary,
      scored: false,
      metrics: [],
      comments: [],
      best: null,
      plots: [
        {
          name: 'pattern',
          title: '弾痕と補正しなかった場合のパターン',
          series: [shotSeries, { name: 'pattern', label: '補正しなかった場合', kind: 'line', points: pattern }],
        },
      ],
    };
  }

  const radius = targetRadius(world);
  const scored = scoreShots(result.shots, world, radius);
  const key = personalBestKey(practice.input, result.weapon.id, result.mode.id);
  const outcome = recordPersonalBest(storage, key, scored, now);
  // 履歴は自己ベストとは別のキーに足す（docs/spec/scoring.md「練習の履歴」）。
  recordHistory(storage, { input: practice.input, weaponId: result.weapon.id, modeId: result.mode.id }, scored, now);
  const aim = aimAtShots(practice.recording, result.shots, world.center, practice.dt);
  const ideal = idealCorrection(result.weapon).slice(0, result.shots.length);
  return {
    summary,
    scored: true,
    metrics: metricRows(scored),
    comments: scored.comments,
    best: personalBestText(outcome),
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
  /** 指標・コメント・自己ベストをまとめた要素。採点しないモードでは隠す。 */
  readonly score: Pick<HTMLElement, 'hidden'>;
  readonly metrics: Pick<HTMLElement, 'innerHTML'>;
  readonly comments: Pick<HTMLElement, 'textContent'>;
  readonly best: Pick<HTMLElement, 'textContent'>;
  readonly plots: Pick<HTMLElement, 'innerHTML'>;
}

/** リザルト画面の要素を書き換える。 */
export function renderResult(elements: ResultElements, view: ResultView): void {
  elements.summary.textContent = view.summary;
  elements.score.hidden = !view.scored;
  elements.metrics.innerHTML = view.metrics
    .map((row) => `<dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd>`)
    .join('');
  elements.comments.textContent = view.comments.join(' / ');
  elements.best.textContent = view.best ?? '';
  elements.plots.innerHTML = view.plots.map(plotHtml).join('');
}
