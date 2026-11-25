import type { PracticeResult } from '../modes/session';

/**
 * リザルト画面に仮に出す 1 行の要約（武器・モード・撃った弾の数）。
 * 何を当たりと数えるか（的に当たった弾だけか）はリザルト画面の Issue で決めるので、ここでは当たりの数を出さない。
 * 壁の弾痕も ShotRecord.position を持つので、position の有無で数えると壁に当たった弾まで当たりになる。
 */
export function resultSummaryText(result: Pick<PracticeResult, 'weapon' | 'mode' | 'shots'>): string {
  return `${result.weapon.name} / ${result.mode.name} — ${result.shots.length} 発`;
}
