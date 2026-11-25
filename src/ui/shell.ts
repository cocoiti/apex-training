import type { ScreenId } from './router';
import { STORAGE_UNAVAILABLE_MESSAGE } from './storage';

/** 画面の要素。index.html の data-screen を持つ要素。 */
export type ScreenElement = Pick<HTMLElement, 'dataset' | 'hidden'>;

/** data-screen が screen の要素だけを表示し、ほかを隠す。 */
export function showScreen(elements: Iterable<ScreenElement>, screen: ScreenId): void {
  for (const element of elements) element.hidden = element.dataset.screen !== screen;
}

/** フッターの保存できないことの表示。一度出したら消さない。 */
export function showStorageNotice(notice: Pick<HTMLElement, 'hidden' | 'textContent'>): void {
  notice.textContent = STORAGE_UNAVAILABLE_MESSAGE;
  notice.hidden = false;
}
