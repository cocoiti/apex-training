import { describe, expect, it } from 'vitest';
import type { Action } from '../../src/input/actions';
import { inputMethodLabel, InputSwitch, type InputPreference } from '../../src/input/input-switch';

function setup(initial: InputPreference = 'auto') {
  let preference = initial;
  const emitted: { action: Action; time: number | undefined }[] = [];
  const inputs = new InputSwitch({ preference: () => preference, emit: (action, time) => emitted.push({ action, time }) });
  return {
    inputs,
    emitted,
    actions: () => emitted.map((e) => e.action),
    setPreference: (next: InputPreference) => {
      preference = next;
    },
  };
}

const fire = (pressed: boolean): Action => ({ type: 'fire', pressed });
const ads = (pressed: boolean): Action => ({ type: 'ads', pressed });
const look: Action = { type: 'look', yaw: 1, pitch: 0 };

describe('今の入力方式', () => {
  it('INP-11: 自動で、どちらのデバイスもまだ操作していないときはマウス', () => {
    const { inputs } = setup('auto');
    expect(inputs.current).toBe('mouse');
  });

  it('INP-1: 自動のとき、マウスで撃ったあとにパッドを操作するとパッドになる', () => {
    const { inputs } = setup('auto');
    inputs.activity('mouse');
    inputs.input('mouse', fire(true));
    inputs.activity('pad');
    expect(inputs.current).toBe('pad');
  });

  it('INP-9: 自動のとき、パッドで撃ったあとにマウスを操作するとマウスになる', () => {
    const { inputs } = setup('auto');
    inputs.activity('pad');
    inputs.input('pad', fire(true));
    inputs.activity('mouse');
    expect(inputs.current).toBe('mouse');
  });

  it('固定しているときは、もう一方のデバイスを操作しても変わらない', () => {
    const pad = setup('pad');
    pad.inputs.activity('mouse');
    expect(pad.inputs.current).toBe('pad');
    const mouse = setup('mouse');
    mouse.inputs.activity('pad');
    expect(mouse.inputs.current).toBe('mouse');
  });

  it('固定から自動に戻すと、最後に操作したデバイスになる', () => {
    const { inputs, setPreference } = setup('mouse');
    inputs.activity('pad');
    setPreference('auto');
    expect(inputs.current).toBe('pad');
  });

  it('HUD の文字はマウス・パッド', () => {
    expect([inputMethodLabel('mouse'), inputMethodLabel('pad')]).toEqual(['マウス', 'パッド']);
  });
});

describe('アクションの振り分け', () => {
  it('INP-2: マウスに固定しているとき、パッドの look・fire・ads は積まない', () => {
    const { inputs, actions } = setup('mouse');
    inputs.activity('pad');
    inputs.input('pad', look);
    inputs.input('pad', fire(true));
    inputs.input('pad', ads(true));
    expect(actions()).toEqual([]);
    inputs.input('mouse', fire(true));
    expect(actions()).toEqual([fire(true)]);
  });

  it('INP-10: パッドに固定しているとき、マウスの look・fire は積まない', () => {
    const { inputs, actions } = setup('pad');
    inputs.activity('mouse');
    inputs.input('mouse', look);
    inputs.input('mouse', fire(true));
    expect(actions()).toEqual([]);
    expect(inputs.current).toBe('pad');
  });

  it('INP-13: マウスで撃っている間にパッドを操作すると、マウスの fire・ads を離し、そのあとのマウスの入力は積まない', () => {
    const { inputs, actions } = setup('auto');
    inputs.activity('mouse');
    inputs.input('mouse', fire(true));
    inputs.input('mouse', ads(true));
    inputs.activity('pad');
    expect(actions()).toEqual([fire(true), ads(true), fire(false), ads(false)]);
    inputs.input('mouse', look);
    inputs.input('mouse', fire(false));
    expect(actions()).toHaveLength(4);
  });

  it('切り替えた操作そのものは新しい入力方式の入力として積む', () => {
    const { inputs, actions } = setup('auto');
    inputs.activity('mouse');
    inputs.input('mouse', fire(true));
    inputs.activity('pad');
    inputs.input('pad', fire(true));
    expect(actions()).toEqual([fire(true), fire(false), fire(true)]);
  });

  it('離しているボタンは切り替えても離す入力を積まない', () => {
    const { inputs, actions } = setup('auto');
    inputs.input('mouse', fire(true));
    inputs.input('mouse', fire(false));
    inputs.activity('pad');
    expect(actions()).toEqual([fire(true), fire(false)]);
  });

  it('同じ入力方式のデバイスを操作しても離す入力を積まない', () => {
    const { inputs, actions } = setup('auto');
    inputs.input('mouse', fire(true));
    inputs.activity('mouse');
    expect(actions()).toEqual([fire(true)]);
  });

  it('時刻を渡したアクションはその時刻で積み、切り替えの解放は activity の時刻で積む', () => {
    const { inputs, emitted } = setup('auto');
    inputs.input('mouse', fire(true));
    inputs.activity('pad', 0.5);
    inputs.input('pad', look, 0.25);
    expect(emitted).toEqual([
      { action: fire(true), time: undefined },
      { action: fire(false), time: 0.5 },
      { action: look, time: 0.25 },
    ]);
  });

  it('resetHeld のあとは、押したままの扱いを忘れて切り替えても離す入力を積まない', () => {
    const { inputs, actions } = setup('auto');
    inputs.input('mouse', fire(true));
    inputs.resetHeld();
    inputs.activity('pad');
    expect(actions()).toEqual([fire(true)]);
  });
});
