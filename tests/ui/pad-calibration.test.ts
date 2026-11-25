import { describe, expect, it } from 'vitest';
import { choosePad, STANDARD_PAD_LAYOUT } from '../../src/input/pad-layout';
import {
  calibrationRadii,
  calibrationTarget,
  formatPadValue,
  padListRows,
  padValueTexts,
  stickPoint,
} from '../../src/ui/pad-calibration';

function fakePad(index: number, mapping: string, id = `pad ${index}`, connected = true) {
  return {
    id,
    index,
    connected,
    mapping,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })),
  };
}

const layout = { fire: 1, ads: 0, lookX: { axis: 0, invert: true }, lookY: { axis: 1, invert: true } };

describe('パッドの一覧', () => {
  it('PAD-26: 番号・名前（省略しない）・配置・標準配置・割り当て・接続・入力を番号の順に出す', () => {
    const xbox = fakePad(2, 'standard', 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)');
    const odd = fakePad(0, '', 'odd');
    const mappedOdd = fakePad(1, '', 'mapped');
    const gone = fakePad(3, 'standard', 'gone', false);
    const mappings = (id: string) => (id === 'mapped' ? layout : undefined);
    const pads = [xbox, null, odd, gone, mappedOdd];
    const rows = padListRows(pads, choosePad(pads, mappings), mappings);
    expect(rows).toEqual([
      ['0', 'odd', '（空）', 'いいえ', 'なし', 'はい', ''],
      ['1', 'mapped', '（空）', 'いいえ', '済み', 'はい', '使用中'],
      ['2', 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', 'standard', 'はい', '—', 'はい', ''],
      ['3', 'gone', 'standard', 'はい', '—', 'いいえ', ''],
    ]);
  });

  it('PAD-25: 番号 0 が標準配置でなく、番号 1 が標準配置なら、番号 1 の行だけに「使用中」', () => {
    const pads = [fakePad(0, ''), fakePad(1, 'standard')];
    const rows = padListRows(pads, choosePad(pads, () => undefined), () => undefined);
    expect(rows.map((row) => row[6])).toEqual(['', '使用中']);
  });

  it('PAD-31: id が空文字のパッドは、名前を「パッド」と出す', () => {
    const pads = [fakePad(0, 'standard', '')];
    const rows = padListRows(pads, choosePad(pads, () => undefined), () => undefined);
    expect(rows[0]?.[1]).toBe('パッド');
  });
});

describe('キャリブレーションの値', () => {
  it('PAD-21: 軸とボタンの生の値を小数第 2 位まで出す', () => {
    const pad = fakePad(0, 'standard');
    pad.axes[2] = 0.6;
    pad.buttons[7] = { value: 0.3, pressed: false };
    const texts = padValueTexts(pad);
    expect(texts.axes).toEqual(['軸 0: 0.00', '軸 1: 0.00', '軸 2: 0.60', '軸 3: 0.00']);
    expect(texts.buttons[7]).toBe('ボタン 7: 0.30');
    expect(texts.buttons).toHaveLength(17);
    expect(formatPadValue(-0.001)).toBe('0.00');
    expect(formatPadValue(-1)).toBe('-1.00');
  });

  it('対象は入力に使うパッド、ないときは番号が最も小さい接続しているパッド', () => {
    const odd = fakePad(0, '');
    const xbox = fakePad(1, 'standard');
    expect(calibrationTarget(choosePad([odd, xbox], () => undefined))?.pad).toBe(xbox);
    expect(calibrationTarget(choosePad([odd], () => undefined))).toEqual({ pad: odd, layout: STANDARD_PAD_LAYOUT });
    expect(calibrationTarget(choosePad([], () => undefined))).toBeUndefined();
  });

  it('右スティックの位置は配置の軸で読み、右と下が正（SVG の座標）、円の外には出さない', () => {
    const pad = fakePad(0, 'standard');
    pad.axes = [0, 0, 0.5, -0.25];
    expect(stickPoint(pad, STANDARD_PAD_LAYOUT)).toEqual({ x: 0.5, y: -0.25 });
    pad.axes = [0, 0, 1, 1];
    const edge = stickPoint(pad, STANDARD_PAD_LAYOUT);
    expect(Math.hypot(edge.x, edge.y)).toBeCloseTo(1, 9);
    // 反転した割り当て: 左右は負が右、上下は正が上。
    pad.axes = [-0.5, 0.5, 0, 0];
    expect(stickPoint(pad, layout)).toEqual({ x: 0.5, y: -0.5 });
  });

  it('PAD-22: デッドゾーンを 10 から 20 に変えると、デッドゾーンの円の半径が 2 倍になる', () => {
    const before = calibrationRadii(10, 2);
    const after = calibrationRadii(20, 2);
    expect(before).toEqual({ deadzone: 0.1, outer: 0.98 });
    expect(after.deadzone / before.deadzone).toBeCloseTo(2, 9);
    expect(after.outer).toBe(before.outer);
  });
});
