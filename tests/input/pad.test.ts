import { describe, expect, it } from 'vitest';
import type { Action } from '../../src/input/actions';
import { firstConnectedGamepad, isStandardMapping, PadInput, type GamepadLike } from '../../src/input/pad';
import { DEFAULT_PAD_SETTINGS, type PadSettings } from '../../src/input/pad-curve';

const linear: PadSettings = { ...DEFAULT_PAD_SETTINGS, deadzone: 0, outerThreshold: 0, responseCurve: 0 };

function gamepad(options: { x?: number; y?: number; r2?: number; l2?: number; mapping?: string } = {}): GamepadLike {
  const buttons = Array.from({ length: 17 }, () => ({ value: 0, pressed: false }));
  buttons[7] = { value: options.r2 ?? 0, pressed: (options.r2 ?? 0) > 0 };
  buttons[6] = { value: options.l2 ?? 0, pressed: (options.l2 ?? 0) > 0 };
  return {
    connected: true,
    mapping: options.mapping ?? 'standard',
    axes: [0, 0, options.x ?? 0, options.y ?? 0],
    buttons,
  };
}

function createPad(settings: PadSettings = linear) {
  const actions: Action[] = [];
  const pad = new PadInput({ emit: (action) => actions.push(action), settings: () => settings });
  return { pad, actions };
}

describe('パッドの配置', () => {
  it('PAD-11: mapping が "standard" なら標準配置、空文字なら標準配置でない', () => {
    expect(isStandardMapping({ mapping: 'standard' })).toBe(true);
    expect(isStandardMapping({ mapping: '' })).toBe(false);
  });

  it('PAD-11: 標準配置でないパッドの R2 とスティックは読まない', () => {
    const { pad, actions } = createPad();
    pad.poll(gamepad({ mapping: '', x: 1, r2: 1 }));
    expect(pad.active).toBe(false);
    expect(actions).toEqual([]);
    expect(pad.step(1 / 120)).toBeUndefined();
  });

  it('つながっているパッドのうち最初のものを選ぶ', () => {
    const a = { ...gamepad(), connected: false };
    const b = gamepad();
    expect(firstConnectedGamepad([null, a, b])).toBe(b);
    expect(firstConnectedGamepad([null])).toBeNull();
  });
});

describe('トリガー', () => {
  it('PAD-7: R2 が 0.4 では fire が出ず、0.6 では出る', () => {
    const { pad, actions } = createPad();
    pad.poll(gamepad({ r2: 0.4 }));
    expect(actions).toEqual([]);
    pad.poll(gamepad({ r2: 0.6 }));
    expect(actions).toEqual([{ type: 'fire', pressed: true }]);
  });

  it('押したままの間は重ねて積まず、しきい値を下回ったら離す', () => {
    const { pad, actions } = createPad();
    pad.poll(gamepad({ r2: 0.6, l2: 1 }));
    pad.poll(gamepad({ r2: 0.9, l2: 1 }));
    pad.poll(gamepad({ r2: 0.2, l2: 1 }));
    expect(actions).toEqual([
      { type: 'fire', pressed: true },
      { type: 'ads', pressed: true },
      { type: 'fire', pressed: false },
    ]);
  });

  it('パッドが外れたら fire・ads を離し、look を止める', () => {
    const { pad, actions } = createPad();
    pad.poll(gamepad({ x: 1, r2: 1, l2: 1 }));
    pad.poll(null);
    expect(actions).toEqual([
      { type: 'fire', pressed: true },
      { type: 'ads', pressed: true },
      { type: 'fire', pressed: false },
      { type: 'ads', pressed: false },
    ]);
    expect(pad.step(1 / 120)).toBeUndefined();
  });
});

describe('固定ステップごとの look', () => {
  it('最後に読んだスティックの値から、ステップの長さを掛けた角度を返す', () => {
    const { pad } = createPad();
    pad.poll(gamepad({ x: 1 }));
    expect(pad.step(0.5)).toEqual({ type: 'look', yaw: 150, pitch: 0 });
  });

  it('Gamepad API の上（負の値）はピッチの正になる', () => {
    const { pad } = createPad();
    pad.poll(gamepad({ y: -1 }));
    const look = pad.step(1);
    expect(look?.pitch).toBeCloseTo(260, 9);
    expect(look?.yaw).toBeCloseTo(0, 9);
  });

  it('L2 を押している間は ADS の速度を使う', () => {
    const { pad } = createPad();
    pad.poll(gamepad({ x: 1, l2: 1 }));
    expect(pad.step(1)?.yaw).toBeCloseTo(90, 9);
  });

  it('PAD-4: デッドゾーン 10% で傾き 8% なら look を出さない', () => {
    const { pad } = createPad({ ...DEFAULT_PAD_SETTINGS, deadzone: 10 });
    pad.poll(gamepad({ x: 0.08 }));
    expect(pad.step(1 / 120)).toBeUndefined();
  });
});
