import type { Random } from '../core/random';
import { addAngles, directionFromAngles, type Angles } from './angles';
import { angularDeviation, raycastScene } from './hit';
import { addRecoilOffset, viewAngles } from './player';
import type { Vec3 } from './vec3';
import { fireInterval, type WeaponData } from './weapon';
import type { World } from './world';

/**
 * 照準のレイ（目の位置から照準の向き = 利用者の照準 + リコイルのオフセット）が乗っている練習の的の識別子
 * （docs/spec/architecture.md「照準と的の当たり」）。レイが最初に当たったものが出現している練習の的のときだけ返し、
 * 外している・手前にマップの箱がある・出現していないときは undefined。
 */
export function aimedTarget(world: World): string | undefined {
  const { player } = world;
  return raycastScene(player.position, directionFromAngles(viewAngles(player)), world.boxes, world.targets.visible)?.target?.id;
}

/** 戻りの時間（秒）。撃ち終わりからリコイルの累積が 0 に戻るまで。 */
export const RECOIL_RECOVERY_TIME = 0.5;

/** 浮動小数の誤差で、ちょうどステップの境目の発射や戻りの終わりを 1 ステップずらさないための許容幅（秒）。 */
const EPSILON = 1e-9;

/** 1 発の記録。 */
export interface ShotRecord {
  /** 発の番号（練習の開始からの通し番号、1 始まり）。 */
  readonly shot: number;
  /** pattern の何発目（1 始まり）を使って撃ったか。戻りの時間がたつ前に押し直すと、続きの番号になる。 */
  readonly patternShot: number;
  /** 発射の時刻（秒）。発射間隔から求めた時刻で、ステップの刻みには丸めない。 */
  readonly time: number;
  /** 弾の向き = 利用者の照準 + リコイルの累積 + その発のブレ。 */
  readonly angles: Angles;
  /** 弾痕の位置（メートル）。どの箱にも当たらなければ null（外れ）。 */
  readonly position: Vec3 | null;
  /** 角度のズレ（水平・垂直、度。右と上が正）。外れなら null。 */
  readonly deviation: Angles | null;
  /**
   * 当たった練習の的の識別子（docs/spec/architecture.md「照準と的の当たり」）。練習の的に当たった弾（命中）だけが持つ。
   * この弾の弾痕は表示しない。
   */
  readonly target?: string;
}

/** 弾を撃つもの。ステップごとに step を呼び、撃った弾を shots に足す。 */
export interface Shooter {
  /** 撃った弾の記録。撃った順。 */
  readonly shots: readonly ShotRecord[];
  /** 1 ステップ進める。入力を適用したあと（player.fire が更新されたあと）に呼ぶ。 */
  step(world: World, dt: number): void;
}

/**
 * 目の位置から angles の向きに撃った弾の当たり。マップの箱と出現している練習の的のうち、目の位置から最も近いものに当たる。
 * 練習の的に当たったときは target にその識別子を入れる。
 */
export function traceShot(world: World, angles: Angles): Pick<ShotRecord, 'position' | 'deviation' | 'target'> {
  const { player } = world;
  const hit = raycastScene(player.position, directionFromAngles(angles), world.boxes, world.targets.visible);
  if (!hit) return { position: null, deviation: null };
  const deviation = angularDeviation(player.position, hit.position, world.center);
  return hit.target ? { position: hit.position, deviation, target: hit.target.id } : { position: hit.position, deviation };
}

/**
 * 武器の発射・リコイル・当たり判定（docs/spec/weapons.md）。Simulation のステップごとの処理として step を呼ぶ。
 * リコイルの累積は Player の recoilOffset に持つ。
 */
export class Gun implements Shooter {
  readonly weapon: WeaponData;
  /** 撃った弾の記録。撃った順。 */
  readonly shots: ShotRecord[] = [];
  private readonly random: Random;
  private readonly interval: number;
  private ammoLeft: number;
  /** 次に使う pattern の添字。 */
  private patternIndex = 0;
  private wasPressed = false;
  /** 撃ち続けている間の、押し始めのステップの時刻と、その押下で撃った発数。 */
  private burst: { start: number; count: number } | undefined;
  /** 戻りの途中なら、撃ち終わり時点の累積と経過時間。 */
  private recovery: { from: Angles; elapsed: number } | undefined;
  private steps = 0;

  constructor(weapon: WeaponData, random: Random) {
    this.weapon = weapon;
    this.random = random;
    this.interval = fireInterval(weapon);
    this.ammoLeft = weapon.magSize;
  }

  /** 残弾。 */
  get ammo(): number {
    return this.ammoLeft;
  }

  /** 撃ち続けているか（fire を押していて、残弾がある）。 */
  get firing(): boolean {
    return this.burst !== undefined;
  }

  /** 次の発が pattern の何発目（1 始まり）か。 */
  get nextPatternShot(): number {
    return this.patternIndex + 1;
  }

  /** 1 ステップ進める。入力を適用したあと（player.fire が更新されたあと）に呼ぶ。 */
  step(world: World, dt: number): void {
    const player = world.player;
    const start = this.steps * dt;
    const end = (this.steps + 1) * dt;
    this.steps += 1;

    if (this.recovery) this.advanceRecovery(world, dt);

    const pressedNow = player.fire && !this.wasPressed;
    this.wasPressed = player.fire;

    if (pressedNow) {
      // 残弾が 0 のときに押し直すと装弾数に戻る（リロードの時間は扱わない）。新しいマガジンはパターンの 1 発目から。
      if (this.ammoLeft === 0) {
        this.ammoLeft = this.weapon.magSize;
        this.patternIndex = 0;
      }
      this.burst = { start, count: 0 };
      this.recovery = undefined;
    }

    if (!this.burst) return;
    if (!player.fire) {
      this.endBurst(world);
      return;
    }
    // 押し始めの時刻から発射間隔ごとの時刻のうち、このステップ [start, end) に入るものを撃つ。
    // 時刻は押し始めからの発数で求めるので、ステップの刻みとの端数は次の発に持ち越される。
    while (this.ammoLeft > 0 && this.burst.start + this.burst.count * this.interval < end - EPSILON) {
      this.shoot(world, this.burst.start + this.burst.count * this.interval);
      this.burst.count += 1;
    }
    if (this.ammoLeft === 0) this.endBurst(world);
  }

  private shoot(world: World, time: number): void {
    const player = world.player;
    const kick = this.weapon.pattern[this.patternIndex] ?? { dx: 0, dy: 0 };
    addRecoilOffset(player, { yaw: kick.dx, pitch: kick.dy });
    const patternShot = this.patternIndex + 1;
    this.patternIndex += 1;
    this.ammoLeft -= 1;

    const r = this.weapon.randomness;
    const spread: Angles = r > 0 ? { yaw: (this.random.next() * 2 - 1) * r, pitch: (this.random.next() * 2 - 1) * r } : { yaw: 0, pitch: 0 };
    const angles = addAngles(viewAngles(player), spread);
    this.shots.push({ shot: this.shots.length + 1, patternShot, time, angles, ...traceShot(world, angles) });
  }

  /** 撃ち終わり（fire を離した、または撃ち切った）。ここから戻りの時間をかけて累積を 0 に戻す。 */
  private endBurst(world: World): void {
    this.burst = undefined;
    this.recovery = { from: world.player.recoilOffset, elapsed: 0 };
  }

  /** 累積を撃ち終わり時点の値から一定の速さで 0 に近づける。戻りきったらパターンを 1 発目に戻す。 */
  private advanceRecovery(world: World, dt: number): void {
    const recovery = this.recovery;
    if (!recovery) return;
    recovery.elapsed += dt;
    if (recovery.elapsed >= RECOIL_RECOVERY_TIME - EPSILON) {
      world.player.recoilOffset = { yaw: 0, pitch: 0 };
      this.patternIndex = 0;
      this.recovery = undefined;
      return;
    }
    const remaining = 1 - recovery.elapsed / RECOIL_RECOVERY_TIME;
    world.player.recoilOffset = { yaw: recovery.from.yaw * remaining, pitch: recovery.from.pitch * remaining };
  }
}
