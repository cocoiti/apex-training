import { describe, expect, it } from 'vitest';
import type { ShotSection } from '../../src/sim/scoring';
import type { HistoryEntry } from '../../src/ui/practice-history';
import {
  summarizeWeakSection,
  weakDirections,
  weakSection,
  weakSectionText,
  WEAK_SECTION_RUNS,
} from '../../src/ui/weak-section';

const section = (start: number, meanH = 0, meanV = 0, shots = 5): ShotSection => ({
  start,
  shots,
  meanH,
  meanV,
  meanError: Math.hypot(meanH, meanV),
});

const run = (sections?: ShotSection[], meanError = 1): HistoryEntry => ({
  at: '2026-11-25T00:00:00.000Z',
  meanError,
  hitRate: 100,
  groupingRadius: 0,
  shots: 28,
  ...(sections ? { sections } : {}),
});

/** 1〜25 発目の 5 つの発の区間で、start の区間だけ (h, v) にずれた件。 */
const runWith = (start: number, h: number, v: number) =>
  run([1, 6, 11, 16, 21].map((s) => (s === start ? section(s, h, v) : section(s))));

describe('苦手な区間の向き', () => {
  it.each([
    [0, 0.5, ['上に外しがち（下げ不足）']],
    [0, -0.5, ['下に外しがち（下げすぎ）']],
    [0.5, 0, ['右に外しがち']],
    [-0.5, 0, ['左に外しがち']],
    [0.6, 1, ['上に外しがち（下げ不足）', '右に外しがち']],
    [0.49, -0.49, ['向きが定まらない']],
  ])('水平 %s 度・垂直 %s 度は %j（しきい値ちょうどは当たる、縦・横の順）', (h, v, expected) => {
    expect(weakDirections(h, v)).toEqual(expected);
  });
});

describe('苦手な区間', () => {
  it('SCO-32 の形: 11〜15 発目だけ右に 2 度ずれた 5 件では「11〜15 発目、右に外しがち」', () => {
    const entries = Array.from({ length: 5 }, () => runWith(11, 2, 0));
    const weak = weakSection(entries);
    expect(weak?.start).toBe(11);
    expect(weak && weakSectionText(weak)).toBe('11〜15 発目、右に外しがち');
  });

  it('SCO-33: 発の区間の記録がある件が 4 件では「なし」', () => {
    const summary = summarizeWeakSection(Array.from({ length: 4 }, () => runWith(11, 2, 0)));
    expect(summary).toEqual({ runs: 4, sections: null, weak: null });
  });

  it('SCO-34: 1〜5 発目が垂直 +1 度・水平 −1 度でいちばん大きいときは「1〜5 発目、上に外しがち（下げ不足）・左に外しがち」', () => {
    const entries = Array.from({ length: 5 }, () =>
      run([section(1, -1, 1), section(6, 0.3, 0), section(11, 0, -0.6), section(16, 0.2, 0.2)]),
    );
    const weak = weakSection(entries);
    expect(weak && weakSectionText(weak)).toBe('1〜5 発目、上に外しがち（下げ不足）・左に外しがち');
  });

  it('SCO-35: すべての発の区間のズレの大きさの平均が 0.5 度未満なら「なし」で、図の発の区間は残る', () => {
    const entries = Array.from({ length: 5 }, () => runWith(11, 0.49, 0));
    const summary = summarizeWeakSection(entries);
    expect(summary.weak).toBeNull();
    expect(summary.sections?.map((s) => s.start)).toEqual([1, 6, 11, 16, 21]);
  });

  it('SCO-37: sections を持たない件は数えず、持つ件の新しい順 5 件だけから求める', () => {
    const withSections = Array.from({ length: 5 }, () => runWith(6, 0, -2));
    const entries = [
      runWith(21, 5, 0),
      run(undefined, 9),
      withSections[0],
      run(undefined, 9),
      ...withSections.slice(1, 4),
      { ...run(), sections: 'broken' },
      withSections[4],
      run(undefined, 9),
    ].filter((e) => e !== undefined);
    const summary = summarizeWeakSection(entries);
    expect(summary.runs).toBe(6);
    expect(summary.weak?.start).toBe(6);
    expect(summary.weak && weakSectionText(summary.weak)).toBe('6〜10 発目、下に外しがち（下げすぎ）');
    // 6 件目より古い（21〜25 発目が大きくずれた）件は対象に入らない。
    expect(summary.sections?.find((s) => s.start === 21)?.meanError).toBe(0);
  });

  it('各件の平均を弾数で重み付けして合わせる', () => {
    const entries = [
      run([section(1, 1, 0, 1)]),
      run([section(1, 0, 0, 4)]),
      run([section(1, 0, 0, 5)]),
      run([section(1, 0, 0, 5)]),
      run([section(1, 0, 0, 5)]),
    ];
    const [first] = summarizeWeakSection(entries).sections ?? [];
    expect(first?.meanH).toBeCloseTo(1 / 20, 10);
    expect(first?.meanError).toBeCloseTo(1 / 20, 10);
  });

  it('5 件のうち 3 件以上にある発の区間だけを比べる', () => {
    const short = run([section(1)]);
    const long = run([section(1), section(6, 3, 0)]);
    // 6〜10 発目は 2 件にしかないので、いちばん大きくても比べない。
    const summary = summarizeWeakSection([short, short, short, long, long]);
    expect(summary.sections?.map((s) => s.start)).toEqual([1]);
    expect(summary.weak).toBeNull();
    // 3 件にあれば比べる。
    expect(weakSection([short, short, long, long, long])?.start).toBe(6);
  });

  it('いちばん大きい発の区間が複数あるときは発の番号の小さい方', () => {
    const entries = Array.from({ length: WEAK_SECTION_RUNS }, () => run([section(1), section(6, 1, 0), section(11, -1, 0)]));
    expect(weakSection(entries)?.start).toBe(6);
  });

  it('23 発だけの練習でも最後の発は 5j として「21〜25 発目」と表す', () => {
    const entries = Array.from({ length: 5 }, () => run([section(1), section(21, 0, 0.8, 3)]));
    const weak = weakSection(entries);
    expect(weak && weakSectionText(weak)).toBe('21〜25 発目、上に外しがち（下げ不足）');
  });

  it('5 件あっても比べる対象の発の区間がなければ「なし」', () => {
    const summary = summarizeWeakSection(Array.from({ length: 5 }, () => run([])));
    expect(summary.sections).toEqual([]);
    expect(summary.weak).toBeNull();
  });
});
