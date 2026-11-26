import type { PointerLockResult } from '../input/mouse';
import { t } from './i18n';

// 通常のポインターロックになったときの警告（docs/spec/mouse.md「ポインターロックと生入力」）は play.mouseAcceleration、
// ポインターロックが失敗したときの表示は play.pointerLockFailed、一時停止の表示は play.paused（src/ui/messages/）。

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
  notice.textContent = result === 'failed' ? t('play.pointerLockFailed') : t('play.mouseAcceleration');
  notice.hidden = false;
}

/** 一時停止の表示を出す・消す。 */
export function showPaused(element: Pick<HTMLElement, 'hidden' | 'textContent'>, paused: boolean): void {
  element.textContent = t('play.paused');
  element.hidden = !paused;
}
