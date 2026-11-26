import { afterEach, describe, expect, it } from 'vitest';
import { modes } from '../../src/modes/registry';
import { setLanguage } from '../../src/ui/i18n';
import { fillModeChoice, fillModeSelect } from '../../src/ui/mode-choices';
import { createFakeSelect } from './fake-select';

afterEach(() => setLanguage('ja'));

describe('fillModeSelect', () => {
  it('モードを渡した順に option にし、最初のモードを選ぶ', () => {
    const { select, element } = createFakeSelect();
    fillModeSelect(select, [
      { id: 'new', name: { ja: '新しいモード', en: '新しいモード' } },
      { id: 'ghost', name: { ja: '反復練習', en: '反復練習' } },
    ]);
    expect(element.children.map((o) => ({ tag: o.tagName, value: o.value, text: o.textContent }))).toEqual([
      { tag: 'OPTION', value: 'new', text: '新しいモード' },
      { tag: 'OPTION', value: 'ghost', text: '反復練習' },
    ]);
    expect(element.value).toBe('new');
  });

  it('登録されたモードがすべて選択肢に出る', () => {
    const { select, element } = createFakeSelect();
    fillModeSelect(select, modes);
    expect(element.children.map((o) => o.value)).toEqual(modes.map((m) => m.id));
    expect(element.value).toBe(modes[0]?.id);
  });

  it('MODE-27: 登録されたモードは「反復練習」「追いエイム」「追いエイム＋リコイル」の順で、「反復練習」を選ぶ', () => {
    const { select, element } = createFakeSelect();
    fillModeSelect(select, modes);
    expect(element.children.map((o) => o.textContent)).toEqual(['反復練習', '追いエイム', '追いエイム＋リコイル', 'フリック']);
    expect(element.value).toBe('ghost');
  });

  it('前の選択肢を消してから入れる', () => {
    const { select, element } = createFakeSelect();
    fillModeSelect(select, [{ id: 'a', name: { ja: 'A', en: 'A' } }]);
    fillModeSelect(select, [{ id: 'b', name: { ja: 'B', en: 'B' } }]);
    expect(element.children.map((o) => o.value)).toEqual(['b']);
  });

  it('keep が true なら、言語を選び直して入れ直しても選んでいたモードのままで、名前は新しい言語になる', () => {
    const { select, element } = createFakeSelect();
    fillModeSelect(select, modes);
    element.value = 'flick';
    setLanguage('en');
    fillModeSelect(select, modes, true);
    expect(element.children.map((o) => o.textContent)).toEqual(['Recoil Drill', 'Tracking', 'Tracking + Recoil', 'Flick']);
    expect(element.value).toBe('flick');
  });

  it('keep が true でも、選んでいたモードが選択肢になければ最初のモードを選ぶ。keep が false なら最初のモードに戻す', () => {
    const { select, element } = createFakeSelect();
    fillModeSelect(select, modes);
    element.value = 'flick';
    fillModeSelect(select, modes);
    expect(element.value).toBe('ghost');
    element.value = 'flick';
    fillModeSelect(select, [{ id: 'ghost', name: { ja: '反復練習', en: 'Recoil Drill' } }], true);
    expect(element.value).toBe('ghost');
  });
});

const mode = (id: string) => modes.find((m) => m.id === id)!;

function choiceElements() {
  const { select, element } = createFakeSelect();
  return { element, elements: { select, choice: { hidden: false }, only: { hidden: true }, name: { textContent: '' } } };
}

describe('fillModeChoice', () => {
  it('登録されたモードが 1 つのときは選択肢の欄を隠し、名前だけを出す', () => {
    const { element, elements } = choiceElements();
    fillModeChoice(elements, [{ id: 'ghost', name: { ja: '反復練習', en: '反復練習' } }]);
    expect(elements.choice.hidden).toBe(true);
    expect(elements.only.hidden).toBe(false);
    expect(elements.name.textContent).toBe('反復練習');
    // 選んでいるモードは隠した select の値で読む。
    expect(element.value).toBe('ghost');
  });

  it('MODE-5: モードが 2 つ以上になると選択肢の欄を出し、名前だけの欄を隠して並び順の順に並べる', () => {
    const { element, elements } = choiceElements();
    fillModeChoice(elements, [{ id: 'ghost', name: { ja: '反復練習', en: '反復練習' } }]);
    fillModeChoice(elements, [{ id: 'ghost', name: { ja: '反復練習', en: '反復練習' } }, { id: 'new', name: { ja: '新しいモード', en: '新しいモード' } }]);
    expect(elements.choice.hidden).toBe(false);
    expect(elements.only.hidden).toBe(true);
    expect(elements.name.textContent).toBe('');
    expect(element.children.map((o) => o.textContent)).toEqual(['反復練習', '新しいモード']);
    expect(element.value).toBe('ghost');
  });

  it('MODE-27・UI-26: 登録されたモード（4 つ）では選択肢の欄を出し、名前だけの欄を隠して「反復練習」を選ぶ', () => {
    const { element, elements } = choiceElements();
    fillModeChoice(elements, modes);
    expect(elements.choice.hidden).toBe(false);
    expect(elements.only.hidden).toBe(true);
    expect(element.children.map((o) => o.textContent)).toEqual(['反復練習', '追いエイム', '追いエイム＋リコイル', 'フリック']);
    expect(element.value).toBe('ghost');
  });

  it('keep が true なら、言語を選び直して作り直しても選んでいたモードのままで、名前だけの欄も新しい言語になる', () => {
    const { element, elements } = choiceElements();
    fillModeChoice(elements, modes);
    element.value = 'tracking';
    setLanguage('en');
    fillModeChoice(elements, modes, true);
    expect(element.value).toBe('tracking');
    expect(element.children.map((o) => o.textContent)).toEqual(['Recoil Drill', 'Tracking', 'Tracking + Recoil', 'Flick']);
    const single = choiceElements();
    fillModeChoice(single.elements, [mode('ghost')], true);
    expect(single.elements.name.textContent).toBe('Recoil Drill');
  });
});
