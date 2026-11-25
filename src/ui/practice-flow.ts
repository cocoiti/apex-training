import type { ScreenId } from './router';

/** 画面に入ったときにすること。 */
export interface ScreenEntry {
  /** 表示する画面。求めた画面に入れないときはトップ画面。 */
  readonly screen: ScreenId;
  /** 練習を始める。 */
  readonly start: boolean;
  /** 練習中の練習を打ち切る。 */
  readonly abort: boolean;
}

/**
 * 練習の始まりと終わりで、プレイ画面とリザルト画面に入れるかを決める（docs/spec/screens.md、docs/spec/modes.md「共通」）。
 * - 「開始」を押したあとにプレイ画面に入ると練習が始まる。押さずに `#/play` を開いたときはトップ画面にする。
 * - 練習中にプレイ画面から離れると、その練習は打ち切る（結果は残さない）。
 * - リザルト画面は、練習を最後まで終えて結果があるときだけ入れる。ないときはトップ画面にする（UI-3）。
 * - セットのまとめは、連続練習を終えた（最後の回まで終えたか途中でやめた）ときだけ入れる。ないときはトップ画面にする（UI-36）。
 * やり直しと連続練習の次の回はプレイ画面の中で始め直すので、画面には入り直さない（docs/adr/2026-11-25-practice-set-within-play-screen.md）。
 * 決定の理由は docs/adr/2026-11-25-practice-session-per-start.md。
 */
export class PracticeFlow {
  private armed = false;
  private active = false;
  private hasResult = false;
  private hasSetResult = false;

  /** 練習中か。 */
  get practicing(): boolean {
    return this.active;
  }

  /** 「開始」を押した。次にプレイ画面に入ったときに練習を始める。 */
  requestStart(): void {
    this.armed = true;
  }

  /** 画面に入ろうとした。 */
  enter(requested: ScreenId): ScreenEntry {
    const armed = this.armed;
    this.armed = false;
    if (requested === 'play') {
      if (armed) {
        this.active = true;
        return { screen: 'play', start: true, abort: false };
      }
      return { screen: this.active ? 'play' : 'top', start: false, abort: false };
    }
    const abort = this.active;
    this.active = false;
    if (requested === 'result' && !this.hasResult) return { screen: 'top', start: false, abort };
    if (requested === 'set-result' && !this.hasSetResult) return { screen: 'top', start: false, abort };
    return { screen: requested, start: false, abort };
  }

  /** 練習が最後まで終わった。このあとリザルト画面に入れる。 */
  finish(): void {
    this.active = false;
    this.hasResult = true;
  }

  /** 連続練習を終えた（最後の回まで終えたか、終えた回があるうちにやめた）。このあとセットのまとめに入れる。 */
  finishSet(): void {
    this.active = false;
    this.hasSetResult = true;
  }
}
