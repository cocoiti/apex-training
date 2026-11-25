import type { Action } from './actions';

/** Apex の感度の換算の係数（度 / カウント / 感度）。docs/spec/mouse.md */
export const DEGREES_PER_COUNT = 0.022;

export interface MouseOptions {
  /** アクションを積む。時刻は呼び出し側で付ける。 */
  emit: (action: Action) => void;
  sensitivity: () => number;
}

/**
 * キャンバスのクリックでポインターロックし、移動量を look、左ボタンを fire、右ボタンを ads にする。
 * 生入力・加速の警告・一時停止は docs/spec/mouse.md の Issue で足す。外すための関数を返す。
 */
export function attachMouse(canvas: HTMLCanvasElement, options: MouseOptions): () => void {
  const locked = () => document.pointerLockElement === canvas;

  const onClick = () => {
    if (!locked()) void canvas.requestPointerLock();
  };
  const onMove = (event: MouseEvent) => {
    if (!locked()) return;
    const k = options.sensitivity() * DEGREES_PER_COUNT;
    if (event.movementX === 0 && event.movementY === 0) return;
    options.emit({ type: 'look', yaw: event.movementX * k, pitch: -event.movementY * k });
  };
  // 押している間に積んだボタン。離す側はロックの有無にかかわらず通し、押したままにならないようにする。
  const held = { fire: false, ads: false };
  const buttonType = (button: number): 'fire' | 'ads' | undefined =>
    button === 0 ? 'fire' : button === 2 ? 'ads' : undefined;
  const release = (type: 'fire' | 'ads') => {
    if (!held[type]) return;
    held[type] = false;
    options.emit({ type, pressed: false });
  };
  const onDown = (event: MouseEvent) => {
    if (!locked()) return;
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
  const onLockChange = () => {
    if (locked()) return;
    release('fire');
    release('ads');
  };
  const onContextMenu = (event: Event) => event.preventDefault();

  canvas.addEventListener('click', onClick);
  canvas.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mousedown', onDown);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('pointerlockchange', onLockChange);

  return () => {
    canvas.removeEventListener('click', onClick);
    canvas.removeEventListener('contextmenu', onContextMenu);
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mousedown', onDown);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('pointerlockchange', onLockChange);
  };
}
