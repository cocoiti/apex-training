/**
 * テストのための読み込みの完了の印（docs/spec/architecture.md「テストのための読み込みの完了の印」）。
 * データの読み込み（docs/spec/screens.md「データの読み込み」）の状態を <html> の data-app-state に出す。
 * 利用者には見えず、画面の表示や操作を変えない。index.html が最初から loading を持ち、読み込みが終わったら一度だけ ready か error にする。
 */

/** 印を置く属性の名前。 */
export const APP_STATE_ATTRIBUTE = 'data-app-state';

/** 読み込み中・画面の操作を受け付ける・読み込めなかった。 */
export type AppState = 'loading' | 'ready' | 'error';

/** 印を置く要素（<html>）。テストでは属性だけを持つ物で差し替える。 */
export interface AppStateTarget {
  setAttribute(name: string, value: string): void;
}

/** 読み込みの状態の印。loading から ready か error に一度だけ移り、そのあとは変えない。 */
export class AppStateMark {
  private current: AppState = 'loading';

  constructor(private readonly target: AppStateTarget) {
    target.setAttribute(APP_STATE_ATTRIBUTE, this.current);
  }

  /** 今の状態。 */
  get state(): AppState {
    return this.current;
  }

  /** マップと武器のデータを読み込み、トップ画面のカードと履歴の画面の選択肢を作り終えた。 */
  ready(): void {
    this.settle('ready');
  }

  /** 読み込めなかった（プレイ画面の状態の行に読み込めなかった旨を出した）。 */
  fail(): void {
    this.settle('error');
  }

  private settle(state: Exclude<AppState, 'loading'>): void {
    if (this.current !== 'loading') return;
    this.current = state;
    this.target.setAttribute(APP_STATE_ATTRIBUTE, state);
  }
}
