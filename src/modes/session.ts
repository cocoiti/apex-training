import { createRandom } from '../core/random';
import type { InputSource } from '../input/queue';
import type { Angles } from '../sim/angles';
import { Gun, type ShotRecord } from '../sim/gun';
import { PracticeEndRule, type PracticeEndReason } from '../sim/practice';
import { Simulation } from '../sim/simulation';
import type { WeaponData } from '../sim/weapon';
import type { World } from '../sim/world';
import type { ModeContext, ModeResult, TrainingMode } from './types';

/** 練習が終わったときにリザルト画面へ渡すもの（docs/spec/modes.md「共通」）。 */
export interface PracticeResult {
  readonly weapon: WeaponData;
  readonly mode: Pick<TrainingMode, 'id' | 'name' | 'category'>;
  /** 撃った弾の記録（弾痕）。撃った順。 */
  readonly shots: readonly ShotRecord[];
  readonly endReason: PracticeEndReason;
  /** 練習の開始から終わりまでの時間（秒、固定ステップの時刻）。 */
  readonly duration: number;
  readonly modeResult: ModeResult;
}

export interface PracticeSessionOptions {
  /** この練習のためだけに作った World。練習が書き換える。 */
  readonly world: World;
  readonly weapon: WeaponData;
  readonly mode: TrainingMode;
  /** 入力の元。時刻は練習の開始からの秒。 */
  readonly input: InputSource;
  /** 乱数の種。 */
  readonly seed: number;
  readonly dt?: number;
}

/**
 * 1 回の練習。選んだ武器とモードで、固定ステップごとに入力 → 射撃 → 終わりの判定 → モードの処理の順に進める。
 * 時刻は練習の開始を 0 とする。終わったあとは step を呼んでも進まない。
 */
export class PracticeSession {
  readonly world: World;
  readonly weapon: WeaponData;
  readonly mode: TrainingMode;
  readonly sim: Simulation;
  readonly gun: Gun;
  private readonly context: ModeContext;
  private readonly endRule = new PracticeEndRule();
  private finished: PracticeResult | undefined;

  constructor(options: PracticeSessionOptions) {
    this.world = options.world;
    this.weapon = options.weapon;
    this.mode = options.mode;
    const random = createRandom(options.seed);
    this.gun = new Gun(options.weapon, random);
    this.sim = new Simulation(options.world, options.input, options.dt);
    this.context = { world: options.world, gun: this.gun, random };
    this.mode.setup(this.context);
    this.sim.addStepHook((world, dt) => {
      this.gun.step(world, dt);
      const reason = this.endRule.step(world.player, this.gun, dt);
      const keepGoing = this.mode.step(this.context, dt);
      if (reason || !keepGoing) this.finish(reason ?? 'mode', dt);
    });
  }

  /** 練習が終わっていれば、その結果。 */
  get result(): PracticeResult | undefined {
    return this.finished;
  }

  get ended(): boolean {
    return this.finished !== undefined;
  }

  /** 練習の開始からの時間（秒、固定ステップの時刻）。終わったあとは終わった時刻のまま。 */
  get elapsed(): number {
    return this.sim.time;
  }

  /** 直前のステップの開始時点の照準の向き。描画の補間に使う。 */
  get previousViewAngles(): Angles {
    return this.sim.previousViewAngles;
  }

  /** 1 固定ステップ進める。終わったあとは何もしない。 */
  step(): void {
    if (this.finished) return;
    this.sim.step();
  }

  private finish(endReason: PracticeEndReason, dt: number): void {
    const modeResult = this.mode.result(this.context);
    this.mode.teardown(this.context);
    this.finished = {
      weapon: this.weapon,
      mode: { id: this.mode.id, name: this.mode.name, category: this.mode.category },
      shots: [...this.gun.shots],
      endReason,
      // フックはステップの数を数える前に呼ばれるので、このステップの終わりの時刻はステップの数 + 1 から求める。
      duration: (this.sim.stepCount + 1) * dt,
      modeResult,
    };
  }
}
