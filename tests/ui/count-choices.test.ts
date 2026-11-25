import { describe, expect, it } from 'vitest';
import { fillCountSelect } from '../../src/ui/count-choices';
import { createFakeSelect } from './fake-select';

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
});
