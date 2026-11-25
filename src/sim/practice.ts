import { DEFAULT_FIXED_STEP } from '../core/loop';
import { createRandom } from '../core/random';
import type { InputSource } from '../input/queue';
import { replayInput, type InputRecording } from '../input/recording';
import { Gun, type ShotRecord } from './gun';
import type { MapData } from './map';
import type { Player } from './player';
import { scoreShots, type ScoreResult } from './scoring';
import { Simulation } from './simulation';
import type { WeaponData } from './weapon';
import { createWorld, type World } from './world';

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

/** 再生で進めるステップの上限（秒）。記録が壊れていても止まるようにする。 */
export const MAX_REPLAY_SECONDS = 600;

export interface PracticeOptions {
  readonly map: MapData;
  readonly weapon: WeaponData;
  /** シミュレーションに流す入力の元。練習では RecordingInput、再生では replayInput。 */
  readonly input: InputSource;
  /** 乱数の種。シミュレーションの乱数（ブレ）はすべてこの種から取る。 */
  readonly seed: number;
  readonly dt?: number;
}

/** 1 回の練習のシミュレーション。マップから World を作り、種で作った乱数の Gun をステップごとに進める。 */
export interface Practice {
  readonly world: World;
  readonly sim: Simulation;
  readonly gun: Gun;
  readonly seed: number;
}

export function createPractice(options: PracticeOptions): Practice {
  const world = createWorld(options.map);
  const sim = new Simulation(world, options.input, options.dt ?? DEFAULT_FIXED_STEP);
  const gun = new Gun(options.weapon, createRandom(options.seed));
  sim.addStepHook((w, dt) => gun.step(w, dt));
  return { world, sim, gun, seed: options.seed };
}

/** 練習の結果。撃った弾（弾痕）と採点結果。 */
export interface PracticeOutcome {
  readonly shots: readonly ShotRecord[];
  readonly score: ScoreResult;
}

/**
 * 練習の結果を求める。採点はリザルト画面と同じ scoreShots で行い、外れの弾も弾の向きと中心との差をズレとして入れる
 * （ADR: score-inputs-from-map-target）。radius は的の半径（度）で、省略するとマップの的から求める（targetRadius）。
 */
export function practiceOutcome(practice: Practice, radius?: number): PracticeOutcome {
  const shots = [...practice.gun.shots];
  return { shots, score: scoreShots(shots, practice.world, radius) };
}

export interface ReplayOptions {
  readonly map: MapData;
  readonly weapon: WeaponData;
  /** 的の半径（度）。省略するとマップの的から求める（リザルト画面と同じ）。 */
  readonly targetRadius?: number;
  readonly dt?: number;
}

/**
 * 入力の記録を再生して結果を求める（docs/spec/input.md「入力の記録と再生」）。乱数は記録の種で作る。
 * 記録のアクションをすべて消費し、撃ち続けていない状態になるまで進める。そこから先は弾が出ないので、結果は元の練習と同じになる。
 */
export function replayRecording(recording: InputRecording, options: ReplayOptions): PracticeOutcome & { practice: Practice } {
  const practice = createPractice({ ...options, input: replayInput(recording), seed: recording.seed });
  const { sim, gun } = practice;
  const lastTime = recording.actions.reduce((latest, { time }) => Math.max(latest, time), 0);
  const maxSteps = Math.ceil(MAX_REPLAY_SECONDS / sim.dt);
  while (sim.stepCount < maxSteps && (sim.time <= lastTime || gun.firing)) sim.step();
  return { practice, ...practiceOutcome(practice, options.targetRadius) };
}
