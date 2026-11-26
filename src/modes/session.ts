import { createRandom } from '../core/random';
import type { InputMethod } from '../input/input-switch';
import type { InputSource } from '../input/queue';
import { replayInput, type InputRecording } from '../input/recording';
import { normalizeYaw, type Angles } from '../sim/angles';
import { aimedTarget, Gun, type Shooter, type ShotRecord } from '../sim/gun';
import { MAX_REPLAY_SECONDS, PracticeEndRule, timeLimitReached, type PracticeEndReason } from '../sim/practice';
import { Simulation } from '../sim/simulation';
import { TapFire } from '../sim/tap-fire';
import { idealCorrectionRate, type WeaponData } from '../sim/weapon';
import type { World } from '../sim/world';
import { modeUsesWeapon, type ModeContext, type ModeResult, type TrainingMode } from './types';

/** リザルト画面が使うモードの項目。 */
export type PracticeResultMode = Pick<TrainingMode, 'id' | 'name' | 'category' | 'usesWeapon' | 'scoring' | 'weakSections'>;

/** 練習が終わったときにリザルト画面へ渡すもの（docs/spec/modes.md「共通」）。 */
export interface PracticeResult {
  /** 練習の武器。武器を使わないモードでは undefined。 */
  readonly weapon: WeaponData | undefined;
  readonly mode: PracticeResultMode;
  /** 撃った弾の記録（弾痕。練習の的への命中は target を持つ）。撃った順。 */
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

/** 武器を使うモードの練習では Gun、武器を使わないモードの練習では undefined。 */
export type SessionGun<W extends WeaponData | undefined> = W extends WeaponData ? Gun : undefined;

export interface PracticeSessionOptions<W extends WeaponData | undefined = WeaponData> {
  /** この練習のためだけに作った World。練習が書き換える。 */
  readonly world: World;
  /** 練習の武器。武器を使うモードでは必ず渡し、武器を使わないモードでは使わない（undefined を渡す）。 */
  readonly weapon: W;
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
 * 1 回の練習。選んだ武器とモードで、固定ステップごとに入力 → 練習の的の位置 → 射撃 → 照準と的の当たり → 終わりの判定 → モードの処理の順に進める。
 * 武器を使わないモードでは Gun の代わりに TapFire で撃つ（docs/spec/architecture.md「武器を使わない練習」）。
 * 時刻は練習の開始を 0 とする。終わったあとは step を呼んでも進まない。
 */
export class PracticeSession<W extends WeaponData | undefined = WeaponData> {
  readonly world: World;
  readonly weapon: W;
  readonly mode: TrainingMode;
  readonly sim: Simulation;
  /** 練習の武器の発射・リコイル。武器を使わないモードでは undefined。 */
  readonly gun: SessionGun<W>;
  private readonly shooter: Shooter;
  private readonly context: ModeContext;
  private readonly endRule = new PracticeEndRule();
  private finished: PracticeResult | undefined;
  private readonly currentInputMethod: () => InputMethod;
  /** 1 発目を撃ったときの入力方式。まだ撃っていなければ undefined。 */
  private firstShotInputMethod: InputMethod | undefined;
  private readonly currentPadName: () => string | undefined;
  /** 1 発目を撃ったときのパッドの名前。 */
  private firstShotPadName: string | undefined;
  /** 撃った各弾の発射時の利用者の照準（開始時の照準からの差）。撃った順。 */
  private readonly aims: Angles[] = [];

  constructor(options: PracticeSessionOptions<W>) {
    this.world = options.world;
    this.weapon = options.weapon;
    this.mode = options.mode;
    this.currentInputMethod = options.inputMethod ?? (() => 'mouse');
    this.currentPadName = options.padName ?? (() => undefined);
    const random = createRandom(options.seed);
    const weapon: WeaponData | undefined = options.weapon;
    const usesWeapon = modeUsesWeapon(options.mode);
    if (usesWeapon && !weapon) throw new Error(`モード ${options.mode.id} は武器を使うので、武器を渡す`);
    const gun = usesWeapon && weapon ? new Gun(weapon, random) : undefined;
    this.gun = gun as SessionGun<W>;
    this.shooter = gun ?? new TapFire();
    this.sim = new Simulation(options.world, options.input, options.dt);
    const { sim, shooter } = this;
    let inStep = false;
    this.context = {
      world: options.world,
      gun,
      shots: shooter.shots,
      targets: options.world.targets,
      random,
      // setup では 0、ステップごとの処理ではそのステップの終わりの時刻（フックはステップの数を数える前に呼ばれる）。
      get time() {
        return inStep ? (sim.stepCount + 1) * sim.dt : sim.time;
      },
    };
    this.mode.setup(this.context);
    this.sim.addStepHook((world, dt) => {
      inStep = true;
      shooter.step(world, dt);
      // 弾はそのステップの入力を適用したあとの照準で撃つ（src/sim/trajectory.ts の aimAtShots と同じ）。
      while (this.aims.length < shooter.shots.length) this.aims.push(this.aim);
      if (this.firstShotInputMethod === undefined && shooter.shots.length > 0) {
        this.firstShotInputMethod = this.currentInputMethod();
        this.firstShotPadName = this.currentPadName();
      }
      // 照準と的の当たりは、そのステップの入力と射撃を適用したあとの照準で求める（docs/spec/architecture.md「照準と的の当たり」）。
      world.targets.setAimed(aimedTarget(world));
      // 撃ち切りと撃たない時間で終わるのは武器を使うモードだけ。武器を使わないモードはモードが決めた終わりの条件だけで終わる。
      const reason = (gun ? this.endRule.step(world.player, gun, dt) : undefined) ?? (timeLimitReached((sim.stepCount + 1) * dt, this.mode.timeLimit) ? 'time' : undefined);
      const keepGoing = this.mode.step(this.context, dt);
      inStep = false;
      if (reason || !keepGoing) this.finish(reason ?? 'mode', dt);
    });
  }

  /** 撃った弾の記録。撃った順。武器を使わないモードでは fire の押し始めごとの 1 発。 */
  get shots(): readonly ShotRecord[] {
    return this.shooter.shots;
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
    const gun: Gun | undefined = this.gun;
    if (this.finished || !gun) return { yaw: 0, pitch: 0 };
    return idealCorrectionRate(gun.weapon, { fire: this.world.player.fire, nextShot: gun.nextPatternShot, ammo: gun.ammo });
  }

  /**
   * 撃った各弾の発射時の利用者の照準。開始時の照準（World の中心）からのヨー・ピッチ（度）で、リコイルのオフセットは含まない。
   * 撃った順で、記録から求めるリザルトの「自分の照準の軌道」（aimAtShots）と同じ値。補正のパネルの自分の線に使う。
   */
  get shotAims(): readonly Angles[] {
    return this.aims;
  }

  /** 今の利用者の照準。開始時の照準（World の中心）からのヨー・ピッチ（度）で、リコイルのオフセットは含まない。補正のパネルの今の照準に使う。 */
  get aim(): Angles {
    const { player, center } = this.world;
    return { yaw: normalizeYaw(player.aim.yaw - center.yaw), pitch: player.aim.pitch - center.pitch };
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
    const { id, name, category, usesWeapon, scoring, weakSections } = this.mode;
    this.finished = {
      weapon: this.gun ? this.weapon : undefined,
      mode: {
        id,
        name,
        category,
        ...(usesWeapon === undefined ? {} : { usesWeapon }),
        ...(scoring === undefined ? {} : { scoring }),
        ...(weakSections === undefined ? {} : { weakSections }),
      },
      shots: [...this.shooter.shots],
      endReason,
      inputMethod,
      padName: inputMethod === 'pad' ? padName : undefined,
      // フックはステップの数を数える前に呼ばれるので、このステップの終わりの時刻はステップの数 + 1 から求める。
      duration: (this.sim.stepCount + 1) * dt,
      modeResult,
    };
  }
}

export type ReplaySessionOptions<W extends WeaponData | undefined = WeaponData> = Omit<PracticeSessionOptions<W>, 'input' | 'seed'>;

/**
 * 入力の記録を、元の練習と同じ World・武器・モードで再生する（docs/spec/input.md「入力の記録と再生」）。乱数は記録の種で作る。
 * モードも同じ乱数を使うので、元の練習と同じモードを与える。練習が終わるまで（上限 MAX_REPLAY_SECONDS）進める。
 */
export function replayPracticeSession<W extends WeaponData | undefined = WeaponData>(
  recording: InputRecording,
  options: ReplaySessionOptions<W>,
): PracticeSession<W> {
  const session = new PracticeSession<W>({ ...options, input: replayInput(recording), seed: recording.seed });
  const maxSteps = Math.ceil(MAX_REPLAY_SECONDS / session.sim.dt);
  while (!session.ended && session.sim.stepCount < maxSteps) session.step();
  return session;
}
