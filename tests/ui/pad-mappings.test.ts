import { describe, expect, it } from 'vitest';
import { choosePad } from '../../src/input/pad-layout';
import { assignmentText, MappingAutoOpen, mappingTarget, PadMappingScreen, PadMappingStore } from '../../src/ui/pad-mappings';
import { loadPadMappings } from '../../src/ui/settings';
import { SafeStorage } from '../../src/ui/storage';

function memory() {
  const items = new Map<string, string>();
  const backing = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  } as Storage;
  return { items, page: () => new SafeStorage(() => backing) };
}

function fakePad(index: number, mapping: string, id = `pad ${index}`) {
  return {
    id,
    index,
    connected: true,
    mapping,
    axes: [0, 0, 0, 0, 0, 0],
    buttons: Array.from({ length: 12 }, () => ({ value: 0, pressed: false })),
  };
}

type FakePad = ReturnType<typeof fakePad>;

function press(pad: FakePad, index: number, down: boolean): void {
  pad.buttons[index] = { value: down ? 1 : 0, pressed: down };
}

/** 4 つの項目を、ボタン 5 を fire・ボタン 4 を ads・軸 2 を左右・軸 5（反転）を上下に割り当てる。 */
function assignAll(screen: PadMappingScreen<FakePad>, pad: FakePad): void {
  screen.frame([pad]);
  screen.start('fire');
  press(pad, 5, true);
  screen.frame([pad]);
  press(pad, 5, false);
  screen.start('ads');
  press(pad, 4, true);
  screen.frame([pad]);
  press(pad, 4, false);
  screen.start('lookX');
  pad.axes[2] = 0.9;
  screen.frame([pad]);
  pad.axes[2] = 0;
  screen.start('lookY');
  pad.axes[5] = 0.9;
  screen.frame([pad]);
  pad.axes[5] = 0;
}

describe('ボタン割り当て画面', () => {
  it('対象は接続している標準配置でないパッドのうち番号が最も小さいもの。ないときは undefined', () => {
    const a = fakePad(3, '');
    const b = fakePad(1, '');
    expect(mappingTarget([fakePad(0, 'standard'), a, b])).toBe(b);
    expect(mappingTarget([fakePad(0, 'standard')])).toBeUndefined();
    const screen = new PadMappingScreen<FakePad>(new PadMappingStore(memory().page()));
    expect(screen.frame([fakePad(0, 'standard')]).target).toBeUndefined();
  });

  it('PAD-3: 「割り当てる」を押してから操作すると割り当てが決まり、4 つそろうと保存して使えるパッドになる', () => {
    const storage = memory();
    const store = new PadMappingStore(storage.page());
    const screen = new PadMappingScreen<FakePad>(store);
    const pad = fakePad(0, '', 'odd');
    expect(screen.frame([pad])).toEqual({
      target: 'odd',
      items: { fire: '未割り当て', ads: '未割り当て', lookX: '未割り当て', lookY: '未割り当て' },
      saved: false,
    });
    screen.start('lookX');
    expect(screen.frame([pad]).items.lookX).toBe('右に倒してください');
    pad.axes[2] = 0.9;
    expect(screen.frame([pad]).items.lookX).toBe('軸 2');
    pad.axes[2] = 0;
    screen.start('lookY');
    expect(screen.frame([pad]).items.lookY).toBe('上に倒してください');

    const fresh = new PadMappingScreen<FakePad>(store);
    assignAll(fresh, pad);
    const state = fresh.frame([pad]);
    expect(state.saved).toBe(true);
    expect(state.items).toEqual({ fire: 'ボタン 5', ads: 'ボタン 4', lookX: '軸 2', lookY: '軸 5（反転）' });
    expect(choosePad([pad], store.get)).toMatchObject({ kind: 'using', pad });
  });

  it('PAD-27: 保存した割り当ては読み直しても残り、「割り当てを消す」で標準配置でないパッドの扱いに戻る', () => {
    const storage = memory();
    const pad = fakePad(0, '', 'odd');
    assignAll(new PadMappingScreen<FakePad>(new PadMappingStore(storage.page())), pad);

    const reloaded = new PadMappingStore(storage.page());
    expect(reloaded.get('odd')).toEqual({ fire: 5, ads: 4, lookX: { axis: 2, invert: false }, lookY: { axis: 5, invert: true } });
    expect(choosePad([pad], reloaded.get).kind).toBe('using');
    const screen = new PadMappingScreen<FakePad>(reloaded);
    expect(screen.frame([pad]).items.fire).toBe('ボタン 5');

    screen.clear();
    const state = screen.frame([pad]);
    expect(state.saved).toBe(false);
    expect(state.items.fire).toBe('未割り当て');
    expect(choosePad([pad], reloaded.get).kind).toBe('nonstandard');
    expect(loadPadMappings(storage.page())).toEqual({});
  });

  it('4 つそろう前に画面を離れると、途中の割り当ては保存しない', () => {
    const storage = memory();
    const store = new PadMappingStore(storage.page());
    const screen = new PadMappingScreen<FakePad>(store);
    const pad = fakePad(0, '', 'odd');
    screen.frame([pad]);
    screen.start('fire');
    press(pad, 5, true);
    screen.frame([pad]);
    screen.leave();
    expect(screen.frame([pad]).items.fire).toBe('未割り当て');
    expect(store.get('odd')).toBeUndefined();
  });

  it('保存済みのパッドで 1 項目だけ割り当て直すと、その項目だけが変わって保存される', () => {
    const storage = memory();
    const store = new PadMappingStore(storage.page());
    store.save('odd', { fire: 0, ads: 1, lookX: { axis: 2, invert: false }, lookY: { axis: 3, invert: false } });
    const screen = new PadMappingScreen<FakePad>(store);
    const pad = fakePad(0, '', 'odd');
    screen.frame([pad]);
    screen.start('fire');
    press(pad, 5, true);
    const state = screen.frame([pad]);
    expect(state.items).toEqual({ fire: 'ボタン 5', ads: 'ボタン 1', lookX: '軸 2', lookY: '軸 3' });
    expect(state.saved).toBe(true);
    expect(new PadMappingStore(storage.page()).get('odd')).toEqual({
      fire: 5,
      ads: 1,
      lookX: { axis: 2, invert: false },
      lookY: { axis: 3, invert: false },
    });
    expect(choosePad([pad], store.get)).toMatchObject({ kind: 'using', pad });

    // 4 つそろう前に離れても、保存した割り当ての表示に戻る。
    screen.start('ads');
    screen.leave();
    expect(screen.frame([pad]).items).toEqual({ fire: 'ボタン 5', ads: 'ボタン 1', lookX: '軸 2', lookY: '軸 3' });
  });

  it('割り当てた番号の表示', () => {
    expect(assignmentText('fire', {})).toBe('未割り当て');
    expect(assignmentText('ads', { ads: 0 })).toBe('ボタン 0');
    expect(assignmentText('lookY', { lookY: { axis: 1, invert: false } })).toBe('軸 1');
  });
});

describe('ボタン割り当て画面を自動で開く', () => {
  it('PAD-3: トップ画面で、標準配置でない割り当てのないパッドだけがあり、そのボタンを押したら 1 回だけ開く', () => {
    const auto = new MappingAutoOpen();
    const pad = fakePad(0, '', 'odd');
    expect(auto.check('top', [pad], false)).toBe(false);
    press(pad, 2, true);
    expect(auto.check('top', [pad], false)).toBe(true);
    expect(auto.check('top', [pad], false)).toBe(false);
    expect(auto.check('settings', [pad], false)).toBe(false);
  });

  it('練習中などトップ画面と設定画面のほかでは開かず、使えるパッドがあれば開かない', () => {
    const auto = new MappingAutoOpen();
    const pad = fakePad(0, '', 'odd');
    press(pad, 2, true);
    expect(auto.check('play', [pad], false)).toBe(false);
    expect(auto.check('settings-pad', [pad], false)).toBe(false);
    expect(auto.check('top', [pad], true)).toBe(false);
    expect(auto.check('settings', [pad], false)).toBe(true);
  });
});
