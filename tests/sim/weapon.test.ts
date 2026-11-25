import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWeaponList, fireInterval, idealCorrection, idealCorrectionRate, parseWeapon, uncorrectedPattern, type WeaponData } from '../../src/sim/weapon';

const WEAPONS_DIR = resolve(__dirname, '../../src/data/weapons');

function validJson(): Record<string, unknown> {
  return {
    id: 'test',
    name: 'テスト',
    category: 'AR',
    version: 'S31-Cipher',
    source: '仮データ',
    rpm: 600,
    magSize: 3,
    pattern: [
      { dx: 0, dy: 1 },
      { dx: 0.5, dy: 1 },
      { dx: -0.5, dy: 0.5 },
    ],
    randomness: 0,
  };
}

function readWeaponFiles() {
  return readdirSync(WEAPONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({ file, json: JSON.parse(readFileSync(join(WEAPONS_DIR, file), 'utf8')) as unknown }));
}

describe('武器データの読み込み', () => {
  it('すべての項目がそろった JSON は読み込める', () => {
    const result = parseWeapon(validJson());
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.weapon).toEqual(validJson());
  });

  it('pattern が magSize より長いときは超えた分を切り詰める', () => {
    const json = { ...validJson(), magSize: 2 };
    const result = parseWeapon(json);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.weapon.pattern).toHaveLength(2);
  });

  it.each([
    ['rpm がない', (j: Record<string, unknown>) => delete j.rpm, 'rpm'],
    ['id がない', (j: Record<string, unknown>) => delete j.id, 'id'],
    ['source が文字列でない', (j: Record<string, unknown>) => (j.source = 1), 'source'],
    ['rpm が 0', (j: Record<string, unknown>) => (j.rpm = 0), 'rpm'],
    ['rpm が数でない', (j: Record<string, unknown>) => (j.rpm = '600'), 'rpm'],
    ['magSize が整数でない', (j: Record<string, unknown>) => (j.magSize = 2.5), 'magSize'],
    ['magSize が 0', (j: Record<string, unknown>) => (j.magSize = 0), 'magSize'],
    ['randomness が負', (j: Record<string, unknown>) => (j.randomness = -0.1), 'randomness'],
    ['pattern が配列でない', (j: Record<string, unknown>) => (j.pattern = {}), 'pattern'],
    ['pattern の要素の dy がない', (j: Record<string, unknown>) => delete (j.pattern as Record<string, unknown>[])[1]!.dy, 'pattern[1].dy'],
    ['pattern の要素の dx が数でない', (j: Record<string, unknown>) => ((j.pattern as Record<string, unknown>[])[0]!.dx = null), 'pattern[0].dx'],
    ['pattern の要素がオブジェクトでない', (j: Record<string, unknown>) => ((j.pattern as unknown[])[2] = 1), 'pattern[2]'],
    ['pattern の要素数が magSize より少ない', (j: Record<string, unknown>) => (j.magSize = 4), 'pattern'],
  ])('%s は読み込みの誤りになる', (_label, mutate, path) => {
    const json = validJson();
    mutate(json);
    const result = parseWeapon(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path)).toEqual([path]);
  });

  it('オブジェクトでない JSON は読み込みの誤りになる', () => {
    expect(parseWeapon([]).ok).toBe(false);
    expect(parseWeapon('r301').ok).toBe(false);
  });

  it('誤りが複数あればすべて返す', () => {
    const json = validJson();
    delete json.rpm;
    delete json.name;
    const result = parseWeapon(json);
    if (result.ok) throw new Error('誤りにならない');
    expect(result.errors.map((e) => e.path)).toEqual(['name', 'rpm']);
  });
});

describe('武器の一覧', () => {
  it('WPN-2: rpm が欠けた JSON は一覧から外れ、ファイル名と欠けた項目が返り、ほかの武器は一覧に残る', () => {
    const broken = validJson();
    delete broken.rpm;
    const list = buildWeaponList([
      { file: 'a.json', json: { ...validJson(), id: 'a' } },
      { file: 'broken.json', json: broken },
      { file: 'b.json', json: { ...validJson(), id: 'b' } },
    ]);
    expect(list.weapons.map((w) => w.id)).toEqual(['a', 'b']);
    expect(list.rejected).toEqual([{ file: 'broken.json', errors: [{ path: 'rpm', message: '必須の項目がない' }] }]);
  });

  it('WPN-12: pattern の要素数が magSize より少ない JSON は一覧から外れ、ファイル名と pattern の誤りが返る', () => {
    const list = buildWeaponList([{ file: 'short.json', json: { ...validJson(), magSize: 5 } }]);
    expect(list.weapons).toEqual([]);
    expect(list.rejected).toHaveLength(1);
    expect(list.rejected[0]?.file).toBe('short.json');
    expect(list.rejected[0]?.errors.map((e) => e.path)).toEqual(['pattern']);
  });

  it('id が重なる 2 つ目の JSON は一覧から外れる', () => {
    const list = buildWeaponList([
      { file: 'a.json', json: validJson() },
      { file: 'b.json', json: validJson() },
    ]);
    expect(list.weapons).toHaveLength(1);
    expect(list.rejected.map((r) => [r.file, r.errors[0]?.path])).toEqual([['b.json', 'id']]);
  });

  it('WPN-3: src/data/weapons/ の JSON から MVP の 7 つの武器が一覧に出て、L-STAR と C.A.R. SMG 以外の 5 つは source に仮データであることが書かれている', () => {
    const list = buildWeaponList(readWeaponFiles());
    expect(list.rejected).toEqual([]);
    expect(list.weapons.map((w) => w.name).sort()).toEqual(
      ['R-301', 'R-99', 'フラットライン', 'ボルト', 'スピットファイア', 'L-STAR', 'C.A.R. SMG'].sort(),
    );
    for (const weapon of list.weapons.filter((w) => !['lstar', 'car'].includes(w.id))) expect(weapon.source).toMatch(/仮データ/);
  });

  it.each(['lstar', 'car'])('WPN-14 / WPN-18: %s の source は自分で撮影した射撃訓練場の動画からの計測で、仮データの旨はなく、アタッチメントはすべて紫、version にシーズンがある', (id) => {
    const weapon = buildWeaponList(readWeaponFiles()).weapons.find((w) => w.id === id)!;
    expect(weapon.source).toMatch(/自分で撮影した射撃訓練場の動画からの計測/);
    expect(weapon.source).not.toMatch(/仮/);
    expect(weapon.source).toMatch(/アタッチメントはすべて紫（レベル 3/);
    expect(weapon.source).not.toMatch(/アタッチメントなし/);
    expect(weapon.version).toMatch(/^S\d+-\S+$/);
    expect(weapon.pattern).toHaveLength(weapon.magSize);
  });

  it('WPN-20: C.A.R. SMG は category が SMG で magSize が 30', () => {
    const car = buildWeaponList(readWeaponFiles()).weapons.find((w) => w.name === 'C.A.R. SMG')!;
    expect(car.category).toBe('SMG');
    expect(car.magSize).toBe(30);
  });
});

describe('理想の補正軌道', () => {
  const weapon = { pattern: [{ dx: 1, dy: 2 }, { dx: -0.5, dy: 1 }] } satisfies Pick<WeaponData, 'pattern'>;

  it('WPN-11: 1 発目 {1, 2}、2 発目 {-0.5, 1} なら、1 発目は (-1, -2)、2 発目は (-0.5, -3)', () => {
    expect(idealCorrection(weapon)).toEqual([
      { yaw: -1, pitch: -2 },
      { yaw: -0.5, pitch: -3 },
    ]);
  });

  it('同じ武器データなら常に同じ結果になる', () => {
    expect(idealCorrection(weapon)).toEqual(idealCorrection(weapon));
  });

  it('合計が 0 の発は -0 ではなく 0 になる', () => {
    const [first] = idealCorrection({ pattern: [{ dx: 0, dy: 0 }] });
    expect(Object.is(first?.yaw, 0)).toBe(true);
    expect(Object.is(first?.pitch, 0)).toBe(true);
  });
});

describe('発射間隔', () => {
  it('rpm 600 なら 0.1 秒', () => {
    expect(fireInterval({ rpm: 600 })).toBeCloseTo(0.1, 12);
  });
});

describe('補正しなかった場合のパターン', () => {
  const pattern = [
    { dx: 1, dy: 2 },
    { dx: -0.5, dy: 1 },
    { dx: 0, dy: 3 },
  ];

  it('i 番目は 1〜i+1 発目の pattern の合計で、撃った弾数まで', () => {
    expect(uncorrectedPattern({ pattern }, 2)).toEqual([
      { yaw: 1, pitch: 2 },
      { yaw: 0.5, pitch: 3 },
    ]);
  });

  it('理想の補正軌道を上下左右に反転したものになる', () => {
    const ideal = idealCorrection({ pattern });
    expect(uncorrectedPattern({ pattern }, 3)).toEqual(ideal.map((a) => ({ yaw: -a.yaw, pitch: -a.pitch })));
  });

  it('弾数が 0 なら空、pattern の長さを超えた分は含めない', () => {
    expect(uncorrectedPattern({ pattern }, 0)).toEqual([]);
    expect(uncorrectedPattern({ pattern }, 10)).toHaveLength(3);
  });
});

describe('理想の補正速度', () => {
  const weapon = { rpm: 600, pattern: [{ dx: 0, dy: 1 }, { dx: 0.5, dy: 1 }, { dx: -0.5, dy: 0.5 }] };

  it('fire を押していて次の弾が k 発目（k ≥ 2）なら、k 発目と k − 1 発目の理想の補正軌道の差 ÷ 発射間隔', () => {
    // 発射間隔 0.1 秒。2 発目の差は (−0.5, −1)、3 発目の差は (+0.5, −0.5)。
    const second = idealCorrectionRate(weapon, { fire: true, nextShot: 2, ammo: 2 });
    expect(second.yaw).toBeCloseTo(-5, 12);
    expect(second.pitch).toBeCloseTo(-10, 12);
    const third = idealCorrectionRate(weapon, { fire: true, nextShot: 3, ammo: 1 });
    expect(third.yaw).toBeCloseTo(5, 12);
    expect(third.pitch).toBeCloseTo(-5, 12);
  });

  it('fire を押していない、次の弾が 1 発目、撃ち切ったときは 0', () => {
    const zero = { yaw: 0, pitch: 0 };
    expect(idealCorrectionRate(weapon, { fire: false, nextShot: 2, ammo: 2 })).toEqual(zero);
    expect(idealCorrectionRate(weapon, { fire: true, nextShot: 1, ammo: 3 })).toEqual(zero);
    expect(idealCorrectionRate(weapon, { fire: true, nextShot: 4, ammo: 0 })).toEqual(zero);
  });

  it('差が 0 の成分は -0 にしない', () => {
    const rate = idealCorrectionRate({ rpm: 600, pattern: [{ dx: 0, dy: 1 }, { dx: 0, dy: 0 }] }, { fire: true, nextShot: 2, ammo: 1 });
    expect(Object.is(rate.yaw, 0)).toBe(true);
    expect(Object.is(rate.pitch, 0)).toBe(true);
  });
});
