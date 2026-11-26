import type { ModeOption, TrainingMode } from '../modes/types';

/**
 * 練習の選択肢（追いエイムの速さなど、docs/spec/screens.md「トップ画面」「履歴の画面」）の欄。
 * 決定の理由は docs/adr/2026-11-26-mode-practice-option.md。
 */

/** 登録されたモードのうち、最初に練習の選択肢を持つモードの選択肢。どれも持たなければ undefined。 */
export function firstModeOption(modes: readonly Pick<TrainingMode, 'option'>[]): ModeOption | undefined {
  return modes.find((m) => m.option)?.option;
}

/** select の今の選択肢の値の id（option は select の直下に置く）。 */
function optionIds(select: HTMLSelectElement): string[] {
  return Array.from(select.children, (o) => (o as HTMLOptionElement).value);
}

/**
 * 練習の選択肢の値を select に入れる。並びは選択肢の並び順。入れたあとは、前に選んでいた値が選択肢にあればそのまま、なければ既定の値を選ぶ。
 * 同じ値の並びが入っているときは入れ直さない（選んでいる値を残す）。
 */
export function fillOptionSelect(select: HTMLSelectElement, option: ModeOption): void {
  const ids = option.choices.map((c) => c.id);
  const current = optionIds(select);
  if (current.length === ids.length && current.every((id, i) => id === ids[i])) return;
  const previous = select.value;
  const doc = select.ownerDocument;
  select.replaceChildren(
    ...option.choices.map((choice) => {
      const element = doc.createElement('option');
      element.value = choice.id;
      element.textContent = choice.name;
      return element;
    }),
  );
  select.value = ids.includes(previous) ? previous : option.defaultChoice;
}

/** 練習の選択肢の欄の要素。choice は欄（label）、name は欄の見出し（例: 「速さ」）。 */
export interface OptionChoiceElements {
  readonly select: HTMLSelectElement;
  readonly choice: Pick<HTMLElement, 'hidden'>;
  readonly name?: Pick<HTMLElement, 'textContent'> | null;
}

/**
 * 選んでいるモードに合わせて練習の選択肢の欄を出すか決める。持つモードでは欄を出し、その選択肢の値を入れる（同じ選択肢なら選んでいる値を残す）。
 * 持たないモードでは欄を隠すだけで、select の値は残す。隠した欄にはパッドでの項目の移動でもフォーカスが移らない（src/ui/pad-menu.ts）。
 */
export function showOptionChoice(elements: OptionChoiceElements, mode: Pick<TrainingMode, 'option'> | undefined): void {
  const option = mode?.option;
  elements.choice.hidden = option === undefined;
  if (!option) return;
  if (elements.name && elements.name.textContent !== option.label) elements.name.textContent = option.label;
  fillOptionSelect(elements.select, option);
}
