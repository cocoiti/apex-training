import { describe, expect, it } from 'vitest';
import {
  choosePad,
  layoutFor,
  MappingCapture,
  PAD_MISSING_MESSAGE,
  PAD_NONSTANDARD_MESSAGE,
  padStatusText,
  shortPadName,
  STANDARD_PAD_LAYOUT,
  type PadLayout,
} from '../../src/input/pad-layout';

interface FakePad {
  id: string;
  index: number;
  connected: boolean;
  mapping: string;
  axes: number[];
  buttons: { value: number; pressed: boolean }[];
}

function fakePad(index: number, mapping: string, id = `pad ${index}`, connected = true): FakePad {
  return {
    id,
    index,
    connected,
    mapping,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })),
  };
}

const mapped: PadLayout = { fire: 1, ads: 0, lookX: { axis: 3, invert: false }, lookY: { axis: 4, invert: true } };

describe('入力に使うパッド', () => {
  it('PAD-2: 接続しているパッドが 1 つもなければ「見つからない」', () => {
    const status = choosePad([null, fakePad(1, 'standard', 'gone', false)], () => undefined);
    expect(status).toEqual({ kind: 'missing' });
    expect(padStatusText(status)).toBe(PAD_MISSING_MESSAGE);
    expect(PAD_MISSING_MESSAGE).toBe('パッドが見つかりません。パッドのボタンを押してください');
  });

  it('PAD-18: 標準配置でない割り当てのないパッドだけなら「標準配置でない」と、そのパッドの名前', () => {
    const odd = fakePad(0, '', 'Generic USB Joystick (Vendor: 0079 Product: 0006)');
    const status = choosePad([odd], () => undefined);
    expect(status).toEqual({ kind: 'nonstandard', pad: odd });
    expect(padStatusText(status)).toBe(`${PAD_NONSTANDARD_MESSAGE}: Generic USB Joystick (Vendor: 0079 Product: 0006)`);
    expect(padStatusText(status, true)).toBe(`${PAD_NONSTANDARD_MESSAGE}: Generic USB Joystick`);
    expect(PAD_NONSTANDARD_MESSAGE).toBe('標準配置でないパッドです（ボタン割り当てが必要）');
  });

  it('PAD-19: 番号 0 が標準配置でなく割り当てなし、番号 1 が標準配置なら、番号 1 を使う', () => {
    const odd = fakePad(0, '');
    const xbox = fakePad(1, 'standard', 'Xbox Wireless Controller (STANDARD GAMEPAD)');
    const status = choosePad([odd, xbox], () => undefined);
    expect(status).toEqual({ kind: 'using', pad: xbox, layout: STANDARD_PAD_LAYOUT });
    expect(padStatusText(status, true)).toBe('Xbox Wireless Controller');
  });

  it('PAD-21: 割り当てを保存した標準配置でないパッドは使えるパッドになり、割り当てで読む', () => {
    const odd = fakePad(0, '', 'odd');
    const mappings = (id: string) => (id === 'odd' ? mapped : undefined);
    expect(choosePad([odd], mappings)).toEqual({ kind: 'using', pad: odd, layout: mapped });
    expect(layoutFor(odd, mappings)).toBe(mapped);
    expect(layoutFor(fakePad(1, 'standard', 'odd'), mappings)).toBe(STANDARD_PAD_LAYOUT);
  });

  it('使えるパッドのうち番号が最も小さいものを、並びによらず選ぶ', () => {
    const a = fakePad(2, 'standard');
    const b = fakePad(1, 'standard');
    expect(choosePad([a, b], () => undefined)).toMatchObject({ kind: 'using', pad: b });
  });

  it('外れたパッドは使わない', () => {
    const gone = fakePad(0, 'standard', 'gone', false);
    const odd = fakePad(1, '');
    expect(choosePad([gone, odd], () => undefined)).toEqual({ kind: 'nonstandard', pad: odd });
  });
});

describe('HUD のパッドの名前', () => {
  it('最初の「 (」より前を出す', () => {
    expect(shortPadName('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')).toBe(
      'DualSense Wireless Controller',
    );
    expect(shortPadName('Pad')).toBe('Pad');
  });

  it('32 文字を超えるときは 31 文字と「…」', () => {
    const name = 'a'.repeat(40);
    expect(shortPadName(name)).toBe(`${'a'.repeat(31)}…`);
    expect([...shortPadName(name)]).toHaveLength(32);
    expect(shortPadName('b'.repeat(32))).toBe('b'.repeat(32));
  });
});

describe('ボタン割り当ての操作', () => {
  it('PAD-3: fire・ads はしきい値以上になった最初のボタン、軸は絶対値 0.5 以上になった最初の軸', () => {
    const pad = fakePad(0, '');
    const capture = new MappingCapture();
    capture.start('fire', pad);
    expect(capture.pending).toBe('fire');
    pad.buttons[3] = { value: 0.4, pressed: true };
    expect(capture.poll(pad)).toBeUndefined();
    pad.buttons[3] = { value: 0.6, pressed: true };
    expect(capture.poll(pad)).toBe('fire');
    pad.buttons[3] = { value: 0, pressed: false };

    capture.start('ads', pad);
    pad.buttons[2] = { value: 1, pressed: true };
    expect(capture.poll(pad)).toBe('ads');
    pad.buttons[2] = { value: 0, pressed: false };

    capture.start('lookX', pad);
    pad.axes = [0, 0, 0.7, 0];
    expect(capture.poll(pad)).toBe('lookX');
    pad.axes = [0, 0, 0, 0];

    capture.start('lookY', pad);
    pad.axes = [0, 0, 0, -0.8];
    expect(capture.poll(pad)).toBe('lookY');

    expect(capture.layout).toEqual({
      fire: 3,
      ads: 2,
      lookX: { axis: 2, invert: false },
      lookY: { axis: 3, invert: false },
    });
  });

  it('右に倒して値が負なら左右を、上に倒して値が正なら上下を反転する', () => {
    const pad = fakePad(0, '');
    const capture = new MappingCapture();
    capture.start('lookX', pad);
    pad.axes = [-0.9, 0, 0, 0];
    capture.poll(pad);
    pad.axes = [0, 0, 0, 0];
    capture.start('lookY', pad);
    pad.axes = [0, 0.9, 0, 0];
    capture.poll(pad);
    expect(capture.assignment).toEqual({ lookX: { axis: 0, invert: true }, lookY: { axis: 1, invert: true } });
  });

  it('「割り当てる」を押した時点でしきい値以上のボタン・軸は、一度戻るまで数えない', () => {
    const pad = fakePad(0, '');
    // 離していても −1 を報告するトリガーの軸。
    pad.axes = [0, 0, 0, 0, -1];
    pad.buttons[0] = { value: 1, pressed: true };
    const capture = new MappingCapture();
    capture.start('fire', pad);
    expect(capture.poll(pad)).toBeUndefined();
    pad.buttons[0] = { value: 0, pressed: false };
    expect(capture.poll(pad)).toBeUndefined();
    pad.buttons[0] = { value: 1, pressed: true };
    expect(capture.poll(pad)).toBe('fire');
    expect(capture.assignment.fire).toBe(0);

    capture.start('lookX', pad);
    expect(capture.poll(pad)).toBeUndefined();
    pad.axes = [0.6, 0, 0, 0, -1];
    expect(capture.poll(pad)).toBe('lookX');
    expect(capture.assignment.lookX).toEqual({ axis: 0, invert: false });
  });

  it('4 つの項目がそろうまでは配置にならず、reset で忘れる', () => {
    const pad = fakePad(0, '');
    const capture = new MappingCapture();
    capture.start('fire', pad);
    pad.buttons[5] = { value: 1, pressed: true };
    capture.poll(pad);
    expect(capture.layout).toBeUndefined();
    capture.reset();
    expect(capture.assignment).toEqual({});
    expect(capture.poll(pad)).toBeUndefined();
  });
});
