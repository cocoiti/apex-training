import { describe, expect, it } from 'vitest';
import type { TimedAction } from '../../src/input/actions';
import { inputFromTimedActions } from '../../src/input/queue';
import { RecordingInput } from '../../src/input/recording';
import { modes } from '../../src/modes/registry';
import { PracticeSession, replayPracticeSession } from '../../src/modes/session';
import type { TrainingMode } from '../../src/modes/types';
import { aimAtShots } from '../../src/sim/trajectory';
import { vec3 } from '../../src/sim/vec3';
import { idealCorrection, idealCorrectionRate, type RecoilStep, type WeaponData } from '../../src/sim/weapon';
import { createWorld, type World } from '../../src/sim/world';

/** 正面 10 メートルに大きな壁だけがある World。開始時の照準はヨー 0・ピッチ 0。 */
function wallWorld(): World {
  return createWorld({
    id: 'test',
    name: 'test',
    spawn: { position: vec3(0, 1.6, 0), aim: { yaw: 0, pitch: 0 } },
    boxes: [{ id: 'wall', kind: 'wall', center: vec3(0, 1.6, -10.1), size: vec3(100, 100, 0.2) }],
  });
}

function makeWeapon(extra: Partial<WeaponData> = {}): WeaponData {
  const magSize = extra.magSize ?? 20;
  const pattern: RecoilStep[] = Array.from({ length: magSize }, (_, i) => ({ dx: ((i % 5) - 2) * 0.1, dy: 0.3 + i * 0.01 }));
  return { id: 'w', name: 'テスト武器', category: 'AR', version: 'v', source: '仮データ', rpm: 600, magSize, pattern, randomness: 0, measured: true, ...extra };
}

const press = (time: number): TimedAction => ({ time, action: { type: 'fire', pressed: true } });
const release = (time: number): TimedAction => ({ time, action: { type: 'fire', pressed: false } });
const modeById = (id: string): TrainingMode => {
  const found = modes.find((m) => m.id === id);
  if (!found) throw new Error(`モード ${id} がない`);
  return found;
};

function session(actions: TimedAction[], options: { weapon?: WeaponData; mode?: TrainingMode } = {}) {
  return new PracticeSession({
    world: wallWorld(),
    weapon: options.weapon ?? makeWeapon(),
    mode: options.mode ?? modeById('ghost'),
    input: inputFromTimedActions(actions),
    seed: 1,
  });
}

/** 秒数分のステップを進める。 */
function advance(s: PracticeSession, seconds: number): void {
  const count = Math.round(seconds / s.sim.dt);
  for (let i = 0; i < count; i += 1) s.step();
}

describe('練習', () => {
  it('始めたとき残弾は装弾数で、1 発撃つごとに 1 減る（MODE-9）', () => {
    const s = session([press(0)]);
    expect(s.gun.ammo).toBe(20);
    const seen: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      s.step();
      seen.push(s.gun.ammo + s.gun.shots.length);
    }
    // どのステップでも、残弾 + 撃った数 = 装弾数。
    expect(new Set(seen)).toEqual(new Set([20]));
    expect(s.gun.shots.length).toBeGreaterThan(0);
  });

  it('照準を動かさずに撃ち切ると、弾痕が武器のパターンの形に並び、撃ち切ったところで終わる（MODE-6）', () => {
    const weapon = makeWeapon();
    const s = session([press(0)], { weapon, mode: modeById('ghost') });
    advance(s, 5);
    expect(s.ended).toBe(true);
    const result = s.result!;
    expect(result.endReason).toBe('empty');
    expect(result.shots).toHaveLength(weapon.magSize);
    let dx = 0;
    let dy = 0;
    result.shots.forEach((shot, i) => {
      dx += weapon.pattern[i]!.dx;
      dy += weapon.pattern[i]!.dy;
      expect(shot.deviation!.yaw).toBeCloseTo(dx, 6);
      expect(shot.deviation!.pitch).toBeCloseTo(dy, 6);
    });
    // 20 発目は 19 × 0.1 秒の時刻のステップで撃たれ、そのステップの終わりで終わる。
    expect(result.duration).toBeCloseTo(1.9 + s.sim.dt, 9);
    expect(result.weapon).toBe(weapon);
    expect(result.mode).toEqual({ id: 'ghost', name: { ja: '反復練習', en: 'Recoil Drill' }, category: 'recoil' });
    expect(result.modeResult).toEqual({});
  });

  it('終わったあとは進まず、経過時間も止まる', () => {
    const s = session([press(0)]);
    advance(s, 3);
    const elapsed = s.elapsed;
    const shots = s.result!.shots.length;
    advance(s, 1);
    expect(s.elapsed).toBe(elapsed);
    expect(s.gun.shots).toHaveLength(shots);
  });

  it('撃ったあと fire を離して 2 秒撃たなかったら終わる（MODE-7）', () => {
    const s = session([press(0), release(0.25)]);
    advance(s, 0.25 + 1.95);
    expect(s.ended).toBe(false);
    advance(s, 0.1);
    expect(s.ended).toBe(true);
    expect(s.result!.endReason).toBe('idle');
    expect(s.result!.shots).toHaveLength(3);
  });

  it('2 秒たつ前に押し直すと、残弾から続けて撃てる（MODE-7）', () => {
    const s = session([press(0), release(0.25), press(2.0), release(2.15)]);
    advance(s, 2.15);
    expect(s.ended).toBe(false);
    expect(s.gun.shots).toHaveLength(5);
    expect(s.gun.ammo).toBe(15);
    advance(s, 2.1);
    expect(s.result?.endReason).toBe('idle');
  });

  it('1 発も撃たずに 2 秒以上たっても終わらない（MODE-8）', () => {
    const s = session([]);
    advance(s, 10);
    expect(s.ended).toBe(false);
    expect(s.elapsed).toBeCloseTo(10, 9);
  });

  it('反復練習でも同じ条件で終わる', () => {
    const s = session([press(0)], { mode: modeById('ghost') });
    advance(s, 3);
    expect(s.result?.endReason).toBe('empty');
    expect(s.result?.mode.id).toBe('ghost');
  });

  it('モードの準備と片付けを 1 回ずつ呼び、モードが false を返すと終わる', () => {
    const calls: string[] = [];
    let steps = 0;
    const mode: TrainingMode = {
      id: 'stub',
      name: { ja: 'stub', en: 'stub' },
      description: { ja: 'stub', en: 'stub' },
      icon: 'spray',
      category: 'recoil',
      order: 0,
      setup: () => calls.push('setup'),
      step: () => {
        steps += 1;
        return steps < 10;
      },
      result: () => {
        calls.push('result');
        return {};
      },
      teardown: () => calls.push('teardown'),
    };
    const s = session([], { mode });
    advance(s, 1);
    expect(calls).toEqual(['setup', 'result', 'teardown']);
    expect(s.result?.endReason).toBe('mode');
    expect(s.elapsed).toBeCloseTo(10 * s.sim.dt, 9);
  });
});

describe('記録の再生（モードを含めた練習）', () => {
  /** setup とステップごとに乱数を取るモード。モードと Gun が同じ乱数を使っても再生が一致することを確かめる。 */
  const randomMode: TrainingMode = {
    ...modeById('ghost'),
    setup(context) {
      context.random.next();
    },
    step(context) {
      context.random.next();
      return true;
    },
  };

  it('同じ World・武器・モードで記録を再生すると、弾痕と終わった理由・時間が元の練習と一致する（INP-4）', () => {
    const weapon = makeWeapon({ randomness: 0.2 });
    const input = new RecordingInput(12345);
    const original = new PracticeSession({ world: wallWorld(), weapon, mode: randomMode, input, seed: input.seed });
    input.push(0, { type: 'fire', pressed: true });
    input.push(0.3, { type: 'look', yaw: 0.5, pitch: -1 });
    input.push(0.8, { type: 'fire', pressed: false });
    while (!original.ended) original.step();

    const replayed = replayPracticeSession(input.recording(), { world: wallWorld(), weapon, mode: randomMode });
    expect(replayed.result).toEqual(original.result);
  });
});

describe('練習の入力方式（docs/spec/input.md「入力方式ごとの保存」）', () => {
  it('INP-14: 1 発目を撃ったときの入力方式を練習の入力方式にし、あとで切り替わっても変えない', () => {
    let current: 'mouse' | 'pad' = 'mouse';
    const s = new PracticeSession({
      world: wallWorld(),
      weapon: makeWeapon(),
      mode: modeById('ghost'),
      input: inputFromTimedActions([press(0)]),
      seed: 1,
      inputMethod: () => current,
    });
    s.step();
    expect(s.gun.shots.length).toBeGreaterThan(0);
    current = 'pad';
    advance(s, 5);
    expect(s.result?.inputMethod).toBe('mouse');
  });

  it('1 発目より前に切り替わった入力方式は練習の入力方式になる', () => {
    let current: 'mouse' | 'pad' = 'mouse';
    const s = new PracticeSession({
      world: wallWorld(),
      weapon: makeWeapon(),
      mode: modeById('ghost'),
      input: inputFromTimedActions([press(0.5)]),
      seed: 1,
      inputMethod: () => current,
    });
    advance(s, 0.25);
    expect(s.gun.shots).toHaveLength(0);
    current = 'pad';
    advance(s, 5);
    expect(s.result?.inputMethod).toBe('pad');
  });

  it('入力方式を渡さないときはマウス', () => {
    const s = session([press(0)]);
    advance(s, 5);
    expect(s.result?.inputMethod).toBe('mouse');
  });
});

describe('パッド向けのガイドと入力推移に使うもの（docs/spec/pad.md）', () => {
  it('理想の補正速度は今の fire の状態と次に撃つ弾から求め、離したときと終わったあとは 0', () => {
    const weapon = makeWeapon();
    const s = session([press(0), release(0.15)], { weapon });
    expect(s.idealRate).toEqual({ yaw: 0, pitch: 0 });
    s.step();
    expect(s.gun.nextPatternShot).toBe(2);
    expect(s.idealRate).toEqual(idealCorrectionRate(weapon, { fire: true, nextShot: 2, ammo: s.gun.ammo }));
    expect(s.idealRate.pitch).toBeLessThan(0);
    advance(s, 0.2);
    expect(s.idealRate).toEqual({ yaw: 0, pitch: 0 });
    advance(s, 3);
    expect(s.ended).toBe(true);
    expect(s.idealRate).toEqual({ yaw: 0, pitch: 0 });
  });

  it('練習の入力方式がパッドなら、1 発目を撃ったときのパッドの名前を結果に載せる', () => {
    let name: string | undefined = 'DualSense Wireless Controller';
    const s = new PracticeSession({
      world: wallWorld(),
      weapon: makeWeapon(),
      mode: modeById('ghost'),
      input: inputFromTimedActions([press(0)]),
      seed: 1,
      inputMethod: () => 'pad',
      padName: () => name,
    });
    s.step();
    name = 'Xbox Wireless Controller';
    advance(s, 5);
    expect(s.result?.padName).toBe('DualSense Wireless Controller');
  });

  it('練習の入力方式がマウスなら、パッドの名前は載せない', () => {
    const s = new PracticeSession({
      world: wallWorld(),
      weapon: makeWeapon(),
      mode: modeById('ghost'),
      input: inputFromTimedActions([press(0)]),
      seed: 1,
      inputMethod: () => 'mouse',
      padName: () => 'DualSense Wireless Controller',
    });
    advance(s, 5);
    expect(s.result?.padName).toBeUndefined();
  });
});

describe('撃った各弾の発射時の照準（docs/spec/screens.md「補正のパネル」）', () => {
  it('撃つ前は空で、記録から求めるリザルトの自分の照準の軌道（aimAtShots）と同じ値を撃った順に持つ', () => {
    const weapon = makeWeapon();
    const input = new RecordingInput(7);
    const s = new PracticeSession({ world: wallWorld(), weapon, mode: modeById('ghost'), input, seed: input.seed });
    expect(s.shotAims).toEqual([]);
    input.push(0, { type: 'fire', pressed: true });
    input.push(0.05, { type: 'look', yaw: 0.4, pitch: -0.7 });
    input.push(0.23, { type: 'look', yaw: -1.1, pitch: -0.2 });
    input.push(0.61, { type: 'fire', pressed: false });
    input.push(0.62, { type: 'look', yaw: 0.3, pitch: 0.3 });
    while (!s.ended) s.step();
    expect(s.shotAims).toHaveLength(s.gun.shots.length);
    const expected = aimAtShots(input.recording(), s.gun.shots, wallWorld().center, s.sim.dt);
    s.shotAims.forEach((aim, i) => {
      expect(aim.yaw).toBeCloseTo(expected[i]?.yaw ?? Number.NaN, 9);
      expect(aim.pitch).toBeCloseTo(expected[i]?.pitch ?? Number.NaN, 9);
    });
  });

  it('UI-63: 今の照準は開始時の照準からの差で、撃つ前に動かした分だけ動き、リコイルのオフセットを含まない', () => {
    const weapon = makeWeapon();
    const s = session([{ time: 0, action: { type: 'look', yaw: 2, pitch: 1 } }, press(0.1)], { weapon, mode: modeById('ghost') });
    expect(s.aim).toEqual({ yaw: 0, pitch: 0 });
    while (s.gun.shots.length < 3) s.step();
    expect(s.aim.yaw).toBeCloseTo(2, 9);
    expect(s.aim.pitch).toBeCloseTo(1, 9);
    expect(s.world.player.recoilOffset.pitch).toBeGreaterThan(0);
  });

  it('UI-56: 照準を動かさずに 5 発撃つと、5 つの照準はすべて原点（リコイルのオフセットを含まない）', () => {
    const weapon = makeWeapon();
    const s = session([press(0)], { weapon, mode: modeById('ghost') });
    while (s.gun.shots.length < 5) s.step();
    expect(s.shotAims.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => ({ yaw: 0, pitch: 0 })));
    expect(s.world.player.recoilOffset.pitch).toBeGreaterThan(0);
  });

  it('UI-57: 各発の発射時に照準を理想の補正軌道に合わせて撃つと、各弾の照準が理想の補正軌道に一致する', () => {
    const weapon = makeWeapon();
    const ideal = idealCorrection(weapon);
    const interval = 60 / weapon.rpm;
    const dt = 1 / 120;
    const actions: TimedAction[] = [press(0)];
    ideal.forEach((point, i) => {
      const previous = ideal[i - 1] ?? { yaw: 0, pitch: 0 };
      // k 発目の発射の少し前に、照準を k 発目の理想の補正軌道へ動かす。
      const time = Math.max(0, i * interval - dt / 2);
      actions.push({ time, action: { type: 'look', yaw: point.yaw - previous.yaw, pitch: point.pitch - previous.pitch } });
    });
    const s = session(actions, { weapon, mode: modeById('ghost') });
    while (!s.ended) s.step();
    expect(s.shotAims).toHaveLength(weapon.magSize);
    s.shotAims.forEach((aim, i) => {
      expect(aim.yaw).toBeCloseTo(ideal[i]?.yaw ?? Number.NaN, 9);
      expect(aim.pitch).toBeCloseTo(ideal[i]?.pitch ?? Number.NaN, 9);
    });
  });
});
