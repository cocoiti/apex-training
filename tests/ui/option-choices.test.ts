import { describe, expect, it } from 'vitest';
import { modes } from '../../src/modes/registry';
import { SPEED_OPTION } from '../../src/modes/tracking';
import type { ModeOption } from '../../src/modes/types';
import { fillOptionSelect, firstModeOption, showOptionChoice } from '../../src/ui/option-choices';
import { createFakeSelect } from './fake-select';

const mode = (id: string) => modes.find((m) => m.id === id)!;

function choiceElements() {
  const { select, element } = createFakeSelect();
  return { element, elements: { select, choice: { hidden: true }, name: { textContent: '' } } };
}

describe('練習の選択肢の欄', () => {
  it('登録されたモードの最初の練習の選択肢は速さ', () => {
    expect(firstModeOption(modes)).toBe(SPEED_OPTION);
    expect(firstModeOption([mode('ghost')])).toBeUndefined();
  });

  it('値を並び順に入れて既定の値（ふつう）を選ぶ', () => {
    const { select, element } = createFakeSelect();
    fillOptionSelect(select, SPEED_OPTION);
    expect(element.children.map((o) => [o.tagName, o.value, o.textContent])).toEqual([
      ['OPTION', 'slow', '遅い'],
      ['OPTION', 'normal', 'ふつう'],
      ['OPTION', 'fast', '速い'],
    ]);
    expect(element.value).toBe('normal');
  });

  it('UI-101: 追いエイムでは欄を出して「ふつう」を選び、追いエイム＋リコイルでも出し、反復練習では隠す', () => {
    const { element, elements } = choiceElements();
    showOptionChoice(elements, mode('ghost'));
    expect(elements.choice.hidden).toBe(true);
    showOptionChoice(elements, mode('tracking'));
    expect(elements.choice.hidden).toBe(false);
    expect(elements.name.textContent).toBe('速さ');
    expect(element.value).toBe('normal');
    showOptionChoice(elements, mode('tracking-recoil'));
    expect(elements.choice.hidden).toBe(false);
    showOptionChoice(elements, mode('ghost'));
    expect(elements.choice.hidden).toBe(true);
  });

  it('UI-102: 選んだ値は、欄を隠しても、同じ選択肢を持つモードに選び直しても残る', () => {
    const { element, elements } = choiceElements();
    showOptionChoice(elements, mode('tracking'));
    element.value = 'fast';
    showOptionChoice(elements, mode('ghost'));
    expect(element.value).toBe('fast');
    showOptionChoice(elements, mode('tracking-recoil'));
    expect(element.value).toBe('fast');
    expect(element.children).toHaveLength(3);
  });

  it('違う選択肢のモードに変えると入れ直し、前の値がなければ既定の値を選ぶ', () => {
    const other: ModeOption = { id: 'size', label: '大きさ', choices: [{ id: 'small', name: '小' }, { id: 'large', name: '大' }], defaultChoice: 'large' };
    const { element, elements } = choiceElements();
    showOptionChoice(elements, mode('tracking'));
    showOptionChoice(elements, { option: other });
    expect(element.children.map((o) => o.value)).toEqual(['small', 'large']);
    expect(element.value).toBe('large');
    expect(elements.name.textContent).toBe('大きさ');
  });
});
