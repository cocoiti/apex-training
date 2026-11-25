/** 1 発ごとの振動（docs/spec/pad.md「振動」）。 */
export const SHOT_RUMBLE = { duration: 60, strongMagnitude: 0.2, weakMagnitude: 0.5 } as const;

/** Gamepad API の vibrationActuator のうち、振動に使う部分。ブラウザやパッドによってはない。 */
export interface RumbleTarget {
  readonly vibrationActuator?: {
    playEffect?: (type: 'dual-rumble', params: { duration: number; strongMagnitude: number; weakMagnitude: number }) => unknown;
  } | null;
}

/** パッドとブラウザが dual-rumble の振動に対応するか。 */
export function canRumble(pad: RumbleTarget): boolean {
  return typeof pad.vibrationActuator?.playEffect === 'function';
}

/**
 * 弾 1 発分の振動を要求する。対応しないとき・要求が失敗したとき（例外・拒否された Promise）は何もしない。
 * 要求を出したら true。
 */
export function rumbleShot(pad: RumbleTarget): boolean {
  const actuator = pad.vibrationActuator;
  if (!actuator || typeof actuator.playEffect !== 'function') return false;
  try {
    const result = actuator.playEffect('dual-rumble', { ...SHOT_RUMBLE });
    if (result instanceof Promise) result.catch(() => {});
    return true;
  } catch {
    return false;
  }
}
