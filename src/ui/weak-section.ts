import { BIAS_THRESHOLD, SHOT_SECTION_SIZE } from '../sim/scoring';
import { entrySections, type HistoryEntry } from './practice-history';

/**
 * 苦手な区間（docs/spec/scoring.md「苦手な区間」）。組の履歴のうち発の区間ごとのズレを持つ件の直近 5 件から、
 * ズレの大きさの平均がいちばん大きい発の区間とその向きを求める。表示だけに使い、書き出しや外部への送信はしない。
 */

/** 苦手な区間を求めるのに使う件数（発の区間ごとのズレを持つ件の新しい順）。 */
export const WEAK_SECTION_RUNS = 5;

/** 比べる対象にするのに要る、その発の区間を持つ件の数。 */
export const WEAK_SECTION_MIN_RUNS = 3;

/** しきい値ちょうどを条件に当たるものとするための、小数の計算の誤差の幅。 */
const EPSILON = 1e-9;

/** 対象の件を弾数で重み付けして合わせた、1 つの発の区間のズレ。 */
export interface SectionAverage {
  /** 最初の発の番号（1, 6, 11, …）。 */
  readonly start: number;
  /** 最後の発の番号（start + 4）。 */
  readonly end: number;
  readonly meanH: number;
  readonly meanV: number;
  readonly meanError: number;
}

/** 苦手な区間。 */
export interface WeakSection extends SectionAverage {
  /** 縦・横の順の向き。どちらにも当たらないときは「向きが定まらない」だけ。 */
  readonly directions: readonly string[];
}

/** 組の履歴から求めた発の区間ごとのズレと苦手な区間。 */
export interface WeakSectionSummary {
  /** 発の区間ごとのズレを持つ件の数。 */
  readonly runs: number;
  /** 比べる対象の発の区間（発の番号の順）。対象が 5 件に満たないときは null。 */
  readonly sections: readonly SectionAverage[] | null;
  /** 苦手な区間。「なし」のときは null。 */
  readonly weak: WeakSection | null;
}

/** 苦手な区間の向き（docs/spec/scoring.md の表）。縦・横の順。 */
export function weakDirections(meanH: number, meanV: number): string[] {
  const directions: string[] = [];
  if (meanV >= BIAS_THRESHOLD - EPSILON) directions.push('上に外しがち（下げ不足）');
  else if (meanV <= -BIAS_THRESHOLD + EPSILON) directions.push('下に外しがち（下げすぎ）');
  if (meanH >= BIAS_THRESHOLD - EPSILON) directions.push('右に外しがち');
  else if (meanH <= -BIAS_THRESHOLD + EPSILON) directions.push('左に外しがち');
  if (directions.length === 0) directions.push('向きが定まらない');
  return directions;
}

/** 組の履歴（古い順）から、発の区間ごとのズレと苦手な区間を求める。発の区間ごとのズレを持たない件は数えない。 */
export function summarizeWeakSection(entries: readonly Pick<HistoryEntry, 'sections'>[]): WeakSectionSummary {
  const runs = entries.map(entrySections).filter((s) => s !== null);
  if (runs.length < WEAK_SECTION_RUNS) return { runs: runs.length, sections: null, weak: null };

  const totals = new Map<number, { runs: number; shots: number; h: number; v: number; e: number }>();
  for (const sections of runs.slice(-WEAK_SECTION_RUNS)) {
    for (const s of sections) {
      const t = totals.get(s.start) ?? { runs: 0, shots: 0, h: 0, v: 0, e: 0 };
      t.runs += 1;
      t.shots += s.shots;
      t.h += s.meanH * s.shots;
      t.v += s.meanV * s.shots;
      t.e += s.meanError * s.shots;
      totals.set(s.start, t);
    }
  }
  const sections: SectionAverage[] = [...totals.entries()]
    .filter(([, t]) => t.runs >= WEAK_SECTION_MIN_RUNS)
    .sort(([a], [b]) => a - b)
    .map(([start, t]) => ({
      start,
      end: start + SHOT_SECTION_SIZE - 1,
      meanH: t.h / t.shots,
      meanV: t.v / t.shots,
      meanError: t.e / t.shots,
    }));

  // 同じ大きさなら発の番号の小さい方（先に並ぶ方）を残す。
  let worst: SectionAverage | undefined;
  for (const s of sections) if (!worst || s.meanError > worst.meanError) worst = s;
  const weak =
    worst && worst.meanError >= BIAS_THRESHOLD - EPSILON
      ? { ...worst, directions: weakDirections(worst.meanH, worst.meanV) }
      : null;
  return { runs: runs.length, sections, weak };
}

/** 組の履歴の苦手な区間。「なし」のときは null。 */
export function weakSection(entries: readonly Pick<HistoryEntry, 'sections'>[]): WeakSection | null {
  return summarizeWeakSection(entries).weak;
}

/** 発の番号の範囲（例: 「11〜15」）。 */
export function sectionRangeText(section: Pick<SectionAverage, 'start' | 'end'>): string {
  return `${section.start}〜${section.end}`;
}

/** 「11〜15 発目、右に外しがち」の形。 */
export function weakSectionText(weak: WeakSection): string {
  return `${sectionRangeText(weak)} 発目、${weak.directions.join('・')}`;
}
