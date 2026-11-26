// docs/spec/scoring.md の受け入れ条件（SCO-6 〜 SCO-14、SCO-1 の計算の部分）の受け入れテスト。
// 公開された入口（src/sim/scoring の score・segmentRange とその型）だけを使い、実装の内部には依存しない。
// 弾ごとのズレは Angles で渡す。yaw が水平のズレ h（右が正）、pitch が垂直のズレ v（上が正）。
import { describe, expect, it } from 'vitest';
import type { Angles } from '../../src/sim/angles';
import { score, segmentRange } from '../../src/sim/scoring';

const dev = (h: number, v: number): Angles => ({ yaw: h, pitch: v });
const times = (count: number, d: Angles): Angles[] => Array.from({ length: count }, () => d);

describe('採点の受け入れ条件', () => {
  it('SCO-1（計算）: 全弾のズレが 0 なら平均ズレ 0・グルーピング半径 0・命中率 100%', () => {
    const r = score(times(30, dev(0, 0)), 1);
    expect(r.meanDeviation).toBe(0);
    expect(r.groupingRadius).toBe(0);
    expect(r.hitRate).toBe(100);
    expect(r.comments).toEqual(['grouped']);
  });

  it('SCO-6: 前半 0・中盤 水平 1 度・後半 水平 5 度なら区間ごとのズレが 0・1・5 度', () => {
    const r = score([...times(10, dev(0, 0)), ...times(10, dev(1, 0)), ...times(10, dev(5, 0))], 1);
    expect(r.segments).toHaveLength(3);
    expect(r.segments[0]).toBeCloseTo(0, 9);
    expect(r.segments[1]).toBeCloseTo(1, 9);
    expect(r.segments[2]).toBeCloseTo(5, 9);
  });

  it('SCO-7: 28 発は前半 1〜9 発目、中盤 10〜18 発目、後半 19〜28 発目に分かれる', () => {
    // 1 発だけを大きく外し、どの区間の平均ズレが 0 でなくなるかで、その弾が入る区間を調べる。
    const expected = (shotNumber: number): number => (shotNumber <= 9 ? 0 : shotNumber <= 18 ? 1 : 2);
    for (let j = 0; j < 28; j++) {
      const shots = times(28, dev(0, 0));
      shots[j] = dev(3, 0);
      const r = score(shots, 1);
      const nonZero = r.segments.flatMap((s, k) => (s !== null && s > 1e-9 ? [k] : []));
      expect(nonZero, `${j + 1} 発目`).toEqual([expected(j + 1)]);
    }
    // 公開関数 segmentRange も同じ分け方を返す（0 から数えた [start, end)）。
    expect([0, 1, 2].map((k) => [...segmentRange(28, k)])).toEqual([
      [0, 9],
      [9, 18],
      [18, 28],
    ]);
  });

  it('SCO-8: 水平 0・垂直 −2 度ならコメントは「下げすぎ」だけ', () => {
    expect(score(times(30, dev(0, -2)), 1).comments).toEqual(['over-pull']);
  });

  it('SCO-9: 水平 0・垂直 +2 度ならコメントは「下げ不足」だけ', () => {
    expect(score(times(30, dev(0, 2)), 1).comments).toEqual(['under-pull']);
  });

  it('SCO-10: 垂直 0・水平 ±1 度の交互なら「横の補正不足」だけ、横ブレ 1・縦ブレ 0・比なし', () => {
    const shots = Array.from({ length: 30 }, (_, i) => dev(i % 2 === 0 ? 1 : -1, 0));
    const r = score(shots, 1);
    expect(r.comments).toEqual(['horizontal']);
    expect(r.horizontalSpread).toBeCloseTo(1, 9);
    expect(r.verticalSpread).toBe(0);
    expect(r.spreadRatio).toBeNull();
  });

  it('SCO-11: 全弾の水平・垂直のズレが 0.4 度以内なら「よくまとまっている」', () => {
    const cases: Angles[][] = [
      times(30, dev(0.4, 0.4)),
      times(30, dev(-0.4, -0.4)),
      times(30, dev(0.4, -0.4)),
      Array.from({ length: 30 }, (_, i) => dev(((i % 9) - 4) / 10, (((i * 7) % 9) - 4) / 10)),
    ];
    for (const shots of cases) {
      expect(score(shots, 1).comments).toEqual(['grouped']);
    }
  });

  it('SCO-12: 的の半径 1 度でズレ 0.5・1・1.5 度の 3 発なら命中率約 66.7%、平均ズレ 1 度', () => {
    const r = score([dev(0.5, 0), dev(0, 1), dev(0.9, -1.2)], 1);
    expect(r.hitRate).toBeCloseTo(200 / 3, 6);
    expect(r.meanDeviation).toBeCloseTo(1, 9);
  });

  it('SCO-13: 19 発のズレ 0・1 発の水平 10 度ならグルーピング半径 0.5 度', () => {
    const shots = times(20, dev(0, 0));
    shots[7] = dev(10, 0);
    expect(score(shots, 1).groupingRadius).toBeCloseTo(0.5, 9);
  });

  it('SCO-14: 1 発も撃たなければすべての指標が「なし」、コメントなし', () => {
    const r = score([], 1);
    expect(r.meanDeviation).toBeNull();
    expect(r.groupingRadius).toBeNull();
    expect(r.hitRate).toBeNull();
    expect(r.segments).toEqual([null, null, null]);
    expect(r.horizontalSpread).toBeNull();
    expect(r.verticalSpread).toBeNull();
    expect(r.spreadRatio).toBeNull();
    expect(r.comments).toEqual([]);
  });
});
