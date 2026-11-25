import type { PracticeResult } from '../modes/session';

/**
 * リザルト画面の見出しの 1 行（武器・モード・撃った弾の数）。当たりは命中率（的の半径、src/sim/scoring.ts）で出すので、ここでは数えない。
 * 壁の弾痕も ShotRecord.position を持つので、position の有無で数えると壁に当たった弾まで当たりになる。
 */
export function resultSummaryText(result: Pick<PracticeResult, 'weapon' | 'mode' | 'shots'>): string {
  return `${result.weapon.name} / ${result.mode.name} — ${result.shots.length} 発`;
}
