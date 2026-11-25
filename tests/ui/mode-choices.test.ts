import { describe, expect, it } from 'vitest';
import { modes } from '../../src/modes/registry';
import { fillModeSelect } from '../../src/ui/mode-choices';
import { createFakeSelect } from './fake-select';

describe('fillModeSelect', () => {
  it('モードを渡した順に option にし、最初のモードを選ぶ', () => {
    const { select, element } = createFakeSelect();
    fillModeSelect(select, [
      { id: 'center', name: 'センター維持' },
      { id: 'ghost', name: '反復練習' },
    ]);
    expect(element.children.map((o) => ({ tag: o.tagName, value: o.value, text: o.textContent }))).toEqual([
      { tag: 'OPTION', value: 'center', text: 'センター維持' },
      { tag: 'OPTION', value: 'ghost', text: '反復練習' },
    ]);
    expect(element.value).toBe('center');
  });

  it('登録されたモードがすべて選択肢に出る', () => {
    const { select, element } = createFakeSelect();
    fillModeSelect(select, modes);
    expect(element.children.map((o) => o.value)).toEqual(modes.map((m) => m.id));
    expect(element.value).toBe(modes[0]?.id);
  });

  it('MODE-27: トップ画面の選択肢は「反復練習」「センター維持」だけで、「反復練習」を選ぶ', () => {
    const { select, element } = createFakeSelect();
    fillModeSelect(select, modes);
    expect(element.children.map((o) => o.textContent)).toEqual(['反復練習', 'センター維持']);
    expect(element.value).toBe('ghost');
  });

  it('前の選択肢を消してから入れる', () => {
    const { select, element } = createFakeSelect();
    fillModeSelect(select, [{ id: 'a', name: 'A' }]);
    fillModeSelect(select, [{ id: 'b', name: 'B' }]);
    expect(element.children.map((o) => o.value)).toEqual(['b']);
  });
});
