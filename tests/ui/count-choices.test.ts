import { afterEach, describe, expect, it } from 'vitest';
import { fillCountSelect, relabelCountSelect } from '../../src/ui/count-choices';
import { setLanguage } from '../../src/ui/i18n';
import { createFakeSelect } from './fake-select';

afterEach(() => setLanguage('ja'));

describe('回数の選択肢', () => {
  it('UI-31: 1・5・10・20 を並べ、1 を選んだ状態にする', () => {
    const { select, element } = createFakeSelect();
    fillCountSelect(select);
    expect(element.children.map((o) => [o.tagName, o.value, o.textContent])).toEqual([
      ['OPTION', '1', '1 回'],
      ['OPTION', '5', '5 回'],
      ['OPTION', '10', '10 回'],
      ['OPTION', '20', '20 回'],
    ]);
    expect(element.value).toBe('1');
  });

  it('言語を選び直して名前を書き直すと、名前が新しい言語になり、選んでいた回数は変わらない', () => {
    const { select, element } = createFakeSelect();
    fillCountSelect(select);
    element.value = '5';
    setLanguage('en');
    relabelCountSelect(select);
    expect(element.children.map((o) => [o.value, o.textContent])).toEqual([
      ['1', '1'],
      ['5', '5'],
      ['10', '10'],
      ['20', '20'],
    ]);
    expect(element.value).toBe('5');
    setLanguage('ja');
    relabelCountSelect(select);
    expect(element.children.map((o) => o.textContent)).toEqual(['1 回', '5 回', '10 回', '20 回']);
    expect(element.value).toBe('5');
  });
});
