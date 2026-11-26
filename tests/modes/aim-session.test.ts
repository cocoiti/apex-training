// エイムのモードの土台（docs/spec/architecture.md「練習の的」「照準と的の当たり」「武器を使わない練習」）を、
// ブラウザなしで PracticeSession から確かめる。
import { describe, expect, it } from 'vitest';
import type { TimedAction } from '../../src/input/actions';
import { inputFromTimedActions } from '../../src/input/queue';
import { RecordingInput } from '../../src/input/recording';
import { PracticeSession, replayPracticeSession } from '../../src/modes/session';
import type { ModeContext, TrainingMode } from '../../src/modes/types';
import { anglesToPoint } from '../../src/sim/hit';
import type { Box } from '../../src/sim/map';
import { vec3, type Vec3 } from '../../src/sim/vec3';
import type { RecoilStep, WeaponData } from '../../src/sim/weapon';
import { createWorld, type World } from '../../src/sim/world';
import { aimMode, TARGET_SIZE } from '../helpers/aim-modes';

const EYE = vec3(0, 1.6, 0);
const BACK_WALL: Box = { id: 'back', kind: 'wall', center: vec3(0, 1.6, -30.1), size: vec3(200, 200, 0.2) };

function world(boxes: Box[] = [BACK_WALL]): World {
  return createWorld({ id: 'test', name: 'test', spawn: { position: EYE, aim: { yaw: 0, pitch: 0 } }, boxes });
}

function makeWeapon(extra: Partial<WeaponData> = {}): WeaponData {
  const magSize = extra.magSize ?? 30;
  const pattern: RecoilStep[] = Array.from({ length: magSize }, () => ({ dx: 0.05, dy: 0.3 }));
  return { id: 'w', name: 'テスト武器', category: 'AR', version: 'v', source: '仮データ', rpm: 600, magSize, pattern, randomness: 0.2, measured: true, ...extra };
}

const press = (time: number): TimedAction => ({ time, action: { type: 'fire', pressed: true } });
const release = (time: number): TimedAction => ({ time, action: { type: 'fire', pressed: false } });
/** 照準を now の向きから to の向きへ動かす look。 */
const lookAt = (time: number, from: { yaw: number; pitch: number }, to: { yaw: number; pitch: number }): TimedAction => ({
  time,
  action: { type: 'look', yaw: to.yaw - from.yaw, pitch: to.pitch - from.pitch },
});

function advance(s: PracticeSession<WeaponData | undefined>, seconds: number): void {
  const count = Math.round(seconds / s.sim.dt);
  for (let i = 0; i < count && !s.ended; i += 1) s.step();
}

function weaponless(mode: TrainingMode, actions: TimedAction[] = [], w: World = world()) {
  return new PracticeSession({ world: w, weapon: undefined, mode, input: inputFromTimedActions(actions), seed: 1 });
}

const still = (id: string, position: Vec3, extra: { appearAt?: number; disappearAt?: number } = {}) => (context: ModeContext) =>
  context.targets.add({ id, size: TARGET_SIZE, position, ...extra });

describe('照準と的の当たり', () => {
  const center = vec3(3, 1.6, -10);
  const onTarget = anglesToPoint(EYE, center);

  it('ARC-32: 出現している的の中心に向けたステップでは乗っていて、的の幅より大きくヨーをずらすと乗っていない', () => {
    const s = weaponless(aimMode({ targets: still('t', center) }), [lookAt(0.1, { yaw: 0, pitch: 0 }, onTarget), lookAt(0.3, onTarget, { ...onTarget, yaw: onTarget.yaw + 10 })]);
    advance(s, 0.2);
    expect(s.world.targets.aimed).toBe('t');
    expect(s.world.targets.isAimed('t')).toBe(true);
    advance(s, 0.2);
    expect(s.world.targets.aimed).toBeUndefined();
  });

  it('ARC-32: 出現の時刻より前と消える時刻より後のステップでは、的の位置に向けても乗っていない', () => {
    const s = weaponless(aimMode({ targets: still('t', center, { appearAt: 1, disappearAt: 2 }) }), [lookAt(0, { yaw: 0, pitch: 0 }, onTarget)]);
    const seen: (string | undefined)[] = [];
    for (const until of [0.5, 1.5, 2.5]) {
      while (s.sim.time < until - 1e-9) s.step();
      seen.push(s.world.targets.aimed);
    }
    expect(seen).toEqual([undefined, 't', undefined]);
  });

  it('ARC-33: 的と目のあいだに壁があると、的の中心に向けても乗っておらず、その向きで撃った弾は壁に当たって命中にならない', () => {
    const between: Box = { id: 'between', kind: 'wall', center: vec3(1.5, 1.6, -5), size: vec3(2, 2, 0.2) };
    const s = weaponless(aimMode({ targets: still('t', center) }), [lookAt(0, { yaw: 0, pitch: 0 }, onTarget), press(0.1), release(0.2)], world([between, BACK_WALL]));
    advance(s, 0.3);
    expect(s.world.targets.aimed).toBeUndefined();
    expect(s.shots).toHaveLength(1);
    expect(s.shots[0]!.target).toBeUndefined();
    expect(s.shots[0]!.position!.z).toBeCloseTo(-4.9, 6);
  });

  it('ARC-34: 動いている的の中心に向けて撃つと、弾の記録に的の識別子が入って命中になる', () => {
    // 毎秒 2 メートルで +X へ動く的。0.5 秒のステップでは中心が X = 1（そのステップの終わりの時刻 0.5 + dt で決まる）。
    const moving = (context: ModeContext) => context.targets.add({ id: 'mover', size: TARGET_SIZE, position: (t) => vec3(2 * t, 1.6, -10) });
    const dt = 1 / 120;
    const aim = anglesToPoint(EYE, vec3(2 * (0.5 + dt), 1.6, -10));
    const s = weaponless(aimMode({ targets: moving }), [lookAt(0.5, { yaw: 0, pitch: 0 }, aim), press(0.5), release(0.6)]);
    advance(s, 0.7);
    expect(s.shots).toHaveLength(1);
    expect(s.shots[0]!.target).toBe('mover');
  });

  it('マップの箱に当たった弾は target を持たない', () => {
    const s = weaponless(aimMode(), [press(0), release(0.1)]);
    advance(s, 0.2);
    expect(s.shots).toHaveLength(1);
    expect(s.shots[0]).not.toHaveProperty('target');
    expect(s.shots[0]!.position).not.toBeNull();
  });
});

describe('武器を使わない練習', () => {
  it('ARC-35: fire を 1 秒押し続けても弾は 1 発で、リコイルのオフセットは 0 のまま。3 回押し直すと 3 発', () => {
    const held = weaponless(aimMode(), [press(0), release(1)]);
    const offsets: { yaw: number; pitch: number }[] = [];
    for (let i = 0; i < 150; i += 1) {
      held.step();
      offsets.push(held.world.player.recoilOffset);
    }
    expect(held.shots).toHaveLength(1);
    expect(new Set(offsets.map((o) => `${o.yaw},${o.pitch}`))).toEqual(new Set(['0,0']));
    expect(held.gun).toBeUndefined();

    const taps = weaponless(aimMode(), [press(0), release(0.1), press(0.2), release(0.3), press(0.4), release(0.5)]);
    advance(taps, 1);
    expect(taps.shots.map((s) => s.shot)).toEqual([1, 2, 3]);
    expect(taps.shots.map((s) => s.patternShot)).toEqual([1, 1, 1]);
  });

  it('撃たない時間がたっても終わらず、モードの終わりの条件（制限時間）だけで終わる（MODE-34）', () => {
    const s = weaponless(aimMode({ timeLimit: 10 }), [press(0.5), release(0.6)]);
    advance(s, 5);
    expect(s.ended).toBe(false);
    advance(s, 5);
    expect(s.ended).toBe(true);
    expect(s.result?.endReason).toBe('time');
    expect(s.result?.duration).toBeCloseTo(10, 9);
    expect(s.result?.weapon).toBeUndefined();
    expect(s.result?.shots).toHaveLength(1);
  });

  it('制限時間のない武器を使わないモードは、撃ったあとも時間で終わらない', () => {
    const s = weaponless(aimMode(), [press(0), release(0.1)]);
    advance(s, 30);
    expect(s.ended).toBe(false);
  });

  it('武器を使うモードに武器を渡さないと投げる', () => {
    expect(() => weaponless(aimMode({ usesWeapon: true }))).toThrow();
  });

  it('武器を使わないモードに武器を渡しても、武器は使わない', () => {
    const s = new PracticeSession({ world: world(), weapon: makeWeapon(), mode: aimMode(), input: inputFromTimedActions([press(0)]), seed: 1 });
    advance(s, 1);
    expect(s.gun).toBeUndefined();
    expect(s.shots).toHaveLength(1);
    expect(s.world.player.recoilOffset).toEqual({ yaw: 0, pitch: 0 });
  });
});

describe('武器を使うエイムのモード', () => {
  it('MODE-35: 制限時間 3 秒で、撃ち切る前に 3 秒たつと、残弾が残ったまま終わる', () => {
    const weapon = makeWeapon({ magSize: 60, pattern: Array.from({ length: 60 }, () => ({ dx: 0, dy: 0.1 })), rpm: 600 });
    const s = new PracticeSession({ world: world(), weapon, mode: aimMode({ usesWeapon: true, timeLimit: 3 }), input: inputFromTimedActions([press(0)]), seed: 1 });
    advance(s, 4);
    expect(s.ended).toBe(true);
    expect(s.result?.endReason).toBe('time');
    expect(s.result?.duration).toBeCloseTo(3, 9);
    expect(s.gun.ammo).toBeGreaterThan(0);
    expect(s.result?.weapon).toBe(weapon);
  });

  it('リコイルをかけて撃ち、練習の的に当たった弾は命中になる', () => {
    const s = new PracticeSession({
      world: world(),
      weapon: makeWeapon({ randomness: 0 }),
      mode: aimMode({ usesWeapon: true, targets: still('t', vec3(0, 1.6, -10)) }),
      input: inputFromTimedActions([press(0), release(0.05)]),
      seed: 1,
    });
    advance(s, 0.1);
    expect(s.shots[0]?.target).toBe('t');
    expect(s.world.player.recoilOffset.pitch).toBeGreaterThan(0);
  });
});

describe('乱数で決める的', () => {
  /** 0.5 秒ごとに、種付きの乱数で決めた位置に的を出し、0.4 秒で消す。出現の時刻は乱数で 0〜0.1 秒ずらす。 */
  function randomMode(): TrainingMode & { readonly log: { id: string; appearAt: number; center: Vec3 }[] } {
    const log: { id: string; appearAt: number; center: Vec3 }[] = [];
    let next = 0;
    return {
      ...aimMode({ id: 'random' }),
      log,
      setup() {
        log.length = 0;
        next = 0;
      },
      step(context) {
        if (context.time >= next) {
          const appearAt = next + context.random.next() * 0.1;
          const center = vec3(context.random.next() * 6 - 3, 1 + context.random.next(), -10);
          const id = `t${log.length}`;
          context.targets.add({ id, size: TARGET_SIZE, position: center, appearAt, disappearAt: appearAt + 0.4 });
          log.push({ id, appearAt, center });
          next += 0.5;
        }
        return true;
      },
    };
  }

  const run = (seed: number) => {
    const mode = randomMode();
    const s = new PracticeSession({ world: world(), weapon: undefined, mode, input: inputFromTimedActions([]), seed });
    advance(s, 5);
    return mode.log.map((e) => ({ ...e }));
  };

  it('ARC-31: 同じ種・同じ入力で 2 回 5 秒進めると位置と出現の時刻の列が一致し、違う種では一致しない', () => {
    const first = run(42);
    expect(first.length).toBeGreaterThanOrEqual(9);
    expect(run(42)).toEqual(first);
    expect(run(43)).not.toEqual(first);
  });
});

describe('入力の記録の再生', () => {
  it('ARC-36: 練習の的を置いた練習の記録を再生すると、各ステップの的の位置・出現・乗っているの判定が一致する', () => {
    const trace = (s: PracticeSession<WeaponData | undefined>) => {
      const steps: string[] = [];
      const step = () => {
        s.step();
        steps.push(JSON.stringify({ targets: s.world.targets.all, aimed: s.world.targets.aimed ?? null }));
      };
      return { steps, step };
    };
    const makeMode = () =>
      aimMode({
        targets: (context) => {
          context.targets.add({ id: 'mover', size: TARGET_SIZE, position: (t) => vec3(Math.sin(t) * 3, 1.6, -10), appearAt: 0.2, disappearAt: 1.6 });
          context.targets.add({ id: 'pop', size: TARGET_SIZE, position: vec3(-2, 2, -12), appearAt: 0.5 });
        },
      });
    const input = new RecordingInput(5);
    const original = new PracticeSession({ world: world(), weapon: undefined, mode: makeMode(), input, seed: input.seed });
    const recorded = trace(original);
    for (let i = 0; i < 240; i += 1) {
      input.push(original.sim.time, { type: 'look', yaw: Math.cos(i / 20) * 0.3, pitch: Math.sin(i / 30) * 0.1 });
      if (i % 40 === 0) input.push(original.sim.time, { type: 'fire', pressed: true });
      if (i % 40 === 5) input.push(original.sim.time, { type: 'fire', pressed: false });
      recorded.step();
    }
    expect(recorded.steps.some((line) => line.includes('"aimed":"mover"') || line.includes('"aimed":"pop"'))).toBe(true);

    const replay = new PracticeSession({
      world: world(),
      weapon: undefined,
      mode: makeMode(),
      input: inputFromTimedActions(input.recording().actions),
      seed: input.recording().seed,
    });
    const replayed = trace(replay);
    for (let i = 0; i < 240; i += 1) replayed.step();
    expect(replayed.steps).toEqual(recorded.steps);
    expect(replay.shots).toEqual(original.shots);
  });

  it('replayPracticeSession は武器を使わないモードの練習も、終わるまで同じ結果で再生する', () => {
    const input = new RecordingInput(9);
    const mode = aimMode({ timeLimit: 2, targets: still('t', vec3(0, 1.6, -10)) });
    const original = new PracticeSession({ world: world(), weapon: undefined, mode, input, seed: input.seed });
    input.push(0, { type: 'fire', pressed: true });
    input.push(0.1, { type: 'fire', pressed: false });
    while (!original.ended) original.step();
    const replayed = replayPracticeSession(input.recording(), { world: world(), weapon: undefined, mode });
    expect(replayed.result?.shots).toEqual(original.result?.shots);
    expect(replayed.result?.shots[0]?.target).toBe('t');
  });
});

describe('モードに渡すもの', () => {
  it('time は setup で 0、ステップごとの処理ではそのステップの終わりの時刻', () => {
    const times: number[] = [];
    const mode = aimMode({
      targets: (context) => times.push(context.time),
      step: (context) => {
        times.push(context.time);
        return true;
      },
    });
    const s = weaponless(mode);
    s.step();
    s.step();
    expect(times[0]).toBe(0);
    expect(times[1]).toBeCloseTo(s.sim.dt, 12);
    expect(times[2]).toBeCloseTo(2 * s.sim.dt, 12);
  });

  it('モードの step で照準と的の当たりが読める', () => {
    const aimed: (string | undefined)[] = [];
    const mode = aimMode({
      targets: still('t', vec3(0, 1.6, -10)),
      step: (context) => {
        aimed.push(context.targets.aimed);
        return true;
      },
    });
    const s = weaponless(mode);
    s.step();
    expect(aimed).toEqual(['t']);
  });
});
