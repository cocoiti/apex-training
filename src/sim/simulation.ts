import { DEFAULT_FIXED_STEP } from '../core/loop';
import type { Action } from '../input/actions';
import type { InputSource } from '../input/queue';
import type { Angles } from './angles';
import { applyLook, viewAngles, type Player } from './player';
import type { World } from './world';

/** ステップごとの追加の処理（練習モードなど）。入力を適用し、練習の的をそのステップの位置にしたあとに呼ぶ。 */
export type StepHook = (world: World, dt: number) => void;

/**
 * 固定ステップで World を進める。ステップ n は [n × dt, (n + 1) × dt) の時刻の入力を消費する。
 * 時刻はステップの番号から求め、足し算の誤差を積み上げない。
 */
export class Simulation {
  readonly world: World;
  readonly dt: number;
  private readonly input: InputSource;
  private readonly hooks: StepHook[] = [];
  private steps = 0;
  private previous: Angles;

  constructor(world: World, input: InputSource, dt = DEFAULT_FIXED_STEP) {
    this.world = world;
    this.input = input;
    this.dt = dt;
    this.previous = viewAngles(world.player);
  }

  get stepCount(): number {
    return this.steps;
  }

  /** 進めた時刻（秒）。 */
  get time(): number {
    return this.steps * this.dt;
  }

  /** 直前のステップの開始時点の照準の向き。描画の補間に使う。 */
  get previousViewAngles(): Angles {
    return this.previous;
  }

  addStepHook(hook: StepHook): void {
    this.hooks.push(hook);
  }

  step(): void {
    this.previous = viewAngles(this.world.player);
    const end = (this.steps + 1) * this.dt;
    applyActions(this.world.player, this.input.take(end));
    // 練習の的の位置と出現は、そのステップの終わりの時刻で決める（docs/spec/architecture.md「練習の的」）。
    this.world.targets.update(end);
    for (const hook of this.hooks) hook(this.world, this.dt);
    this.steps += 1;
  }

  /** 秒数分のステップを進める（テスト用）。 */
  advance(seconds: number): void {
    const count = Math.round(seconds / this.dt);
    for (let i = 0; i < count; i += 1) this.step();
  }
}

/**
 * 1 ステップで消費した入力を順に適用する。look は足し合わせ、fire・ads は最後の状態にする。
 * 照準の軌道（trajectory.ts）も同じ規則で look を消費するため、ここを共有する。
 */
export function applyActions(player: Player, actions: readonly Action[]): void {
  let yaw = 0;
  let pitch = 0;
  for (const action of actions) {
    switch (action.type) {
      case 'look':
        yaw += action.yaw;
        pitch += action.pitch;
        break;
      case 'fire':
        player.fire = action.pressed;
        break;
      case 'ads':
        player.ads = action.pressed;
        break;
    }
  }
  if (yaw !== 0 || pitch !== 0) applyLook(player, { yaw, pitch });
}
