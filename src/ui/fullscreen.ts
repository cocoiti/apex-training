/** 全画面の切替（docs/spec/mouse.md「全画面」）。 */

export interface FullscreenDocument {
  readonly fullscreenElement: Element | null;
  exitFullscreen(): Promise<void>;
}

export interface FullscreenTarget {
  requestFullscreen(): Promise<void>;
}

/** 全画面でなければ target を全画面にし、全画面なら解除する。拒否されても例外にしない。 */
export async function toggleFullscreen(doc: FullscreenDocument, target: FullscreenTarget): Promise<void> {
  try {
    if (doc.fullscreenElement) await doc.exitFullscreen();
    else await target.requestFullscreen();
  } catch {
    // 全画面を拒否する環境では、そのままの表示で続ける。
  }
}

/** 切替ボタンの文言。 */
export function fullscreenLabel(doc: Pick<FullscreenDocument, 'fullscreenElement'>): string {
  return doc.fullscreenElement ? '全画面を解除' : '全画面';
}
