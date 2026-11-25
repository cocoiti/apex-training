import type { Action } from './actions';
import { countsToLook, type MouseSettings } from './mouse-sensitivity';

/**
 * ポインターロックの要求の結果（docs/spec/mouse.md「ポインターロックと生入力」）。
 * raw は加速を外したポインターロック、accelerated は通常のポインターロック（加速が効いている可能性がある）、
 * failed はどちらも拒否された。
 */
export type PointerLockResult = 'raw' | 'accelerated' | 'failed';

/** 1 回の要求の結果。promise は Promise で成功を知らされた、event は pointerlockchange で知らされた。 */
type Attempt = 'promise' | 'event' | 'rejected';

/**
 * ポインターロックを 1 回要求する。
 * Promise を返すブラウザでは Promise だけで判断する（前の要求の pointerlockerror を次の要求の失敗と取り違えないため）。
 * Promise を返さない古いブラウザでは pointerlockchange・pointerlockerror で判断する。
 */
function tryPointerLock(canvas: HTMLCanvasElement, options?: PointerLockOptions): Promise<Attempt> {
  return new Promise((resolve) => {
    let returned: Promise<void> | undefined;
    try {
      returned = (options ? canvas.requestPointerLock(options) : canvas.requestPointerLock()) as Promise<void> | undefined;
    } catch {
      resolve('rejected');
      return;
    }
    if (returned && typeof returned.then === 'function') {
      returned.then(
        () => resolve('promise'),
        () => resolve('rejected'),
      );
      return;
    }
    const done = (attempt: Attempt) => {
      document.removeEventListener('pointerlockchange', onChange);
      document.removeEventListener('pointerlockerror', onError);
      resolve(attempt);
    };
    const onChange = () => {
      if (document.pointerLockElement === canvas) done('event');
    };
    const onError = () => done('rejected');
    document.addEventListener('pointerlockchange', onChange);
    document.addEventListener('pointerlockerror', onError);
  });
}

/**
 * 加速を外したポインターロック（unadjustedMovement 付き）を要求し、拒否されたら通常のポインターロックを要求し直す。
 * Promise を返さないブラウザは unadjustedMovement にも対応していない（オプションを無視する）とみなし、
 * ロックできても accelerated とする。
 */
export async function requestRawPointerLock(canvas: HTMLCanvasElement): Promise<PointerLockResult> {
  const raw = await tryPointerLock(canvas, { unadjustedMovement: true });
  if (raw === 'promise') return 'raw';
  if (raw === 'event') return 'accelerated';
  return (await tryPointerLock(canvas)) === 'rejected' ? 'failed' : 'accelerated';
}

export interface MouseOptions {
  /** アクションを積む。時刻は呼び出し側で付ける。 */
  emit: (action: Action) => void;
  /** ロック中のマウスの操作（移動、ボタンの押下）。アクションを積む前に呼ぶ（docs/spec/input.md「入力方式の切替」）。 */
  onActivity?: () => void;
  settings: () => Readonly<MouseSettings>;
  /** キャンバスのクリックで要求したポインターロックの結果。 */
  onLockResult?: (result: PointerLockResult) => void;
  /** ポインターロックが掛かった・外れたとき。外れたときは fire・ads の解放を積んだあとに呼ぶ。 */
  onLockChange?: (locked: boolean) => void;
}

/**
 * キャンバスのクリックで加速を外したポインターロックを要求し、移動量を感度・ADS 倍率で換算して look、
 * 左ボタンを fire、右ボタンを ads にする（docs/spec/mouse.md）。外すための関数を返す。
 */
export function attachMouse(canvas: HTMLCanvasElement, options: MouseOptions): () => void {
  const locked = () => document.pointerLockElement === canvas;
  let requesting = false;
  let detached = false;

  const onClick = () => {
    if (locked() || requesting) return;
    requesting = true;
    void requestRawPointerLock(canvas).then((result) => {
      requesting = false;
      if (!detached) options.onLockResult?.(result);
    });
  };
  // 押している間に積んだボタン。離す側はロックの有無にかかわらず通し、押したままにならないようにする。
  const held = { fire: false, ads: false };
  const onMove = (event: MouseEvent) => {
    if (!locked()) return;
    if (event.movementX === 0 && event.movementY === 0) return;
    options.onActivity?.();
    // ADS 中かはマウスの右ボタンで判断する。
    const look = countsToLook(event.movementX, event.movementY, options.settings(), held.ads);
    options.emit({ type: 'look', ...look });
  };
  const buttonType = (button: number): 'fire' | 'ads' | undefined =>
    button === 0 ? 'fire' : button === 2 ? 'ads' : undefined;
  const release = (type: 'fire' | 'ads') => {
    if (!held[type]) return;
    held[type] = false;
    options.emit({ type, pressed: false });
  };
  const onDown = (event: MouseEvent) => {
    if (!locked()) return;
    options.onActivity?.();
    const type = buttonType(event.button);
    if (!type || held[type]) return;
    held[type] = true;
    options.emit({ type, pressed: true });
  };
  const onUp = (event: MouseEvent) => {
    const type = buttonType(event.button);
    if (type) release(type);
  };
  // ロックが外れたら、押したままのボタンを離した扱いにする（ロックの外で離しても mouseup が届かないことがある）。
  let wasLocked = locked();
  const onLockChange = () => {
    const now = locked();
    if (!now) {
      release('fire');
      release('ads');
    }
    if (now === wasLocked) return;
    wasLocked = now;
    options.onLockChange?.(now);
  };
  const onContextMenu = (event: Event) => event.preventDefault();

  canvas.addEventListener('click', onClick);
  canvas.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mousedown', onDown);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('pointerlockchange', onLockChange);

  return () => {
    detached = true;
    canvas.removeEventListener('click', onClick);
    canvas.removeEventListener('contextmenu', onContextMenu);
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mousedown', onDown);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('pointerlockchange', onLockChange);
  };
}
