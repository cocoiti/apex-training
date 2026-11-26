import type { TrainingMode } from '../modes/types';

/**
 * モードの選択肢を select に入れる（docs/spec/screens.md「トップ画面」）。並びは渡した順（登録の並び順）で、
 * 最初のモードを選んだ状態にする。
 */
export function fillModeSelect(select: HTMLSelectElement, modes: readonly Pick<TrainingMode, 'id' | 'name'>[]): void {
  const doc = select.ownerDocument;
  select.replaceChildren(
    ...modes.map((mode) => {
      const option = doc.createElement('option');
      option.value = mode.id;
      option.textContent = mode.name;
      return option;
    }),
  );
  select.value = modes[0]?.id ?? '';
}

/** モードの欄の要素。choice は select を囲む選択肢の欄、only はモードが 1 つのときに名前だけを出す欄、name はその名前。 */
export interface ModeChoiceElements {
  readonly select: HTMLSelectElement;
  readonly choice: Pick<HTMLElement, 'hidden'>;
  readonly only: Pick<HTMLElement, 'hidden'>;
  readonly name: Pick<HTMLElement, 'textContent'>;
}

/**
 * トップ画面と履歴の画面のモードの欄を作る（docs/spec/screens.md「トップ画面」「履歴の画面」）。
 * select には登録されたモードを入れて最初のモードを選ぶ。登録されたモードが 1 つのときは選択肢の欄を隠して、
 * そのモードの名前だけを出す（隠した欄にはパッドのフォーカスも移らない）。2 つ以上のときは選択肢の欄を出す。
 * select は隠しても残し、選んでいるモードはいつも select の値で読む。決定の理由は docs/adr/2026-11-26-remove-center-mode-and-panel-setting.md。
 */
export function fillModeChoice(elements: ModeChoiceElements, modes: readonly Pick<TrainingMode, 'id' | 'name'>[]): void {
  fillModeSelect(elements.select, modes);
  const single = modes.length === 1;
  elements.choice.hidden = single;
  elements.only.hidden = !single;
  elements.name.textContent = single ? (modes[0]?.name ?? '') : '';
}
