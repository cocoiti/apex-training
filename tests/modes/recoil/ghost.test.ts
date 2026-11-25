import { describe, expect, it } from 'vitest';
import type { TimedAction } from '../../../src/input/actions';
import { inputFromTimedActions } from '../../../src/input/queue';
import ghostMode, { ghostAngles } from '../../../src/modes/recoil/ghost';
import { modes } from '../../../src/modes/registry';
import { PracticeSession } from '../../../src/modes/session';
import type { TrainingMode } from '../../../src/modes/types';
import { RECOIL_RECOVERY_TIME } from '../../../src/sim/gun';
import { viewAngles } from '../../../src/sim/player';
import { vec3 } from '../../../src/sim/vec3';
import { idealCorrection, type RecoilStep, type WeaponData } from '../../../src/sim/weapon';
import { createWorld, type World } from '../../../src/sim/world';

/** 正面 10 メートルに大きな壁だけがある World。開始時の照準はヨー 5・ピッチ 2（0 でない値で、開始時の照準が足されることを見る）。 */
function wallWorld(): World {
  return createWorld({
    id: 'test',
    name: 'test',
    spawn: { position: vec3(0, 1.6, 0), aim: { yaw: 5, pitch: 2 } },
    boxes: [{ id: 'wall', kind: 'wall', center: vec3(0, 1.6, -10.1), size: vec3(100, 100, 0.2) }],
  });
}

function makeWeapon(extra: Partial<WeaponData> = {}): WeaponData {
  const magSize = extra.magSize ?? 12;
  const pattern: RecoilStep[] = Array.from({ length: magSize }, (_, i) => ({ dx: ((i % 5) - 2) * 0.1, dy: 0.3 + i * 0.01 }));
  return { id: 'w', name: 'テスト武器', category: 'AR', version: 'v', source: '仮データ', rpm: 600, magSize, pattern, randomness: 0, measured: true, ...extra };
}

const press = (time: number): TimedAction => ({ time, action: { type: 'fire', pressed: true } });
const release = (time: number): TimedAction => ({ time, action: { type: 'fire', pressed: false } });

function session(actions: TimedAction[], weapon = makeWeapon()) {
  return new PracticeSession({ world: wallWorld(), weapon, mode: ghostMode, input: inputFromTimedActions(actions), seed: 1 });
}

function advance(s: PracticeSession, seconds: number): void {
  const count = Math.round(seconds / s.sim.dt);
  for (let i = 0; i < count; i += 1) s.step();
}

/** 開始時の照準 + n 発目（1 始まり）の理想の補正軌道。 */
function expected(weapon: WeaponData, n: number, world: World) {
  const ideal = idealCorrection(weapon)[n - 1];
  if (!ideal) throw new Error('理想の補正軌道がない');
  return { yaw: world.center.yaw + ideal.yaw, pitch: world.center.pitch + ideal.pitch };
}

describe('ゴースト追従のモード', () => {
  it('登録されたモードに入り、パターン観察とセンター維持のあいだに並び、採点する', () => {
    const ids = modes.map((m) => m.id);
    expect(ids.indexOf('pattern')).toBeLessThan(ids.indexOf('ghost'));
    expect(ids.indexOf('ghost')).toBeLessThan(ids.indexOf('center'));
    expect(ghostMode.name).toBe('ゴースト追従');
    expect(ghostMode.result({} as Parameters<TrainingMode['result']>[0]).scored).toBe(true);
  });

  it('ほかのモードはゴーストを持たない', () => {
    for (const id of ['pattern', 'center']) expect(modes.find((m) => m.id === id)?.ghost).toBeUndefined();
    const s = new PracticeSession({
      world: wallWorld(),
      weapon: makeWeapon(),
      mode: modes.find((m) => m.id === 'center') as TrainingMode,
      input: inputFromTimedActions([]),
      seed: 1,
    });
    expect(s.ghost).toBeUndefined();
  });
});

describe('ゴーストの向き', () => {
  it('撃つ前は、開始時の照準 + 1 発目の理想の補正軌道（MODE-12）', () => {
    const weapon = makeWeapon();
    const s = session([]);
    advance(s, 1);
    const ghost = s.ghost;
    expect(ghost?.yaw).toBeCloseTo(expected(weapon, 1, s.world).yaw, 9);
    expect(ghost?.pitch).toBeCloseTo(expected(weapon, 1, s.world).pitch, 9);
  });

  it('i 発目を撃ったステップで i+1 発目の位置に進み、今のリコイルの累積を足す（MODE-3）', () => {
    const weapon = makeWeapon();
    const s = session([press(0)], weapon);
    let checked = 0;
    while (s.gun.ammo > 1) {
      s.step();
      const n = s.gun.shots.length + 1;
      const base = expected(weapon, n, s.world);
      const { recoilOffset } = s.world.player;
      expect(s.ghost?.yaw).toBeCloseTo(base.yaw + recoilOffset.yaw, 9);
      expect(s.ghost?.pitch).toBeCloseTo(base.pitch + recoilOffset.pitch, 9);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('各発をゴーストに重ねて撃つと、randomness 0 の武器では全弾が中心に当たる（MODE-13）', () => {
    const weapon = makeWeapon();
    const s = session([press(0)], weapon);
    // 毎ステップの始めに、照準の向き（利用者の照準 + 累積）をゴーストに合わせる。
    while (!s.ended) {
      const ghost = s.ghost;
      if (ghost) {
        const view = viewAngles(s.world.player);
        s.world.player.aim = { yaw: s.world.player.aim.yaw + ghost.yaw - view.yaw, pitch: s.world.player.aim.pitch + ghost.pitch - view.pitch };
      }
      s.step();
    }
    expect(s.gun.shots).toHaveLength(weapon.magSize);
    for (const shot of s.gun.shots) {
      expect(shot.deviation?.yaw).toBeCloseTo(0, 6);
      expect(shot.deviation?.pitch).toBeCloseTo(0, 6);
    }
  });

  it('1 マガジンを撃ち切ったステップでゴーストが消え、練習が終わる（MODE-14）', () => {
    const s = session([press(0)]);
    while (s.gun.ammo > 0) {
      expect(s.ghost).toBeDefined();
      s.step();
    }
    expect(s.ghost).toBeUndefined();
    expect(s.ended).toBe(true);
    expect(s.result?.modeResult.scored).toBe(true);
  });

  it('離して押し直すまでは次に撃つ発の位置にあり、戻りの時間がたつと 1 発目の位置に戻る（MODE-15）', () => {
    const weapon = makeWeapon();
    const s = session([press(0), release(0.35)], weapon);
    advance(s, 0.4);
    const fired = s.gun.shots.length;
    expect(fired).toBeGreaterThan(1);
    const mid = expected(weapon, fired + 1, s.world);
    expect(s.ghost?.yaw).toBeCloseTo(mid.yaw + s.world.player.recoilOffset.yaw, 9);
    expect(s.ghost?.pitch).toBeCloseTo(mid.pitch + s.world.player.recoilOffset.pitch, 9);
    advance(s, RECOIL_RECOVERY_TIME + 0.1);
    expect(s.ended).toBe(false);
    const first = expected(weapon, 1, s.world);
    expect(s.ghost?.yaw).toBeCloseTo(first.yaw, 9);
    expect(s.ghost?.pitch).toBeCloseTo(first.pitch, 9);
  });

  it('ゴーストを求めても World と武器の状態は変わらない', () => {
    const s = session([press(0)]);
    advance(s, 0.2);
    const before = JSON.stringify({ player: s.world.player, ammo: s.gun.ammo, next: s.gun.nextPatternShot, shots: s.gun.shots });
    for (let i = 0; i < 5; i += 1) void s.ghost;
    void ghostAngles(s.world, s.gun);
    expect(JSON.stringify({ player: s.world.player, ammo: s.gun.ammo, next: s.gun.nextPatternShot, shots: s.gun.shots })).toBe(before);
  });

  it('練習が終わったあとはゴーストを返さない', () => {
    const s = session([press(0), release(0.15)]);
    advance(s, 3);
    expect(s.ended).toBe(true);
    expect(s.gun.ammo).toBeGreaterThan(0);
    expect(s.ghost).toBeUndefined();
  });
});
