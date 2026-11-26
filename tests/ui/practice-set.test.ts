import { describe, expect, it } from 'vitest';
import { INTERLUDE_SECONDS, parsePracticeCount, PRACTICE_COUNTS, PracticeSet } from '../../src/ui/practice-set';

describe('連続練習（セット）', () => {
  it('回数の選択肢は 1・5・10・20 で、選択肢にない値は 1 にする', () => {
    expect(PRACTICE_COUNTS).toEqual([1, 5, 10, 20]);
    expect(parsePracticeCount('5')).toBe(5);
    expect(parsePracticeCount('20')).toBe(20);
    expect(parsePracticeCount('3')).toBe(1);
    expect(parsePracticeCount('')).toBe(1);
  });

  it('回数が 1 のときは連続練習でなく、1 回終えると終わる', () => {
    const set = new PracticeSet(1);
    expect(set.isSet).toBe(false);
    expect(set.completeRound(0.5, 0)).toBe('done');
    expect(set.rounds).toEqual([{ round: 1, meanDeviation: 0.5, bestUpdated: false }]);
  });

  it('回ごとに自己ベストを更新したかを残す（省いたときは更新していない）', () => {
    const set = new PracticeSet(3);
    set.completeRound(1.0, 0, true);
    set.next();
    set.completeRound(0.8, 1);
    expect(set.rounds.map((r) => r.bestUpdated)).toEqual([true, false]);
  });

  it('MODE-17: 最後でない回を終えると短いリザルトになり、3 秒たつと次の回にできる', () => {
    const set = new PracticeSet(5);
    expect(set.isSet).toBe(true);
    expect(set.round).toBe(1);
    expect(set.completeRound(1.0, 10)).toBe('interlude');
    expect(set.interludeRemaining(10)).toBe(INTERLUDE_SECONDS);
    expect(set.interludeRemaining(11.5)).toBeCloseTo(1.5, 9);
    expect(set.interludeElapsed(12.9)).toBe(false);
    expect(set.interludeElapsed(13)).toBe(true);
    expect(set.next()).toBe(true);
    expect(set.phase).toBe('playing');
    expect(set.round).toBe(2);
    expect(set.interludeRemaining(13)).toBe(0);
  });

  it('MODE-19: 短いリザルトの表示中は 3 秒を待たずに次の回にできる。練習中は次の回にしない', () => {
    const set = new PracticeSet(5);
    expect(set.next()).toBe(false);
    set.completeRound(1.0, 0);
    expect(set.next()).toBe(true);
    expect(set.round).toBe(2);
  });

  it('MODE-18: 回数分を終えると終わり、各回の平均ズレが回の順に残る', () => {
    const set = new PracticeSet(5);
    const means = [1.0, 0.8, 1.2, 0.6, 0.9];
    means.forEach((mean, i) => {
      expect(set.completeRound(mean, i)).toBe(i === 4 ? 'done' : 'interlude');
      if (i < 4) set.next();
    });
    expect(set.rounds.map((r) => [r.round, r.meanDeviation])).toEqual(means.map((m, i) => [i + 1, m]));
  });

  it('MODE-20: 2 回を終えたあとにやめると、終えた 2 回だけでまとめにする（練習中でも短いリザルトの表示中でも）', () => {
    const during = new PracticeSet(5);
    during.completeRound(1.0, 0);
    during.next();
    during.completeRound(0.8, 1);
    during.next();
    expect(during.quit()).toBe('summary');
    expect(during.rounds).toHaveLength(2);
    expect(during.phase).toBe('done');

    const interlude = new PracticeSet(5);
    interlude.completeRound(1.0, 0);
    interlude.next();
    interlude.completeRound(0.8, 1);
    expect(interlude.quit()).toBe('summary');
    expect(interlude.rounds).toHaveLength(2);
    expect(interlude.next()).toBe(false);
  });

  it('MODE-21: 1 回目の練習中にやめると、まとめにせずトップ画面に戻す', () => {
    expect(new PracticeSet(5).quit()).toBe('top');
  });

  it('やめたあとは回を終えても数に入れない', () => {
    const set = new PracticeSet(5);
    set.quit();
    expect(set.completeRound(0.5, 0)).toBe('done');
    expect(set.rounds).toEqual([]);
  });
});
