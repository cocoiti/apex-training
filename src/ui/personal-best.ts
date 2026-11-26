import type { InputMethod } from '../input/input-switch';
import type { CompareMetric } from '../modes/types';
import type { ScoreResult } from '../sim/scoring';
import { isBetter, isMetricValue, SHOT_DEVIATION_METRIC } from './mode-scoring';
import type { SafeStorage } from './storage';

/** 入力方式。自己ベストは入力方式ごとに別のキーで保存する（docs/spec/input.md「入力方式ごとの保存」）。 */
export type { InputMethod };

/** 保存の形の版（docs/spec/scoring.md「保存の形」）。 */
export const PERSONAL_BEST_VERSION = 1;

/** 保存の形で決まっている項目名。モードが決めた指標はこの名前を上書きしない。 */
const RESERVED = new Set(['version', 'achievedAt']);

/** 弾痕のズレの採点（反復練習）で保存する自己ベスト。localStorage には JSON の文字列で置く。 */
export interface PersonalBest {
  readonly version: typeof PERSONAL_BEST_VERSION;
  /** 平均ズレ（度）。比べる指標。 */
  readonly meanError: number;
  /** グルーピング半径（度）。 */
  readonly groupingRadius: number;
  /** 命中率（%）。 */
  readonly hitRate: number;
  /** 撃った弾数。 */
  readonly shots: number;
  /** 記録した日時（ISO 8601、UTC）。 */
  readonly achievedAt: string;
}

/**
 * 自己ベストのキー。`apex-training:best:<入力方式>:<武器の id>:<モードの id>`。
 * 武器を使わないモードでは武器の id に NO_WEAPON_ID（`-`）を渡す。練習の選択肢を持つモードでは、選んだ値の id（例: `normal`）を
 * モードの選択肢の並び順に optionIds に渡し、キーの末尾にそれぞれ `:<値の id>` を足す（docs/spec/scoring.md「保存の形」）。
 */
export function personalBestKey(input: InputMethod, weaponId: string, modeId: string, optionIds?: readonly string[]): string {
  return `apex-training:best:${input}:${weaponId}:${modeKeyPart(modeId, optionIds)}`;
}

/** キーのモードの部分。練習の選択肢を持つモードでは `<モードの id>:<値の id>`（選択肢が 2 つなら `<モードの id>:<値の id>:<値の id>`）。 */
export function modeKeyPart(modeId: string, optionIds: readonly string[] | undefined): string {
  return [modeId, ...(optionIds ?? [])].join(':');
}

/** 読み出した自己ベスト。record は保存してある値そのもの、value はその比べる指標の値。 */
export interface StoredBest {
  readonly record: Readonly<Record<string, unknown>>;
  readonly value: number;
}

/**
 * 読み出した値を自己ベストにする。JSON として読めない、version が 1 でない、比べる指標の項目がその指標のとりうる値でないときは null
 * （自己ベストがないものとして扱う）。ほかの項目は表示に使わないので、欠けていても捨てない。
 */
export function parseStoredBest(raw: string | null, metric: CompareMetric): StoredBest | null {
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;
  if (record.version !== PERSONAL_BEST_VERSION) return null;
  const value = record[metric.id];
  if (!isMetricValue(metric, value)) return null;
  return { record, value };
}

/** 弾痕のズレの採点の自己ベストを読む（meanError が 0 以上の有限の数でなければ null）。 */
export function parsePersonalBest(raw: string | null): PersonalBest | null {
  return (parseStoredBest(raw, SHOT_DEVIATION_METRIC)?.record as PersonalBest | undefined) ?? null;
}

/** 自己ベストと比べる、練習の結果の比べる指標の値と、一緒に保存する指標。 */
export interface BestCandidate {
  /** 比べる指標の値。求まらないときは null（判定しない）。 */
  readonly value: number | null;
  /** 一緒に保存する指標（項目名 → 値）。保存の形で決まっている項目名（version・achievedAt）と比べる指標の id は無視する。 */
  readonly fields?: Readonly<Record<string, unknown>>;
}

/** 練習を終えたときの自己ベスト。 */
export interface BestOutcome {
  /** この結果で自己ベストを更新したか。 */
  readonly updated: boolean;
  /** 今の自己ベストの比べる指標の値（更新したならこの結果の値）。ないときは null。 */
  readonly value: number | null;
  /** 今の自己ベストの保存してある値。ないときは null。 */
  readonly record: Readonly<Record<string, unknown>> | null;
}

/**
 * 練習の結果をその比べる指標で自己ベストと比べ、値が求まり、自己ベストがまだないか値が良いときだけ保存する
 * （docs/spec/scoring.md「自己ベスト」）。等しいときは更新しない。保存に失敗しても投げない（SafeStorage）。
 * 保存の値は version・比べる指標・モードが決めた指標・achievedAt の順の項目を持つ。
 */
export function recordBest(
  storage: Pick<SafeStorage, 'get' | 'set'>,
  key: string,
  metric: CompareMetric,
  candidate: BestCandidate,
  now: Date,
): BestOutcome {
  const stored = parseStoredBest(storage.get(key), metric);
  const { value } = candidate;
  if (value === null || !isMetricValue(metric, value) || (stored !== null && !isBetter(metric, value, stored.value))) {
    return { updated: false, value: stored?.value ?? null, record: stored?.record ?? null };
  }
  const fields = Object.fromEntries(Object.entries(candidate.fields ?? {}).filter(([name]) => !RESERVED.has(name) && name !== metric.id));
  const record = { version: PERSONAL_BEST_VERSION, [metric.id]: value, ...fields, achievedAt: now.toISOString() };
  storage.set(key, JSON.stringify(record));
  return { updated: true, value, record };
}

/** 弾痕のズレの採点の結果から、自己ベストと比べるものを作る。 */
export function shotDeviationBestCandidate(result: ScoreResult): BestCandidate {
  return {
    value: result.meanDeviation,
    fields: { groupingRadius: result.groupingRadius ?? 0, hitRate: result.hitRate ?? 0, shots: result.shots },
  };
}

/** 弾痕のズレの採点で練習を終えたときの自己ベスト。 */
export interface PersonalBestOutcome {
  /** この結果で自己ベストを更新したか。 */
  readonly updated: boolean;
  /** 今の自己ベスト（更新したならこの結果）。ないときは null。 */
  readonly best: PersonalBest | null;
}

/**
 * 弾痕のズレの採点の結果を自己ベストと比べ、平均ズレが「なし」でなく、自己ベストがまだないか平均ズレが小さいときだけ保存する
 * （docs/spec/scoring.md「自己ベスト」）。等しいときは更新しない。保存に失敗しても投げない（SafeStorage）。
 */
export function recordPersonalBest(
  storage: Pick<SafeStorage, 'get' | 'set'>,
  key: string,
  result: ScoreResult,
  now: Date,
): PersonalBestOutcome {
  const outcome = recordBest(storage, key, SHOT_DEVIATION_METRIC, shotDeviationBestCandidate(result), now);
  return { updated: outcome.updated, best: outcome.record as PersonalBest | null };
}
