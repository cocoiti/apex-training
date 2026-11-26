import { describe, expect, it } from 'vitest';
import { parsePageOptions, parseSeed } from '../../src/ui/page-options';

describe('URL のクエリで決まるテストのための振る舞い', () => {
  it('何も付けないときは描画し、実時間の時計を使う', () => {
    expect(parsePageOptions('')).toEqual({ render: true, manualClock: false, seed: undefined });
    expect(parsePageOptions('?')).toEqual({ render: true, manualClock: false, seed: undefined });
  });

  it('render=off で描画せず、clock=manual でテストから進める時計にする（先頭の ? はなくてもよい）', () => {
    expect(parsePageOptions('?render=off')).toEqual({ render: false, manualClock: false, seed: undefined });
    expect(parsePageOptions('clock=manual')).toEqual({ render: true, manualClock: true, seed: undefined });
    expect(parsePageOptions('?render=off&clock=manual')).toEqual({ render: false, manualClock: true, seed: undefined });
  });

  it.each(['?render=on', '?render=OFF', '?render=', '?clock=real', '?clock=Manual', '?other=1'])('%s はどちらも変えない', (search) => {
    expect(parsePageOptions(search)).toEqual({ render: true, manualClock: false, seed: undefined });
  });

  it('seed=<0 以上 2³² 未満の 10 進の整数> で練習の種をその値に固定し、render・clock と組み合わせられる', () => {
    expect(parsePageOptions('?seed=12345')).toEqual({ render: true, manualClock: false, seed: 12345 });
    expect(parsePageOptions('?render=off&clock=manual&seed=0')).toEqual({ render: false, manualClock: true, seed: 0 });
    expect(parsePageOptions('seed=4294967295').seed).toBe(2 ** 32 - 1);
  });

  it.each(['', '?seed=', '?seed=abc', '?seed=-1', '?seed=1.5', '?seed=4294967296', '?seed=1e3', '?seed=+5', '?seed=%201', '?seed=0x10', '?seed=99999999999999999999'])(
    '%s では種を固定しない',
    (search) => {
      expect(parsePageOptions(search).seed).toBeUndefined();
    },
  );

  it('種の値は数字だけの 10 進で読む（先頭の 0 は無視する）', () => {
    expect(parseSeed('007')).toBe(7);
    expect(parseSeed(null)).toBeUndefined();
  });
});
