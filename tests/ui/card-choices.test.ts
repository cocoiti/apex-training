import { describe, expect, it } from 'vitest';
import { cardGroupsOf, keyDirection, type SelectChildLike } from '../../src/ui/card-choices';

const option = (value: string, text: string): SelectChildLike => ({ tagName: 'OPTION', value, textContent: text });
const group = (label: string, ...children: SelectChildLike[]): SelectChildLike => ({ tagName: 'OPTGROUP', label, textContent: '', children });

describe('select の選択肢からカードの並びを作る', () => {
  it('UI-10: optgroup は label を見出しにし、中の武器は一覧の順に並べる', () => {
    const groups = cardGroupsOf([group('SMG', option('car', 'C.A.R. SMG')), group('LMG', option('lstar', 'L-STAR'), option('spitfire', 'スピットファイア'))]);
    expect(groups).toEqual([
      { heading: 'SMG', items: [{ value: 'car', label: 'C.A.R. SMG' }] },
      {
        heading: 'LMG',
        items: [
          { value: 'lstar', label: 'L-STAR' },
          { value: 'spitfire', label: 'スピットファイア' },
        ],
      },
    ]);
  });

  it('見出しのない option は、続けて並ぶものを 1 つのまとまりにする（モードのカード）', () => {
    const groups = cardGroupsOf([option('ghost', ' 反復練習 '), option('tracking', '追いエイム'), group('X', option('x', 'x')), option('flick', 'フリック')]);
    expect(groups).toEqual([
      {
        items: [
          { value: 'ghost', label: '反復練習' },
          { value: 'tracking', label: '追いエイム' },
        ],
      },
      { heading: 'X', items: [{ value: 'x', label: 'x' }] },
      { items: [{ value: 'flick', label: 'フリック' }] },
    ]);
  });

  it('選択肢がなければ並びもない', () => {
    expect(cardGroupsOf([])).toEqual([]);
  });
});

describe('矢印キーの向き', () => {
  it('UI-121: 右・下で次、左・上で前、ほかのキーは向きなし', () => {
    expect(keyDirection('ArrowRight')).toBe(1);
    expect(keyDirection('ArrowDown')).toBe(1);
    expect(keyDirection('ArrowLeft')).toBe(-1);
    expect(keyDirection('ArrowUp')).toBe(-1);
    expect(keyDirection('Enter')).toBeUndefined();
    expect(keyDirection('KeyR')).toBeUndefined();
  });
});
