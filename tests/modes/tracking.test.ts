// 追いエイムのモード（docs/spec/modes.md「追いエイム」）を、ブラウザなしで PracticeSession から確かめる。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRandom } from '../../src/core/random';
import { RecordingInput } from '../../src/input/recording';
import { modes } from '../../src/modes/registry';
import { PracticeSession, replayPracticeSession } from '../../src/modes/session';
import { ON_TARGET_RATE_METRIC, SPEED_OPTION, TRACKING_TARGET_ID, trackingScoring, trackingSpeed } from '../../src/modes/tracking';
import { modeUsesDirectionSound, modeUsesWeakSections, modeUsesWeapon, type TrainingMode } from '../../src/modes/types';
import { anglesToPoint } from '../../src/sim/hit';
import { parseMap, type MapData } from '../../src/sim/map';
import { HUMANOID_DEPTH, HUMANOID_WIDTH, humanoidParts } from '../../src/sim/humanoid';
import { createTrackingMotion, TRACKING_DURATION, type TrackingMotion } from '../../src/sim/tracking';
import type { PracticeTargetSpec, PracticeTargets } from '../../src/sim/targets';
import { vec3, type Vec3 } from '../../src/sim/vec3';
import { parseWeapon, type WeaponData } from '../../src/sim/weapon';
import { createWorld } from '../../src/sim/world';

const DATA = resolve(__dirname, '../../src/data');
const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(DATA, path), 'utf8'));

function rangeMap(): MapData {
  const parsed = parseMap(readJson('maps/range.json'));
  if (!parsed.ok) throw new Error('マップを読めない');
  return parsed.map;
}

function lstar(): WeaponData {
  const parsed = parseWeapon(readJson('weapons/lstar.json'));
  if (!parsed.ok) throw new Error('武器を読めない');
  return parsed.weapon;
}

function modeById(id: string): TrainingMode {
  const found = modes.find((m) => m.id === id);
  if (!found) throw new Error(`モード ${id} がない`);
  return found;
}

const SEED = 11;

/** 練習の種と速さから、モードが setup で決める的の動きを同じように求める（setup は練習の乱数を最初に引く）。 */
function expectedMotion(map: MapData, speed: string, seed = SEED): TrackingMotion {
  return createTrackingMotion(createRandom(seed), { eye: map.spawn.position, aim: map.spawn.aim, speed: trackingSpeed(speed) });
}

interface RunOptions {
  readonly modeId?: 'tracking' | 'tracking-recoil';
  readonly speed?: string;
  readonly seed?: number;
  /** ステップの終わりの時刻 t に、照準を向ける向き（利用者の照準 + リコイルのオフセット）。undefined なら照準を動かさない。 */
  readonly aim?: (t: number, motion: TrackingMotion) => { yaw: number; pitch: number } | undefined;
  /** ステップの開始の時刻 t に、fire を押しているか。 */
  readonly fire?: (t: number) => boolean;
  /** 進める秒数。省くと練習が終わるまで。 */
  readonly seconds?: number;
}

function run(options: RunOptions = {}) {
  const map = rangeMap();
  const modeId = options.modeId ?? 'tracking';
  const speed = options.speed ?? 'normal';
  const seed = options.seed ?? SEED;
  const mode = modeById(modeId);
  const world = createWorld(map);
  const input = new RecordingInput(seed);
  const weapon = modeUsesWeapon(mode) ? lstar() : undefined;
  const session = new PracticeSession<WeaponData | undefined>({ world, weapon, mode, input, seed, options: { speed } });
  const motion = expectedMotion(map, speed, seed);
  const offsets: { yaw: number; pitch: number }[] = [];
  let fired = false;
  const maxSteps = Math.round((options.seconds ?? TRACKING_DURATION + 1) / session.sim.dt);
  for (let i = 0; i < maxSteps && !session.ended; i += 1) {
    const start = session.sim.time;
    const end = start + session.sim.dt;
    const fire = options.fire?.(start) ?? false;
    if (fire !== fired) {
      input.push(start, { type: 'fire', pressed: fire });
      fired = fire;
    }
    const want = options.aim?.(end, motion);
    if (want) {
      // 照準の向きは利用者の照準 + リコイルのオフセット。このステップで足されるリコイルは読めないので、直前のオフセットで合わせる。
      const { aim, recoilOffset } = world.player;
      input.push(start, { type: 'look', yaw: want.yaw - recoilOffset.yaw - aim.yaw, pitch: want.pitch - recoilOffset.pitch - aim.pitch });
    }
    session.step();
    offsets.push(world.player.recoilOffset);
  }
  return { session, world, motion, offsets, input, map, mode, weapon };
}

/** 的の中心に向ける。 */
const atCenter = (map: MapData) => (t: number, motion: TrackingMotion) => anglesToPoint(map.spawn.position, motion.positionAt(t));

describe('追いエイムのモードの登録', () => {
  it('追いエイムは武器を使わず、追いエイム＋リコイルは武器を使い、どちらも速さの選択肢（既定はふつう）と 20 秒の制限時間を持つ', () => {
    const tracking = modeById('tracking');
    const recoil = modeById('tracking-recoil');
    expect(modeUsesWeapon(tracking)).toBe(false);
    expect(modeUsesWeapon(recoil)).toBe(true);
    for (const mode of [tracking, recoil]) {
      expect(mode.category).toBe('aim');
      expect(mode.timeLimit).toBe(20);
      expect(mode.options).toEqual([SPEED_OPTION]);
      expect(mode.options?.[0]?.choices.map((c) => [c.id, c.name.ja])).toEqual([
        ['slow', '遅い'],
        ['normal', 'ふつう'],
        ['fast', '速い'],
      ]);
      expect(mode.options?.[0]?.defaultChoice).toBe('normal');
      expect(mode.scoring?.compare).toBe(ON_TARGET_RATE_METRIC);
      expect(mode.correctionPanel).toBeUndefined();
      expect(mode.ghost).toBeUndefined();
      // MODE-43: 向きの音・苦手な区間を使わない。
      expect(modeUsesDirectionSound(mode)).toBe(false);
      expect(modeUsesWeakSections(mode)).toBe(false);
    }
    expect(recoil.refillOnRelease).toBe(true);
  });

  it('速さの id の的の速さは毎秒 1.5・3.0・4.5 メートルで、知らない id はふつう', () => {
    expect(['slow', 'normal', 'fast', 'x', undefined].map(trackingSpeed)).toEqual([1.5, 3.0, 4.5, 3.0, 3.0]);
  });
});

describe('追いエイムの練習', () => {
  it('的は縮尺 1 の人形で、練習のあいだずっと出現し、照準が乗ると違う色にする的', () => {
    const { session } = run({ seconds: 1 });
    const target = session.world.targets.get(TRACKING_TARGET_ID)!;
    expect(target.parts).toEqual(humanoidParts(1));
    expect(target.visible).toBe(true);
    expect(target.highlightAimed).toBe(true);
  });

  it('MODE-36: 撃たなくても 20 秒たつまで終わらず、20 秒たったステップで終わる', () => {
    const { session } = run({ seconds: 19.99 });
    expect(session.ended).toBe(false);
    session.step();
    expect(session.ended).toBe(true);
    expect(session.result!.endReason).toBe('time');
    expect(session.result!.duration).toBeCloseTo(20, 9);
  });

  it('MODE-36: fire を押して離し、2 秒以上たっても終わらない', () => {
    const { session } = run({ seconds: 5, fire: (t) => t >= 0.5 && t < 0.6 });
    expect(session.shots).toHaveLength(1);
    expect(session.ended).toBe(false);
  });

  it('MODE-37: 同じ種・同じ速さなら、各ステップの的の中心の位置が 2 回で一致し、モードの結果の切り返しの時刻も一致する', () => {
    const positions = (seed: number) => {
      const map = rangeMap();
      const world = createWorld(map);
      const session = new PracticeSession({ world, weapon: undefined, mode: modeById('tracking'), input: new RecordingInput(seed), seed, options: { speed: 'normal' } });
      const list = [];
      while (!session.ended) {
        session.step();
        list.push(world.targets.get(TRACKING_TARGET_ID)!.center);
      }
      return { list, reversals: session.result!.modeResult.reversals };
    };
    const a = positions(5);
    const b = positions(5);
    expect(a.list).toEqual(b.list);
    expect(a.reversals).toEqual(b.reversals);
  });

  it('MODE-38: 0.4 秒進めると、遅い・ふつう・速いで基準の点から 0.6・1.2・1.8 メートル動いている', () => {
    const moved = ['slow', 'normal', 'fast'].map((speed) => {
      const { session, motion } = run({ speed, seconds: 0.4 });
      const c = session.world.targets.get(TRACKING_TARGET_ID)!.center;
      return Math.hypot(c.x - motion.base.x, c.z - motion.base.z);
    });
    expect(moved[0]).toBeCloseTo(0.6, 6);
    expect(moved[1]).toBeCloseTo(1.2, 6);
    expect(moved[2]).toBeCloseTo(1.8, 6);
  });

  it('開始時の照準は的の中心（基準の点）を向いていて、選んだ速さが練習の結果に入る', () => {
    const { session, map } = run({ speed: 'fast', seconds: TRACKING_DURATION });
    const base = expectedMotion(map, 'fast').base;
    expect(anglesToPoint(map.spawn.position, base).yaw).toBeCloseTo(map.spawn.aim.yaw, 9);
    expect(session.result!.options).toEqual([{ id: 'fast', name: { ja: '速い', en: 'Fast' }, optionId: 'speed', label: { ja: '速さ', en: 'Speed' } }]);
    expect(session.options[0]?.choice.id).toBe('fast');
  });

  it('選択肢にない速さを渡したときは、既定の「ふつう」で練習する', () => {
    const world = createWorld(rangeMap());
    const session = new PracticeSession({ world, weapon: undefined, mode: modeById('tracking'), input: new RecordingInput(1), seed: 1, options: { speed: 'warp' } });
    expect(session.options[0]?.choice.id).toBe('normal');
  });

  it('MODE-41: 追いエイム（リコイルなし）で fire を押し続けても、照準のリコイルのオフセットは 0 のままで、弾は 1 発', () => {
    const { session, offsets } = run({ fire: () => true });
    expect(offsets.every((o) => o.yaw === 0 && o.pitch === 0)).toBe(true);
    expect(session.gun).toBeUndefined();
    expect(session.shots).toHaveLength(1);
    expect(session.result!.weapon).toBeUndefined();
  });

  it('MODE-42: 追いエイム＋リコイルで fire を押し続けると、リコイルがかかり、撃ち切っても終わらずに残弾 0 のまま撃たない', () => {
    const weapon = lstar();
    const { session, offsets } = run({ modeId: 'tracking-recoil', fire: (t) => t < 5, seconds: 5 });
    expect(offsets.some((o) => o.pitch !== 0)).toBe(true);
    expect(session.ended).toBe(false);
    expect(session.gun!.ammo).toBe(0);
    expect(session.shots).toHaveLength(weapon.magSize);
  });

  it('MODE-42: 撃ち切ったあと fire を離すと残弾が装弾数に戻り、押し直すとパターンの 1 発目から撃て、20 秒で終わる', () => {
    const weapon = lstar();
    const { session } = run({ modeId: 'tracking-recoil', fire: (t) => t < 4 || (t >= 4.2 && t < 4.5) });
    expect(session.ended).toBe(true);
    expect(session.result!.endReason).toBe('time');
    const refilled = session.shots.slice(weapon.magSize);
    expect(refilled.length).toBeGreaterThan(0);
    expect(refilled[0]!.patternShot).toBe(1);
    expect(session.gun!.ammo).toBe(weapon.magSize - refilled.length);
  });

  it('撃ち切る前に fire を離しても残弾は戻らず、離して 2 秒以上たっても終わらない', () => {
    const { session } = run({ modeId: 'tracking-recoil', fire: (t) => t < 0.3, seconds: 3 });
    expect(session.gun!.ammo).toBe(lstar().magSize - session.shots.length);
    expect(session.ended).toBe(false);
  });

  it('入力の記録を同じモード・速さ・武器で再生すると、的の動き・照準と的の当たり・結果が同じになる', () => {
    const { session, input, mode, weapon } = run({ modeId: 'tracking-recoil', speed: 'slow', aim: atCenter(rangeMap()), fire: (t) => t > 1 && t < 3 });
    const replayed = replayPracticeSession<WeaponData | undefined>(input.recording(), { world: createWorld(rangeMap()), weapon, mode, options: { speed: 'slow' } });
    expect(replayed.result!.modeResult).toEqual(session.result!.modeResult);
    expect(replayed.shots).toEqual(session.shots);
  });
});

describe('追いエイムの採点（練習から）', () => {
  const score = (result: NonNullable<ReturnType<typeof run>['session']['result']>, withShots = false) =>
    trackingScoring(withShots).score({ shots: result.shots, duration: result.duration, modeResult: result.modeResult });

  it('SCO-45: 各ステップの照準を的の中心に向け続けると、乗っていた割合 100%・外していたときのズレ「なし」・乗り直すまでの時間 0 秒', () => {
    const { session } = run({ aim: atCenter(rangeMap()) });
    const s = score(session.result!);
    expect(s.value).toBe(100);
    expect(s.metrics).toEqual([
      { label: '乗っていた割合', value: '100.0%' },
      { label: '外していたときのズレ', value: 'なし' },
      { label: '乗り直すまでの時間', value: '0.00 秒' },
    ]);
    expect(s.fields).toEqual({ reacquireTime: 0 });
  });

  it('MODE-40: 照準を的の中心に向けたステップでは乗っていて、的の幅より大きく外したステップでは乗っていない', () => {
    const map = rangeMap();
    const aim = (t: number, motion: TrackingMotion) => {
      const a = anglesToPoint(map.spawn.position, motion.positionAt(t));
      return t > 1 && t < 1.5 ? { ...a, yaw: a.yaw + 10 } : a;
    };
    const { session } = run({ aim, seconds: 1 });
    expect(session.world.targets.isAimed(TRACKING_TARGET_ID)).toBe(true);
    for (let i = 0; i < 30; i += 1) session.step();
    expect(session.world.targets.aimed).toBeUndefined();
  });

  it('MODE-59: 照準を人形の胴の中心に向け続けると乗っていた割合が 100%、人形の幅だけ左右にずらし続けると（肩の外側から幅の半分外）0%', () => {
    const map = rangeMap();
    const eye = map.spawn.position;
    const at = (dx: number) => (t: number, motion: TrackingMotion) => {
      const c = motion.positionAt(t);
      return anglesToPoint(eye, vec3(c.x + dx, c.y, c.z));
    };
    expect(score(run({ aim: at(0) }).session.result!).value).toBe(100);
    for (const dx of [HUMANOID_WIDTH, -HUMANOID_WIDTH]) expect(score(run({ aim: at(dx) }).session.result!).value).toBe(0);
  });

  it('ARC-63: 乗っているかは部分の箱の和で決まり、脇の下の空き（胴の右端と右腕の左端のあいだの中央）に向けたステップは、空きが目の位置から見通せるあいだ乗っていない', () => {
    const map = rangeMap();
    const eye = map.spawn.position;
    // 脇の下の空きは幅 0.04 メートル、奥行き 0.25 メートル。視線が斜めになると側面で塞がるので、見通せるステップだけを数える。
    const gapX = (0.25 + 0.29) / 2;
    const seeThrough = (c: Vec3) => (Math.abs(c.x + gapX - eye.x) / Math.abs(c.z - eye.z)) * (HUMANOID_DEPTH / 2) < 0.02 - 1e-6;
    const { session, motion } = run({ aim: (t, m) => {
      const c = m.positionAt(t);
      return anglesToPoint(eye, vec3(c.x + gapX, c.y, c.z));
    } });
    const steps = session.result!.modeResult.steps as { on: boolean }[];
    const open = steps.filter((_, k) => seeThrough(motion.positionAt((k + 1) * session.sim.dt)));
    expect(open.length).toBeGreaterThan(60);
    expect(open.every((s) => !s.on)).toBe(true);
  });

  it('MODE-60: 同じ種・同じ速さなら、的を人形にしても、人形の中心と同じ位置の 1 つの箱にしても、的の中心の位置と切り返しの時刻の列が一致する', () => {
    const centers = (box: boolean) => {
      const mode = modeById('tracking');
      // 1 つの箱にする方は、モードが足す的の形だけを差し替える（動きの関数と識別子はモードのまま）。
      const boxMode: TrainingMode = {
        ...mode,
        setup(context) {
          const targets = context.targets as PracticeTargets;
          const add = targets.add.bind(targets);
          targets.add = (spec: PracticeTargetSpec) => add({ ...spec, parts: undefined, size: vec3(0.5, 1.8, 0.25) });
          try {
            mode.setup(context);
          } finally {
            targets.add = add;
          }
        },
      };
      const map = rangeMap();
      const world = createWorld(map);
      const session = new PracticeSession({ world, weapon: undefined, mode: box ? boxMode : mode, input: new RecordingInput(SEED), seed: SEED, options: { speed: 'normal' } });
      const seen: Vec3[] = [];
      while (!session.ended) {
        session.step();
        seen.push(world.targets.get(TRACKING_TARGET_ID)!.center);
      }
      expect(world.targets.get(TRACKING_TARGET_ID)!.parts).toHaveLength(box ? 1 : 6);
      return { seen, reversals: session.result!.modeResult.reversals };
    };
    const dummy = centers(false);
    const box = centers(true);
    expect(box.seen).toHaveLength(Math.round(TRACKING_DURATION * 120));
    expect(box.seen).toEqual(dummy.seen);
    expect(box.reversals).toEqual(dummy.reversals);
  });

  it('SCO-46: 照準を開始時の向きから動かさないと、乗っていた割合が 100% より小さく、外していたときのズレが 0 より大きい', () => {
    const { session } = run();
    const s = score(session.result!);
    expect(s.value!).toBeLessThan(100);
    expect(s.value!).toBeGreaterThan(0);
    expect(s.fields!.offTargetError).toBeGreaterThan(0);
  });

  it('SCO-47: 前半 10 秒だけ的の中心に向けると、乗っていた割合が 50%（差が 1 ステップ分以内）', () => {
    const map = rangeMap();
    const aim = (t: number, motion: TrackingMotion) => {
      const a = anglesToPoint(map.spawn.position, motion.positionAt(t));
      return t <= 10 + 1e-9 ? a : { yaw: a.yaw + 30, pitch: 0 };
    };
    const { session } = run({ aim });
    const steps = session.result!.duration / session.sim.dt;
    expect(Math.abs(score(session.result!).value! - 50)).toBeLessThanOrEqual(100 / steps + 1e-9);
  });

  it('SCO-48: 各切り返しの時刻から 0.3 秒だけ照準を外すと、乗り直すまでの時間が約 0.3 秒', () => {
    const map = rangeMap();
    // 練習の終わりの 0.5 秒前より後に切り返しがない種を選ぶ。
    const seed = Array.from({ length: 50 }, (_, i) => i + 1).find((s) => expectedMotion(map, 'normal', s).reversals.every((r) => r.time < TRACKING_DURATION - 0.5))!;
    const reversals = expectedMotion(map, 'normal', seed).reversals.map((r) => r.time);
    const aim = (t: number, motion: TrackingMotion) => {
      const a = anglesToPoint(map.spawn.position, motion.positionAt(t));
      return reversals.some((r) => t > r && t <= r + 0.3) ? { ...a, yaw: a.yaw + 10 } : a;
    };
    const { session } = run({ aim, seed });
    const value = session.result!.modeResult.reversals as number[];
    expect(value).toEqual(reversals);
    const reacquire = score(session.result!).fields!.reacquireTime!;
    expect(Math.abs(reacquire - 0.3)).toBeLessThanOrEqual(session.sim.dt + 1e-9);
  });

  it('SCO-53: 追いエイム＋リコイルで的の中心に向けて fire を押し続けると、命中率（練習の的に当たった弾の割合）と撃った弾数が出る', () => {
    const { session } = run({ modeId: 'tracking-recoil', aim: atCenter(rangeMap()), fire: () => true });
    const s = score(session.result!, true);
    const shots = session.result!.shots;
    const hits = shots.filter((x) => x.target === TRACKING_TARGET_ID).length;
    expect(shots.length).toBeGreaterThan(0);
    expect(hits).toBeGreaterThan(0);
    expect(s.fields!.shots).toBe(shots.length);
    expect(s.fields!.hitRate).toBeCloseTo((hits / shots.length) * 100, 9);
    expect(s.metrics.map((m) => m.label)).toEqual(['乗っていた割合', '外していたときのズレ', '乗り直すまでの時間', '命中率', '撃った弾数']);
  });

  it('SCO-54: 追いエイム（リコイルなし）では命中率と撃った弾数が出ず、fire を押しても乗っていた割合は押さないときと同じ', () => {
    const tracking = modeById('tracking');
    const pressed = run({ fire: (t) => Math.floor(t) % 3 === 0 });
    const released = run();
    expect(pressed.session.shots.length).toBeGreaterThan(1);
    const a = tracking.scoring!.score({ shots: pressed.session.shots, duration: 20, modeResult: pressed.session.result!.modeResult });
    const b = tracking.scoring!.score({ shots: released.session.shots, duration: 20, modeResult: released.session.result!.modeResult });
    expect(a.value).toBe(b.value);
    expect(a.metrics.map((m) => m.label)).not.toContain('命中率');
    expect(a.metrics.map((m) => m.label)).not.toContain('撃った弾数');
    expect(Object.keys(a.fields ?? {})).not.toContain('shots');
  });

  it('乗っていた割合は 0〜100 の数だけをとりうる値とし、大きいほど良い', () => {
    expect(ON_TARGET_RATE_METRIC.better).toBe('higher');
    expect([0, 55, 100, -1, 100.5].map((v) => ON_TARGET_RATE_METRIC.valid!(v))).toEqual([true, true, true, false, false]);
    expect(ON_TARGET_RATE_METRIC.format(72)).toBe('72.0%');
  });

  it('結果の形が合わないときは、乗っていた割合を「なし」にする', () => {
    expect(trackingScoring(false).score({ shots: [], duration: 20, modeResult: {} }).value).toBeNull();
  });
});
