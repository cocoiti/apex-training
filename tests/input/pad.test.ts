import { describe, expect, it } from 'vitest';
import type { Action } from '../../src/input/actions';
import { firstConnectedGamepad, isStandardMapping, PadInput, type GamepadLike } from '../../src/input/pad';
import { DEFAULT_PAD_SETTINGS, type PadSettings } from '../../src/input/pad-curve';

const linear: PadSettings = { ...DEFAULT_PAD_SETTINGS, deadzone: 0, outerThreshold: 0, responseCurve: 0 };

function gamepad(
  options: { x?: number; y?: number; r2?: number; l2?: number; a?: boolean; mapping?: string } = {},
): GamepadLike {
  const buttons = Array.from({ length: 17 }, () => ({ value: 0, pressed: false }));
  buttons[0] = { value: options.a ? 1 : 0, pressed: options.a ?? false };
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
  const events: string[] = [];
  const pad = new PadInput({
    emit: (action) => {
      actions.push(action);
      events.push(action.type);
    },
    settings: () => settings,
    onActivity: () => events.push('activity'),
  });
  const activities = () => events.filter((e) => e === 'activity').length;
  return { pad, actions, events, activities };
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

describe('パッドの操作（docs/spec/input.md「入力方式の切替」）', () => {
  it('ボタンを押し始めたときに 1 回だけ操作とみなし、押したままでは重ねない', () => {
    const { pad, activities } = createPad();
    pad.poll(gamepad({ a: true }));
    pad.poll(gamepad({ a: true }));
    expect(activities()).toBe(1);
    pad.poll(gamepad());
    pad.poll(gamepad({ a: true }));
    expect(activities()).toBe(2);
  });

  it('R2 はしきい値以上に押したときだけ操作とみなし、fire を積む前に知らせる', () => {
    const { pad, events } = createPad();
    pad.poll(gamepad({ r2: 0.4 }));
    expect(events).toEqual([]);
    pad.poll(gamepad({ r2: 0.6 }));
    expect(events).toEqual(['activity', 'fire']);
  });

  it('INP-12: デッドゾーン 10% の内側でだけスティックを動かしても操作とみなさない', () => {
    const { pad, activities } = createPad({ ...DEFAULT_PAD_SETTINGS, deadzone: 10 });
    for (const [x, y] of [[0.02, 0.01], [-0.05, 0.05], [0.08, 0], [0, -0.1], [0, 0]] as const) pad.poll(gamepad({ x, y }));
    expect(activities()).toBe(0);
  });

  it('スティックがデッドゾーンの外へ出たときに操作とみなし、外にある間は重ねない', () => {
    const { pad, activities } = createPad({ ...DEFAULT_PAD_SETTINGS, deadzone: 10 });
    pad.poll(gamepad({ x: 0.3 }));
    pad.poll(gamepad({ x: 0.5 }));
    expect(activities()).toBe(1);
    pad.poll(gamepad({ x: 0.05 }));
    pad.poll(gamepad({ y: -0.4 }));
    expect(activities()).toBe(2);
  });

  it('外れたあとにつなぎ直して押しているボタンは、押し始めとみなす', () => {
    const { pad, activities } = createPad();
    pad.poll(gamepad({ a: true }));
    pad.poll(null);
    pad.poll(gamepad({ a: true }));
    expect(activities()).toBe(2);
  });

  it('標準配置でないパッドは操作とみなさない', () => {
    const { pad, activities } = createPad();
    pad.poll(gamepad({ mapping: '', a: true, x: 1 }));
    expect(activities()).toBe(0);
  });
});

describe('ガイドに使う値', () => {
  it('右スティックの値をデッドゾーンをかける前のまま、上を正にして返す。名前は Gamepad API の id', () => {
    const { pad } = createPad({ ...DEFAULT_PAD_SETTINGS, deadzone: 10 });
    expect(pad.stickValue).toEqual({ x: 0, y: 0 });
    expect(pad.name).toBeUndefined();
    pad.poll({ ...gamepad({ x: 0.05, y: 0.04 }), id: 'Xbox Wireless Controller' });
    expect(pad.stickValue).toEqual({ x: 0.05, y: -0.04 });
    expect(pad.name).toBe('Xbox Wireless Controller');
  });

  it('外れたら中心に戻し、名前を忘れる。id が空文字なら名前は分からない', () => {
    const { pad } = createPad();
    pad.poll({ ...gamepad({ x: 0.5 }), id: 'DualSense' });
    pad.poll(null);
    expect(pad.stickValue).toEqual({ x: 0, y: 0 });
    expect(pad.name).toBeUndefined();
    pad.poll({ ...gamepad(), id: '' });
    expect(pad.name).toBeUndefined();
  });
});
