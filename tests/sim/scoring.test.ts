import { describe, expect, it } from 'vitest';
import type { Angles } from '../../src/sim/angles';
import { DEFAULT_TARGET_RADIUS, score, segmentRange, shotDeviations, shotSections, targetRadius } from '../../src/sim/scoring';
import { vec3 } from '../../src/sim/vec3';
import { createWorld } from '../../src/sim/world';

const shot = (yaw: number, pitch: number): Angles => ({ yaw, pitch });
const repeat = (count: number, d: Angles): Angles[] => Array.from({ length: count }, () => d);

describe('採点の指標', () => {
  it('SCO-1: 全弾のズレが 0 なら平均ズレ 0・グルーピング半径 0・命中率 100%', () => {
    const result = score(repeat(30, shot(0, 0)), 1);
    expect(result.meanDeviation).toBe(0);
    expect(result.groupingRadius).toBe(0);
    expect(result.hitRate).toBe(100);
    expect(result.comments).toEqual(['よくまとまっている']);
  });

  it('SCO-6: 前半 0・中盤 1・後半 5 度のズレは区間ごとのズレがそのまま出る', () => {
    const result = score([...repeat(10, shot(0, 0)), ...repeat(10, shot(1, 0)), ...repeat(10, shot(5, 0))], 1);
    expect(result.segments[0]).toBeCloseTo(0, 9);
    expect(result.segments[1]).toBeCloseTo(1, 9);
    expect(result.segments[2]).toBeCloseTo(5, 9);
  });

  it('SCO-2: 後半だけ大きく外すと後半の区間が最も大きい', () => {
    const result = score([...repeat(20, shot(0, 0)), ...repeat(10, shot(3, -4))], 1);
    const [first, middle, last] = result.segments.map((s) => s ?? 0) as [number, number, number];
    expect(last).toBeGreaterThan(first);
    expect(last).toBeGreaterThan(middle);
  });

  it('SCO-7: 28 発は 1〜9・10〜18・19〜28 発目に分かれる', () => {
    expect([0, 1, 2].map((k) => segmentRange(28, k))).toEqual([
      [0, 9],
      [9, 18],
      [18, 28],
    ]);
    // 区間ごとに違うズレにして、score でも同じ分け方になることを確かめる。
    const result = score([...repeat(9, shot(1, 0)), ...repeat(9, shot(2, 0)), ...repeat(10, shot(3, 0))], 1);
    expect(result.segments).toEqual([1, 2, 3]);
  });

  it('29 発は 9・10・10 発に分かれる', () => {
    expect([0, 1, 2].map((k) => segmentRange(29, k))).toEqual([
      [0, 9],
      [9, 19],
      [19, 29],
    ]);
  });

  it('3 発未満では弾が入らない区間が「なし」になる', () => {
    expect(score([shot(1, 0)], 1).segments).toEqual([null, null, 1]);
    expect(score([shot(1, 0), shot(2, 0)], 1).segments).toEqual([null, 1, 2]);
  });

  it('SCO-12: 的の半径 1 度で 0.5・1・1.5 度の 3 発は命中率 66.7%・平均ズレ 1 度', () => {
    const result = score([shot(0.5, 0), shot(0, -1), shot(0.9, 1.2)], 1);
    expect(result.hitRate).toBeCloseTo(200 / 3, 9);
    expect(result.meanDeviation).toBeCloseTo(1, 9);
  });

  it('SCO-13: 19 発が 0 で 1 発が水平 10 度ならグルーピング半径 0.5 度', () => {
    const result = score([...repeat(19, shot(0, 0)), shot(10, 0)], 1);
    expect(result.groupingRadius).toBeCloseTo(0.5, 9);
  });

  it('SCO-14: 1 発も撃たなければすべて「なし」でコメントなし', () => {
    expect(score([], 1)).toEqual({
      shots: 0,
      meanDeviation: null,
      groupingRadius: null,
      hitRate: null,
      segments: [null, null, null],
      horizontalSpread: null,
      verticalSpread: null,
      spreadRatio: null,
      comments: [],
      sections: [],
    });
  });

  it('同じ入力なら同じ結果になる', () => {
    const deviations = [shot(0.3, -1.2), shot(-0.7, 0.4), shot(2, 2.5), shot(0.1, -0.1)];
    expect(score(deviations, 1)).toEqual(score(deviations, 1));
  });

  it('横ブレと縦ブレと比', () => {
    const result = score([shot(1, -2), shot(-3, 2)], 1);
    expect(result.horizontalSpread).toBe(2);
    expect(result.verticalSpread).toBe(2);
    expect(result.spreadRatio).toBe(1);
  });
});

describe('採点のコメント', () => {
  it('SCO-3 / SCO-8: 全弾が垂直 −2 度なら「下げすぎ」だけ', () => {
    expect(score(repeat(30, shot(0, -2)), 1).comments).toEqual(['下げすぎ']);
  });

  it('SCO-9: 全弾が垂直 +2 度なら「下げ不足」だけ', () => {
    expect(score(repeat(30, shot(0, 2)), 1).comments).toEqual(['下げ不足']);
  });

  it('SCO-10: 水平が交互に ±1 度なら「横の補正不足」だけで、横ブレ 1・縦ブレ 0・比なし', () => {
    const result = score(
      Array.from({ length: 30 }, (_, i) => shot(i % 2 === 0 ? 1 : -1, 0)),
      1,
    );
    expect(result.comments).toEqual(['横の補正不足']);
    expect(result.horizontalSpread).toBe(1);
    expect(result.verticalSpread).toBe(0);
    expect(result.spreadRatio).toBeNull();
  });

  it('SCO-11: 全弾が 0.4 度以内なら「よくまとまっている」', () => {
    const result = score([shot(0.4, -0.4), shot(-0.4, 0.4), shot(0.2, -0.3), shot(-0.1, 0.4)], 1);
    expect(result.comments).toEqual(['よくまとまっている']);
  });

  it('縦と横の両方に当たれば縦・横の順に 2 つ出る', () => {
    expect(score(repeat(10, shot(1, -1)), 1).comments).toEqual(['下げすぎ', '横の補正不足']);
  });

  it('しきい値ちょうどは条件に当たる', () => {
    expect(score([shot(0, -0.5)], 1).comments).toEqual(['下げすぎ']);
    expect(score([shot(0, 0.5)], 1).comments).toEqual(['下げ不足']);
    expect(score([shot(0.5, 0)], 1).comments).toEqual(['横の補正不足']);
  });

  it('命中の判定は的の半径ちょうどを含む', () => {
    expect(score([shot(1, 0)], 1).hitRate).toBe(100);
  });
});

describe('発の区間ごとのズレ', () => {
  it('発の番号で 5 発ずつに分け、各発の区間の水平・垂直のズレの平均とズレの大きさの平均を求める', () => {
    const deviations = [
      { yaw: 3, pitch: 4 },
      { yaw: -3, pitch: -4 },
      { yaw: 0, pitch: 0 },
      { yaw: 0, pitch: 0 },
      { yaw: 0, pitch: 0 },
      { yaw: 1, pitch: 0 },
      { yaw: 1, pitch: 2 },
    ];
    expect(shotSections(deviations)).toEqual([
      { start: 1, shots: 5, meanH: 0, meanV: 0, meanError: 2 },
      { start: 6, shots: 2, meanH: 1, meanV: 1, meanError: (1 + Math.hypot(1, 2)) / 2 },
    ]);
  });

  it('撃った弾数によらず、同じ発の番号は同じ発の区間に入る（採点の前半・中盤・後半とは別）', () => {
    const at = (n: number) => shotSections(Array.from({ length: n }, () => ({ yaw: 1, pitch: 0 }))).map((s) => [s.start, s.shots]);
    expect(at(23)).toEqual([[1, 5], [6, 5], [11, 5], [16, 5], [21, 3]]);
    expect(at(5)).toEqual([[1, 5]]);
    expect(at(0)).toEqual([]);
  });

  it('score の結果にも発の区間ごとのズレを持つ', () => {
    const deviations = Array.from({ length: 12 }, (_, i) => ({ yaw: i, pitch: 0 }));
    expect(score(deviations, 1).sections).toEqual(shotSections(deviations));
  });
});

describe('弾ごとのズレ', () => {
  it('当たった弾は記録した角度のズレ、外れの弾は弾の向きと中心との差（ヨーは正規化）', () => {
    const deviations = shotDeviations(
      [
        { angles: { yaw: 1, pitch: 1 }, deviation: { yaw: 0.5, pitch: -0.25 } },
        { angles: { yaw: -179, pitch: 12 }, deviation: null },
      ],
      { yaw: 179, pitch: 10 },
    );
    expect(deviations).toEqual([
      { yaw: 0.5, pitch: -0.25 },
      { yaw: 2, pitch: 2 },
    ]);
  });
});

describe('的の半径', () => {
  const world = (boxes: Parameters<typeof createWorld>[0]['boxes']) =>
    createWorld({ id: 't', name: 't', spawn: { position: vec3(0, 1.6, 0), aim: { yaw: 0, pitch: 0 } }, boxes });

  it('的の箱の幅と高さの小さいほうの半分を、手前の面までの距離で見込む角度', () => {
    // range の的: 0.6 m 四方、手前の面まで 9.9 m。
    const r = targetRadius(world([{ id: 'target', kind: 'target', center: vec3(0, 1.6, -9.95), size: vec3(0.6, 0.8, 0.1) }]));
    expect(r).toBeCloseTo((Math.atan(0.3 / 9.9) * 180) / Math.PI, 9);
  });

  it('的が複数あれば最も近いもの、的がなければ既定の値', () => {
    const near = { id: 'a', kind: 'target', center: vec3(0, 1.6, -5.05), size: vec3(1, 1, 0.1) } as const;
    const far = { id: 'b', kind: 'target', center: vec3(0, 1.6, -20.05), size: vec3(1, 1, 0.1) } as const;
    expect(targetRadius(world([far, near]))).toBeCloseTo((Math.atan(0.5 / 5) * 180) / Math.PI, 9);
    expect(targetRadius(world([{ id: 'wall', kind: 'wall', center: vec3(0, 0, -10), size: vec3(1, 1, 1) }]))).toBe(
      DEFAULT_TARGET_RADIUS,
    );
  });
});
