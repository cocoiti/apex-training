import type { ScreenControl } from '../input/screen-controls';
import type { ScreenId } from './router';

/**
 * 画面の操作（docs/spec/screens.md「画面の操作」）。
 * - restart: 練習中の回を最初からやり直す（modes.md「やり直し」）。
 * - next: 短いリザルトを待たずに次の回を始める。
 * - quit: セットをやめる。
 * - again: リザルト画面・セットのまとめの「もう一度」。
 * - change-weapon: リザルト画面・セットのまとめの「武器変更」。
 * - share: リザルト画面・セットのまとめの「結果をシェア」（screens.md「結果のシェア」）。
 */
export type ScreenCommand = 'restart' | 'next' | 'quit' | 'again' | 'change-weapon' | 'share';

/** プレイ画面の状態。practicing は練習中、interlude は短いリザルトの表示中、paused は一時停止中、idle はそのどれでもない。 */
export type PlayPhase = 'practicing' | 'interlude' | 'paused' | 'idle';

export interface ScreenState {
  readonly screen: ScreenId;
  /** プレイ画面の状態。プレイ画面以外では見ない。 */
  readonly play: PlayPhase;
  /** 連続練習（回数が 2 以上）か。 */
  readonly inSet: boolean;
}

const isPrimary = (control: ScreenControl) => control === 'r' || control === 'space' || control === 'pad-a';
const isQuit = (control: ScreenControl) => control === 'q' || control === 'pad-b';

/** 今の画面で、キーかボタンが何の操作になるか。操作にならないときは undefined。トップ画面などでは何もしない。 */
export function screenCommand(state: ScreenState, control: ScreenControl): ScreenCommand | undefined {
  switch (state.screen) {
    case 'play':
      if (state.play === 'practicing') {
        // 練習中のやり直しは R と A / × だけ（Space は割り当てない）。やめるは連続練習のときだけ。
        if (control === 'r' || control === 'pad-a') return 'restart';
        if (isQuit(control) && state.inSet) return 'quit';
        return undefined;
      }
      if (state.play === 'interlude') {
        if (isPrimary(control)) return 'next';
        if (isQuit(control)) return 'quit';
      }
      // 一時停止中はプレイ画面の操作を受け付けない。
      return undefined;
    case 'result':
    case 'set-result':
      if (isPrimary(control)) return 'again';
      // 武器変更はパッドの B / ○ だけ（キーボードの Q は割り当てない）。
      if (control === 'pad-b') return 'change-weapon';
      // 結果をシェアはパッドの Y / △ だけ（キーボードには割り当てない）。
      if (control === 'pad-y') return 'share';
      return undefined;
    default:
      return undefined;
  }
}
