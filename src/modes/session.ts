import { createRandom } from '../core/random';
import type { InputMethod } from '../input/input-switch';
import type { InputSource } from '../input/queue';
import { replayInput, type InputRecording } from '../input/recording';
import type { Angles } from '../sim/angles';
import { Gun, type ShotRecord } from '../sim/gun';
import { MAX_REPLAY_SECONDS, PracticeEndRule, type PracticeEndReason } from '../sim/practice';
import { Simulation } from '../sim/simulation';
import { idealCorrectionRate, type WeaponData } from '../sim/weapon';
import type { World } from '../sim/world';
import type { ModeContext, ModeResult, TrainingMode } from './types';

/** 練習が終わったときにリザルト画面へ渡すもの（docs/spec/modes.md「共通」）。 */
export interface PracticeResult {
  readonly weapon: WeaponData;
  readonly mode: Pick<TrainingMode, 'id' | 'name' | 'category'>;
  /** 撃った弾の記録（弾痕）。撃った順。 */
  readonly shots: readonly ShotRecord[];
  readonly endReason: PracticeEndReason;
  /** 練習の入力方式。1 発目を撃ったときの今の入力方式（docs/spec/input.md「入力方式ごとの保存」）。 */
  readonly inputMethod: InputMethod;
  /**
   * 練習の入力方式がパッドのとき、1 発目を撃ったときに入力に使っていたパッドの名前（Gamepad API の id）。
   * マウスのとき、名前が分からないときは undefined（docs/spec/pad.md「リザルトの入力推移のグラフ」）。
   */
  readonly padName: string | undefined;
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
  /** 今の入力方式。1 発目を撃ったステップで 1 回だけ読む。省いたときはマウス。 */
  readonly inputMethod?: () => InputMethod;
  /** 入力に使っているパッドの名前。入力方式と同じく、1 発目を撃ったステップで 1 回だけ読む。省いたときは分からない。 */
  readonly padName?: () => string | undefined;
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
  private readonly currentInputMethod: () => InputMethod;
  /** 1 発目を撃ったときの入力方式。まだ撃っていなければ undefined。 */
  private firstShotInputMethod: InputMethod | undefined;
  private readonly currentPadName: () => string | undefined;
  /** 1 発目を撃ったときのパッドの名前。 */
  private firstShotPadName: string | undefined;

  constructor(options: PracticeSessionOptions) {
    this.world = options.world;
    this.weapon = options.weapon;
    this.mode = options.mode;
    this.currentInputMethod = options.inputMethod ?? (() => 'mouse');
    this.currentPadName = options.padName ?? (() => undefined);
    const random = createRandom(options.seed);
    this.gun = new Gun(options.weapon, random);
    this.sim = new Simulation(options.world, options.input, options.dt);
    this.context = { world: options.world, gun: this.gun, random };
    this.mode.setup(this.context);
    this.sim.addStepHook((world, dt) => {
      this.gun.step(world, dt);
      if (this.firstShotInputMethod === undefined && this.gun.shots.length > 0) {
        this.firstShotInputMethod = this.currentInputMethod();
        this.firstShotPadName = this.currentPadName();
      }
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

  /**
   * 今のゴーストの向き。ゴーストを表示しないモード、表示しない状態（撃ち切ったなど）、練習が終わったあとは undefined。
   * 設定のゴースト表示の ON/OFF はここでは見ない（描画の側で見る）。
   */
  get ghost(): Angles | undefined {
    if (this.finished) return undefined;
    return this.mode.ghost?.(this.context);
  }

  /**
   * 今の理想の補正速度（ヨー・ピッチ、度/秒、docs/spec/pad.md「理想の補正速度」）。今の fire の状態と次に撃つ弾から求める。
   * パッド向けのガイドの理想の位置に使う。練習が終わったあとは 0。
   */
  get idealRate(): Angles {
    if (this.finished) return { yaw: 0, pitch: 0 };
    return idealCorrectionRate(this.weapon, { fire: this.world.player.fire, nextShot: this.gun.nextPatternShot, ammo: this.gun.ammo });
  }

  /** 1 固定ステップ進める。終わったあとは何もしない。 */
  step(): void {
    if (this.finished) return;
    this.sim.step();
  }

  private finish(endReason: PracticeEndReason, dt: number): void {
    const modeResult = this.mode.result(this.context);
    this.mode.teardown(this.context);
    const inputMethod = this.firstShotInputMethod ?? this.currentInputMethod();
    const padName = this.firstShotInputMethod === undefined ? this.currentPadName() : this.firstShotPadName;
    this.finished = {
      weapon: this.weapon,
      mode: { id: this.mode.id, name: this.mode.name, category: this.mode.category },
      shots: [...this.gun.shots],
      endReason,
      inputMethod,
      padName: inputMethod === 'pad' ? padName : undefined,
      // フックはステップの数を数える前に呼ばれるので、このステップの終わりの時刻はステップの数 + 1 から求める。
      duration: (this.sim.stepCount + 1) * dt,
      modeResult,
    };
  }
}

export type ReplaySessionOptions = Omit<PracticeSessionOptions, 'input' | 'seed'>;

/**
 * 入力の記録を、元の練習と同じ World・武器・モードで再生する（docs/spec/input.md「入力の記録と再生」）。乱数は記録の種で作る。
 * モードも同じ乱数を使うので、元の練習と同じモードを与える。練習が終わるまで（上限 MAX_REPLAY_SECONDS）進める。
 */
export function replayPracticeSession(recording: InputRecording, options: ReplaySessionOptions): PracticeSession {
  const session = new PracticeSession({ ...options, input: replayInput(recording), seed: recording.seed });
  const maxSteps = Math.ceil(MAX_REPLAY_SECONDS / session.sim.dt);
  while (!session.ended && session.sim.stepCount < maxSteps) session.step();
  return session;
}
