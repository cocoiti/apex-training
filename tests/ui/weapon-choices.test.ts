import { describe, expect, it } from 'vitest';
import type { WeaponData } from '../../src/sim/weapon';
import { fillWeaponSelect, groupWeaponsByCategory } from '../../src/ui/weapon-choices';
import { createFakeSelect, describeSelect } from './fake-select';

function weapon(id: string, category: string, name = id): WeaponData {
  return { id, name, category, version: 'v', source: '仮データ', rpm: 600, magSize: 1, pattern: [{ dx: 0, dy: 0 }], randomness: 0, measured: true };
}

describe('groupWeaponsByCategory', () => {
  it('すべての武器を category ごとに分け、分類は初出の順、分類の中は一覧の順にする', () => {
    const list = [weapon('a', 'AR'), weapon('b', 'SMG'), weapon('c', 'AR'), weapon('d', 'LMG'), weapon('e', 'SMG')];
    const groups = groupWeaponsByCategory(list);
    expect(groups.map((g) => g.category)).toEqual(['AR', 'SMG', 'LMG']);
    expect(groups.map((g) => g.weapons.map((w) => w.id))).toEqual([['a', 'c'], ['b', 'e'], ['d']]);
    expect(groups.flatMap((g) => g.weapons)).toHaveLength(list.length);
  });

  it('空の一覧では分類がない', () => {
    expect(groupWeaponsByCategory([])).toEqual([]);
  });
});

describe('fillWeaponSelect', () => {
  it('分類ごとに label が category の optgroup を作り、option の value を id・textContent を name にする', () => {
    const { select, element } = createFakeSelect();
    fillWeaponSelect(select, [
      weapon('r301', 'AR', 'R-301'),
      weapon('r99', 'SMG', 'R-99'),
      weapon('flatline', 'AR', 'フラットライン'),
      weapon('lstar', 'LMG', 'L-STAR'),
      weapon('volt', 'SMG', 'ボルト'),
    ]);
    expect(describeSelect(element)).toEqual([
      {
        tag: 'OPTGROUP',
        label: 'AR',
        options: [
          { tag: 'OPTION', value: 'r301', text: 'R-301' },
          { tag: 'OPTION', value: 'flatline', text: 'フラットライン' },
        ],
      },
      {
        tag: 'OPTGROUP',
        label: 'SMG',
        options: [
          { tag: 'OPTION', value: 'r99', text: 'R-99' },
          { tag: 'OPTION', value: 'volt', text: 'ボルト' },
        ],
      },
      { tag: 'OPTGROUP', label: 'LMG', options: [{ tag: 'OPTION', value: 'lstar', text: 'L-STAR' }] },
    ]);
  });

  it('前の選択肢を消してから入れる', () => {
    const { select, element } = createFakeSelect();
    element.append(element.ownerDocument.createElement('option'));
    fillWeaponSelect(select, [weapon('a', 'AR', 'A')]);
    fillWeaponSelect(select, [weapon('b', 'SMG', 'B')]);
    expect(describeSelect(element)).toEqual([{ tag: 'OPTGROUP', label: 'SMG', options: [{ tag: 'OPTION', value: 'b', text: 'B' }] }]);
  });

  it('空の一覧では選択肢がなくなる', () => {
    const { select, element } = createFakeSelect();
    fillWeaponSelect(select, [weapon('a', 'AR')]);
    fillWeaponSelect(select, []);
    expect(element.children).toEqual([]);
  });
});
