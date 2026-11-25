import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '../../src/input/actions';
import { attachMouse } from '../../src/input/mouse';

/** DOM のない環境で、document とキャンバスを EventTarget で代用する。 */
class FakeDocument extends EventTarget {
  pointerLockElement: unknown = null;
}

const mouse = (type: string, button: number): Event => Object.assign(new Event(type), { button });

describe('マウスのボタン', () => {
  let doc: FakeDocument;
  let canvas: EventTarget & { requestPointerLock: () => Promise<void> };
  let actions: Action[];
  let detach: () => void;

  const lock = () => {
    doc.pointerLockElement = canvas;
    doc.dispatchEvent(new Event('pointerlockchange'));
  };
  const unlock = () => {
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
  };

  beforeEach(() => {
    doc = new FakeDocument();
    vi.stubGlobal('document', doc);
    canvas = Object.assign(new EventTarget(), { requestPointerLock: () => Promise.resolve() });
    actions = [];
    detach = attachMouse(canvas as unknown as HTMLCanvasElement, {
      emit: (action) => actions.push(action),
      sensitivity: () => 1,
    });
  });

  afterEach(() => {
    detach();
    vi.unstubAllGlobals();
  });

  it('ロック中に押して離すと fire の押下と解放を積む', () => {
    lock();
    doc.dispatchEvent(mouse('mousedown', 0));
    doc.dispatchEvent(mouse('mouseup', 0));
    expect(actions).toEqual([
      { type: 'fire', pressed: true },
      { type: 'fire', pressed: false },
    ]);
  });

  it('ロックしていないときの押下は積まない', () => {
    doc.dispatchEvent(mouse('mousedown', 0));
    doc.dispatchEvent(mouse('mouseup', 0));
    expect(actions).toEqual([]);
  });

  it('押したままロックが外れると fire・ads を離した扱いにし、そのあとの mouseup で重ねて積まない', () => {
    lock();
    doc.dispatchEvent(mouse('mousedown', 0));
    doc.dispatchEvent(mouse('mousedown', 2));
    unlock();
    doc.dispatchEvent(mouse('mouseup', 0));
    doc.dispatchEvent(mouse('mouseup', 2));
    expect(actions).toEqual([
      { type: 'fire', pressed: true },
      { type: 'ads', pressed: true },
      { type: 'fire', pressed: false },
      { type: 'ads', pressed: false },
    ]);
  });

  it('ロックが外れたあとに離した mouseup も解放として積む（pointerlockchange より先に届いた場合）', () => {
    lock();
    doc.dispatchEvent(mouse('mousedown', 2));
    doc.pointerLockElement = null;
    doc.dispatchEvent(mouse('mouseup', 2));
    doc.dispatchEvent(new Event('pointerlockchange'));
    expect(actions).toEqual([
      { type: 'ads', pressed: true },
      { type: 'ads', pressed: false },
    ]);
  });
});
