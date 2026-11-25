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
