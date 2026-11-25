import { describe, expect, it } from 'vitest';
import type { Action } from '../../src/input/actions';
import { DEFAULT_PAD_SETTINGS } from '../../src/input/pad-curve';
import { PadInput, type GamepadLike } from '../../src/input/pad';
import {
  heldCommands,
  NAV_REPEAT_DELAY_MS,
  NAV_REPEAT_INTERVAL_MS,
  PadNavigator,
  stickDirection,
} from '../../src/input/pad-navigation';

interface PadState {
  /** 押しているボタンの番号。 */
  buttons?: readonly number[];
  /** 軸の値（0〜3）。 */
  axes?: readonly number[];
  mapping?: string;
}

/** 標準配置のパッド。ボタンは 17 個、軸は 4 本。 */
function pad({ buttons = [], axes = [0, 0, 0, 0], mapping = 'standard' }: PadState = {}): GamepadLike {
  return {
    connected: true,
    mapping,
    axes,
    buttons: Array.from({ length: 17 }, (_, i) => {
      const pressed = buttons.includes(i);
      return { pressed, value: pressed ? 1 : 0 };
    }),
  };
}

const DOWN = 13;

describe('左スティックの向き', () => {
  it('大きいほうの成分の絶対値が 0.5 以上でその向き、0.5 より小さければ向きなし（軸 1 は負が上）', () => {
    expect(stickDirection(0, 0.6)).toBe('down');
    expect(stickDirection(0, -0.5)).toBe('up');
    expect(stickDirection(0.7, 0.2)).toBe('right');
    expect(stickDirection(-0.9, 0.6)).toBe('left');
    expect(stickDirection(0, 0.4)).toBeUndefined();
    expect(stickDirection(0.49, -0.49)).toBeUndefined();
  });
});

describe('パッドで押している項目の操作', () => {
  it('十字キー（12〜15）・左スティック・A / ×・B / ○ を読む', () => {
    expect([...heldCommands(pad({ buttons: [12, 15, 0, 1] }))].sort()).toEqual(['back', 'confirm', 'right', 'up']);
    expect([...heldCommands(pad({ axes: [0, 1, 0, 0] }))]).toEqual(['down']);
  });

  it('PAD-33: 右スティック・R2 / RT・L2 / LT は項目の操作にならない', () => {
    expect(heldCommands(pad({ buttons: [6, 7], axes: [0, 0, 1, -1] })).size).toBe(0);
  });
});

describe('パッドでの項目の移動の繰り返し', () => {
  /** 一度何も押していない状態を読ませてから使う（読めるようになったときに押していたものは操作にしない）。 */
  const ready = () => {
    const nav = new PadNavigator();
    nav.poll(pad(), 0);
    return nav;
  };

  it('UI-48: 押し始めに 1 回、0.4 秒たつまでは繰り返さず、そのあと 0.1 秒ごとに 1 回', () => {
    const nav = ready();
    const held = pad({ buttons: [DOWN] });
    const counts: number[] = [];
    // 10 ミリ秒ごとに 1 秒間読む。at(ms) は押し始めから ms ミリ秒までに操作になった数。
    for (let t = 1000; t <= 2000; t += 10) counts.push(nav.poll(held, t).length);
    const at = (ms: number) => counts.slice(0, ms / 10 + 1).reduce((a, b) => a + b, 0);
    expect(at(0)).toBe(1);
    expect(at(NAV_REPEAT_DELAY_MS - 10)).toBe(1);
    expect(at(NAV_REPEAT_DELAY_MS)).toBe(2);
    expect(at(NAV_REPEAT_DELAY_MS + NAV_REPEAT_INTERVAL_MS - 10)).toBe(2);
    expect(at(NAV_REPEAT_DELAY_MS + NAV_REPEAT_INTERVAL_MS)).toBe(3);
    // 0.4 秒・0.5 秒…1.0 秒の 7 回と、押し始めの 1 回。
    expect(at(1000)).toBe(8);
  });

  it('UI-48: 左スティックを下に 0.6 倒すと十字キーの下と同じく移り、0.4 では移らない', () => {
    const nav = ready();
    expect(nav.poll(pad({ axes: [0, 0.4, 0, 0] }), 10)).toEqual([]);
    expect(nav.poll(pad({ axes: [0, 0.6, 0, 0] }), 20)).toEqual(['down']);
    expect(nav.poll(pad({ axes: [0, 0.6, 0, 0] }), 30)).toEqual([]);
  });

  it('A / ×・B / ○ は押し続けても繰り返さない', () => {
    const nav = ready();
    expect(nav.poll(pad({ buttons: [0] }), 10)).toEqual(['confirm']);
    expect(nav.poll(pad({ buttons: [0] }), 2000)).toEqual([]);
    expect(nav.poll(pad({ buttons: [0, 1] }), 2010)).toEqual(['back']);
    expect(nav.poll(pad({ buttons: [1] }), 5000)).toEqual([]);
  });

  it('画面が変わる前から押し続けていたもの（block）は、一度離すまで操作にならない', () => {
    const nav = ready();
    expect(nav.poll(pad({ buttons: [DOWN] }), 10)).toEqual(['down']);
    nav.block();
    expect(nav.poll(pad({ buttons: [DOWN] }), 2000)).toEqual([]);
    expect(nav.poll(pad(), 2010)).toEqual([]);
    expect(nav.poll(pad({ buttons: [DOWN] }), 2020)).toEqual(['down']);
  });

  it('読めるようになったときに押していたものは、一度離すまで操作にならない', () => {
    const nav = new PadNavigator();
    expect(nav.poll(pad({ buttons: [0, DOWN] }), 0)).toEqual([]);
    expect(nav.poll(pad({ buttons: [0, DOWN] }), 1000)).toEqual([]);
    expect(nav.poll(pad({ buttons: [DOWN] }), 1010)).toEqual([]);
    expect(nav.poll(pad({ buttons: [0, DOWN] }), 1020)).toEqual(['confirm']);
  });

  it('UI-54: 標準配置として扱えないパッドは読まない', () => {
    const nav = new PadNavigator();
    expect(nav.poll(pad({ mapping: '' }), 0)).toEqual([]);
    for (const buttons of [[0], [1], [12], [13], [14], [15]]) {
      expect(nav.poll(pad({ mapping: '', buttons }), 10)).toEqual([]);
      expect(nav.poll(pad({ mapping: '' }), 20)).toEqual([]);
    }
    expect(nav.poll(pad({ mapping: '', axes: [1, 1, 0, 0] }), 30)).toEqual([]);
    expect(nav.poll(null, 40)).toEqual([]);
  });
});

describe('PAD-32: 十字キーと左スティックはアクションにならない', () => {
  it('十字キーを押し、左スティックを倒し切っても look・fire・ads を積まない', () => {
    const emitted: Action[] = [];
    const input = new PadInput({ emit: (action) => emitted.push(action), settings: () => DEFAULT_PAD_SETTINGS });
    for (const buttons of [[12], [13], [14], [15], [12, 14], [13, 15]]) {
      input.poll(pad({ buttons, axes: [1, -1, 0, 0] }));
      expect(input.step(1 / 60)).toBeUndefined();
      input.poll(pad({ axes: [-1, 1, 0, 0] }));
      expect(input.step(1 / 60)).toBeUndefined();
    }
    expect(emitted).toEqual([]);
  });
});
