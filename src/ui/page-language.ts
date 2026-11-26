import { chooseLanguage, currentLanguage, onLanguageChange, parseLanguage, t, type MessageKey } from './i18n';
import type { SafeStorage } from './storage';

/**
 * index.html の文言を今の言語にする（docs/spec/screens.md「表示の言語」）。index.html は画面の文言を直接持たず、
 * 要素に辞書のキーを持たせる: `data-i18n` は文字、`data-i18n-aria-label`・`data-i18n-title`・`data-i18n-placeholder` は同じ名前の属性。
 * `<html lang>` とページのタイトルもここで合わせる。言語を選び直すたびに呼ぶ。
 */

/** 辞書のキーを持たせる属性と、書き換える属性（undefined は文字）。 */
export const TEXT_ATTRIBUTES: readonly (readonly [string, string | undefined])[] = [
  ['data-i18n', undefined],
  ['data-i18n-aria-label', 'aria-label'],
  ['data-i18n-title', 'title'],
  ['data-i18n-placeholder', 'placeholder'],
];

/** 文書の中の、辞書のキーを持つ要素の文字と属性を今の言語にし、`<html lang>` とタイトルを合わせる。同じ値なら書き直さない。 */
export function applyPageLanguage(doc: Document): void {
  for (const [source, target] of TEXT_ATTRIBUTES) {
    for (const element of doc.querySelectorAll<HTMLElement>(`[${source}]`)) {
      const text = t(element.getAttribute(source) as MessageKey);
      if (target === undefined) {
        if (element.textContent !== text) element.textContent = text;
      } else if (element.getAttribute(target) !== text) {
        element.setAttribute(target, text);
      }
    }
  }
  doc.documentElement.lang = currentLanguage();
  const title = t('app.title');
  if (doc.title !== title) doc.title = title;
}

/** 言語の欄の要素の、設定画面が使う部分。 */
export interface LanguageFieldElement {
  value: string;
  addEventListener(type: 'change', listener: () => void): void;
}

/**
 * 設定画面の言語の欄（docs/spec/screens.md「言語の設定」）。今の言語を出し、選び直すとすぐに保存して言語を変える
 * （ページを読み込み直さない）。保存できない環境でも投げず、ページを開いている間は選んだ言語のまま。
 */
export function bindLanguageField(field: LanguageFieldElement, storage: Pick<SafeStorage, 'set'>): void {
  field.value = currentLanguage();
  field.addEventListener('change', () => {
    const language = parseLanguage(field.value);
    if (language) chooseLanguage(storage, language);
    field.value = currentLanguage();
  });
  onLanguageChange((language) => {
    if (field.value !== language) field.value = language;
  });
}
