import type { WeaponData } from '../sim/weapon';

/** トップ画面の武器の選択肢の 1 つの分類。 */
export interface WeaponCategoryGroup {
  readonly category: string;
  readonly weapons: readonly WeaponData[];
}

/**
 * 武器の一覧を `category` ごとに分ける（docs/spec/weapons.md WPN-13）。
 * 分類の並びは一覧に最初に出た順、分類の中の武器の並びは一覧の順のまま。一覧のすべての武器がどれかの分類に入る。
 */
export function groupWeaponsByCategory(weapons: readonly WeaponData[]): WeaponCategoryGroup[] {
  const groups = new Map<string, WeaponData[]>();
  for (const weapon of weapons) {
    const group = groups.get(weapon.category);
    if (group) group.push(weapon);
    else groups.set(weapon.category, [weapon]);
  }
  return [...groups].map(([category, list]) => ({ category, weapons: list }));
}

/** 武器の選択肢を、分類ごとの optgroup に分けて select に入れる。 */
export function fillWeaponSelect(select: HTMLSelectElement, weapons: readonly WeaponData[]): void {
  const doc = select.ownerDocument;
  select.replaceChildren(
    ...groupWeaponsByCategory(weapons).map(({ category, weapons: list }) => {
      const group = doc.createElement('optgroup');
      group.label = category;
      for (const weapon of list) {
        const option = doc.createElement('option');
        option.value = weapon.id;
        option.textContent = weapon.name;
        group.append(option);
      }
      return group;
    }),
  );
}
