// docs/spec/weapons.md「簡易版のパターン」の QA の受け入れテスト（WPN-24〜WPN-28）。
// 公開された入口（src/sim/simple-pattern.ts の simplePattern と、src/data/weapons/ の武器の JSON）だけを使う。
// 期待値は SPEC の定義から tests/helpers/simple-pattern-oracle.ts で求め、実装の内部には依存しない。
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { simplePattern } from '../../src/sim/simple-pattern';
import { idealPoints, oracleSimplePattern, positionsOf, type Deg } from '../helpers/simple-pattern-oracle';

const ROOT = resolve(__dirname, '../..');

interface WeaponJson {
  id: string;
  name: string;
  magSize: number;
  randomness: number;
  rpm: number;
  measured: boolean;
  pattern: { dx: number; dy: number }[];
}
const load = (id: string) => JSON.parse(readFileSync(join(ROOT, 'src/data/weapons', `${id}.json`), 'utf8')) as WeaponJson;

/** 受け入れテスト用の武器データ（パターン以外の項目は SPEC の必須の項目を埋める）。 */
function weapon(pattern: { dx: number; dy: number }[], extra: Partial<WeaponJson> = {}) {
  return {
    id: 'qa-simple',
    name: 'QA',
    category: 'AR',
    version: 'S31-Cipher',
    source: '仮データ（受け入れテスト）',
    rpm: 600,
    magSize: pattern.length,
    randomness: 0,
    measured: true,
    pattern,
    ...extra,
  };
}

const toDeg = (a: { yaw: number; pitch: number }): Deg => [a.yaw, a.pitch];
const d = (a: Deg, b: Deg) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('WPN-24: 計測した武器データの簡易版は区切りが 5 本以下で、両端が原点と magSize 発目、どの発も差が 1.0 度以下', () => {
  for (const id of ['lstar', 'car']) {
    it(`${id}`, () => {
      const w = load(id);
      expect(w.measured).toBe(true);
      const s = simplePattern(w as never);
      const ideal = idealPoints(w);
      expect(s.segments.length).toBeGreaterThanOrEqual(1);
      expect(s.segments.length).toBeLessThanOrEqual(5);
      expect(s.vertices.length).toBe(s.segments.length + 1);
      expect(s.vertices[0]).toBe(0);
      expect(s.vertices[s.vertices.length - 1]).toBe(w.magSize);
      // 頂点は発の番号の順。
      for (let k = 1; k < s.vertices.length; k += 1) expect(s.vertices[k]!).toBeGreaterThan(s.vertices[k - 1]!);
      // 両端の位置: 原点と magSize 発目の理想の補正軌道。
      expect(d(toDeg(s.points[0]!), [0, 0])).toBeLessThan(1e-9);
      expect(d(toDeg(s.points[s.points.length - 1]!), ideal[w.magSize]!)).toBeLessThan(1e-9);
      // 頂点の位置は詳細版のその発の位置。
      s.vertices.forEach((v, k) => expect(d(toDeg(s.points[k]!), ideal[v]!), `頂点 ${v} 発目`).toBeLessThan(1e-9));
      // 区切りは隣り合う頂点を結び、a+1〜b 発目を受け持つ。
      s.segments.forEach((seg, k) => {
        expect(seg.from).toBe(s.vertices[k]);
        expect(seg.to).toBe(s.vertices[k + 1]);
      });
      // 簡易版での各発の位置を SPEC の内分で求め、理想の補正軌道との差が 1.0 度以下。
      const pos = positionsOf(ideal, [...s.vertices]);
      const errors: string[] = [];
      for (let i = 1; i <= w.magSize; i += 1) {
        const e = d(pos[i]!, ideal[i]!);
        if (e > 1.0) errors.push(`${i} 発目: ${e.toFixed(3)} 度`);
      }
      expect(errors, errors.join('\n')).toEqual([]);
      // 公開された positions も SPEC の内分の位置と一致する。
      expect(s.positions.length).toBe(w.magSize + 1);
      for (let i = 0; i <= w.magSize; i += 1) expect(d(toDeg(s.positions[i]!), pos[i]!), `${i} 発目の位置`).toBeLessThan(1e-9);
    });

    it(`${id}: SPEC の折れ線の選び方（本数を 1 本から増やし、最大の差が最小のもの）どおりの頂点と言葉になる`, () => {
      const w = load(id);
      const s = simplePattern(w as never);
      const o = oracleSimplePattern(w);
      expect([...s.vertices]).toEqual(o.vertices);
      expect(s.segments.map((x) => x.label)).toEqual(o.segments.map((x) => x.label));
      expect(s.maxError).toBeCloseTo(o.maxError, 9);
    });
  }
});

describe('WPN-25: magSize 10・pattern がすべて (0, 1) の武器は、区切り 1 本で「1〜10 発: ↓ 下」', () => {
  it('区切りと言葉', () => {
    const s = simplePattern(weapon(Array.from({ length: 10 }, () => ({ dx: 0, dy: 1 }))) as never);
    expect(s.segments.length).toBe(1);
    expect([...s.vertices]).toEqual([0, 10]);
    expect(s.segments.map((x) => x.label)).toEqual(['1〜10 発: ↓ 下']);
  });
});

describe('WPN-26: 1〜5 発目 (0, 1)・6〜10 発目 (1, 0) の武器は、区切り 2 本・頂点 0・5・10 発目', () => {
  it('頂点と言葉', () => {
    const pattern = [...Array.from({ length: 5 }, () => ({ dx: 0, dy: 1 })), ...Array.from({ length: 5 }, () => ({ dx: 1, dy: 0 }))];
    const s = simplePattern(weapon(pattern) as never);
    expect(s.segments.length).toBe(2);
    expect([...s.vertices]).toEqual([0, 5, 10]);
    expect(s.segments.map((x) => x.label)).toEqual(['1〜5 発: ↓ 下', '6〜10 発: ← 左']);
  });
});

describe('WPN-27: pattern が同じで randomness が 0 と 0.5 の武器の簡易版を 2 回ずつ求めると、4 回とも頂点と言葉が一致する', () => {
  for (const id of ['lstar', 'car']) {
    it(`${id} の pattern`, () => {
      const base = load(id);
      const results = [0, 0, 0.5, 0.5].map((r) => simplePattern(weapon(base.pattern, { magSize: base.magSize, randomness: r }) as never));
      const shape = (s: ReturnType<typeof simplePattern>) => ({
        vertices: [...s.vertices],
        points: s.points.map((p) => [p.yaw, p.pitch]),
        labels: s.segments.map((x) => x.label),
      });
      for (const r of results.slice(1)) expect(shape(r)).toEqual(shape(results[0]!));
    });
  }
});

describe('WPN-28: magSize 20・奇数発目 (3, 0)・偶数発目 (-3, 0) の武器は、エラーにならず区切りが 5 本以下の折れ線が求まる', () => {
  it('5 本では許容差に収まらないときも折れ線が求まる', () => {
    const pattern = Array.from({ length: 20 }, (_, k) => (k % 2 === 0 ? { dx: 3, dy: 0 } : { dx: -3, dy: 0 }));
    const w = weapon(pattern);
    // 前提: SPEC の選び方では 5 本でも許容差に収まらない。
    const o = oracleSimplePattern(w);
    expect(o.maxError).toBeGreaterThan(1.0);
    let s: ReturnType<typeof simplePattern> | undefined;
    expect(() => {
      s = simplePattern(w as never);
    }).not.toThrow();
    expect(s!.segments.length).toBeGreaterThanOrEqual(1);
    expect(s!.segments.length).toBeLessThanOrEqual(5);
    expect(s!.vertices[0]).toBe(0);
    expect(s!.vertices[s!.vertices.length - 1]).toBe(20);
    expect(s!.positions.length).toBe(21);
    for (const p of s!.positions) {
      expect(Number.isFinite(p.yaw)).toBe(true);
      expect(Number.isFinite(p.pitch)).toBe(true);
    }
    // 5 本以下で作れる折れ線のうち最大の差が最も小さいもの。
    const ideal = idealPoints(w);
    const pos = positionsOf(ideal, [...s!.vertices]);
    let m = 0;
    for (let i = 1; i <= 20; i += 1) m = Math.max(m, d(pos[i]!, ideal[i]!));
    expect(m).toBeCloseTo(o.maxError, 9);
    expect(s!.segments.map((x) => x.label).every((l) => /^\d+(〜\d+)? 発: /.test(l))).toBe(true);
  });
});
