import type { PracticeResult, PracticeResultOption } from '../modes/session';

/** 練習の選択肢の値の書き方（例: 「速さ: ふつう」。docs/spec/screens.md「シェアの文」）。持たないモードでは undefined。 */
export function optionText(option: Pick<PracticeResultOption, 'label' | 'name'> | undefined): string | undefined {
  return option ? `${option.label}: ${option.name}` : undefined;
}

/**
 * リザルト画面の見出しの 1 行（武器・モード・練習の選択肢の値・撃った弾の数）。武器を使わないモードではモードと撃った弾の数。当たりは命中率（的の半径、src/sim/scoring.ts）で出すので、ここでは数えない。
 * 壁の弾痕も ShotRecord.position を持つので、position の有無で数えると壁に当たった弾まで当たりになる。
 */
export function resultSummaryText(result: Pick<PracticeResult, 'weapon' | 'mode' | 'shots'> & Partial<Pick<PracticeResult, 'option'>>): string {
  const names = [
    ...(result.weapon ? [result.weapon.name] : []),
    result.mode.name,
    ...(result.option ? [optionText(result.option)] : []),
  ].join(' / ');
  return `${names} — ${result.shots.length} 発`;
}
