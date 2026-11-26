// 追いエイムの的の動きと採点（docs/spec/modes.md「追いエイム」、docs/spec/scoring.md「追いエイムの採点」）。
import { describe, expect, it } from 'vitest';
import { createRandom } from '../../src/core/random';
import {
  angleToPoint,
  createTrackingMotion,
  REVERSAL_MAX_INTERVAL,
  REVERSAL_MIN_INTERVAL,
  scoreTracking,
  TRACKING_DURATION,
  TRACKING_RANGE,
  TRACKING_SPEEDS,
  trackingHitRate,
  type TrackingStep,
} from '../../src/sim/tracking';
import { vec3 } from '../../src/sim/vec3';

const EYE = vec3(0, 1.6, 0);
const AIM = { yaw: 0, pitch: 0 };
const DT = 1 / 120;

const motion = (seed: number, speed: number = TRACKING_SPEEDS.normal) => createTrackingMotion(createRandom(seed), { eye: EYE, aim: AIM, speed });

describe('追いエイムの的の動き', () => {
  it('基準の点は目の位置から開始時の照準の向きに 8 メートル先で、開始時の的の中心は基準の点にある', () => {
    const m = motion(1);
    expect(m.base.x).toBeCloseTo(0, 9);
    expect(m.base.y).toBeCloseTo(1.6, 9);
    expect(m.base.z).toBeCloseTo(-8, 9);
    expect(m.positionAt(0)).toEqual(m.base);
  });

  it('左右の線は開始時の照準の向きに垂直な水平の線で、高さは基準の点のまま変わらない', () => {
    const m = createTrackingMotion(createRandom(3), { eye: EYE, aim: { yaw: 30, pitch: 0 }, speed: TRACKING_SPEEDS.fast });
    for (let t = 0; t <= TRACKING_DURATION; t += 0.25) {
      const p = m.positionAt(t);
      expect(p.y).toBeCloseTo(m.base.y, 9);
      const forward = { x: Math.sin(Math.PI / 6), z: -Math.cos(Math.PI / 6) };
      // 基準の点からのずれは、照準の向きの水平成分に垂直。
      expect((p.x - m.base.x) * forward.x + (p.z - m.base.z) * forward.z).toBeCloseTo(0, 9);
    }
  });

  it('MODE-37: 同じ種・同じ速さなら、各ステップの位置と切り返しの時刻の列が一致する', () => {
    const a = motion(42);
    const b = motion(42);
    const steps = Math.round(TRACKING_DURATION / DT);
    for (let i = 1; i <= steps; i += 1) expect(a.positionAt(i * DT)).toEqual(b.positionAt(i * DT));
    expect(a.reversals).toEqual(b.reversals);
    expect(a.reversals.length).toBeGreaterThan(5);
    expect(motion(43).reversals).not.toEqual(a.reversals);
  });

  it('MODE-38: 同じ種で 0.4 秒のときに動いた距離は、遅い・ふつう・速いで 0.6・1.2・1.8 メートル', () => {
    const distances = [TRACKING_SPEEDS.slow, TRACKING_SPEEDS.normal, TRACKING_SPEEDS.fast].map((speed) => {
      const m = motion(7, speed);
      expect(m.reversals[0]!.time).toBeGreaterThan(0.4);
      const p = m.positionAt(0.4);
      return Math.hypot(p.x - m.base.x, p.z - m.base.z);
    });
    expect(distances[0]).toBeCloseTo(0.6, 9);
    expect(distances[1]).toBeCloseTo(1.2, 9);
    expect(distances[2]).toBeCloseTo(1.8, 9);
  });

  it('最初に動く向きは種で決まり、右と左のどちらもある', () => {
    const directions = new Set(Array.from({ length: 20 }, (_, seed) => Math.sign(motion(seed).offsetAt(0.1))));
    expect(directions).toEqual(new Set([1, -1]));
  });

  it('MODE-39: 端に着かずに切り返した間隔はすべて 0.5〜1.5 秒で、的は基準の点から左右に 3 メートルより離れない', () => {
    for (const seed of [1, 2, 3, 4, 5, 99]) {
      for (const speed of Object.values(TRACKING_SPEEDS)) {
        const m = motion(seed, speed);
        let previous = 0;
        for (const r of m.reversals) {
          const gap = r.time - previous;
          if (!r.edge) {
            expect(gap).toBeGreaterThanOrEqual(REVERSAL_MIN_INTERVAL - 1e-9);
            expect(gap).toBeLessThanOrEqual(REVERSAL_MAX_INTERVAL + 1e-9);
          } else {
            expect(Math.abs(m.offsetAt(r.time))).toBeCloseTo(TRACKING_RANGE, 9);
          }
          previous = r.time;
        }
        for (let t = 0; t <= TRACKING_DURATION; t += DT) expect(Math.abs(m.offsetAt(t))).toBeLessThanOrEqual(TRACKING_RANGE + 1e-9);
      }
    }
  });

  it('速いと動く範囲の端で切り返すことがあり、端の切り返しのあとは逆向きに動く', () => {
    const m = Array.from({ length: 30 }, (_, seed) => motion(seed, TRACKING_SPEEDS.fast)).find((x) => x.reversals.some((r) => r.edge))!;
    expect(m).toBeDefined();
    const edge = m.reversals.find((r) => r.edge)!;
    const at = m.offsetAt(edge.time);
    expect(Math.abs(m.offsetAt(edge.time + 0.1))).toBeLessThan(Math.abs(at));
  });

  it('切り返しの時刻で向きが変わり、そのあいだは一定の速さで動く', () => {
    const m = motion(5, TRACKING_SPEEDS.slow);
    const first = m.reversals[0]!.time;
    const before = m.offsetAt(first - 0.1) - m.offsetAt(first - 0.2);
    const after = m.offsetAt(first + 0.2) - m.offsetAt(first + 0.1);
    expect(before).toBeCloseTo(-after, 9);
    expect(Math.abs(before)).toBeCloseTo(0.15, 9);
  });
});

describe('照準と点のなす角', () => {
  it('点の向きなら 0 度、ヨーを 5 度ずらすと 5 度', () => {
    const point = vec3(0, 1.6, -8);
    expect(angleToPoint(EYE, AIM, point)).toBeCloseTo(0, 9);
    expect(angleToPoint(EYE, { yaw: 5, pitch: 0 }, point)).toBeCloseTo(5, 9);
  });
});

/** n ステップの記録。on(i) が true のステップは乗っている。 */
const record = (n: number, on: (i: number) => boolean, offAngle = 2): TrackingStep[] =>
  Array.from({ length: n }, (_, i) => ({ on: on(i), offAngle: on(i) ? 0 : offAngle }));

const N = Math.round(TRACKING_DURATION / DT);

describe('追いエイムの採点', () => {
  it('SCO-45: すべてのステップで乗っていれば、乗っていた割合 100%・外していたときのズレ「なし」・乗り直すまでの時間 0 秒', () => {
    const score = scoreTracking(record(N, () => true), [1, 2.2, 3.1], DT);
    expect(score.onTargetRate).toBe(100);
    expect(score.offTargetError).toBeNull();
    expect(score.reacquireTime).toBe(0);
  });

  it('SCO-47: 乗っていた割合は、乗っていたステップの数 ÷ ステップの数 × 100', () => {
    expect(scoreTracking(record(N, (i) => i < N / 2), [], DT).onTargetRate).toBeCloseTo(50, 9);
    expect(scoreTracking(record(8, (i) => i < 3), [], DT).onTargetRate).toBeCloseTo(37.5, 9);
  });

  it('外していたときのズレは、乗っていなかったステップのなす角の平均', () => {
    const steps = [
      { on: true, offAngle: 0.1 },
      { on: false, offAngle: 1 },
      { on: false, offAngle: 3 },
    ];
    expect(scoreTracking(steps, [], DT).offTargetError).toBeCloseTo(2, 9);
  });

  it('SCO-48: 各切り返しのあと 0.3 秒だけ外すと、乗り直すまでの時間が約 0.3 秒', () => {
    const reversals = [1.0, 2.25, 3.5, 5.1];
    const off = (i: number) => reversals.some((r) => i * DT >= r - 1e-9 && i * DT < r + 0.3 - 1e-9);
    const score = scoreTracking(record(N, (i) => !off(i)), reversals, DT);
    expect(Math.abs(score.reacquireTime! - 0.3)).toBeLessThanOrEqual(DT + 1e-9);
  });

  it('0.2 秒より短くしか乗らなかったときは乗り直したとみなさず、次に 0.2 秒以上続いた区間の始まりまでの時間にする', () => {
    // 1 秒の切り返しのあと、1.1〜1.15 秒だけ乗り、1.5 秒から乗り続ける。
    const on = (i: number) => {
      const t = (i + 1) * DT;
      return t <= 1 || (t > 1.1 && t <= 1.15) || t > 1.5;
    };
    const score = scoreTracking(record(N, on), [1], DT);
    expect(score.reacquireTime).toBeCloseTo(0.5 + DT, 6);
  });

  it('次の切り返しまでに乗り直さなかった切り返しは、次の切り返しまでの時間にする。最後の切り返しは練習の終わりまで', () => {
    const steps = record(N, (i) => (i + 1) * DT <= 2);
    const score = scoreTracking(steps, [3, 5], DT);
    expect(score.reacquireTime).toBeCloseTo((2 + (TRACKING_DURATION - 5)) / 2, 6);
  });

  it('練習の終わりの 0.2 秒前より後の切り返しは数えず、数える切り返しがなければ「なし」', () => {
    expect(scoreTracking(record(N, () => false), [TRACKING_DURATION - 0.1], DT).reacquireTime).toBeNull();
    expect(scoreTracking(record(N, () => true), [], DT).reacquireTime).toBeNull();
    expect(scoreTracking(record(N, () => true), [1, TRACKING_DURATION - 0.1], DT).reacquireTime).toBe(0);
  });

  it('ステップがないときはどの指標も「なし」', () => {
    expect(scoreTracking([], [1], DT)).toEqual({ onTargetRate: null, offTargetError: null, reacquireTime: null });
  });

  it('命中率は撃った弾のうち練習の的に当たった弾の割合で、撃たなかったときは「なし」', () => {
    expect(trackingHitRate([])).toBeNull();
    expect(trackingHitRate([{ target: 'tracking' }, {}, { target: 'tracking' }, {}])).toBe(50);
  });
});
