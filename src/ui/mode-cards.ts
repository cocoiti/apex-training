import { modeOptionChoices, modeUsesWeapon, type TrainingMode } from '../modes/types';
import { cardName } from './card-choices';
import { createModeIcon } from './mode-icons';
import { compareMetric, NO_WEAPON_ID } from './mode-scoring';
import { parseStoredBest, personalBestKey, type InputMethod } from './personal-best';
import type { SafeStorage } from './storage';

/**
 * トップ画面のモードのカードの中身（docs/spec/screens.md「モードの選択」）。アイコン・名前・ひとこと説明・自己ベストの要約を出す。
 */

/** 自己ベストの要約を読む組。武器と練習の選択肢の値は、トップ画面で選んでいるもの。 */
export interface BestSummarySelection {
  readonly input: InputMethod;
  /** 選んでいる武器の id。武器を使わないモードでは使わない。 */
  readonly weaponId: string;
  /** 選んでいる練習の選択肢の値（選択肢の id → 値の id）。 */
  readonly options: Readonly<Record<string, string | undefined>>;
}

/** 自己ベストがないときの要約。 */
export const NO_BEST_SUMMARY = '自己ベスト: まだ記録なし';

/**
 * モードのカードの自己ベストの要約。そのモードの、選んでいる武器（武器を使うモード）・練習の選択肢の値（持つモード）・入力方式の組の自己ベストの
 * 比べる指標を、リザルト画面と同じ書き方で「自己ベスト: <値>」にする。その組の自己ベストがない（読めない）ときは「自己ベスト: まだ記録なし」。
 */
export function modeBestSummary(
  storage: Pick<SafeStorage, 'get'>,
  mode: Pick<TrainingMode, 'id' | 'scoring' | 'usesWeapon' | 'options'>,
  selection: BestSummarySelection,
): string {
  const metric = compareMetric(mode);
  const optionIds = modeOptionChoices(mode, selection.options).map((s) => s.choice.id);
  const weaponId = modeUsesWeapon(mode) ? selection.weaponId : NO_WEAPON_ID;
  const best = parseStoredBest(storage.get(personalBestKey(selection.input, weaponId, mode.id, optionIds)), metric);
  return best ? `自己ベスト: ${metric.format(best.value)}` : NO_BEST_SUMMARY;
}

/** モードのカードの中身。自己ベストの要約の欄（`.card-best`）は空で作り、setModeBest で書く。 */
export function modeCardContent(doc: Document, mode: Pick<TrainingMode, 'name' | 'description' | 'icon'>): Node[] {
  const description = doc.createElement('span');
  description.className = 'card-description';
  description.textContent = mode.description;
  const best = doc.createElement('span');
  best.className = 'card-best';
  const title = doc.createElement('span');
  title.className = 'card-title';
  title.append(createModeIcon(doc, mode.icon), cardName(doc, mode.name));
  return [title, description, best];
}

/** カードの自己ベストの要約を書く。同じ文なら書き直さない。 */
export function setModeBest(card: ParentNode, text: string): void {
  const best = card.querySelector('.card-best');
  if (best && best.textContent !== text) best.textContent = text;
}
