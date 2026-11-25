import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedStepLoop } from '../../src/core/loop';
import { ManualTimeSource } from '../../src/core/time';
import type { Action } from '../../src/input/actions';
import { attachMouse, requestRawPointerLock, type PointerLockResult } from '../../src/input/mouse';
import { DEFAULT_MOUSE_SETTINGS, type MouseSettings } from '../../src/input/mouse-sensitivity';
import { InputQueue } from '../../src/input/queue';
import { Simulation } from '../../src/sim/simulation';
import { createWorld } from '../../src/sim/world';
import { vec3 } from '../../src/sim/vec3';

/** DOM のない環境で、document とキャンバスを EventTarget で代用する。 */
class FakeDocument extends EventTarget {
  pointerLockElement: unknown = null;
}

/**
 * ポインターロックを要求できるキャンバス。
 * mode が raw なら何でも受け付け、accelerated なら unadjustedMovement 付きの要求だけを拒否し、failed ならすべて拒否する。
 * legacy は Promise を返さず、イベントだけで結果を知らせる古いブラウザ。
 */
class FakeCanvas extends EventTarget {
  requests: (PointerLockOptions | undefined)[] = [];

  constructor(
    private readonly doc: FakeDocument,
    public mode: PointerLockResult = 'raw',
    private readonly legacy = false,
  ) {
    super();
  }

  requestPointerLock(options?: PointerLockOptions): Promise<void> | undefined {
    this.requests.push(options);
    const ok = this.mode === 'raw' || (this.mode === 'accelerated' && !options?.unadjustedMovement);
    if (this.legacy) {
      queueMicrotask(() => {
        if (ok) this.lockNow();
        else this.doc.dispatchEvent(new Event('pointerlockerror'));
      });
      return undefined;
    }
    if (!ok) {
      // Chrome と同じく、拒否のときも pointerlockerror を出す。
      queueMicrotask(() => this.doc.dispatchEvent(new Event('pointerlockerror')));
      return Promise.reject(new DOMException('拒否', 'NotSupportedError'));
    }
    this.lockNow();
    return Promise.resolve();
  }

  private lockNow(): void {
    this.doc.pointerLockElement = this;
    this.doc.dispatchEvent(new Event('pointerlockchange'));
  }
}

const mouse = (type: string, button: number): Event => Object.assign(new Event(type), { button });
const move = (movementX: number, movementY: number): Event => Object.assign(new Event('mousemove'), { movementX, movementY });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let doc: FakeDocument;

beforeEach(() => {
  doc = new FakeDocument();
  vi.stubGlobal('document', doc);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(options: { mode?: PointerLockResult; legacy?: boolean; settings?: MouseSettings } = {}) {
  const canvas = new FakeCanvas(doc, options.mode, options.legacy);
  const actions: Action[] = [];
  const results: PointerLockResult[] = [];
  const lockChanges: boolean[] = [];
  const detach = attachMouse(canvas as unknown as HTMLCanvasElement, {
    emit: (action) => actions.push(action),
    settings: () => options.settings ?? DEFAULT_MOUSE_SETTINGS,
    onLockResult: (result) => results.push(result),
    onLockChange: (locked) => lockChanges.push(locked),
  });
  const lock = () => {
    doc.pointerLockElement = canvas;
    doc.dispatchEvent(new Event('pointerlockchange'));
  };
  const unlock = () => {
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
  };
  const click = async () => {
    canvas.dispatchEvent(new Event('click'));
    await flush();
  };
  return { canvas, actions, results, lockChanges, detach, lock, unlock, click };
}

describe('ポインターロックの要求', () => {
  it('MOU-1: 加速を外したポインターロックに対応していれば unadjustedMovement 付きで 1 回だけ要求し、raw になる', async () => {
    const { canvas, results, lockChanges, click, detach } = setup({ mode: 'raw' });
    await click();
    expect(canvas.requests).toEqual([{ unadjustedMovement: true }]);
    expect(results).toEqual(['raw']);
    expect(lockChanges).toEqual([true]);
    detach();
  });

  it('MOU-2: unadjustedMovement 付きの要求だけを拒否されたら通常のポインターロックを要求し直し、accelerated になる', async () => {
    const { canvas, results, lockChanges, click, detach } = setup({ mode: 'accelerated' });
    await click();
    expect(canvas.requests).toEqual([{ unadjustedMovement: true }, undefined]);
    expect(results).toEqual(['accelerated']);
    expect(lockChanges).toEqual([true]);
    expect(doc.pointerLockElement).toBe(canvas);
    detach();
  });

  it('MOU-7: すべての要求を拒否されたら failed になり、もう一度クリックするとまた要求する', async () => {
    const { canvas, results, lockChanges, click, detach } = setup({ mode: 'failed' });
    await click();
    expect(results).toEqual(['failed']);
    expect(lockChanges).toEqual([]);
    canvas.mode = 'raw';
    await click();
    expect(results).toEqual(['failed', 'raw']);
    expect(canvas.requests).toHaveLength(3);
    detach();
  });

  it('要求の結果が出る前に重ねてクリックしても要求を重ねない', async () => {
    const { canvas, click, detach } = setup({ mode: 'accelerated' });
    canvas.dispatchEvent(new Event('click'));
    await click();
    expect(canvas.requests).toHaveLength(2);
    detach();
  });

  it('Promise を返さないブラウザでは、イベントで結果を判断し、ロックできても accelerated とする', async () => {
    const legacy = new FakeCanvas(doc, 'raw', true);
    await expect(requestRawPointerLock(legacy as unknown as HTMLCanvasElement)).resolves.toBe('accelerated');
    const rejected = new FakeCanvas(doc, 'failed', true);
    doc.pointerLockElement = null;
    await expect(requestRawPointerLock(rejected as unknown as HTMLCanvasElement)).resolves.toBe('failed');
    expect(rejected.requests).toEqual([{ unadjustedMovement: true }, undefined]);
  });

  it('要求そのものが例外を投げたら次の要求に進む', async () => {
    let calls = 0;
    const canvas = {
      requestPointerLock: () => {
        calls += 1;
        throw new Error('対応していない');
      },
    };
    await expect(requestRawPointerLock(canvas as unknown as HTMLCanvasElement)).resolves.toBe('failed');
    expect(calls).toBe(2);
  });
});

describe('マウスの移動', () => {
  it('MOU-5: 感度 2.0 で水平に 1000 カウント動かすとヨーが 44 度の look を積む', () => {
    const { actions, lock, detach } = setup({ settings: { ...DEFAULT_MOUSE_SETTINGS, sensitivity: 2 } });
    lock();
    doc.dispatchEvent(move(1000, 0));
    expect(actions).toHaveLength(1);
    const look = actions[0];
    expect(look?.type).toBe('look');
    if (look?.type !== 'look') return;
    expect(look.yaw).toBeCloseTo(44, 9);
    expect(look.pitch).toBe(0);
    detach();
  });

  it('MOU-6: 感度 2.0・ADS 倍率 0.5 で右ボタンを押している間は 1000 カウントでヨーが 22 度', () => {
    const { actions, lock, detach } = setup({ settings: { dpi: 800, sensitivity: 2, adsMultiplier: 0.5 } });
    lock();
    doc.dispatchEvent(mouse('mousedown', 2));
    doc.dispatchEvent(move(1000, 0));
    doc.dispatchEvent(mouse('mouseup', 2));
    doc.dispatchEvent(move(1000, 0));
    const yaws = actions.flatMap((a) => (a.type === 'look' ? [a.yaw] : []));
    expect(yaws[0]).toBeCloseTo(22, 9);
    expect(yaws[1]).toBeCloseTo(44, 9);
    detach();
  });

  it('MOU-10: 感度 2.0 で前に 1000 カウント動かすとピッチが 44 度増える look を積む', () => {
    const { actions, lock, detach } = setup({ settings: { ...DEFAULT_MOUSE_SETTINGS, sensitivity: 2 } });
    lock();
    doc.dispatchEvent(move(0, -1000));
    const look = actions[0];
    if (look?.type !== 'look') throw new Error('look がない');
    expect(look.pitch).toBeCloseTo(44, 9);
    detach();
  });

  it('MOU-11: 設定していないときは既定値で換算し、水平に 1000 カウントでヨーが 33 度', () => {
    const { actions, lock, detach } = setup();
    lock();
    doc.dispatchEvent(move(1000, 0));
    const look = actions[0];
    if (look?.type !== 'look') throw new Error('look がない');
    expect(look.yaw).toBeCloseTo(33, 9);
    detach();
  });

  it('ロックしていないときの移動と、動きのない移動は積まない', () => {
    const { actions, lock, detach } = setup();
    doc.dispatchEvent(move(1000, 0));
    lock();
    doc.dispatchEvent(move(0, 0));
    expect(actions).toEqual([]);
    detach();
  });
});

describe('マウスのボタン', () => {
  it('ロック中に押して離すと fire の押下と解放を積む', () => {
    const { actions, lock, detach } = setup();
    lock();
    doc.dispatchEvent(mouse('mousedown', 0));
    doc.dispatchEvent(mouse('mouseup', 0));
    expect(actions).toEqual([
      { type: 'fire', pressed: true },
      { type: 'fire', pressed: false },
    ]);
    detach();
  });

  it('ロックしていないときの押下は積まない', () => {
    const { actions, detach } = setup();
    doc.dispatchEvent(mouse('mousedown', 0));
    doc.dispatchEvent(mouse('mouseup', 0));
    expect(actions).toEqual([]);
    detach();
  });

  it('押したままロックが外れると fire・ads を離した扱いにしてから外れたことを知らせ、そのあとの mouseup で重ねて積まない', () => {
    const order: string[] = [];
    const canvas = new FakeCanvas(doc);
    const detach = attachMouse(canvas as unknown as HTMLCanvasElement, {
      emit: (action) => order.push(`${action.type}:${'pressed' in action ? String(action.pressed) : ''}`),
      settings: () => DEFAULT_MOUSE_SETTINGS,
      onLockChange: (locked) => order.push(`lock:${String(locked)}`),
    });
    doc.pointerLockElement = canvas;
    doc.dispatchEvent(new Event('pointerlockchange'));
    doc.dispatchEvent(mouse('mousedown', 0));
    doc.dispatchEvent(mouse('mousedown', 2));
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
    doc.dispatchEvent(mouse('mouseup', 0));
    doc.dispatchEvent(mouse('mouseup', 2));
    expect(order).toEqual(['lock:true', 'fire:true', 'ads:true', 'fire:false', 'ads:false', 'lock:false']);
    detach();
  });

  it('ロックが外れたあとに離した mouseup も解放として積む（pointerlockchange より先に届いた場合）', () => {
    const { actions, lock, detach } = setup();
    lock();
    doc.dispatchEvent(mouse('mousedown', 2));
    doc.pointerLockElement = null;
    doc.dispatchEvent(mouse('mouseup', 2));
    doc.dispatchEvent(new Event('pointerlockchange'));
    expect(actions).toEqual([
      { type: 'ads', pressed: true },
      { type: 'ads', pressed: false },
    ]);
    detach();
  });

  it('右クリックのメニューを出さない', () => {
    const { canvas, detach } = setup();
    const event = new Event('contextmenu', { cancelable: true });
    canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    detach();
  });
});

describe('マウスの操作（docs/spec/input.md「入力方式の切替」）', () => {
  it('ロック中の移動とボタンの押下を、アクションを積む前に操作として知らせる', () => {
    const order: string[] = [];
    const canvas = new FakeCanvas(doc);
    const detach = attachMouse(canvas as unknown as HTMLCanvasElement, {
      emit: (action) => order.push(action.type),
      settings: () => DEFAULT_MOUSE_SETTINGS,
      onActivity: () => order.push('activity'),
    });
    doc.dispatchEvent(move(10, 0));
    doc.dispatchEvent(mouse('mousedown', 0));
    expect(order).toEqual([]);
    doc.pointerLockElement = canvas;
    doc.dispatchEvent(new Event('pointerlockchange'));
    doc.dispatchEvent(move(0, 0));
    doc.dispatchEvent(move(10, 0));
    doc.dispatchEvent(mouse('mousedown', 0));
    doc.dispatchEvent(mouse('mousedown', 1));
    doc.dispatchEvent(mouse('mouseup', 0));
    expect(order).toEqual(['activity', 'look', 'activity', 'fire', 'activity', 'fire']);
    detach();
  });
});

describe('一時停止と再開', () => {
  /** main.ts と同じつなぎ方で、ループ・シミュレーション・マウスをつなぐ。 */
  function practice() {
    const world = createWorld({
      id: 'test',
      name: 'test',
      spawn: { position: vec3(0, 1.6, 0), aim: { yaw: 0, pitch: 0 } },
      boxes: [{ id: 'wall', kind: 'wall', center: vec3(0, 1.6, -10.1), size: vec3(100, 100, 0.2) }],
    });
    const input = new InputQueue();
    const sim = new Simulation(world, input);
    const time = new ManualTimeSource();
    const loop = new FixedStepLoop({ timeSource: time, update: () => sim.step(), render: () => {} });
    const canvas = new FakeCanvas(doc);
    const detach = attachMouse(canvas as unknown as HTMLCanvasElement, {
      emit: (action) => input.push(loop.currentTime(), action),
      settings: () => DEFAULT_MOUSE_SETTINGS,
      onLockChange: (locked) => (locked ? loop.resume() : loop.pause()),
    });
    const frames = (count: number) => {
      for (let i = 0; i < count; i += 1) {
        time.advance(1 / 60);
        loop.frame();
      }
    };
    return { world, sim, loop, canvas, detach, frames };
  }

  it('MOU-3: ロックが外れると練習が止まり、もう一度クリックしてロックすると再開する', async () => {
    const { sim, loop, canvas, detach, frames } = practice();
    canvas.dispatchEvent(new Event('click'));
    await flush();
    frames(30);
    expect(sim.stepCount).toBe(60);
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
    expect(loop.paused).toBe(true);
    frames(60);
    expect(sim.stepCount).toBe(60);
    canvas.dispatchEvent(new Event('click'));
    await flush();
    expect(loop.paused).toBe(false);
    frames(30);
    expect(sim.stepCount).toBe(120);
    detach();
  });

  it('MOU-8: 一時停止中に左ボタンを押したまま移動しても照準は変わらず、再開しても fire にならない', async () => {
    const { world, sim, canvas, detach, frames } = practice();
    canvas.dispatchEvent(new Event('click'));
    await flush();
    frames(6);
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
    doc.dispatchEvent(mouse('mousedown', 0));
    doc.dispatchEvent(move(500, -300));
    frames(30);
    expect(world.player.aim).toEqual({ yaw: 0, pitch: 0 });
    expect(world.player.fire).toBe(false);
    canvas.dispatchEvent(new Event('click'));
    await flush();
    frames(30);
    expect(world.player.aim).toEqual({ yaw: 0, pitch: 0 });
    expect(world.player.fire).toBe(false);
    expect(sim.stepCount).toBe(72);
    detach();
  });
});
