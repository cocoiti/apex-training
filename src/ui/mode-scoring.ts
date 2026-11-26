import type { CompareMetric, MetricSpec, TrainingMode } from '../modes/types';

/**
 * モードごとの採点の指標（docs/spec/scoring.md「モードごとの採点」）。採点の仕方（scoring）を持たないモードは弾痕のズレの採点で、
 * 比べる指標は平均ズレ（小さいほど良い）。決定の理由は docs/adr/2026-11-26-mode-scoring-and-weaponless-modes.md。
 */

/** 武器を使わないモードの保存のキーで、武器の id の代わりに書くもの（docs/spec/scoring.md「保存の形」）。 */
export const NO_WEAPON_ID = '-';

/** 弾痕のズレの採点の比べる指標。平均ズレ（度、0 以上）で、小さいほど良い。保存の項目名は meanError。 */
export const SHOT_DEVIATION_METRIC: CompareMetric = {
  id: 'meanError',
  label: '平均ズレ',
  unit: '°',
  better: 'lower',
  format: (value) => `${value.toFixed(2)}°`,
  valid: (value) => value >= 0,
};

/** 弾痕のズレの採点の命中率（%、小数第 1 位まで）。 */
export const HIT_RATE_METRIC: MetricSpec = { id: 'hitRate', label: '命中率', unit: '%', format: (value) => `${value.toFixed(1)}%` };

/** 弾痕のズレの採点の履歴の一覧で、平均ズレのあとに並べる指標（docs/spec/screens.md「履歴の画面」）。 */
export const SHOT_DEVIATION_COLUMNS: readonly MetricSpec[] = [
  HIT_RATE_METRIC,
  { id: 'groupingRadius', label: 'グルーピング半径', unit: '°', format: (value) => `${value.toFixed(2)}°` },
];

/** モードの比べる指標。採点の仕方を持たないモードは平均ズレ。 */
export function compareMetric(mode: Pick<TrainingMode, 'scoring'>): CompareMetric {
  return mode.scoring?.compare ?? SHOT_DEVIATION_METRIC;
}

/** モードの履歴の一覧で、比べる指標のあとに並べる指標。 */
export function historyColumns(mode: Pick<TrainingMode, 'scoring'>): readonly MetricSpec[] {
  return mode.scoring ? (mode.scoring.columns ?? []) : SHOT_DEVIATION_COLUMNS;
}

/** 保存してある値が、その比べる指標のとりうる値か。有限の数で、指標が決めた範囲（valid）に入るもの。 */
export function isMetricValue(metric: Pick<CompareMetric, 'valid'>, value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && (metric.valid?.(value) ?? true);
}

/** value が than より良いか。等しいときは良くない。 */
export function isBetter(metric: Pick<CompareMetric, 'better'>, value: number, than: number): boolean {
  return metric.better === 'lower' ? value < than : value > than;
}

/** 指標の値の表示。求まらない（null）ときは「なし」。 */
export function formatMetric(metric: Pick<MetricSpec, 'format'>, value: number | null): string {
  return value === null ? 'なし' : metric.format(value);
}
