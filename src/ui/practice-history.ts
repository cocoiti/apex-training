import type { CompareMetric } from '../modes/types';
import { SHOT_SECTION_SIZE, type ScoreResult, type ShotSection } from '../sim/scoring';
import { isMetricValue, SHOT_DEVIATION_METRIC } from './mode-scoring';
import { modeKeyPart, type BestCandidate, type InputMethod } from './personal-best';
import type { SafeStorage } from './storage';

/** 保存の形の版（docs/spec/scoring.md「履歴の保存の形」）。 */
export const HISTORY_VERSION = 1;

/** 武器・モード・入力方式の組ごとに残す件数の上限（docs/spec/scoring.md「練習の履歴」）。 */
export const HISTORY_LIMIT = 200;

/** 直近の平均に使う件数。 */
export const RECENT_COUNT = 10;

/**
 * 履歴の 1 件（docs/spec/scoring.md「履歴の保存の形」）。終えた日時 at と、比べる指標の値を比べる指標の id を項目名にして持ち、
 * ほかにモードが決めた指標を持てる。読み出した件では、比べる指標の項目だけを確かめている。
 */
export type StoredEntry = { readonly at: string } & Readonly<Record<string, unknown>>;

/** 弾痕のズレの採点（反復練習）の履歴の 1 件。 */
export type HistoryEntry = {
  /** 終えた日時（ISO 8601、UTC）。 */
  readonly at: string;
  /** 平均ズレ（度）。 */
  readonly meanError: number;
  /** 命中率（%）。 */
  readonly hitRate: number;
  /** グルーピング半径（度）。 */
  readonly groupingRadius: number;
  /** 撃った弾数。 */
  readonly shots: number;
  /**
   * 発の区間ごとのズレ。古い形式の件は持たない。読み出した件では形を確かめていないので、使うときは entrySections を通す。
   * 形に合わない値も書き直すときはそのまま残す（docs/spec/scoring.md「履歴の保存の形」）。
   */
  readonly sections?: unknown;
};

/** 保存する履歴。localStorage には JSON の文字列で置く。 */
export interface StoredHistory {
  readonly version: typeof HISTORY_VERSION;
  /** 古い順。 */
  readonly entries: readonly StoredEntry[];
}

/** 履歴の組（キーの部分）。 */
export interface HistorySelection {
  readonly input: InputMethod;
  readonly weaponId: string;
  readonly modeId: string;
  /** 練習の選択肢を持つモードで選んだ値の id（例: `normal`）。モードの選択肢の並び順。持たないモードでは省く。 */
  readonly options?: readonly string[];
}

/**
 * 履歴のキー。`apex-training:history:<入力方式>:<武器の id>:<モードの id>`。武器を使わないモードの武器の id は NO_WEAPON_ID（`-`）。
 * 練習の選択肢を持つモードでは末尾に選択肢ごとに `:<値の id>` を足す（docs/spec/scoring.md「履歴の保存の形」）。
 */
export function historyKey(selection: HistorySelection): string {
  return `apex-training:history:${selection.input}:${selection.weaponId}:${modeKeyPart(selection.modeId, selection.options)}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isEntry(value: unknown, metric: CompareMetric): value is StoredEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== 'string' || Number.isNaN(Date.parse(record.at))) return false;
  return isMetricValue(metric, record[metric.id]);
}

function isSection(value: unknown): value is ShotSection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    Number.isInteger(r.start) &&
    (r.start as number) >= 1 &&
    (r.start as number) % SHOT_SECTION_SIZE === 1 &&
    Number.isInteger(r.shots) &&
    (r.shots as number) >= 1 &&
    (r.shots as number) <= SHOT_SECTION_SIZE &&
    isFiniteNumber(r.meanH) &&
    isFiniteNumber(r.meanV) &&
    isFiniteNumber(r.meanError) &&
    r.meanError >= 0
  );
}

/**
 * 件の発の区間ごとのズレ。sections がない、配列でない、要素のどれかが形に合わない、start が重なるときは null（持たない件）。
 * 発の番号の順に並べて返す。
 */
export function entrySections(entry: Pick<HistoryEntry, 'sections'>): ShotSection[] | null {
  const sections = entry.sections;
  if (!Array.isArray(sections) || !sections.every(isSection)) return null;
  const starts = new Set(sections.map((s) => s.start));
  if (starts.size !== sections.length) return null;
  return [...sections].sort((a, b) => a.start - b.start);
}

/**
 * 読み出した値を履歴にする（古い順）。JSON として読めない、version が 1 でない、entries が配列でないときは空。
 * at が日時として読めない、または比べる指標の項目がその指標のとりうる値でない要素は読み飛ばし、ほかの要素はそのまま使う。
 */
export function parseHistoryEntries(raw: string | null, metric: CompareMetric): StoredEntry[] {
  if (raw === null) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return [];
  const record = json as Record<string, unknown>;
  if (record.version !== HISTORY_VERSION || !Array.isArray(record.entries)) return [];
  return record.entries.filter((entry): entry is StoredEntry => isEntry(entry, metric));
}

/** 弾痕のズレの採点の履歴を読む（meanError が 0 以上の有限の数でない要素は読み飛ばす）。 */
export function parseHistory(raw: string | null): HistoryEntry[] {
  return parseHistoryEntries(raw, SHOT_DEVIATION_METRIC) as HistoryEntry[];
}

/** 組の履歴を、その比べる指標で読む。 */
export function loadModeHistory(storage: Pick<SafeStorage, 'get'>, selection: HistorySelection, metric: CompareMetric): StoredEntry[] {
  return parseHistoryEntries(storage.get(historyKey(selection)), metric);
}

/** 弾痕のズレの採点の組の履歴を読む。 */
export function loadHistory(storage: Pick<SafeStorage, 'get'>, selection: HistorySelection): HistoryEntry[] {
  return parseHistory(storage.get(historyKey(selection)));
}

/** 保存の形で決まっている項目名。モードが決めた指標はこの名前を上書きしない。 */
const RESERVED = new Set(['at']);

/**
 * 練習の結果を組の履歴の最後に足して保存する（docs/spec/scoring.md「練習の履歴」）。比べる指標の値が求まらないときは足さない。
 * 1 件は at・比べる指標・モードが決めた指標の順の項目を持つ。上限を超えたら最も古い件から消す。読み飛ばした要素は書き直すときに除く。
 * 保存に失敗しても投げない（SafeStorage）。足したあとの履歴を返す。
 */
export function recordHistoryEntry(
  storage: Pick<SafeStorage, 'get' | 'set'>,
  selection: HistorySelection,
  metric: CompareMetric,
  candidate: BestCandidate,
  now: Date,
): StoredEntry[] {
  const entries = loadModeHistory(storage, selection, metric);
  const { value } = candidate;
  if (value === null || !isMetricValue(metric, value)) return entries;
  const fields = Object.fromEntries(Object.entries(candidate.fields ?? {}).filter(([name]) => !RESERVED.has(name) && name !== metric.id));
  entries.push({ at: now.toISOString(), [metric.id]: value, ...fields });
  const kept = entries.slice(-HISTORY_LIMIT);
  const stored: StoredHistory = { version: HISTORY_VERSION, entries: kept };
  storage.set(historyKey(selection), JSON.stringify(stored));
  return kept;
}

/** 弾痕のズレの採点の結果から、履歴の 1 件に入れるものを作る。 */
export function shotDeviationHistoryCandidate(result: ScoreResult): BestCandidate {
  return {
    value: result.meanDeviation,
    fields: { hitRate: result.hitRate ?? 0, groupingRadius: result.groupingRadius ?? 0, shots: result.shots, sections: result.sections },
  };
}

/** 弾痕のズレの採点の結果を組の履歴の最後に足して保存する。平均ズレが「なし」なら足さない。足したあとの履歴を返す。 */
export function recordHistory(
  storage: Pick<SafeStorage, 'get' | 'set'>,
  selection: HistorySelection,
  result: ScoreResult,
  now: Date,
): HistoryEntry[] {
  return recordHistoryEntry(storage, selection, SHOT_DEVIATION_METRIC, shotDeviationHistoryCandidate(result), now) as HistoryEntry[];
}

/** 読み出した件の比べる指標の値（古い順）。件は parseHistoryEntries で比べる指標の項目を確かめたもの。 */
export function historyValues(entries: readonly StoredEntry[], metric: Pick<CompareMetric, 'id'> = SHOT_DEVIATION_METRIC): number[] {
  return entries.map((e) => e[metric.id] as number);
}

/** 組の履歴だけを消す。ほかの組の履歴と自己ベストは消さない。 */
export function clearHistory(storage: Pick<SafeStorage, 'remove'>, selection: HistorySelection): void {
  storage.remove(historyKey(selection));
}

/** 履歴の 3 つの平均（比べる指標の値の平均）。当たる件がないものは null（「なし」）。 */
export interface HistoryAverages {
  readonly today: number | null;
  readonly recent: number | null;
  readonly overall: number | null;
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** ブラウザの時間帯で同じ日付か。 */
function sameLocalDate(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 今日の平均・直近 10 回の平均・全体の平均（docs/spec/scoring.md「履歴の平均」）。entries は古い順。 */
export function historyAverages(
  entries: readonly StoredEntry[],
  now: Date,
  metric: Pick<CompareMetric, 'id'> = SHOT_DEVIATION_METRIC,
): HistoryAverages {
  const values = historyValues(entries, metric);
  return {
    today: average(values.filter((_, i) => sameLocalDate(new Date(entries[i]?.at ?? ''), now))),
    recent: average(values.slice(-RECENT_COUNT)),
    overall: average(values),
  };
}
