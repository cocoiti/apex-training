import { t } from './i18n';
import { PRACTICE_COUNTS } from './practice-set';

/**
 * 回数の選択肢（1・5・10・20）を select に入れ、1 を選んだ状態にする（docs/spec/screens.md「トップ画面」、UI-31）。
 * 選択は保存しない。ページを開いているあいだは select の値として残る。表示の言語を選び直したときは relabelCountSelect で名前だけを書き直す。
 */
export function fillCountSelect(select: HTMLSelectElement): void {
  const doc = select.ownerDocument;
  select.replaceChildren(
    ...PRACTICE_COUNTS.map((count) => {
      const option = doc.createElement('option');
      option.value = String(count);
      option.textContent = t('count.option', { count });
      return option;
    }),
  );
  select.value = String(PRACTICE_COUNTS[0]);
}

/** 回数の選択肢の名前を今の言語で書き直す。選んでいる値は変えない。 */
export function relabelCountSelect(select: HTMLSelectElement): void {
  for (const option of select.options) option.textContent = t('count.option', { count: option.value });
}
