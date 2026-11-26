import { traceShot, type Shooter, type ShotRecord } from './gun';
import { viewAngles } from './player';
import type { World } from './world';

/**
 * 武器を使わない練習の撃ち方（docs/spec/architecture.md「武器を使わない練習」）。`fire` の押し始めのステップごとに 1 発を撃ち、
 * そのステップの照準のレイで当たりを求める。押し続けても 2 発目は出ない。リコイル・ブレ・残弾はなく、照準のリコイルのオフセットは変えない。
 */
export class TapFire implements Shooter {
  readonly shots: ShotRecord[] = [];
  private wasPressed = false;
  private steps = 0;

  step(world: World, dt: number): void {
    const start = this.steps * dt;
    this.steps += 1;
    const { player } = world;
    const pressedNow = player.fire && !this.wasPressed;
    this.wasPressed = player.fire;
    if (!pressedNow) return;
    const angles = viewAngles(player);
    // パターンを使わないので、どの弾もパターンの 1 発目として記録する。時刻は押し始めのステップの開始（Gun の 1 発目と同じ）。
    this.shots.push({ shot: this.shots.length + 1, patternShot: 1, time: start, angles, ...traceShot(world, angles) });
  }
}
