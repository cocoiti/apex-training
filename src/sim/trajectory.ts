import { DEFAULT_FIXED_STEP } from '../core/loop';
import type { InputRecording } from '../input/recording';
import { inputFromTimedActions } from '../input/queue';
import type { Angles } from './angles';
import { createPlayer } from './player';
import { applyActions } from './simulation';
import { vec3 } from './vec3';

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
