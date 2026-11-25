import type { ScoreResult } from '../sim/scoring';
import type { SafeStorage } from './storage';

/** 入力方式。自己ベストは入力方式ごとに別のキーで保存する（docs/spec/input.md「入力方式ごとの保存」）。 */
export type InputMethod = 'mouse' | 'pad';

/** 保存の形の版（docs/spec/scoring.md「保存の形」）。 */
export const PERSONAL_BEST_VERSION = 1;

/** 保存する自己ベスト。localStorage には JSON の文字列で置く。 */
export interface PersonalBest {
  readonly version: typeof PERSONAL_BEST_VERSION;
  /** 平均ズレ（度）。 */
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

/** 自己ベストのキー。`apex-training:best:<入力方式>:<武器の id>:<モードの id>`。 */
export function personalBestKey(input: InputMethod, weaponId: string, modeId: string): string {
  return `apex-training:best:${input}:${weaponId}:${modeId}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 読み出した値を自己ベストにする。JSON として読めない、version が 1 でない、meanError が 0 以上の有限の数でないときは null
 * （自己ベストがないものとして扱う）。ほかの項目は表示に使わないので、欠けていても捨てない。
 */
export function parsePersonalBest(raw: string | null): PersonalBest | null {
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
  if (!isFiniteNumber(record.meanError) || record.meanError < 0) return null;
  return record as unknown as PersonalBest;
}

/** 練習を終えたときの自己ベスト。 */
export interface PersonalBestOutcome {
  /** この結果で自己ベストを更新したか。 */
  readonly updated: boolean;
  /** 今の自己ベスト（更新したならこの結果）。ないときは null。 */
  readonly best: PersonalBest | null;
}

/**
 * 採点の結果を自己ベストと比べ、平均ズレが「なし」でなく、自己ベストがまだないか平均ズレが小さいときだけ保存する
 * （docs/spec/scoring.md「自己ベスト」）。等しいときは更新しない。保存に失敗しても投げない（SafeStorage）。
 */
export function recordPersonalBest(
  storage: Pick<SafeStorage, 'get' | 'set'>,
  key: string,
  result: ScoreResult,
  now: Date,
): PersonalBestOutcome {
  const stored = parsePersonalBest(storage.get(key));
  const meanError = result.meanDeviation;
  if (meanError === null || (stored !== null && meanError >= stored.meanError)) return { updated: false, best: stored };
  const best: PersonalBest = {
    version: PERSONAL_BEST_VERSION,
    meanError,
    groupingRadius: result.groupingRadius ?? 0,
    hitRate: result.hitRate ?? 0,
    shots: result.shots,
    achievedAt: now.toISOString(),
  };
  storage.set(key, JSON.stringify(best));
  return { updated: true, best };
}
