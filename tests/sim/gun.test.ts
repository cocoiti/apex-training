import { describe, expect, it } from 'vitest';
import range from '../../src/data/maps/range.json';
import { FixedStepLoop } from '../../src/core/loop';
import { createRandom } from '../../src/core/random';
import { ManualTimeSource } from '../../src/core/time';
import type { TimedAction } from '../../src/input/actions';
import { inputFromTimedActions } from '../../src/input/queue';
import { Gun, RECOIL_RECOVERY_TIME } from '../../src/sim/gun';
import { Simulation } from '../../src/sim/simulation';
import { vec3 } from '../../src/sim/vec3';
import type { RecoilStep, WeaponData } from '../../src/sim/weapon';
import { createWorld, loadWorld, type World } from '../../src/sim/world';

/** 正面 10 メートルに大きな壁だけがある World。開始時の照準はヨー 0・ピッチ 0。 */
function wallWorld(): World {
  return createWorld({
    id: 'test',
    name: 'test',
    spawn: { position: vec3(0, 1.6, 0), aim: { yaw: 0, pitch: 0 } },
    boxes: [{ id: 'wall', kind: 'wall', center: vec3(0, 1.6, -10.1), size: vec3(100, 100, 0.2) }],
  });
}

function rangeWorld(): World {
  const result = loadWorld(range);
  if (!result.ok) throw new Error('range を読み込めない');
  return result.world;
}

function makeWeapon(extra: Partial<WeaponData> = {}): WeaponData {
  const magSize = extra.magSize ?? 30;
  const pattern: RecoilStep[] = Array.from({ length: magSize }, (_, i) => ({ dx: ((i % 5) - 2) * 0.1, dy: 0.3 + i * 0.01 }));
  return { id: 'w', name: 'w', category: 'AR', version: 'S31-Cipher', source: '仮データ', rpm: 600, magSize, pattern, randomness: 0, measured: true, ...extra };
}

const press = (time: number): TimedAction => ({ time, action: { type: 'fire', pressed: true } });
const release = (time: number): TimedAction => ({ time, action: { type: 'fire', pressed: false } });

function setup(weapon: WeaponData, actions: TimedAction[], world = wallWorld(), seed = 1) {
  const sim = new Simulation(world, inputFromTimedActions(actions));
  const gun = new Gun(weapon, createRandom(seed));
  sim.addStepHook((w, dt) => gun.step(w, dt));
  return { sim, gun, world };
}

/** pattern の 1〜i 発目の合計。 */
function cumulative(pattern: readonly RecoilStep[]) {
  let dx = 0;
  let dy = 0;
  return pattern.map((p) => ({ yaw: (dx += p.dx), pitch: (dy += p.dy) }));
}

describe('発射', () => {
  it.each([60, 144])('WPN-4: rpm 600・装弾数 30 で fire を 1 秒押し続けると、1/%d 秒間隔の描画で 10 発撃たれる', (hz) => {
    const { sim, gun } = setup(makeWeapon({ rpm: 600, magSize: 30 }), [press(0), release(1)]);
    const time = new ManualTimeSource();
    const loop = new FixedStepLoop({ timeSource: time, update: () => sim.step(), render: () => {} });
    for (let i = 0; i < hz * 2; i += 1) {
      time.advance(1 / hz);
      loop.frame();
    }
    expect(gun.shots).toHaveLength(10);
    expect(gun.ammo).toBe(20);
  });

  it('fire を押し始めたステップで 1 発目を撃つ', () => {
    const { sim, gun } = setup(makeWeapon(), [press(0.05)]);
    sim.advance(0.05);
    expect(gun.shots).toHaveLength(0);
    sim.step();
    expect(gun.shots).toHaveLength(1);
  });

  it('発射間隔がステップの倍数でなくても、端数を持ち越して 1 秒あたりの発数がずれない', () => {
    // rpm 900 は 1/15 秒ごと。1/120 秒のステップでは 8 ステップ = 1/15 秒でちょうどだが、rpm 700 は端数が出る。
    const { sim, gun } = setup(makeWeapon({ rpm: 700, magSize: 100 }), [press(0), release(3)]);
    sim.advance(3.5);
    // 0, 60/700, ... のうち 3 秒未満: ceil(3 / (60/700)) = 35 発
    expect(gun.shots).toHaveLength(35);
    gun.shots.forEach((s, i) => expect(s.time).toBeCloseTo((i * 60) / 700, 9));
  });

  it('WPN-5: 装弾数 28 で押し続けると 28 発で止まり、離して押し直すとまた撃てる', () => {
    const { sim, gun } = setup(makeWeapon({ magSize: 28 }), [press(0), release(4), press(4.5), release(4.75)]);
    sim.advance(4);
    expect(gun.shots).toHaveLength(28);
    expect(gun.ammo).toBe(0);
    expect(gun.firing).toBe(false);
    sim.advance(1);
    // 4.5 秒に押し直して装弾数に戻り、4.75 秒に離すまでに 4.5, 4.6, 4.7 の 3 発
    expect(gun.shots).toHaveLength(31);
    expect(gun.ammo).toBe(25);
  });

  it('残弾があるうちに離して押し直すと、残弾から続けて撃つ', () => {
    const { sim, gun } = setup(makeWeapon({ magSize: 30 }), [press(0), release(0.45), press(1), release(1.25)]);
    sim.advance(2);
    expect(gun.shots).toHaveLength(8);
    expect(gun.ammo).toBe(22);
  });
});

describe('リコイル', () => {
  it('WPN-6: randomness 0 で照準を動かさずに撃つと、i 発目は 1〜i 発目の pattern の合計の位置に当たる', () => {
    const weapon = makeWeapon({ magSize: 10 });
    const { sim, gun } = setup(weapon, [press(0)]);
    sim.advance(2);
    expect(gun.shots).toHaveLength(10);
    const expected = cumulative(weapon.pattern);
    gun.shots.forEach((shot, i) => {
      expect(shot.shot).toBe(i + 1);
      expect(shot.deviation?.yaw).toBeCloseTo(expected[i]!.yaw, 9);
      expect(shot.deviation?.pitch).toBeCloseTo(expected[i]!.pitch, 9);
    });
  });

  it('WPN-7: 各発の pattern と逆向きに同じ量だけ照準を動かすと、全弾が中心に当たる', () => {
    const weapon = makeWeapon({ magSize: 10 });
    // i+1 発目は i × 0.1 秒に撃つ。その直前（前のステップ）に i 発目までの分を打ち消しておく。
    const looks: TimedAction[] = weapon.pattern.map((p, i) => ({
      time: i * 0.1 + 0.001,
      action: { type: 'look', yaw: -p.dx, pitch: -p.dy },
    }));
    const { sim, gun } = setup(weapon, [press(0), ...looks]);
    sim.advance(2);
    expect(gun.shots).toHaveLength(10);
    for (const shot of gun.shots) {
      expect(shot.deviation?.yaw).toBeCloseTo(0, 9);
      expect(shot.deviation?.pitch).toBeCloseTo(0, 9);
    }
  });

  it('撃ち終わりから戻りの時間をかけて、一定の速さで累積が 0 に戻る', () => {
    const weapon = makeWeapon({ magSize: 30, pattern: Array.from({ length: 30 }, () => ({ dx: 1, dy: 2 })) });
    const { sim, world } = setup(weapon, [press(0), release(0.25)]); // 0, 0.1, 0.2 の 3 発
    sim.advance(0.25 + 1 / 120); // 離したステップまで
    expect(world.player.recoilOffset).toEqual({ yaw: 3, pitch: 6 });
    sim.advance(RECOIL_RECOVERY_TIME / 2);
    expect(world.player.recoilOffset.yaw).toBeCloseTo(1.5, 9);
    expect(world.player.recoilOffset.pitch).toBeCloseTo(3, 9);
    sim.advance(RECOIL_RECOVERY_TIME / 2);
    expect(world.player.recoilOffset).toEqual({ yaw: 0, pitch: 0 });
  });

  it('WPN-8: 数発撃って離し、戻りの時間より長く待ってから撃つと、1 発目は照準 + pattern[0] に当たる', () => {
    const weapon = makeWeapon({ magSize: 30 });
    const { sim, gun, world } = setup(weapon, [
      press(0),
      release(0.35),
      { time: 0.4, action: { type: 'look', yaw: 2, pitch: -1 } },
      press(0.35 + RECOIL_RECOVERY_TIME + 0.1),
    ]);
    sim.advance(1.5);
    const first = gun.shots[4]!;
    expect(gun.shots.slice(0, 4).map((s) => s.shot)).toEqual([1, 2, 3, 4]);
    expect(first.deviation?.yaw).toBeCloseTo(2 + weapon.pattern[0]!.dx, 9);
    expect(first.deviation?.pitch).toBeCloseTo(-1 + weapon.pattern[0]!.dy, 9);
    expect(world.player.aim).toEqual({ yaw: 2, pitch: -1 });
  });

  it('戻りきる前に撃ち始めると、残っている累積に続けて加え、パターンは続きの発から使う', () => {
    const weapon = makeWeapon({ magSize: 30, pattern: Array.from({ length: 30 }, (_, i) => ({ dx: 0, dy: i + 1 })) });
    // 0, 0.1 の 2 発（累積 3）。0.15 に離し、0.25 に押し直す（戻りは 0.1 秒分 = 2 割）。
    const { sim, gun } = setup(weapon, [press(0), release(0.15), press(0.25)]);
    sim.advance(0.25 + 1 / 120);
    expect(gun.shots).toHaveLength(3);
    // 3 発目は pattern[2]（dy 3）を、0.8 倍に戻った累積 3 × 0.8 = 2.4 に足して 5.4
    expect(gun.shots[2]?.deviation?.pitch).toBeCloseTo(3 * (1 - 0.1 / RECOIL_RECOVERY_TIME) + 3, 6);
    expect(gun.nextPatternShot).toBe(4);
  });

  it('撃ち切ったあとに押し直すと、パターンは 1 発目から始まる', () => {
    const weapon = makeWeapon({ magSize: 3, pattern: [{ dx: 0, dy: 1 }, { dx: 0, dy: 2 }, { dx: 0, dy: 3 }] });
    const { sim, gun } = setup(weapon, [press(0), release(0.3), press(0.35)]);
    sim.advance(0.36);
    expect(gun.shots).toHaveLength(4);
    expect(gun.nextPatternShot).toBe(2);
    expect(gun.shots.map((s) => s.patternShot)).toEqual([1, 2, 3, 1]);
  });

  it('弾の記録の patternShot は使った pattern の発で、戻りきる前の押し直しでは続きの番号、戻りきったあとは 1 から', () => {
    const weapon = makeWeapon({ magSize: 30 });
    // 0, 0.1 の 2 発。0.15 に離して 0.25 に押し直す（戻りの前）と 0.25, 0.35 の 2 発が 3・4 発目。
    // 0.4 に離して 1 秒に押し直す（戻りのあと）と 1, 1.1 の 2 発が 1・2 発目。
    const { sim, gun } = setup(weapon, [press(0), release(0.15), press(0.25), release(0.4), press(1), release(1.15)]);
    sim.advance(1.5);
    expect(gun.shots.map((s) => s.shot)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(gun.shots.map((s) => s.patternShot)).toEqual([1, 2, 3, 4, 1, 2]);
  });
});

describe('ブレ', () => {
  it('WPN-9: 同じ入力と同じ種なら弾痕が一致し、randomness 0 との差は水平・垂直とも randomness 以下', () => {
    const r = 0.2;
    const actions = [press(0), { time: 0.33, action: { type: 'look', yaw: 0.5, pitch: -0.25 } } as TimedAction, release(2)];
    const run = (randomness: number, seed: number) => {
      const { sim, gun } = setup(makeWeapon({ randomness }), actions, wallWorld(), seed);
      sim.advance(2.5);
      return gun.shots;
    };
    const a = run(r, 42);
    const b = run(r, 42);
    const base = run(0, 42);
    expect(a).toEqual(b);
    expect(a).toHaveLength(20);
    expect(a.some((s, i) => s.deviation!.yaw !== base[i]!.deviation!.yaw)).toBe(true);
    a.forEach((shot, i) => {
      expect(Math.abs(shot.deviation!.yaw - base[i]!.deviation!.yaw)).toBeLessThanOrEqual(r + 1e-9);
      expect(Math.abs(shot.deviation!.pitch - base[i]!.deviation!.pitch)).toBeLessThanOrEqual(r + 1e-9);
    });
    expect(run(r, 7)).not.toEqual(a);
  });

  it('ブレはリコイルの累積に残らない', () => {
    const weapon = makeWeapon({ randomness: 0.5 });
    const { sim, world } = setup(weapon, [press(0)]);
    sim.step();
    expect(world.player.recoilOffset).toEqual({ yaw: weapon.pattern[0]!.dx, pitch: weapon.pattern[0]!.dy });
  });
});

describe('当たり判定と弾痕', () => {
  it('WPN-10: range で照準を動かさず、randomness 0・pattern がすべて 0 の武器で撃つと、角度のズレは 0 度', () => {
    const weapon = makeWeapon({ magSize: 5, pattern: Array.from({ length: 5 }, () => ({ dx: 0, dy: 0 })) });
    const { sim, gun } = setup(weapon, [press(0)], rangeWorld());
    sim.advance(1);
    expect(gun.shots).toHaveLength(5);
    for (const shot of gun.shots) {
      expect(shot.position).not.toBeNull();
      expect(shot.deviation?.yaw).toBeCloseTo(0, 12);
      expect(shot.deviation?.pitch).toBeCloseTo(0, 12);
    }
  });

  it('どの箱にも当たらない弾は位置なしの外れとして記録する', () => {
    const { sim, gun } = setup(makeWeapon(), [{ time: 0, action: { type: 'look', yaw: 180, pitch: 0 } }, press(0)]);
    sim.step();
    expect(gun.shots).toHaveLength(1);
    expect(gun.shots[0]?.position).toBeNull();
    expect(gun.shots[0]?.deviation).toBeNull();
  });
});
