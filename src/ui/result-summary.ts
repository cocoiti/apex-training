import type { PracticeResult, PracticeResultOption } from '../modes/session';
import { localize, t } from './i18n';

/**
 * 練習の選択肢の値の書き方（例: 「速さ: ふつう」、2 つなら「出る範囲: 遠い / 的の大きさ: 小」。docs/spec/screens.md「シェアの文」）。
 * 持たないモードでは undefined。
 */
export function optionText(options: readonly Pick<PracticeResultOption, 'label' | 'name'>[] | undefined): string | undefined {
  return options && options.length > 0 ? options.map((o) => `${localize(o.label)}: ${localize(o.name)}`).join(' / ') : undefined;
}

/**
 * リザルト画面の見出しの 1 行（武器・モード・練習の選択肢の値・撃った弾の数）。武器を使わないモードではモードと撃った弾の数。当たりは命中率（的の半径、src/sim/scoring.ts）で出すので、ここでは数えない。
 * 壁の弾痕も ShotRecord.position を持つので、position の有無で数えると壁に当たった弾まで当たりになる。
 */
export function resultSummaryText(result: Pick<PracticeResult, 'weapon' | 'mode' | 'shots'> & Partial<Pick<PracticeResult, 'options'>>): string {
  const option = optionText(result.options);
  const names = [...(result.weapon ? [result.weapon.name] : []), localize(result.mode.name), ...(option === undefined ? [] : [option])].join(' / ');
  return t('result.summary', { names, shots: result.shots.length });
}
