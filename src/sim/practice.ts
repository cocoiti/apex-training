import type { Gun } from './gun';
import type { Player } from './player';

/** 1 発以上撃ったあと、`fire` を離してから練習が終わるまでの時間（秒）。docs/spec/modes.md「共通」。 */
export const IDLE_END_TIME = 2;

/** 浮動小数の誤差で、ちょうど IDLE_END_TIME たったステップを 1 ステップずらさないための許容幅（秒）。 */
const EPSILON = 1e-9;

/** 練習が終わった理由。empty は撃ち切った、idle は離して撃たなかった、mode はモードが終えた。 */
export type PracticeEndReason = 'empty' | 'idle' | 'mode';

/**
 * 練習の終わりの判定（docs/spec/modes.md「共通」、MODE-6〜MODE-8）。
 * Gun の step のあと（そのステップの弾を記録したあと）に、ステップごとに呼ぶ。
 * - 1 マガジンを撃ち切った（残弾が 0）とき empty。
 * - 1 発以上撃ったあと、`fire` を離している時間が IDLE_END_TIME になったとき idle。押し直せば数え直す。
 * - 1 発も撃っていないあいだは終わらない。
 */
export class PracticeEndRule {
  /** `fire` を離してからのステップの数。時間は足し算を積まず、ステップの数から求める。 */
  private idleSteps = 0;

  step(player: Readonly<Pick<Player, 'fire'>>, gun: Readonly<Pick<Gun, 'ammo' | 'shots'>>, dt: number): PracticeEndReason | undefined {
    if (gun.shots.length === 0) return undefined;
    if (gun.ammo === 0) return 'empty';
    if (player.fire) {
      this.idleSteps = 0;
      return undefined;
    }
    this.idleSteps += 1;
    return this.idleSteps * dt >= IDLE_END_TIME - EPSILON ? 'idle' : undefined;
  }
}
