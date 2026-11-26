import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TimedAction } from '../../src/input/actions';
import { ManualFrameClock } from '../../src/core/frame-clock';
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
  PREVIEW_LOOKAHEAD,
  type PreviewOutput,
  type ScheduledTone,
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
  const session = new PracticeSession({ world: wallWorld(), weapon, mode: modeById(options.mode ?? 'ghost'), input, seed: input.seed });
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

  it('MODE-29: どのモードでも 1 発目で最初の区切りの向きの音が鳴る', () => {
    for (const mode of ['ghost', 'center']) {
      const { played } = practiceSounds([press(0)], { mode });
      expect(played).toEqual([
        { shot: 1, direction: '下' },
        { shot: 9, direction: '左下' },
        { shot: 21, direction: '右下' },
      ]);
    }
  });

  it('MODE-30: 練習を作り直したあとに撃ち始めると、1 発目で最初の区切りの音が鳴る', () => {
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

/** 予約された音を記録する、試聴の音の出口の偽物。音の時計はページの時計から offset 秒ずれて進む。 */
function fakeOutput(clock: ManualFrameClock, offset = 100) {
  const scheduled: { direction: string; when: number; calledAt: number; cancelledAt: number | undefined }[] = [];
  let available = true;
  const output: PreviewOutput = {
    now: () => (available ? clock.now() + offset : undefined),
    schedule: (direction, when): ScheduledTone | undefined => {
      if (!available) return undefined;
      const entry = { direction, when, calledAt: clock.now() + offset, cancelledAt: undefined as number | undefined };
      scheduled.push(entry);
      return { cancel: () => void (entry.cancelledAt ??= clock.now() + offset) };
    },
  };
  /** 鳴った（予約されて、鳴る時刻より前に取り消されなかった）音。 */
  const heard = () => scheduled.filter((e) => e.cancelledAt === undefined || e.cancelledAt > e.when);
  return { output, scheduled, heard, setAvailable: (on: boolean) => void (available = on) };
}

describe('試聴', () => {
  it('UI-78: L-STAR の区切りの順に、（区切りの最初の発の番号 − 1）× 発射間隔 の時刻に 1 回ずつ鳴り、最後の音のあとに表示が戻る', () => {
    const weapon = lstar();
    const segments = simplePattern(weapon).segments;
    const interval = fireInterval(weapon);
    const clock = new ManualFrameClock(undefined, 5);
    const { output, scheduled } = fakeOutput(clock);
    const changes: boolean[] = [];
    const preview = new SoundPreview({ clock, onChange: (playing) => changes.push(playing) });
    preview.start(weapon, output);
    expect(preview.playing).toBe(true);
    expect(changes).toEqual([true]);
    const lastAt = segments.at(-1)!.from * interval;
    clock.advance(lastAt - 0.02);
    expect(changes).toEqual([true]);
    clock.advance(0.05);
    expect(changes).toEqual([true, false]);
    expect(preview.playing).toBe(false);
    clock.advance(10);
    expect(scheduled.map((p) => p.direction)).toEqual(segments.map((s) => s.direction));
    // 押した時点（音の時計で 105 秒）からの時刻に、区切りごとに予約する。
    scheduled.forEach((p, i) => expect(p.when).toBeCloseTo(105 + segments[i]!.from * interval, 9));
    expect(previewCues(weapon).map((c) => c.time)).toEqual(segments.map((s) => s.from * interval));
  });

  it('UI-78: 描画が大きく遅れても、音の時刻は押した時点からの経過で決まり、遅れが積み重ならない', () => {
    const weapon = lstar();
    const segments = simplePattern(weapon).segments;
    const interval = fireInterval(weapon);
    const clock = new ManualFrameClock(undefined, 0);
    const { output, scheduled } = fakeOutput(clock);
    const preview = new SoundPreview({ clock, onChange: () => {} });
    preview.start(weapon, output);
    clock.advance(1 / 60);
    // そのあとの描画が 0.2 秒ずつ遅れる。
    clock.advance(10, 0.2);
    expect(scheduled.map((p) => p.direction)).toEqual(segments.map((s) => s.direction));
    scheduled.forEach((p, i) => expect(p.when).toBeCloseTo(100 + segments[i]!.from * interval, 9));
    // 押した直後の最初の音のほかは、遅れが先読み（PREVIEW_LOOKAHEAD）より短ければ、鳴る時刻より前に予約できている。
    scheduled.slice(1).forEach((p) => expect(p.calledAt).toBeLessThanOrEqual(p.when + 1e-9));
    expect(PREVIEW_LOOKAHEAD).toBeGreaterThan(0.2);
  });

  it('UI-78: 途中で止めると、それより後の音は鳴らない', () => {
    const weapon = lstar();
    const cues = previewCues(weapon);
    expect(cues.length).toBeGreaterThanOrEqual(2);
    const clock = new ManualFrameClock(undefined, 0);
    const { output, scheduled, heard } = fakeOutput(clock);
    const changes: boolean[] = [];
    const preview = new SoundPreview({ clock, onChange: (playing) => changes.push(playing) });
    preview.start(weapon, output);
    // 2 つ目の音を先読みで予約したあと、鳴る前に止める。
    clock.advance(cues[1]!.time - 0.01);
    expect(scheduled.map((p) => p.direction)).toEqual([cues[0]!.direction, cues[1]!.direction]);
    preview.stop();
    clock.advance(60);
    expect(scheduled).toHaveLength(2);
    expect(heard().map((p) => p.direction)).toEqual([cues[0]!.direction]);
    expect(changes).toEqual([true, false]);
    preview.stop();
    expect(changes).toEqual([true, false]);
  });

  it('UI-79: 試聴を始め直すと、前の試聴の残りの音は鳴らない', () => {
    const clock = new ManualFrameClock(undefined, 0);
    const first = fakeOutput(clock);
    const second = fakeOutput(clock);
    const preview = new SoundPreview({ clock, onChange: () => {} });
    preview.start(lstar(), first.output);
    clock.advance(0.01);
    preview.start(threeSegmentWeapon(), second.output);
    clock.advance(60);
    expect(first.heard().map((p) => p.direction)).toEqual([previewCues(lstar())[0]!.direction]);
    expect(second.heard().map((p) => p.direction)).toEqual(['下', '左下', '右下']);
  });

  it('UI-83: 音を鳴らせないあいだに時刻が来た音は鳴らさず、鳴らせるようになったあとの音は押した時点からの時刻に鳴らす', () => {
    const weapon = threeSegmentWeapon();
    const interval = fireInterval(weapon);
    const clock = new ManualFrameClock(undefined, 0);
    const { output, scheduled, setAvailable } = fakeOutput(clock);
    const changes: boolean[] = [];
    const preview = new SoundPreview({ clock, onChange: (playing) => changes.push(playing) });
    setAvailable(false);
    preview.start(weapon, output);
    clock.advance(0.5);
    setAvailable(true);
    clock.advance(60);
    expect(scheduled.map((p) => [p.direction, p.when])).toEqual([
      ['左下', 100 + 8 * interval],
      ['右下', 100 + 20 * interval],
    ]);
    expect(changes).toEqual([true, false]);
  });
});

/** 作った音の高さ・波形・大きさの変化を記録する AudioContext の偽物。 */
function fakeContext(state = 'running') {
  const tones: {
    type: string;
    frequency: number;
    start?: number | undefined;
    stop?: number | undefined;
    disconnected?: boolean;
    gain: [string, number, number][];
  }[] = [];
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
        disconnect: () => {},
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
        disconnect: () => void (tone.disconnected = true),
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

  it('UI-78: 音の時計の指定した時刻に予約でき、取り消すと止めてつなぎを外す。過ぎた時刻は今に鳴らし、鳴らせないときは undefined', () => {
    const { context, tones } = fakeContext();
    const sound = new DirectionSound(() => context);
    expect(sound.now()).toBeUndefined();
    expect(sound.schedule('下', 50, 3)).toBeUndefined();
    sound.unlock();
    expect(sound.now()).toBe(2);
    const tone = sound.schedule('下', 50, 3.5)!;
    expect(tones.at(-1)!.start).toBe(3.5);
    expect(tones.at(-1)!.stop).toBeCloseTo(3.5 + TONE_DURATION, 9);
    tone.cancel();
    expect(tones.at(-1)!.stop).toBe(0);
    expect(tones.at(-1)!.disconnected).toBe(true);
    sound.schedule('下', 50, 1);
    expect(tones.at(-1)!.start).toBe(2);
    expect(sound.schedule('斜め', 50, 3)).toBeUndefined();
    expect(new DirectionSound(() => fakeContext('suspended').context).now()).toBeUndefined();
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
