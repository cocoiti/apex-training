import { describe, expect, it } from 'vitest';
import type { GamepadLike } from '../../src/input/pad';
import { keyControl, PadButtons } from '../../src/input/screen-controls';

const key = (code: string, extra: Partial<{ repeat: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
  code,
  repeat: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...extra,
});

/** A / ×（ボタン 0）と B / ○（ボタン 1）の押下だけを持つ標準配置のパッド。 */
function pad(a: boolean, b: boolean, mapping = 'standard'): GamepadLike {
  const button = (pressed: boolean) => ({ pressed, value: pressed ? 1 : 0 });
  return { connected: true, mapping, axes: [0, 0, 0, 0], buttons: [button(a), button(b), ...Array.from({ length: 14 }, () => button(false))] };
}

describe('画面の操作のキー', () => {
  it.each([
    ['KeyR', 'r'],
    ['Space', 'space'],
    ['KeyQ', 'q'],
  ])('%s は %s の操作になる', (code, control) => {
    expect(keyControl(key(code))).toBe(control);
  });

  it('ほかのキー、押し続けたときの繰り返し、修飾キーと一緒に押したときは操作にしない', () => {
    expect(keyControl(key('KeyW'))).toBeUndefined();
    expect(keyControl(key('KeyR', { repeat: true }))).toBeUndefined();
    expect(keyControl(key('KeyR', { ctrlKey: true }))).toBeUndefined();
    expect(keyControl(key('KeyR', { metaKey: true }))).toBeUndefined();
    expect(keyControl(key('KeyQ', { altKey: true }))).toBeUndefined();
  });
});

describe('画面の操作のパッドのボタン', () => {
  it('A / × と B / ○ は離した状態から押した状態になったときに 1 回だけ操作になる', () => {
    const buttons = new PadButtons();
    expect(buttons.poll(pad(false, false))).toEqual([]);
    expect(buttons.poll(pad(true, false))).toEqual(['pad-a']);
    expect(buttons.poll(pad(true, false))).toEqual([]);
    expect(buttons.poll(pad(true, true))).toEqual(['pad-b']);
    expect(buttons.poll(pad(false, false))).toEqual([]);
    expect(buttons.poll(pad(true, false))).toEqual(['pad-a']);
  });

  it('UI-37: 押し続けている間は繰り返さず、一度離して押し直すと操作になる', () => {
    const buttons = new PadButtons();
    buttons.poll(pad(false, false));
    expect(buttons.poll(pad(true, false))).toEqual(['pad-a']);
    for (let i = 0; i < 100; i += 1) expect(buttons.poll(pad(true, false))).toEqual([]);
    buttons.poll(pad(false, false));
    expect(buttons.poll(pad(true, false))).toEqual(['pad-a']);
  });

  it('つないだときに押していたボタンは、一度離すまで操作にしない', () => {
    const buttons = new PadButtons();
    expect(buttons.poll(null)).toEqual([]);
    expect(buttons.poll(pad(true, true))).toEqual([]);
    expect(buttons.poll(pad(true, true))).toEqual([]);
    buttons.poll(pad(false, true));
    expect(buttons.poll(pad(true, true))).toEqual(['pad-a']);
  });

  it('標準配置として扱えないパッドと外れたパッドでは操作にしない', () => {
    const buttons = new PadButtons();
    buttons.poll(pad(false, false, ''));
    expect(buttons.poll(pad(true, true, ''))).toEqual([]);
    buttons.poll(pad(false, false));
    buttons.poll(null);
    expect(buttons.poll(pad(true, false))).toEqual([]);
  });
});
