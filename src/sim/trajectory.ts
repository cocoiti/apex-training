import { DEFAULT_FIXED_STEP } from '../core/loop';
import { createRandom } from '../core/random';
import type { InputRecording } from '../input/recording';
import { inputFromTimedActions } from '../input/queue';
import { normalizeYaw, type Angles } from './angles';
import { Gun, type ShotRecord } from './gun';
import { createPlayer } from './player';
import { applyActions } from './simulation';
import { vec3 } from './vec3';
import { idealCorrectionRate, type WeaponData } from './weapon';
import type { World } from './world';

/** 照準の軌道の 1 点。時刻（練習の開始からの秒）と、その時刻の利用者の照準（度）。リコイルのオフセットは含まない。 */
export interface AimPoint {
  readonly time: number;
  readonly yaw: number;
  readonly pitch: number;
}

/**
 * 入力の記録と開始時の照準から照準の軌道を取り出す（docs/spec/input.md「照準の軌道」）。
 * 時刻 0 の開始時の照準から始め、固定ステップの終わりごとに 1 点ずつ、記録の最後のアクションを消費するステップまで続く。
 * look の消費とピッチの範囲・ヨーの正規化は Simulation と同じ applyActions で行う。
 */
export function aimTrajectory(recording: Pick<InputRecording, 'actions'>, start: Angles, dt = DEFAULT_FIXED_STEP): AimPoint[] {
  const player = createPlayer(vec3(0, 0, 0), start);
  const points: AimPoint[] = [{ time: 0, yaw: player.aim.yaw, pitch: player.aim.pitch }];
  const input = inputFromTimedActions(recording.actions);
  // Simulation と同じく、ステップ n は時刻が (n + 1) × dt 未満の入力を消費し、時刻はステップの番号から求める。
  for (let steps = 1; input.size > 0; steps += 1) {
    const end = steps * dt;
    applyActions(player, input.take(end));
    points.push({ time: end, yaw: player.aim.yaw, pitch: player.aim.pitch });
  }
  return points;
}

/** 発射の時刻を、その発を撃つステップの番号に丸めるときの許容幅（秒）。Gun と同じ。 */
const SHOT_EPSILON = 1e-9;

/**
 * 各弾の発射時の利用者の照準を、開始時の照準からのヨー・ピッチ（度）で撃った順に返す（docs/spec/scoring.md「リザルト画面」）。
 * 時刻 t の弾はステップ ⌊t ÷ dt⌋ で撃たれ、そのステップの入力を適用したあとの照準（軌道のそのステップの終わりの点）で撃つ。
 * 記録の最後のアクションのあとに撃った弾は、軌道の最後の点の照準で撃ったものとする。
 */
export function aimAtShots(
  recording: Pick<InputRecording, 'actions'>,
  shots: readonly Pick<ShotRecord, 'time'>[],
  start: Angles,
  dt = DEFAULT_FIXED_STEP,
): Angles[] {
  const points = aimTrajectory(recording, start, dt);
  return shots.map(({ time }) => {
    const index = Math.min(Math.floor((time + SHOT_EPSILON) / dt) + 1, points.length - 1);
    const point = points[index] ?? points[points.length - 1] ?? { yaw: start.yaw, pitch: start.pitch };
    return { yaw: normalizeYaw(point.yaw - start.yaw), pitch: point.pitch - start.pitch };
  });
}

/** 回転速度の推移の 1 点。固定ステップ 1 つ分。 */
export interface LookRatePoint {
  /** そのステップの開始の時刻（練習の開始からの秒）。 */
  readonly time: number;
  /** そのステップの入力を適用したあとの ADS の状態（記録の ads から決める）。 */
  readonly ads: boolean;
  /** 自分の回転速度。そのステップの look の角度の合計 ÷ ステップの長さ（度/秒）。 */
  readonly rate: Angles;
  /** 理想の補正速度（度/秒）。そのステップの開始の時点の fire の状態と次に撃つ弾から求める。 */
  readonly ideal: Angles;
}

/**
 * 入力の記録を再生し、固定ステップごとの自分の回転速度と理想の補正速度を求める（docs/spec/pad.md「リザルトの入力推移のグラフ」）。
 * 理想の補正速度は、そのステップの入力を適用する前の状態（直前のステップの終わり）で求める。練習中のガイドがそのステップの
 * スティックの値を読むときに表示している理想の位置と同じものにするため。照準の軌道と同じく、記録の最後のアクションを消費するステップまで続く。
 * 次に撃つ弾は Gun で再生して数える。弾の当たりとブレは使わないので、箱のない World と固定の種の乱数で進める。
 */
export function lookRateTrace(
  recording: Pick<InputRecording, 'actions'>,
  weapon: WeaponData,
  dt = DEFAULT_FIXED_STEP,
): LookRatePoint[] {
  const center = { yaw: 0, pitch: 0 };
  const world: World = { mapId: '', boxes: [], center, player: createPlayer(vec3(0, 0, 0), center) };
  const gun = new Gun(weapon, createRandom(0));
  const input = inputFromTimedActions(recording.actions);
  const points: LookRatePoint[] = [];
  for (let step = 0; input.size > 0; step += 1) {
    const { player } = world;
    const ideal = idealCorrectionRate(weapon, { fire: player.fire, nextShot: gun.nextPatternShot, ammo: gun.ammo });
    const actions = input.take((step + 1) * dt);
    let yaw = 0;
    let pitch = 0;
    for (const action of actions) {
      if (action.type !== 'look') continue;
      yaw += action.yaw;
      pitch += action.pitch;
    }
    applyActions(player, actions);
    gun.step(world, dt);
    points.push({ time: step * dt, ads: player.ads, rate: { yaw: yaw / dt, pitch: pitch / dt }, ideal });
  }
  return points;
}
