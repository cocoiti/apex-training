import { PRACTICE_COUNTS } from './practice-set';

/**
 * 回数の選択肢（1・5・10・20）を select に入れ、1 を選んだ状態にする（docs/spec/screens.md「トップ画面」、UI-31）。
 * 選択は保存しない。ページを開いているあいだは select の値として残る。
 */
export function fillCountSelect(select: HTMLSelectElement): void {
  const doc = select.ownerDocument;
  select.replaceChildren(
    ...PRACTICE_COUNTS.map((count) => {
      const option = doc.createElement('option');
      option.value = String(count);
      option.textContent = `${count} 回`;
      return option;
    }),
  );
  select.value = String(PRACTICE_COUNTS[0]);
}
