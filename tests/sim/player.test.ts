import { describe, expect, it } from 'vitest';
import { addRecoilOffset, applyLook, createPlayer, viewAngles } from '../../src/sim/player';
import { vec3 } from '../../src/sim/vec3';

describe('リコイルのオフセット', () => {
  it('ARC-9: オフセットにピッチ +2 度を加えると照準の向きは利用者の照準より 2 度高く、利用者の照準は変わらない', () => {
    const player = createPlayer(vec3(0, 1.6, 0), { yaw: 0, pitch: 3 });
    addRecoilOffset(player, { yaw: 0, pitch: 2 });
    expect(player.aim.pitch).toBe(3);
    expect(viewAngles(player).pitch).toBe(5);
  });

  it('利用者の入力はオフセットを書き換えない', () => {
    const player = createPlayer(vec3(0, 1.6, 0), { yaw: 0, pitch: 0 });
    addRecoilOffset(player, { yaw: 1, pitch: 2 });
    applyLook(player, { yaw: 5, pitch: -1 });
    expect(player.recoilOffset).toEqual({ yaw: 1, pitch: 2 });
    expect(viewAngles(player)).toEqual({ yaw: 6, pitch: 1 });
  });

  it('プレイヤーは「立ち止まって撃つ」状態で始まる', () => {
    expect(createPlayer(vec3(0, 0, 0), { yaw: 0, pitch: 0 }).state).toEqual({ kind: 'standing' });
  });
});
