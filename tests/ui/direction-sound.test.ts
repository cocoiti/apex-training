import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TimedAction } from '../../src/input/actions';
import { RecordingInput } from '../../src/input/recording';
import { modes } from '../../src/modes/registry';
import { PracticeSession, replayPracticeSession } from '../../src/modes/session';
import type { TrainingMode } from '../../src/modes/types';
import { RECOIL_RECOVERY_TIME } from '../../src/sim/gun';
import { simplePattern } from '../../src/sim/simple-pattern';
import { vec3 } from '../../src/sim/vec3';
import { fireInterval, parseWeapon, type RecoilStep, type WeaponData } from '../../src/sim/weapon';
import { createWorld, type World } from '../../src/sim/world';
import {
  DIRECTION_TONES,
  DirectionSound,
  MAX_TONE_GAIN,
  previewCues,
  segmentStartingAt,
  ShotSounds,
  soundBlockedReason,
  SoundPreview,
  TONE_DURATION,
  type AudioContextLike,
  type PreviewTimers,
} from '../../src/ui/direction-sound';

function wallWorld(): World {
  return createWorld({
    id: 'test',
    name: 'test',
    spawn: { position: vec3(0, 1.6, 0), aim: { yaw: 0, pitch: 0 } },
    boxes: [{ id: 'wall', kind: 'wall', center: vec3(0, 1.6, -10.1), size: vec3(100, 100, 0.2) }],
  });
}

/** 補正の向きが 1〜8 発で下、9〜20 発で左下、21〜28 発で右下になる武器（リコイルは補正の逆）。 */
function threeSegmentWeapon(): WeaponData {
  const pattern: RecoilStep[] = Array.from({ length: 28 }, (_, i) => {
    if (i < 8) return { dx: 0, dy: 0.5 };
    if (i < 20) return { dx: 0.5, dy: 0.5 };
    return { dx: -0.5, dy: 0.5 };
  });
  return { id: 'w', name: 'テスト武器', category: 'AR', version: 'v', source: '仮データ', measured: true, rpm: 600, magSize: 28, pattern, randomness: 0 };
}

function lstar(): WeaponData {
  const parsed = parseWeapon(JSON.parse(readFileSync(resolve(__dirname, '../../src/data/weapons/lstar.json'), 'utf8')));
  if (!parsed.ok) throw new Error('lstar.json を読めない');
  return parsed.weapon;
}

const press = (time: number): TimedAction => ({ time, action: { type: 'fire', pressed: true } });
const release = (time: number): TimedAction => ({ time, action: { type: 'fire', pressed: false } });
const modeById = (id: string): TrainingMode => {
  const found = modes.find((m) => m.id === id);
  if (!found) throw new Error(`モード ${id} がない`);
  return found;
};

/** 練習を進め、描画のたびと同じくステップごとに ShotSounds.sync を呼ぶ。鳴らした発（patternShot ではなく通し番号）と向きを返す。 */
function practiceSounds(actions: TimedAction[], options: { weapon?: WeaponData; mode?: string; play?: boolean; seconds?: number } = {}) {
  const weapon = options.weapon ?? threeSegmentWeapon();
  const input = new RecordingInput(1);
  for (const { time, action } of actions) input.push(time, action);
  const session = new PracticeSession({ world: wallWorld(), weapon, mode: modeById(options.mode ?? 'pattern'), input, seed: input.seed });
  const played: { shot: number; direction: string }[] = [];
  const sounds = new ShotSounds(
    simplePattern(weapon),
    options.play === false ? undefined : (direction) => played.push({ shot: session.gun.shots.length, direction }),
  );
  const steps = Math.round((options.seconds ?? 5) / session.sim.dt);
  for (let i = 0; i < steps && !session.ended; i += 1) {
    session.step();
    sounds.sync(session.gun.shots);
  }
  return { session, played, recording: input.recording() };
}

describe('向きの音の高さと波形', () => {
  it('UI-76: 9 つの向きの音は表のとおりで、高さと波形の組がどの 2 つでも異なる', () => {
    expect(DIRECTION_TONES).toEqual({
      左上: { frequency: 330, wave: 'square' },
      上: { frequency: 440, wave: 'square' },
      右上: { frequency: 660, wave: 'square' },
      左: { frequency: 330, wave: 'triangle' },
      動かさない: { frequency: 440, wave: 'triangle' },
      右: { frequency: 660, wave: 'triangle' },
      左下: { frequency: 330, wave: 'sine' },
      下: { frequency: 440, wave: 'sine' },
      右下: { frequency: 660, wave: 'sine' },
    });
    const pairs = new Set(Object.values(DIRECTION_TONES).map((t) => `${t.frequency}:${t.wave}`));
    expect(pairs.size).toBe(9);
  });
});

describe('音を鳴らさないとき', () => {
  it('音が OFF か音量が 0 なら理由を返し、ON で音量があれば undefined', () => {
    expect(soundBlockedReason({ sound: false, volume: 50 })).toBe('設定で音が OFF です');
    expect(soundBlockedReason({ sound: false, volume: 0 })).toBe('設定で音が OFF です');
    expect(soundBlockedReason({ sound: true, volume: 0 })).toBe('設定の音量が 0 です');
    expect(soundBlockedReason({ sound: true, volume: 50 })).toBeUndefined();
  });
});

describe('練習中の向きの音', () => {
  it('区切りの最初の発だけが音を鳴らす発になる', () => {
    const pattern = simplePattern(threeSegmentWeapon());
    expect(pattern.segments.map((s) => s.label)).toEqual(['1〜8 発: ↓ 下', '9〜20 発: ↙ 左下', '21〜28 発: ↘ 右下']);
    expect(segmentStartingAt(pattern, 1)?.direction).toBe('下');
    expect(segmentStartingAt(pattern, 9)?.direction).toBe('左下');
    expect(segmentStartingAt(pattern, 21)?.direction).toBe('右下');
    for (const shot of [2, 8, 10, 20, 22, 28]) expect(segmentStartingAt(pattern, shot)).toBeUndefined();
  });

  it('UI-75: 撃ち切ると 1・9・21 発目にこの順で下・左下・右下が 1 回ずつ鳴り、ほかの発では鳴らない', () => {
    const { session, played } = practiceSounds([press(0)]);
    expect(session.gun.shots).toHaveLength(28);
    expect(played).toEqual([
      { shot: 1, direction: '下' },
      { shot: 9, direction: '左下' },
      { shot: 21, direction: '右下' },
    ]);
  });

  it('UI-77: 音を鳴らす処理を渡さない（音が OFF・音量 0）ときは、撃ち切っても鳴らさずエラーにもならない', () => {
    const { session, played } = practiceSounds([press(0)], { play: false });
    expect(session.gun.shots).toHaveLength(28);
    expect(played).toEqual([]);
  });

  it('UI-81: 12 発で離して戻りの前に押し直すと次は 21 発目の右下だけ、戻りより長く待つと押し直した 1 発目で下', () => {
    const interval = fireInterval(threeSegmentWeapon());
    // 0〜1.1 秒の 12 発。1.15 秒に離す。
    const before = practiceSounds([press(0), release(1.15), press(1.15 + RECOIL_RECOVERY_TIME / 2)]);
    expect(before.session.gun.shots).toHaveLength(28);
    expect(before.played).toEqual([
      { shot: 1, direction: '下' },
      { shot: 9, direction: '左下' },
      { shot: 21, direction: '右下' },
    ]);
    expect(before.session.gun.shots[20]?.patternShot).toBe(21);

    const after = practiceSounds([press(0), release(1.15), press(1.15 + RECOIL_RECOVERY_TIME + 0.2)], { seconds: 6 });
    expect(after.session.gun.shots[12]?.patternShot).toBe(1);
    expect(after.played).toEqual([
      { shot: 1, direction: '下' },
      { shot: 9, direction: '左下' },
      { shot: 13, direction: '下' },
      { shot: 21, direction: '左下' },
    ]);
    expect(interval).toBeCloseTo(0.1, 9);
  });

  it('MODE-28: どのモードでも 1 発目で最初の区切りの向きの音が鳴る', () => {
    for (const mode of ['pattern', 'ghost', 'center']) {
      const { played } = practiceSounds([press(0)], { mode });
      expect(played).toEqual([
        { shot: 1, direction: '下' },
        { shot: 9, direction: '左下' },
        { shot: 21, direction: '右下' },
      ]);
    }
  });

  it('MODE-29: 練習を作り直したあとに撃ち始めると、1 発目で最初の区切りの音が鳴る', () => {
    const first = practiceSounds([press(0), release(0.55)]);
    expect(first.played).toEqual([{ shot: 1, direction: '下' }]);
    const again = practiceSounds([press(0.2)]);
    expect(again.played[0]).toEqual({ shot: 1, direction: '下' });
  });

  it('UI-82: 簡易版は武器だけから求めるので、パターンの表示によらず同じ発と向きで鳴る', () => {
    // 簡易版は武器データだけから求める（設定のパターンの表示は使わない）。同じ武器なら何度求めても同じ区切りになる。
    const a = practiceSounds([press(0)]);
    const b = practiceSounds([press(0)]);
    expect(b.played).toEqual(a.played);
  });

  it('UI-80: 弾痕と採点は音の有無で変わらず、記録の再生は ShotSounds を通らないので鳴らない', () => {
    const on = practiceSounds([press(0)], { mode: 'center' });
    const off = practiceSounds([press(0)], { mode: 'center', play: false });
    expect(off.session.gun.shots).toEqual(on.session.gun.shots);
    expect(off.session.result?.modeResult).toEqual(on.session.result?.modeResult);
    const played = on.played.length;
    for (const recording of [on.recording, off.recording]) {
      const replayed = replayPracticeSession(recording, { world: wallWorld(), weapon: threeSegmentWeapon(), mode: modeById('center') });
      expect(replayed.gun.shots).toEqual(on.session.gun.shots);
    }
    expect(on.played).toHaveLength(played);
  });
});

/** 時刻を手で進めるタイマー。 */
class FakeTimers implements PreviewTimers {
  now = 0;
  private next = 0;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  set(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, callback });
    return id;
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = end;
  }
}

describe('試聴', () => {
  it('UI-78: L-STAR の区切りの順に、（区切りの最初の発の番号 − 1）× 発射間隔 の時刻に 1 回ずつ鳴り、最後の音のあとに表示が戻る', () => {
    const weapon = lstar();
    const segments = simplePattern(weapon).segments;
    const interval = fireInterval(weapon);
    const timers = new FakeTimers();
    const changes: boolean[] = [];
    const played: { time: number; direction: string }[] = [];
    const preview = new SoundPreview({ timers, onChange: (playing) => changes.push(playing) });
    preview.start(weapon, (direction) => played.push({ time: timers.now, direction }));
    expect(preview.playing).toBe(true);
    expect(changes).toEqual([true]);
    timers.advance(60_000);
    expect(played.map((p) => p.direction)).toEqual(segments.map((s) => s.direction));
    played.forEach((p, i) => expect(p.time).toBeCloseTo(segments[i]!.from * interval * 1000, 6));
    expect(previewCues(weapon).map((c) => c.time)).toEqual(segments.map((s) => s.from * interval));
    expect(changes).toEqual([true, false]);
    expect(preview.playing).toBe(false);
  });

  it('UI-78: 途中で止めると、それより後の音は鳴らない', () => {
    const weapon = lstar();
    const cues = previewCues(weapon);
    expect(cues.length).toBeGreaterThanOrEqual(2);
    const timers = new FakeTimers();
    const changes: boolean[] = [];
    const played: string[] = [];
    const preview = new SoundPreview({ timers, onChange: (playing) => changes.push(playing) });
    preview.start(weapon, (direction) => played.push(direction));
    timers.advance(cues[1]!.time * 1000 - 1);
    expect(played).toEqual([cues[0]!.direction]);
    preview.stop();
    timers.advance(60_000);
    expect(played).toEqual([cues[0]!.direction]);
    expect(changes).toEqual([true, false]);
    preview.stop();
    expect(changes).toEqual([true, false]);
  });

  it('UI-79: 試聴を始め直すと、前の試聴の残りの音は鳴らない', () => {
    const timers = new FakeTimers();
    const played: string[] = [];
    const preview = new SoundPreview({ timers, onChange: () => {} });
    preview.start(lstar(), (d) => played.push(`lstar:${d}`));
    timers.advance(1);
    preview.start(threeSegmentWeapon(), (d) => played.push(`w:${d}`));
    timers.advance(60_000);
    expect(played).toEqual([`lstar:${previewCues(lstar())[0]!.direction}`, 'w:下', 'w:左下', 'w:右下']);
  });
});

/** 作った音の高さ・波形・大きさの変化を記録する AudioContext の偽物。 */
function fakeContext(state = 'running') {
  const tones: { type: string; frequency: number; start?: number | undefined; stop?: number | undefined; gain: [string, number, number][] }[] = [];
  const context = {
    state,
    currentTime: 2,
    destination: {},
    resume: vi.fn(() => Promise.resolve()),
    createOscillator: () => {
      const tone = { type: '', frequency: 0, gain: [] as [string, number, number][] } as (typeof tones)[number];
      tones.push(tone);
      return {
        get type() {
          return tone.type;
        },
        set type(value: string) {
          tone.type = value;
        },
        frequency: {
          set value(v: number) {
            tone.frequency = v;
          },
          get value() {
            return tone.frequency;
          },
          setValueAtTime: () => {},
          linearRampToValueAtTime: () => {},
        },
        connect: () => {},
        start: (when?: number) => void (tone.start = when),
        stop: (when?: number) => void (tone.stop = when),
      };
    },
    createGain: () => {
      const tone = tones.at(-1)!;
      return {
        gain: {
          value: 1,
          setValueAtTime: (v: number, t: number) => void tone.gain.push(['set', v, t]),
          linearRampToValueAtTime: (v: number, t: number) => void tone.gain.push(['ramp', v, t]),
        },
        connect: () => {},
      };
    },
  };
  return { context: context as AudioContextLike, tones, resume: context.resume };
}

describe('Web Audio での合成', () => {
  it('UI-76: 向きごとの高さと波形で 0.12 秒鳴らし、鳴り始めと終わりを 0 から上げ下げし、大きさは音量に比例する', () => {
    const { context, tones } = fakeContext();
    const sound = new DirectionSound(() => context);
    sound.unlock();
    for (const direction of Object.keys(DIRECTION_TONES)) sound.play(direction, 100);
    expect(tones.map((t) => [t.type, t.frequency])).toEqual(Object.values(DIRECTION_TONES).map((t) => [t.wave, t.frequency]));
    const first = tones[0]!;
    expect(first.start).toBe(2);
    expect(first.stop).toBeCloseTo(2 + TONE_DURATION, 9);
    expect(first.gain[0]).toEqual(['set', 0, 2]);
    expect(first.gain.at(-1)?.[1]).toBe(0);
    expect(first.gain.at(-1)?.[2]).toBeCloseTo(2 + TONE_DURATION, 9);
    expect(Math.max(...first.gain.map((g) => g[1]))).toBeCloseTo(MAX_TONE_GAIN, 9);

    sound.play('下', 50);
    expect(Math.max(...tones.at(-1)!.gain.map((g) => g[1]))).toBeCloseTo(MAX_TONE_GAIN / 2, 9);
  });

  it('UI-83: 操作の前は AudioContext を作らず鳴らさない', () => {
    const create = vi.fn(() => fakeContext().context);
    const sound = new DirectionSound(create);
    expect(() => sound.play('下', 50)).not.toThrow();
    expect(create).not.toHaveBeenCalled();
    sound.unlock();
    sound.unlock();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('UI-83: Web Audio が使えない・作るときに投げる・音を許さない（running でない）ときもエラーにならず鳴らさない', () => {
    const missing = new DirectionSound(() => undefined);
    missing.unlock();
    expect(() => missing.play('下', 50)).not.toThrow();

    const throwing = new DirectionSound(() => {
      throw new Error('使えない');
    });
    expect(() => throwing.unlock()).not.toThrow();
    expect(() => throwing.play('下', 50)).not.toThrow();

    const suspended = fakeContext('suspended');
    const blocked = new DirectionSound(() => suspended.context);
    blocked.unlock();
    blocked.play('下', 50);
    expect(suspended.tones).toHaveLength(0);
    expect(suspended.resume).toHaveBeenCalled();

    const rejecting = fakeContext('suspended');
    rejecting.resume.mockImplementation(() => Promise.reject(new Error('許さない')));
    expect(() => new DirectionSound(() => rejecting.context).unlock()).not.toThrow();
  });

  it('音量 0 と知らない向きは鳴らさない', () => {
    const { context, tones } = fakeContext();
    const sound = new DirectionSound(() => context);
    sound.unlock();
    sound.play('下', 0);
    sound.play('斜め', 50);
    expect(tones).toHaveLength(0);
  });
});
