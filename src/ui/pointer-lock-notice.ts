import type { PointerLockResult } from '../input/mouse';

/** 通常のポインターロックになったときの警告（docs/spec/mouse.md「ポインターロックと生入力」）。 */
export const MOUSE_ACCELERATION_WARNING =
  'マウス加速が効いている可能性があります（このブラウザでは加速を外したポインターロックを使えません）。';

/** ポインターロックが失敗したときの表示。 */
export const POINTER_LOCK_FAILED_MESSAGE = 'ポインターロックできませんでした。キャンバスをもう一度クリックしてください。';

/** 一時停止の表示。 */
export const PAUSED_MESSAGE = '一時停止中 — キャンバスをクリックすると再開します';

type NoticeElement = Pick<HTMLElement, 'hidden' | 'textContent' | 'dataset'>;

/** ポインターロックの結果に合わせて表示する。加速を外したポインターロックになったときは隠す。 */
export function showPointerLockNotice(notice: NoticeElement, result: PointerLockResult): void {
  if (result === 'raw') {
    notice.hidden = true;
    notice.textContent = '';
    delete notice.dataset.kind;
    return;
  }
  notice.dataset.kind = result === 'failed' ? 'error' : 'warning';
  notice.textContent = result === 'failed' ? POINTER_LOCK_FAILED_MESSAGE : MOUSE_ACCELERATION_WARNING;
  notice.hidden = false;
}

/** 一時停止の表示を出す・消す。 */
export function showPaused(element: Pick<HTMLElement, 'hidden' | 'textContent'>, paused: boolean): void {
  element.textContent = PAUSED_MESSAGE;
  element.hidden = !paused;
}
