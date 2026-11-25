import { addAngles, type Angles } from './angles';
import type { Vec3 } from './vec3';

/**
 * プレイヤーの状態。MVP は「立ち止まって撃つ」だけで、将来の移動の状態はここに足す。
 */
export type PlayerState = { kind: 'standing' };

export interface Player {
  /** 目の位置（メートル）。 */
  position: Vec3;
  /** 利用者の照準。入力だけが書き換える。 */
  aim: Angles;
  /** リコイルによる照準のズレ。利用者の入力はこれを書き換えない。 */
  recoilOffset: Angles;
  fire: boolean;
  ads: boolean;
  state: PlayerState;
}

export function createPlayer(position: Vec3, aim: Angles): Player {
  return {
    position,
    aim: addAngles(aim, { yaw: 0, pitch: 0 }),
    recoilOffset: { yaw: 0, pitch: 0 },
    fire: false,
    ads: false,
    state: { kind: 'standing' },
  };
}

/** 照準の向き = 利用者の照準 + リコイルのオフセット。 */
export function viewAngles(player: Readonly<Player>): Angles {
  return addAngles(player.aim, player.recoilOffset);
}

/** 利用者の照準を動かす（look の入力）。 */
export function applyLook(player: Player, delta: Angles): void {
  player.aim = addAngles(player.aim, delta);
}

/** リコイルのオフセットを足す。利用者の照準は変えない。 */
export function addRecoilOffset(player: Player, delta: Angles): void {
  player.recoilOffset = {
    yaw: player.recoilOffset.yaw + delta.yaw,
    pitch: player.recoilOffset.pitch + delta.pitch,
  };
}
