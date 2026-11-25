import { SHOT_SECTION_SIZE, type ScoreResult, type ShotSection } from '../sim/scoring';
import type { InputMethod } from './personal-best';
import type { SafeStorage } from './storage';

/** 保存の形の版（docs/spec/scoring.md「履歴の保存の形」）。 */
export const HISTORY_VERSION = 1;

/** 武器・モード・入力方式の組ごとに残す件数の上限（docs/spec/scoring.md「練習の履歴」）。 */
export const HISTORY_LIMIT = 200;

/** 直近の平均に使う件数。 */
export const RECENT_COUNT = 10;

/** 履歴の 1 件。 */
export interface HistoryEntry {
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
}

/** 保存する履歴。localStorage には JSON の文字列で置く。 */
export interface StoredHistory {
  readonly version: typeof HISTORY_VERSION;
  /** 古い順。 */
  readonly entries: readonly HistoryEntry[];
}

/** 履歴の組（キーの部分）。 */
export interface HistorySelection {
  readonly input: InputMethod;
  readonly weaponId: string;
  readonly modeId: string;
}

/** 履歴のキー。`apex-training:history:<入力方式>:<武器の id>:<モードの id>`。 */
export function historyKey(selection: HistorySelection): string {
  return `apex-training:history:${selection.input}:${selection.weaponId}:${selection.modeId}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== 'string' || Number.isNaN(Date.parse(record.at))) return false;
  return isFiniteNumber(record.meanError) && record.meanError >= 0;
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
 * at が日時として読めない、または meanError が 0 以上の有限の数でない要素は読み飛ばし、ほかの要素はそのまま使う。
 */
export function parseHistory(raw: string | null): HistoryEntry[] {
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
  return record.entries.filter(isEntry);
}

/** 組の履歴を読む。 */
export function loadHistory(storage: Pick<SafeStorage, 'get'>, selection: HistorySelection): HistoryEntry[] {
  return parseHistory(storage.get(historyKey(selection)));
}

/**
 * 採点の結果を組の履歴の最後に足して保存する。平均ズレが「なし」なら足さない。
 * 上限を超えたら最も古い件から消す。読み飛ばした要素は書き直すときに除く。保存に失敗しても投げない（SafeStorage）。
 * 足したあとの履歴を返す。
 */
export function recordHistory(
  storage: Pick<SafeStorage, 'get' | 'set'>,
  selection: HistorySelection,
  result: ScoreResult,
  now: Date,
): HistoryEntry[] {
  const entries = loadHistory(storage, selection);
  const meanError = result.meanDeviation;
  if (meanError === null) return entries;
  entries.push({
    at: now.toISOString(),
    meanError,
    hitRate: result.hitRate ?? 0,
    groupingRadius: result.groupingRadius ?? 0,
    shots: result.shots,
    sections: result.sections,
  });
  const kept = entries.slice(-HISTORY_LIMIT);
  const stored: StoredHistory = { version: HISTORY_VERSION, entries: kept };
  storage.set(historyKey(selection), JSON.stringify(stored));
  return kept;
}

/** 組の履歴だけを消す。ほかの組の履歴と自己ベストは消さない。 */
export function clearHistory(storage: Pick<SafeStorage, 'remove'>, selection: HistorySelection): void {
  storage.remove(historyKey(selection));
}

/** 履歴の 3 つの平均（度）。当たる件がないものは null（「なし」）。 */
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
export function historyAverages(entries: readonly HistoryEntry[], now: Date): HistoryAverages {
  const errors = entries.map((e) => e.meanError);
  return {
    today: average(entries.filter((e) => sameLocalDate(new Date(e.at), now)).map((e) => e.meanError)),
    recent: average(errors.slice(-RECENT_COUNT)),
    overall: average(errors),
  };
}
