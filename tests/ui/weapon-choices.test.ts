import { describe, expect, it } from 'vitest';
import type { WeaponData } from '../../src/sim/weapon';
import { groupWeaponsByCategory } from '../../src/ui/weapon-choices';

function weapon(id: string, category: string): WeaponData {
  return { id, name: id, category, version: 'v', source: '仮データ', rpm: 600, magSize: 1, pattern: [{ dx: 0, dy: 0 }], randomness: 0 };
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
