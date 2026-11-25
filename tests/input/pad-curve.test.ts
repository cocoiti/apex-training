import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAD_SETTINGS,
  DEFAULT_SIMPLE_PAD_SETTINGS,
  lookRate,
  simpleToAdvanced,
  stickAmount,
  stickPosition,
  type PadSettings,
} from '../../src/input/pad-curve';

const linear: PadSettings = { ...DEFAULT_PAD_SETTINGS, deadzone: 0, outerThreshold: 0, responseCurve: 0 };

describe('スティックの入力量', () => {
  it('デッドゾーン以下は 0、1 − 外側しきい値 以上は 1', () => {
    const s = { ...DEFAULT_PAD_SETTINGS, deadzone: 10, outerThreshold: 2 };
    expect(stickAmount(0.08, s)).toBe(0);
    expect(stickAmount(0.1, s)).toBe(0);
    expect(stickAmount(0.98, s)).toBe(1);
    expect(stickAmount(1.2, s)).toBe(1);
  });

  it('リニアでは正規化した傾きのまま、カーブ 8 では 2 乗になる', () => {
    expect(stickAmount(0.5, linear)).toBeCloseTo(0.5, 12);
    const classic = { ...DEFAULT_PAD_SETTINGS, deadzone: 10, outerThreshold: 2, responseCurve: 8 };
    expect(stickAmount(0.54, classic)).toBeCloseTo(0.25, 12);
  });

  it('デッドゾーンと外側しきい値の和が 100% 以上でも NaN にならない', () => {
    const s = { ...DEFAULT_PAD_SETTINGS, deadzone: 60, outerThreshold: 50 };
    expect(stickAmount(0.5, s)).toBe(0);
    expect(stickAmount(0.7, s)).toBe(1);
  });
});

describe('回転速度', () => {
  it('倒した向きのまま大きさだけを入力量にし、最大回転速度を掛ける', () => {
    const rate = lookRate(Math.SQRT1_2, Math.SQRT1_2, linear, false);
    expect(rate.yaw).toBeCloseTo(Math.SQRT1_2 * 300, 9);
    expect(rate.pitch).toBeCloseTo(Math.SQRT1_2 * 260, 9);
  });

  it('ADS 中は ADS の最大回転速度を使う', () => {
    expect(lookRate(1, 0, linear, true).yaw).toBeCloseTo(90, 12);
    expect(lookRate(0, -1, linear, true).pitch).toBeCloseTo(-78, 12);
  });

  it('中心では 0', () => {
    expect(lookRate(0, 0, linear, false)).toEqual({ yaw: 0, pitch: 0 });
  });
});

describe('簡易設定', () => {
  it('PAD-10: 視点感度 2・ADS 感度 5・リニアは対応表の値になる', () => {
    expect(simpleToAdvanced({ look: 2, ads: 5, curve: 'linear' })).toEqual({
      yaw: 180,
      pitch: 156,
      adsYaw: 105,
      adsPitch: 91,
      responseCurve: 0,
      deadzone: 10,
      outerThreshold: 2,
    });
  });

  it.each([
    [1, 120, 104, 45, 39],
    [2, 180, 156, 60, 52],
    [3, 240, 208, 75, 65],
    [4, 300, 260, 90, 78],
    [5, 360, 312, 105, 91],
    [6, 420, 364, 120, 104],
  ])('PAD-10: 感度 %i の行が対応表のとおり', (level, yaw, pitch, adsYaw, adsPitch) => {
    const s = simpleToAdvanced({ look: level, ads: level, curve: 'classic' });
    expect(s).toMatchObject({ yaw, pitch, adsYaw, adsPitch, responseCurve: 8, deadzone: 10, outerThreshold: 2 });
  });

  it('初期値（視点感度 4・ADS 感度 4）の速度は詳細設定の既定値と同じ', () => {
    const s = simpleToAdvanced(DEFAULT_SIMPLE_PAD_SETTINGS);
    expect(s).toMatchObject({
      yaw: DEFAULT_PAD_SETTINGS.yaw,
      pitch: DEFAULT_PAD_SETTINGS.pitch,
      adsYaw: DEFAULT_PAD_SETTINGS.adsYaw,
      adsPitch: DEFAULT_PAD_SETTINGS.adsPitch,
    });
  });

  it('範囲外の感度は 1〜6 に収める', () => {
    expect(simpleToAdvanced({ look: 0, ads: 9, curve: 'linear' })).toMatchObject({ yaw: 120, adsYaw: 120 });
  });
});

describe('カーブの逆', () => {
  const alc = (responseCurve: number): PadSettings => ({ ...DEFAULT_PAD_SETTINGS, deadzone: 10, outerThreshold: 2, responseCurve });

  it.each([
    ['リニア', 0],
    ['クラシック', 8],
  ])('PAD-15: %s で、最大回転速度より遅い回転速度を位置に直して式に通すと元の速度に戻る（腰撃ち・ADS）', (_, curve) => {
    const settings = alc(curve);
    const rates = [
      { yaw: 75, pitch: 0 },
      { yaw: 0, pitch: -40 },
      { yaw: -120, pitch: 90 },
      { yaw: 3, pitch: 2 },
      { yaw: 200, pitch: -150 },
    ];
    for (const ads of [false, true]) {
      const scale = ads ? 0.25 : 1;
      for (const rate of rates) {
        const target = { yaw: rate.yaw * scale, pitch: rate.pitch * scale };
        const { x, y } = stickPosition(target, settings, ads);
        const back = lookRate(x, y, settings, ads);
        expect(back.yaw).toBeCloseTo(target.yaw, 9);
        expect(back.pitch).toBeCloseTo(target.pitch, 9);
      }
    }
  });

  it('PAD-16: クラシック・ヨー速度 300 で右 75 度/秒は右に 54%、回転速度 0 は中心', () => {
    const settings = { ...alc(8), yaw: 300 };
    const position = stickPosition({ yaw: 75, pitch: 0 }, settings, false);
    expect(position.x).toBeCloseTo(0.54, 12);
    expect(position.y).toBe(0);
    expect(stickPosition({ yaw: 0, pitch: 0 }, settings, false)).toEqual({ x: 0, y: 0 });
  });

  it('最大回転速度より速いときは同じ向きに倒し切った位置（1 − 外側しきい値）になる', () => {
    const position = stickPosition({ yaw: 600, pitch: 520 }, alc(8), false);
    expect(Math.hypot(position.x, position.y)).toBeCloseTo(0.98, 12);
    expect(position.x).toBeCloseTo(position.y, 12);
  });

  it('ADS 中は ADS の最大回転速度で割る', () => {
    expect(stickPosition({ yaw: 90, pitch: 0 }, linear, true).x).toBeCloseTo(1, 12);
    expect(stickPosition({ yaw: 90, pitch: 0 }, linear, false).x).toBeCloseTo(0.3, 12);
  });

  it('最大回転速度が 0 の軸に 0 でない速度を求めたときは、その軸の成分を 0 にする', () => {
    const settings = { ...linear, pitch: 0 };
    expect(stickPosition({ yaw: 150, pitch: 50 }, settings, false)).toEqual({ x: 0.5, y: 0 });
    expect(stickPosition({ yaw: 0, pitch: 50 }, settings, false)).toEqual({ x: 0, y: 0 });
  });
});
