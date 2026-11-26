import type { ScreenId } from './router';
import { t } from './i18n';

/** 画面の要素。index.html の data-screen を持つ要素。 */
export type ScreenElement = Pick<HTMLElement, 'dataset' | 'hidden'>;

/** data-screen が screen の要素だけを表示し、ほかを隠す。 */
export function showScreen(elements: Iterable<ScreenElement>, screen: ScreenId): void {
  for (const element of elements) element.hidden = element.dataset.screen !== screen;
}

/** フッターの保存できないことの表示。一度出したら消さない。表示の言語を選び直したときも、出していれば呼び直す。 */
export function showStorageNotice(notice: Pick<HTMLElement, 'hidden' | 'textContent'>): void {
  notice.textContent = t('storage.unavailable');
  notice.hidden = false;
}
