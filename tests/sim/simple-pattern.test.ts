import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SIMPLE_PATTERN_MAX_SEGMENTS, SIMPLE_PATTERN_TOLERANCE, simplePattern } from '../../src/sim/simple-pattern';
import { idealCorrection, parseWeapon, type RecoilStep, type WeaponData } from '../../src/sim/weapon';

const WEAPONS_DIR = resolve(__dirname, '../../src/data/weapons');

function weaponOf(pattern: RecoilStep[], randomness = 0): WeaponData {
  return { id: 'w', name: 'テスト武器', category: 'AR', version: 'v', source: '仮データ', measured: true, rpm: 600, magSize: pattern.length, pattern, randomness };
}

function measuredWeapons(): WeaponData[] {
  return readdirSync(WEAPONS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => parseWeapon(JSON.parse(readFileSync(join(WEAPONS_DIR, file), 'utf8'))))
    .flatMap((parsed) => (parsed.ok && parsed.weapon.measured ? [parsed.weapon] : []));
}

const distance = (a: { yaw: number; pitch: number }, b: { yaw: number; pitch: number }) => Math.hypot(a.yaw - b.yaw, a.pitch - b.pitch);

describe('簡易版のパターン', () => {
  it('WPN-24: 計測した武器データは区切りが 5 本以下で、両端が原点と装弾数発目、どの発も差が 1.0 度以下', () => {
    const weapons = measuredWeapons();
    expect(weapons.map((w) => w.id).sort()).toEqual(['car', 'lstar']);
    for (const weapon of weapons) {
      const simple = simplePattern(weapon);
      const ideal = idealCorrection(weapon);
      expect(simple.segments.length).toBeGreaterThanOrEqual(1);
      expect(simple.segments.length).toBeLessThanOrEqual(SIMPLE_PATTERN_MAX_SEGMENTS);
      expect(simple.vertices[0]).toBe(0);
      expect(simple.vertices.at(-1)).toBe(weapon.magSize);
      expect(simple.points[0]).toEqual({ yaw: 0, pitch: 0 });
      expect(simple.points.at(-1)).toEqual(ideal[weapon.magSize - 1]);
      expect(simple.positions).toHaveLength(weapon.magSize + 1);
      for (let i = 1; i <= weapon.magSize; i++) {
        expect(distance(simple.positions[i] ?? { yaw: NaN, pitch: NaN }, ideal[i - 1] ?? { yaw: NaN, pitch: NaN })).toBeLessThanOrEqual(SIMPLE_PATTERN_TOLERANCE);
      }
      expect(simple.maxError).toBeLessThanOrEqual(SIMPLE_PATTERN_TOLERANCE);
    }
  });

  it('WPN-25: まっすぐ下に補正する武器は区切り 1 本で「1〜10 発: ↓ 下」', () => {
    const simple = simplePattern(weaponOf(Array.from({ length: 10 }, () => ({ dx: 0, dy: 1 }))));
    expect(simple.vertices).toEqual([0, 10]);
    expect(simple.segments.map((s) => s.label)).toEqual(['1〜10 発: ↓ 下']);
    expect(simple.maxError).toBeCloseTo(0, 12);
  });

  it('WPN-26: 下に 5 発・左に 5 発の武器は頂点 0・5・10 の 2 本', () => {
    const pattern = Array.from({ length: 10 }, (_, i) => (i < 5 ? { dx: 0, dy: 1 } : { dx: 1, dy: 0 }));
    const simple = simplePattern(weaponOf(pattern));
    expect(simple.vertices).toEqual([0, 5, 10]);
    expect(simple.segments.map((s) => s.label)).toEqual(['1〜5 発: ↓ 下', '6〜10 発: ← 左']);
    expect(simple.points).toEqual([{ yaw: 0, pitch: 0 }, { yaw: 0, pitch: -5 }, { yaw: -5, pitch: -5 }]);
  });

  it('WPN-27: randomness によらず、何度求めても頂点と言葉が同じ', () => {
    const pattern = Array.from({ length: 20 }, (_, i) => ({ dx: Math.sin(i) * 0.6, dy: 0.4 + (i % 4) * 0.2 }));
    const results = [0, 0, 0.5, 0.5].map((r) => simplePattern(weaponOf(pattern, r)));
    for (const result of results) {
      expect(result.vertices).toEqual(results[0]?.vertices);
      expect(result.segments.map((s) => s.label)).toEqual(results[0]?.segments.map((s) => s.label));
    }
  });

  it('WPN-28: 5 本では許容差に収まらない武器でもエラーにならず、5 本以下で最大の差が最も小さい折れ線が求まる', () => {
    const pattern = Array.from({ length: 20 }, (_, i) => ({ dx: i % 2 === 0 ? 3 : -3, dy: 0 }));
    const simple = simplePattern(weaponOf(pattern));
    expect(simple.segments.length).toBeGreaterThanOrEqual(1);
    expect(simple.segments.length).toBeLessThanOrEqual(SIMPLE_PATTERN_MAX_SEGMENTS);
    expect(simple.maxError).toBeGreaterThan(SIMPLE_PATTERN_TOLERANCE);
    expect(simple.vertices[0]).toBe(0);
    expect(simple.vertices.at(-1)).toBe(20);
    expect(simple.positions).toHaveLength(21);
  });

  it('許容差に収まる最初の本数を使い、同じ最大の差なら頂点の発の番号が前で小さいものを選ぶ', () => {
    // 3 発目で曲がる折れ線。1 本では 2 度ずれ、2 本（0・3・6）でぴったり重なる。
    const pattern = Array.from({ length: 6 }, (_, i) => (i < 3 ? { dx: 0, dy: 1 } : { dx: -1, dy: 0 }));
    expect(simplePattern(weaponOf(pattern)).vertices).toEqual([0, 3, 6]);
    // まっすぐな線は 2 本以上に分ける必要がなく、1 本にする。
    expect(simplePattern(weaponOf(Array.from({ length: 6 }, () => ({ dx: 0.5, dy: 0.5 })))).vertices).toEqual([0, 6]);
  });

  it('i 発目の簡易版での位置は、受け持つ区切りの両端を (i − a) : (b − i) に内分した位置', () => {
    const pattern = [{ dx: 0, dy: 1 }, { dx: 0, dy: 1 }, { dx: 0, dy: 2 }];
    const simple = simplePattern(weaponOf(pattern));
    expect(simple.vertices).toEqual([0, 3]);
    const pitches = simple.positions.map((p) => p.pitch);
    [0, -4 / 3, -8 / 3, -4].forEach((pitch, i) => expect(pitches[i]).toBeCloseTo(pitch, 12));
    expect(simple.positions.every((p) => p.yaw === 0)).toBe(true);
  });

  it('言葉の向きは 8 方位で、1 発だけの区切りは「<b> 発」、短い区切りは「・ 動かさない」', () => {
    const cases: [RecoilStep, string][] = [
      [{ dx: 0, dy: -1 }, '↑ 上'],
      [{ dx: -1, dy: -1 }, '↗ 右上'],
      [{ dx: -1, dy: 0 }, '→ 右'],
      [{ dx: -1, dy: 1 }, '↘ 右下'],
      [{ dx: 0, dy: 1 }, '↓ 下'],
      [{ dx: 1, dy: 1 }, '↙ 左下'],
      [{ dx: 1, dy: 0 }, '← 左'],
      [{ dx: 1, dy: -1 }, '↖ 左上'],
      [{ dx: 0.05, dy: 0 }, '・ 動かさない'],
    ];
    for (const [step, words] of cases) {
      expect(simplePattern(weaponOf([step])).segments.map((s) => s.label)).toEqual([`1 発: ${words}`]);
    }
  });

  it('pattern が magSize より長いときは magSize 発目までで求める', () => {
    const weapon = { ...weaponOf(Array.from({ length: 6 }, () => ({ dx: 0, dy: 1 }))), magSize: 4 };
    const simple = simplePattern(weapon);
    expect(simple.vertices).toEqual([0, 4]);
    expect(simple.positions).toHaveLength(5);
  });
});
