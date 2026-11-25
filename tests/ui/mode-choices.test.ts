import { describe, expect, it } from 'vitest';
import { modes } from '../../src/modes/registry';
import { fillModeSelect } from '../../src/ui/mode-choices';
import { createFakeSelect } from './fake-select';

describe('fillModeSelect', () => {
  it('モードを渡した順に option にし、最初のモードを選ぶ', () => {
    const { select, element } = createFakeSelect();
    fillModeSelect(select, [
      { id: 'pattern', name: 'パターン観察' },
      { id: 'center', name: 'センター維持' },
    ]);
    expect(element.children.map((o) => ({ tag: o.tagName, value: o.value, text: o.textContent }))).toEqual([
      { tag: 'OPTION', value: 'pattern', text: 'パターン観察' },
      { tag: 'OPTION', value: 'center', text: 'センター維持' },
    ]);
    expect(element.value).toBe('pattern');
  });

  it('登録されたモードがすべて選択肢に出る', () => {
    const { select, element } = createFakeSelect();
    fillModeSelect(select, modes);
    expect(element.children.map((o) => o.value)).toEqual(modes.map((m) => m.id));
    expect(element.value).toBe(modes[0]?.id);
  });

  it('前の選択肢を消してから入れる', () => {
    const { select, element } = createFakeSelect();
    fillModeSelect(select, [{ id: 'a', name: 'A' }]);
    fillModeSelect(select, [{ id: 'b', name: 'B' }]);
    expect(element.children.map((o) => o.value)).toEqual(['b']);
  });
});
