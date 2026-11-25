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

/** 時刻を待って呼ぶもの。ブラウザでは setTimeout と clearTimeout。 */
export interface PreviewTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/**
 * トップ画面の「パターンの音を聞く」（docs/spec/screens.md「音」の「試聴」）。区切りの順に向きの音を鳴らし、
 * 止めたときは残りの音を鳴らさない。鳴らすかどうか（音の設定）は呼ぶ側が決める。
 */
export class SoundPreview {
  private handles: unknown[] = [];

  constructor(
    private readonly options: {
      readonly timers: PreviewTimers;
      /** 試聴が始まった・終わった（最後の音を鳴らした、または止めた）。 */
      readonly onChange: (playing: boolean) => void;
    },
  ) {}

  get playing(): boolean {
    return this.handles.length > 0;
  }

  /** weapon の試聴を最初から始める。試聴の途中なら止めてから始める。 */
  start(weapon: Pick<WeaponData, 'pattern' | 'magSize' | 'rpm'>, play: (direction: string) => void): void {
    this.cancel();
    const cues = previewCues(weapon);
    if (cues.length === 0) return;
    let left = cues.length;
    this.handles = cues.map((cue) =>
      this.options.timers.set(() => {
        play(cue.direction);
        left -= 1;
        if (left === 0) {
          this.handles = [];
          this.options.onChange(false);
        }
      }, cue.time * 1000),
    );
    this.options.onChange(true);
  }

  /** 試聴を止める。試聴していなければ何もしない。 */
  stop(): void {
    if (!this.playing) return;
    this.cancel();
    this.options.onChange(false);
  }

  private cancel(): void {
    for (const handle of this.handles) this.options.timers.clear(handle);
    this.handles = [];
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

  /** direction の向きの音を、音量 volume（0〜100）に比例した大きさで 1 回鳴らす。 */
  play(direction: string, volume: number): void {
    const tone = DIRECTION_TONES[direction];
    const context = this.context;
    if (!tone || !context || context.state !== 'running' || volume <= 0) return;
    try {
      const peak = (MAX_TONE_GAIN * Math.min(100, volume)) / 100;
      const start = context.currentTime;
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
    } catch {
      // 鳴らせなくても練習は続ける。
    }
  }
}
