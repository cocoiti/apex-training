import { describe, expect, it } from 'vitest';
import { parsePageOptions } from '../../src/ui/page-options';

describe('URL のクエリで決まるテストのための振る舞い', () => {
  it('何も付けないときは描画し、実時間の時計を使う', () => {
    expect(parsePageOptions('')).toEqual({ render: true, manualClock: false });
    expect(parsePageOptions('?')).toEqual({ render: true, manualClock: false });
  });

  it('render=off で描画せず、clock=manual でテストから進める時計にする（先頭の ? はなくてもよい）', () => {
    expect(parsePageOptions('?render=off')).toEqual({ render: false, manualClock: false });
    expect(parsePageOptions('clock=manual')).toEqual({ render: true, manualClock: true });
    expect(parsePageOptions('?render=off&clock=manual')).toEqual({ render: false, manualClock: true });
  });

  it.each(['?render=on', '?render=OFF', '?render=', '?clock=real', '?clock=Manual', '?other=1'])('%s はどちらも変えない', (search) => {
    expect(parsePageOptions(search)).toEqual({ render: true, manualClock: false });
  });
});
