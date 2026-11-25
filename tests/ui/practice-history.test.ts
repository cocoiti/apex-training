import { describe, expect, it } from 'vitest';
import { score } from '../../src/sim/scoring';
import {
  clearHistory,
  HISTORY_LIMIT,
  historyAverages,
  historyKey,
  loadHistory,
  parseHistory,
  recordHistory,
  type HistoryEntry,
} from '../../src/ui/practice-history';
import { SafeStorage } from '../../src/ui/storage';

/** Map で代用した保存先。 */
function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    get: (key: string) => items.get(key) ?? null,
    set: (key: string, value: string) => {
      items.set(key, value);
      return true;
    },
    remove: (key: string) => items.delete(key),
  };
}

const R301_CENTER = { input: 'mouse', weaponId: 'r301', modeId: 'center' } as const;
const KEY = 'apex-training:history:mouse:r301:center';
const NOW = new Date('2026-11-25T05:06:07.000Z');
/** 全弾の水平のズレが h 度の 10 発の採点（平均ズレ h 度）。 */
const result = (h: number) => score(Array.from({ length: 10 }, () => ({ yaw: h, pitch: 0 })), 1);
const entry = (meanError: number, at = '2026-01-01T00:00:00.000Z'): HistoryEntry => ({
  at,
  meanError,
  hitRate: 100,
  groupingRadius: 0,
  shots: 10,
});
const stored = (entries: unknown[]) => JSON.stringify({ version: 1, entries });

describe('履歴のキー', () => {
  it('apex-training:history:<入力方式>:<武器の id>:<モードの id>', () => {
    expect(historyKey(R301_CENTER)).toBe(KEY);
    expect(historyKey({ input: 'pad', weaponId: 'r99', modeId: 'ghost' })).toBe('apex-training:history:pad:r99:ghost');
  });
});

describe('履歴の読み出し', () => {
  it('保存の形の JSON を古い順に読む', () => {
    expect(parseHistory(stored([entry(1), entry(2)])).map((e) => e.meanError)).toEqual([1, 2]);
  });

  it.each([
    ['値がない', null],
    ['JSON として読めない', '{not json'],
    ['オブジェクトでない', '[1]'],
    ['version が 1 でない', JSON.stringify({ version: 2, entries: [entry(1)] })],
    ['entries が配列でない', JSON.stringify({ version: 1, entries: {} })],
  ])('%s ときは空とする', (_, raw) => {
    expect(parseHistory(raw)).toEqual([]);
  });

  it('at が日時として読めない要素と meanError が 0 以上の有限の数でない要素は読み飛ばし、ほかは使う', () => {
    const raw = stored([
      entry(1),
      { ...entry(2), at: 'not a date' },
      { ...entry(3), at: 123 },
      { ...entry(4), meanError: -1 },
      { ...entry(5), meanError: '5' },
      null,
      entry(0),
    ]);
    expect(parseHistory(raw).map((e) => e.meanError)).toEqual([1, 0]);
  });
});

describe('履歴に足す', () => {
  it('1 件目は、終えた日時・平均ズレ・命中率・グルーピング半径・撃った弾数を保存の形で保存する', () => {
    const storage = memoryStorage();
    recordHistory(storage, R301_CENTER, result(0.25), NOW);
    expect(JSON.parse(storage.items.get(KEY) ?? '')).toEqual({
      version: 1,
      entries: [{ at: '2026-11-25T05:06:07.000Z', meanError: 0.25, hitRate: 100, groupingRadius: 0, shots: 10 }],
    });
  });

  it('SCO-23: 3 回足すと 3 件が古い順に並ぶ', () => {
    const storage = memoryStorage();
    [0.5, 0.25, 0.75].forEach((h, i) => recordHistory(storage, R301_CENTER, result(h), new Date(NOW.getTime() + i * 1000)));
    const entries = loadHistory(storage, R301_CENTER);
    expect(entries.map((e) => e.meanError)).toEqual([0.5, 0.25, 0.75]);
    expect(entries.map((e) => Date.parse(e.at))).toEqual([0, 1, 2].map((i) => NOW.getTime() + i * 1000));
  });

  it('SCO-24: 200 件あるときに足すと 200 件のままで、最も古い 1 件が消え、最後が今の結果になる', () => {
    const old = Array.from({ length: HISTORY_LIMIT }, (_, i) => entry(i + 1));
    const storage = memoryStorage({ [KEY]: stored(old) });
    recordHistory(storage, R301_CENTER, result(0.125), NOW);
    const entries = loadHistory(storage, R301_CENTER);
    expect(HISTORY_LIMIT).toBe(200);
    expect(entries).toHaveLength(200);
    expect(entries[0]?.meanError).toBe(2);
    expect(entries[199]).toMatchObject({ meanError: 0.125, at: NOW.toISOString() });
  });

  it('SCO-26: ほかの組の履歴は変えない', () => {
    const saved = stored([entry(1)]);
    const storage = memoryStorage({ [KEY]: saved });
    recordHistory(storage, { ...R301_CENTER, modeId: 'ghost' }, result(1), NOW);
    recordHistory(storage, { ...R301_CENTER, input: 'pad' }, result(1), NOW);
    expect(storage.items.get(KEY)).toBe(saved);
  });

  it('SCO-29: 保存してある値が JSON として読めなければ、その結果の 1 件だけにする', () => {
    const storage = memoryStorage({ [KEY]: '{broken' });
    recordHistory(storage, R301_CENTER, result(2), NOW);
    expect(loadHistory(storage, R301_CENTER).map((e) => e.meanError)).toEqual([2]);
  });

  it('読み飛ばした要素は、次に足すときに除いて書き直す', () => {
    const storage = memoryStorage({ [KEY]: stored([entry(1), { at: 'x', meanError: 1 }]) });
    recordHistory(storage, R301_CENTER, result(2), NOW);
    expect((JSON.parse(storage.items.get(KEY) ?? '') as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it('平均ズレが「なし」（1 発も撃っていない）なら足さない', () => {
    const storage = memoryStorage();
    recordHistory(storage, R301_CENTER, score([], 1), NOW);
    expect(storage.items.size).toBe(0);
  });

  it('SCO-30: 書き込みが例外になっても投げず、同じページでは足した履歴を読める', () => {
    const storage = new SafeStorage(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    recordHistory(storage, R301_CENTER, result(1), NOW);
    recordHistory(storage, R301_CENTER, result(2), NOW);
    expect(storage.unavailable).toBe(true);
    expect(loadHistory(storage, R301_CENTER).map((e) => e.meanError)).toEqual([1, 2]);
  });
});

describe('履歴を消す', () => {
  it('選んだ組の履歴だけを消し、ほかの組と自己ベストは残す', () => {
    const best = 'apex-training:best:mouse:r301:center';
    const other = historyKey({ ...R301_CENTER, modeId: 'ghost' });
    const storage = memoryStorage({ [KEY]: stored([entry(1)]), [other]: stored([entry(2)]), [best]: '{}' });
    clearHistory(storage, R301_CENTER);
    expect(loadHistory(storage, R301_CENTER)).toEqual([]);
    expect(storage.items.has(other)).toBe(true);
    expect(storage.items.has(best)).toBe(true);
  });
});

describe('履歴の平均', () => {
  it('SCO-27: 1〜12 度の 12 件（最後の 2 件だけが今日）なら、今日 11.5・直近 10 回 7.5・全体 6.5 度', () => {
    const now = new Date(2026, 10, 25, 12, 0, 0);
    const yesterday = new Date(2026, 10, 24, 23, 59, 0).toISOString();
    const today = new Date(2026, 10, 25, 0, 1, 0).toISOString();
    const entries = Array.from({ length: 12 }, (_, i) => entry(i + 1, i >= 10 ? today : yesterday));
    expect(historyAverages(entries, now)).toEqual({ today: 11.5, recent: 7.5, overall: 6.5 });
  });

  it('SCO-28: 履歴が 1 件もなければ、3 つの平均はすべて「なし」', () => {
    expect(historyAverages([], NOW)).toEqual({ today: null, recent: null, overall: null });
  });

  it('10 件未満なら直近の平均はあるだけの件で求め、今日の件がなければ今日の平均は「なし」', () => {
    const entries = [entry(1), entry(3)];
    expect(historyAverages(entries, NOW)).toEqual({ today: null, recent: 2, overall: 2 });
  });
});
