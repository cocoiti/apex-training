import { describe, expect, it } from 'vitest';
import { showScreen, showStorageNotice, type ScreenElement } from '../../src/ui/shell';

const element = (screen: string): ScreenElement => ({ dataset: { screen }, hidden: false });

describe('画面の表示', () => {
  it('指定した画面の要素だけを表示し、ほかを隠す', () => {
    const elements = ['top', 'settings', 'play'].map(element);
    showScreen(elements, 'settings');
    expect(elements.map((e) => e.hidden)).toEqual([true, false, true]);
    showScreen(elements, 'top');
    expect(elements.map((e) => e.hidden)).toEqual([false, true, true]);
  });
});

describe('保存できないことの表示', () => {
  it('文言を入れて表示する', () => {
    const notice: Pick<HTMLElement, 'hidden' | 'textContent'> = { hidden: true, textContent: '' };
    showStorageNotice(notice);
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe('この環境では設定と記録を保存できません。練習はそのまま続けられます。');
    expect(notice.textContent).toBe('この環境では設定と記録を保存できません。練習はそのまま続けられます。');
  });
});
