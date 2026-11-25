import { describe, expect, it } from 'vitest';
import type { TimedAction } from '../../src/input/actions';
import { inputFromTimedActions } from '../../src/input/queue';
import { RecordingInput } from '../../src/input/recording';
import { modes } from '../../src/modes/registry';
import { PracticeSession, replayPracticeSession } from '../../src/modes/session';
import type { TrainingMode } from '../../src/modes/types';
import { vec3 } from '../../src/sim/vec3';
import type { RecoilStep, WeaponData } from '../../src/sim/weapon';
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
  return { id: 'w', name: 'テスト武器', category: 'AR', version: 'v', source: '仮データ', rpm: 600, magSize, pattern, randomness: 0, ...extra };
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
    mode: options.mode ?? modeById('pattern'),
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

  it('パターン観察で照準を動かさずに撃ち切ると、弾痕が武器のパターンの形に並び、撃ち切ったところで終わる（MODE-2、MODE-6）', () => {
    const weapon = makeWeapon();
    const s = session([press(0)], { weapon, mode: modeById('pattern') });
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
    expect(result.mode).toEqual({ id: 'pattern', name: 'パターン観察', category: 'recoil' });
    expect(result.modeResult.scored).toBe(false);
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

  it('センター維持でも同じ条件で終わり、採点するモードとして結果を渡す', () => {
    const s = session([press(0)], { mode: modeById('center') });
    advance(s, 3);
    expect(s.result?.endReason).toBe('empty');
    expect(s.result?.modeResult.scored).toBe(true);
  });

  it('モードの準備と片付けを 1 回ずつ呼び、モードが false を返すと終わる', () => {
    const calls: string[] = [];
    let steps = 0;
    const mode: TrainingMode = {
      id: 'stub',
      name: 'stub',
      category: 'recoil',
      order: 0,
      setup: () => calls.push('setup'),
      step: () => {
        steps += 1;
        return steps < 10;
      },
      result: () => {
        calls.push('result');
        return { scored: false };
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
    ...modeById('pattern'),
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
