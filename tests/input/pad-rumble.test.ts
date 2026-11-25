import { describe, expect, it } from 'vitest';
import { canRumble, rumbleShot, SHOT_RUMBLE } from '../../src/input/pad-rumble';

describe('1 発ごとの振動', () => {
  it('PAD-8: 長さ 60 ミリ秒・強い側 0.2・弱い側 0.5 の dual-rumble を 1 回要求する', () => {
    const calls: unknown[][] = [];
    const pad = { vibrationActuator: { playEffect: (...args: unknown[]) => void calls.push(args) } };
    expect(canRumble(pad)).toBe(true);
    expect(rumbleShot(pad)).toBe(true);
    expect(calls).toEqual([['dual-rumble', { duration: 60, strongMagnitude: 0.2, weakMagnitude: 0.5 }]]);
    expect(SHOT_RUMBLE).toEqual({ duration: 60, strongMagnitude: 0.2, weakMagnitude: 0.5 });
  });

  it('PAD-23: vibrationActuator も playEffect もないパッドでは何もせず、エラーにしない', () => {
    expect(canRumble({})).toBe(false);
    expect(canRumble({ vibrationActuator: null })).toBe(false);
    expect(canRumble({ vibrationActuator: {} })).toBe(false);
    expect(rumbleShot({})).toBe(false);
    expect(rumbleShot({ vibrationActuator: {} })).toBe(false);
  });

  it('要求が例外になっても、拒否された Promise を返しても投げない', async () => {
    const throwing = {
      vibrationActuator: {
        playEffect: () => {
          throw new Error('not allowed');
        },
      },
    };
    expect(() => rumbleShot(throwing)).not.toThrow();
    expect(rumbleShot(throwing)).toBe(false);
    const rejected = Promise.reject(new Error('busy'));
    const rejecting = { vibrationActuator: { playEffect: () => rejected } };
    expect(rumbleShot(rejecting)).toBe(true);
    await expect(rejected).rejects.toThrow('busy');
  });

  it('playEffect は vibrationActuator のメソッドとして呼ぶ', () => {
    const actuator = {
      called: false,
      playEffect(this: { called: boolean }) {
        this.called = true;
      },
    };
    rumbleShot({ vibrationActuator: actuator });
    expect(actuator.called).toBe(true);
  });
});
