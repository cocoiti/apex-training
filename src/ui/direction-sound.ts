import type { ShotRecord } from '../sim/gun';
import { simplePattern, type SimplePattern, type SimpleSegment } from '../sim/simple-pattern';
import { fireInterval, type WeaponData } from '../sim/weapon';

/**
 * 簡易版のパターンの区切りごとの向きの音（docs/spec/screens.md「音」）。音はすべて Web Audio でその場で合成し、音声のファイルは使わない。
 * 音は聞くためだけのもので、シミュレーション・弾痕・採点・入力の記録には触れない。
 */

/** 音の波形。上下を分ける。 */
export type ToneWave = 'square' | 'triangle' | 'sine';

/** 1 つの向きの音。高さ（Hz）で左右を、波形で上下を分ける。 */
export interface DirectionTone {
  readonly frequency: number;
  readonly wave: ToneWave;
}

const LEFT = 330;
const CENTER = 440;
const RIGHT = 660;

/** 9 つの向き（簡易版の区切りの向きの名前）の音。高さと波形の組はすべて異なる。 */
export const DIRECTION_TONES: Readonly<Record<string, DirectionTone>> = {
  左上: { frequency: LEFT, wave: 'square' },
  上: { frequency: CENTER, wave: 'square' },
  右上: { frequency: RIGHT, wave: 'square' },
  左: { frequency: LEFT, wave: 'triangle' },
  動かさない: { frequency: CENTER, wave: 'triangle' },
  右: { frequency: RIGHT, wave: 'triangle' },
  左下: { frequency: LEFT, wave: 'sine' },
  下: { frequency: CENTER, wave: 'sine' },
  右下: { frequency: RIGHT, wave: 'sine' },
};

/** 1 つの音の長さ（秒）。 */
export const TONE_DURATION = 0.12;
/** 鳴り始めと鳴り終わりに音の大きさを上げ下げする時間（秒）。プツッという雑音を出さないため。 */
export const TONE_FADE = 0.01;
/** 音量 100 のときの音の大きさ（GainNode の値）。 */
export const MAX_TONE_GAIN = 0.3;

/** 音を鳴らさない理由。鳴らせるときは undefined（docs/spec/screens.md「音」の「鳴らさないとき」）。 */
export function soundBlockedReason(settings: { readonly sound: boolean; readonly volume: number }): string | undefined {
  if (!settings.sound) return '設定で音が OFF です';
  if (settings.volume <= 0) return '設定の音量が 0 です';
  return undefined;
}

/** pattern の patternShot 発目が区切りの最初の発（a 発目〜b 発目の区切りの a+1 発目）なら、その区切り。 */
export function segmentStartingAt(pattern: Pick<SimplePattern, 'segments'>, patternShot: number): SimpleSegment | undefined {
  return pattern.segments.find((segment) => segment.from + 1 === patternShot);
}

/**
 * 練習中に撃った弾に合わせて向きの音を鳴らす。描画のたびに sync を呼び、増えた弾のうち区切りの最初の発で 1 回ずつ鳴らす。
 * 発の番号は弾の記録の patternShot（シミュレーションが撃つときに使った pattern の発）を使うので、
 * 戻りの時間がたつ前に押し直したときは続きの発から数える。play が undefined（音が OFF・音量 0）のときは鳴らさない。
 */
export class ShotSounds {
  private synced = 0;

  constructor(
    private readonly pattern: Pick<SimplePattern, 'segments'>,
    private readonly play: ((direction: string) => void) | undefined,
  ) {}

  sync(shots: readonly Pick<ShotRecord, 'patternShot'>[]): void {
    for (; this.synced < shots.length; this.synced += 1) {
      const shot = shots[this.synced] as Pick<ShotRecord, 'patternShot'>;
      const segment = segmentStartingAt(this.pattern, shot.patternShot);
      if (segment && this.play) this.play(segment.direction);
    }
  }
}

/** 試聴で鳴らす 1 つの音。time は押してからの秒。 */
export interface PreviewCue {
  readonly time: number;
  readonly direction: string;
}

/** 試聴の音の並び。a 発目〜b 発目の区切りの音を a × 発射間隔 の時刻に鳴らす（fire を押し続けて撃ったときと同じ間隔）。 */
export function previewCues(weapon: Pick<WeaponData, 'pattern' | 'magSize' | 'rpm'>): PreviewCue[] {
  const interval = fireInterval(weapon);
  return simplePattern(weapon).segments.map((segment) => ({ time: segment.from * interval, direction: segment.direction }));
}

/** 試聴の音を、鳴らす時刻よりどれだけ前（秒）に Web Audio へ予約するか。描画が遅れても、この時間までなら音は遅れない。 */
export const PREVIEW_LOOKAHEAD = 0.25;

/** 試聴の時刻を数えるページの時計（src/core/frame-clock.ts の FrameClock の、試聴に使う部分）。 */
export interface PreviewClock {
  /** 今の時刻（秒）。 */
  now(): number;
  /** 次の描画で cb を 1 回呼ぶ。 */
  requestFrame(cb: () => void): void;
}

/** 予約した 1 つの音。cancel で、まだ鳴っていなければ鳴らさず、鳴っていれば止める。 */
export interface ScheduledTone {
  cancel(): void;
}

/** 試聴の音を鳴らす先。ブラウザでは DirectionSound。 */
export interface PreviewOutput {
  /** 音の時計（AudioContext.currentTime）の今の時刻（秒）。音を鳴らせないあいだは undefined。 */
  now(): number | undefined;
  /** direction の向きの音を、音の時計の when 秒に鳴らすよう予約する。鳴らせないときは undefined。 */
  schedule(direction: string, when: number): ScheduledTone | undefined;
}

/**
 * トップ画面の「パターンの音を聞く」（docs/spec/screens.md「音」の「試聴」）。区切りの順に向きの音を鳴らし、
 * 止めたときは残りの音を鳴らさない。鳴らすかどうか（音の設定）は呼ぶ側が決める。
 * どの音まで予約したかはページの時計で数え、予約した音は「押した時点の音の時計 + 区切りの時刻」に鳴らす。
 * 音の時刻を押した時点からの経過で決めるので、描画やタイマーが遅れても次の音に遅れが積み重ならない。
 */
export class SoundPreview {
  /** 今の試聴。始め直す・止めるたびに新しいものに替え、前の試聴の描画の呼び出しは何もしない。 */
  private current: { readonly tones: ScheduledTone[] } | undefined;

  constructor(
    private readonly options: {
      readonly clock: PreviewClock;
      /** 試聴が始まった・終わった（最後の音を鳴らした、または止めた）。 */
      readonly onChange: (playing: boolean) => void;
    },
  ) {}

  get playing(): boolean {
    return this.current !== undefined;
  }

  /** weapon の試聴を最初から始める。試聴の途中なら止めてから始める。 */
  start(weapon: Pick<WeaponData, 'pattern' | 'magSize' | 'rpm'>, output: PreviewOutput): void {
    this.cancel();
    const cues = previewCues(weapon);
    if (cues.length === 0) return;
    const { clock } = this.options;
    const run = { tones: [] as ScheduledTone[] };
    this.current = run;
    const startedAt = clock.now();
    const lastAt = (cues[cues.length - 1] as PreviewCue).time;
    // 押した時点の音の時計。音を鳴らせるようになった時点で、ページの時計の経過から逆算して決める。
    let audioStart: number | undefined;
    let next = 0;
    const tick = () => {
      if (this.current !== run) return;
      const elapsed = clock.now() - startedAt;
      if (audioStart === undefined) {
        const audioNow = output.now();
        if (audioNow !== undefined) audioStart = audioNow - elapsed;
      }
      // 音を鳴らせないあいだに時刻が来た音は鳴らさずに進める。
      for (; next < cues.length && (cues[next] as PreviewCue).time <= elapsed + PREVIEW_LOOKAHEAD; next += 1) {
        const cue = cues[next] as PreviewCue;
        const tone = audioStart === undefined ? undefined : output.schedule(cue.direction, audioStart + cue.time);
        if (tone) run.tones.push(tone);
      }
      if (elapsed >= lastAt) {
        this.current = undefined;
        this.options.onChange(false);
        return;
      }
      clock.requestFrame(tick);
    };
    this.options.onChange(true);
    clock.requestFrame(tick);
  }

  /** 試聴を止める。試聴していなければ何もしない。 */
  stop(): void {
    if (!this.playing) return;
    this.cancel();
    this.options.onChange(false);
  }

  private cancel(): void {
    for (const tone of this.current?.tones ?? []) tone.cancel();
    this.current = undefined;
  }
}

/** Web Audio の AudioParam の、音に使う部分。 */
interface ParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
}

interface NodeLike {
  connect(destination: unknown): unknown;
  disconnect(): void;
}

/** Web Audio の AudioContext の、音に使う部分。テストでは偽物を渡す。 */
export interface AudioContextLike {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  resume(): Promise<unknown>;
  createOscillator(): NodeLike & {
    type: string;
    readonly frequency: ParamLike;
    start(when?: number): void;
    stop(when?: number): void;
  };
  createGain(): NodeLike & { readonly gain: ParamLike };
}

/** ブラウザの AudioContext を作る。Web Audio が使えない環境、作れないときは undefined。 */
export function browserAudioContext(): AudioContextLike | undefined {
  const scope = globalThis as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike };
  const Context = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Context) return undefined;
  try {
    return new Context();
  } catch {
    return undefined;
  }
}

/**
 * 向きの音を Web Audio で合成して鳴らす。ブラウザの自動再生の制限に合わせ、最初のクリック・キー・パッドのボタンの押し下げで
 * unlock を呼ぶまでは AudioContext を作らず、鳴らさない。Web Audio が使えないとき・ブラウザが音を許さないあいだ
 * （AudioContext が running でない）も鳴らさず、例外を外に出さない。
 */
export class DirectionSound {
  private context: AudioContextLike | undefined;
  private unlocked = false;

  constructor(private readonly createContext: () => AudioContextLike | undefined = browserAudioContext) {}

  /** 利用者の操作のあとに呼ぶ。何度呼んでもよい。 */
  unlock(): void {
    try {
      if (!this.unlocked) {
        this.unlocked = true;
        this.context = this.createContext();
      }
      const context = this.context;
      if (context && context.state !== 'running') context.resume().catch(() => {});
    } catch {
      // 音が使えなくても画面と練習は続ける。
    }
  }

  /** 音の時計（AudioContext.currentTime）の今の時刻（秒）。音を鳴らせないあいだ（操作の前・ブラウザが許さない・Web Audio がない）は undefined。 */
  now(): number | undefined {
    const context = this.context;
    return context && context.state === 'running' ? context.currentTime : undefined;
  }

  /** direction の向きの音を、音量 volume（0〜100）に比例した大きさで今すぐ 1 回鳴らす。 */
  play(direction: string, volume: number): void {
    this.schedule(direction, volume);
  }

  /**
   * direction の向きの音を、音量 volume（0〜100）に比例した大きさで、音の時計の when 秒（省略時は今）に 1 回鳴らす。
   * 鳴らせないときは undefined を返す。
   */
  schedule(direction: string, volume: number, when?: number): ScheduledTone | undefined {
    const tone = DIRECTION_TONES[direction];
    const context = this.context;
    if (!tone || !context || context.state !== 'running' || volume <= 0) return undefined;
    try {
      const peak = (MAX_TONE_GAIN * Math.min(100, volume)) / 100;
      const start = Math.max(context.currentTime, when ?? 0);
      const end = start + TONE_DURATION;
      const oscillator = context.createOscillator();
      oscillator.type = tone.wave;
      oscillator.frequency.value = tone.frequency;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak, start + TONE_FADE);
      gain.gain.setValueAtTime(peak, end - TONE_FADE);
      gain.gain.linearRampToValueAtTime(0, end);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(end);
      return {
        cancel: () => {
          try {
            oscillator.stop(0);
            gain.disconnect();
          } catch {
            // 止められなくても練習と画面は続ける。
          }
        },
      };
    } catch {
      // 鳴らせなくても練習は続ける。
      return undefined;
    }
  }
}
