import { afterEach, describe, expect, it } from 'vitest';
import { FLICK_RANGE_OPTION, FLICK_SIZE_OPTION } from '../../src/modes/aim/flick';
import { modes } from '../../src/modes/registry';
import { SPEED_OPTION } from '../../src/modes/tracking';
import type { ModeOption } from '../../src/modes/types';
import { setLanguage } from '../../src/ui/i18n';
import {
  buildOptionFields,
  fillOptionSelect,
  modeOptionsOf,
  optionFieldValues,
  relabelOptionFields,
  showOptionChoice,
  showOptionFields,
} from '../../src/ui/option-choices';
import { createFakeDocument, createFakeSelect, type FakeElement } from './fake-select';

const mode = (id: string) => modes.find((m) => m.id === id)!;

function choiceElements() {
  const { select, element } = createFakeSelect();
  return { element, elements: { select, choice: { hidden: true }, name: { textContent: '' } } };
}

/** 登録されたモードの選択肢の欄を、DOM の環境なしで作る。 */
function fields(prefix = '') {
  const container = createFakeDocument().createElement('div');
  const built = buildOptionFields(container as unknown as HTMLElement, modeOptionsOf(modes), prefix);
  const select = (id: string) => built.find((f) => f.id === id)!.select as unknown as FakeElement;
  const shown = () => built.filter((f) => !f.choice.hidden).map((f) => f.id);
  return { container, built, select, shown };
}

afterEach(() => setLanguage('ja'));

describe('練習の選択肢の欄', () => {
  it('登録されたモードの練習の選択肢は、id ごとに 1 つずつ、速さ・出る範囲・的の大きさの順', () => {
    expect(modeOptionsOf(modes)).toEqual([SPEED_OPTION, FLICK_RANGE_OPTION, FLICK_SIZE_OPTION]);
    expect(modeOptionsOf([mode('ghost')])).toEqual([]);
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

  it('選択肢ごとに欄を作り、要素の id は選択肢の id（履歴の画面は history- を前に付ける）で、どれも隠して既定の値を選ぶ', () => {
    const top = fields();
    expect(top.container.children.map((c) => (c as unknown as { id: string }).id)).toEqual(['speed-choice', 'flick-range-choice', 'flick-size-choice']);
    expect(top.built.map((f) => (f.select as unknown as { id: string }).id)).toEqual(['speed', 'flick-range', 'flick-size']);
    expect(top.built.map((f) => f.name?.textContent)).toEqual(['速さ', '出る範囲', '的の大きさ']);
    expect(top.shown()).toEqual([]);
    expect(optionFieldValues(top.built)).toEqual({ speed: 'normal', 'flick-range': 'normal', 'flick-size': 'medium' });
    expect(fields('history-').built.map((f) => (f.select as unknown as { id: string }).id)).toEqual(['history-speed', 'history-flick-range', 'history-flick-size']);
  });

  it('UI-101: 追いエイムでは速さの欄だけを出し、追いエイム＋リコイルでも出し、反復練習では隠す', () => {
    const page = fields();
    showOptionFields(page.built, mode('ghost'));
    expect(page.shown()).toEqual([]);
    showOptionFields(page.built, mode('tracking'));
    expect(page.shown()).toEqual(['speed']);
    expect(page.select('speed').value).toBe('normal');
    showOptionFields(page.built, mode('tracking-recoil'));
    expect(page.shown()).toEqual(['speed']);
    showOptionFields(page.built, mode('ghost'));
    expect(page.shown()).toEqual([]);
  });

  it('UI-107: フリックでは出る範囲と的の大きさの欄をこの順に出して「ふつう」「中」を選び、速さの欄は隠す', () => {
    const page = fields();
    showOptionFields(page.built, mode('flick'));
    expect(page.shown()).toEqual(['flick-range', 'flick-size']);
    expect(page.select('flick-range').children.map((o) => o.textContent)).toEqual(['近い', 'ふつう', '遠い']);
    expect(page.select('flick-size').children.map((o) => o.textContent)).toEqual(['大', '中', '小']);
    expect(optionFieldValues(page.built)).toMatchObject({ 'flick-range': 'normal', 'flick-size': 'medium' });
  });

  it('UI-102: 選んだ値は、欄を隠しても、同じ選択肢を持つモードに選び直しても残る', () => {
    const page = fields();
    showOptionFields(page.built, mode('tracking'));
    page.select('speed').value = 'fast';
    showOptionFields(page.built, mode('flick'));
    page.select('flick-range').value = 'far';
    page.select('flick-size').value = 'small';
    showOptionFields(page.built, mode('ghost'));
    showOptionFields(page.built, mode('tracking-recoil'));
    expect(page.select('speed').value).toBe('fast');
    expect(page.select('speed').children).toHaveLength(3);
    showOptionFields(page.built, mode('flick'));
    expect(optionFieldValues(page.built)).toEqual({ speed: 'fast', 'flick-range': 'far', 'flick-size': 'small' });
  });

  it('違う値の並びの選択肢を渡すと入れ直し、前の値がなければ既定の値を選ぶ', () => {
    const other: ModeOption = { id: 'size', label: { ja: '大きさ', en: '大きさ' }, choices: [{ id: 'small', name: { ja: '小', en: '小' } }, { id: 'large', name: { ja: '大', en: '大' } }], defaultChoice: 'large' };
    const { element, elements } = choiceElements();
    showOptionChoice(elements, SPEED_OPTION);
    showOptionChoice(elements, other);
    expect(element.children.map((o) => o.value)).toEqual(['small', 'large']);
    expect(element.value).toBe('large');
    expect(elements.name.textContent).toBe('大きさ');
    showOptionChoice(elements, undefined);
    expect(elements.choice.hidden).toBe(true);
  });

  it('言語を選び直して書き直すと、見出しと値の名前が新しい言語になり、選んでいた値と欄の出し隠しは変わらない', () => {
    const page = fields();
    showOptionFields(page.built, mode('flick'));
    page.select('flick-range').value = 'far';
    page.select('flick-size').value = 'small';
    page.select('speed').value = 'fast';
    setLanguage('en');
    relabelOptionFields(page.built);
    expect(page.built.map((f) => f.name?.textContent)).toEqual(['Speed', 'Spawn range', 'Target size']);
    expect(page.select('speed').children.map((o) => o.textContent)).toEqual(['Slow', 'Normal', 'Fast']);
    expect(page.select('flick-range').children.map((o) => o.textContent)).toEqual(['Near', 'Normal', 'Far']);
    expect(page.select('flick-size').children.map((o) => o.textContent)).toEqual(['Large', 'Medium', 'Small']);
    expect(optionFieldValues(page.built)).toEqual({ speed: 'fast', 'flick-range': 'far', 'flick-size': 'small' });
    expect(page.shown()).toEqual(['flick-range', 'flick-size']);
    setLanguage('ja');
    relabelOptionFields(page.built);
    expect(page.built.map((f) => f.name?.textContent)).toEqual(['速さ', '出る範囲', '的の大きさ']);
    expect(optionFieldValues(page.built)).toEqual({ speed: 'fast', 'flick-range': 'far', 'flick-size': 'small' });
  });
});
