import { describe, expect, it } from 'vitest';
import { score } from '../../src/sim/scoring';
import {
  clearHistory,
  HISTORY_LIMIT,
  historyAverages,
  historyKey,
  loadHistory,
  parseHistory,
  entrySections,
  historyValues,
  loadModeHistory,
  parseHistoryEntries,
  recordHistory,
  recordHistoryEntry,
  type HistoryEntry,
} from '../../src/ui/practice-history';
import { NO_WEAPON_ID } from '../../src/ui/mode-scoring';
import { HIT_COUNT } from '../helpers/aim-modes';
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

const LSTAR_CENTER = { input: 'mouse', weaponId: 'lstar', modeId: 'center' } as const;
const KEY = 'apex-training:history:mouse:lstar:center';
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
    expect(historyKey(LSTAR_CENTER)).toBe(KEY);
    expect(historyKey({ input: 'pad', weaponId: 'car', modeId: 'ghost' })).toBe('apex-training:history:pad:car:ghost');
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

describe('件の発の区間ごとのズレ', () => {
  const section = (start: number, extra: Record<string, unknown> = {}) => ({
    start,
    shots: 5,
    meanH: 0,
    meanV: 0,
    meanError: 0,
    ...extra,
  });

  it('形に合う sections を発の番号の順に返す', () => {
    expect(entrySections({ sections: [section(6), section(1)] })?.map((s) => s.start)).toEqual([1, 6]);
  });

  it.each([
    ['sections がない', undefined],
    ['配列でない', {}],
    ['start が 5 で割って 1 余らない', [section(2)]],
    ['start が 1 未満', [section(-4)]],
    ['start が整数でない', [section(1.5)]],
    ['shots が 0', [section(1, { shots: 0 })]],
    ['shots が 6', [section(1, { shots: 6 })]],
    ['meanH が有限の数でない', [section(1, { meanH: null })]],
    ['meanV が文字列', [section(1, { meanV: '0' })]],
    ['meanError が負', [section(1, { meanError: -0.1 })]],
    ['start が重なる', [section(1), section(1)]],
    ['要素がオブジェクトでない', [1]],
  ])('%s ときは持たない件とする', (_, sections) => {
    expect(entrySections({ sections })).toBeNull();
  });

  it('形に合わない sections の件もほかの項目はそのまま読み、書き直すときも残す', () => {
    const broken = { ...entry(1), sections: [section(2)] };
    const storage = memoryStorage({ [KEY]: stored([broken]) });
    expect(loadHistory(storage, LSTAR_CENTER).map((e) => e.meanError)).toEqual([1]);
    recordHistory(storage, LSTAR_CENTER, result(1), NOW);
    const saved = JSON.parse(storage.items.get(KEY) ?? '') as { entries: unknown[] };
    expect(saved.entries[0]).toEqual(broken);
  });
});

describe('履歴に足す', () => {
  it('1 件目は、終えた日時・平均ズレ・命中率・グルーピング半径・撃った弾数・発の区間ごとのズレを保存の形で保存する', () => {
    const storage = memoryStorage();
    recordHistory(storage, LSTAR_CENTER, result(0.25), NOW);
    const section = (start: number) => ({ start, shots: 5, meanH: 0.25, meanV: 0, meanError: 0.25 });
    expect(JSON.parse(storage.items.get(KEY) ?? '')).toEqual({
      version: 1,
      entries: [
        {
          at: '2026-11-25T05:06:07.000Z',
          meanError: 0.25,
          hitRate: 100,
          groupingRadius: 0,
          shots: 10,
          sections: [section(1), section(6)],
        },
      ],
    });
  });

  it('SCO-31: 23 発を採点すると、start が 1・6・11・16・21 の 5 つの発の区間を保存し、最後の発の区間は 3 発になる', () => {
    const storage = memoryStorage();
    // i 発目（0 始まり）は水平 i / 10 度、垂直 −i / 20 度。
    const deviations = Array.from({ length: 23 }, (_, i) => ({ yaw: i / 10, pitch: -i / 20 }));
    recordHistory(storage, LSTAR_CENTER, score(deviations, 1), NOW);
    const [saved] = loadHistory(storage, LSTAR_CENTER);
    const sections = saved ? entrySections(saved) : null;
    expect(sections?.map((s) => s.start)).toEqual([1, 6, 11, 16, 21]);
    expect(sections?.map((s) => s.shots)).toEqual([5, 5, 5, 5, 3]);
    sections?.forEach((s) => {
      const part = deviations.slice(s.start - 1, s.start - 1 + s.shots);
      const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
      expect(s.meanH).toBeCloseTo(mean(part.map((d) => d.yaw)), 10);
      expect(s.meanV).toBeCloseTo(mean(part.map((d) => d.pitch)), 10);
      expect(s.meanError).toBeCloseTo(mean(part.map((d) => Math.hypot(d.yaw, d.pitch))), 10);
    });
  });

  it('SCO-36: sections を持たない古い形式の件はそのまま残し、11 件目を足す', () => {
    const old = Array.from({ length: 10 }, (_, i) => entry(i + 1));
    const storage = memoryStorage({ [KEY]: stored(old) });
    const kept = recordHistory(storage, LSTAR_CENTER, result(1), NOW);
    expect(kept).toHaveLength(11);
    const saved = JSON.parse(storage.items.get(KEY) ?? '') as { entries: unknown[] };
    expect(saved.entries.slice(0, 10)).toEqual(old);
  });

  it('SCO-23: 3 回足すと 3 件が古い順に並ぶ', () => {
    const storage = memoryStorage();
    [0.5, 0.25, 0.75].forEach((h, i) => recordHistory(storage, LSTAR_CENTER, result(h), new Date(NOW.getTime() + i * 1000)));
    const entries = loadHistory(storage, LSTAR_CENTER);
    expect(entries.map((e) => e.meanError)).toEqual([0.5, 0.25, 0.75]);
    expect(entries.map((e) => Date.parse(e.at))).toEqual([0, 1, 2].map((i) => NOW.getTime() + i * 1000));
  });

  it('SCO-24: 200 件あるときに足すと 200 件のままで、最も古い 1 件が消え、最後が今の結果になる', () => {
    const old = Array.from({ length: HISTORY_LIMIT }, (_, i) => entry(i + 1));
    const storage = memoryStorage({ [KEY]: stored(old) });
    recordHistory(storage, LSTAR_CENTER, result(0.125), NOW);
    const entries = loadHistory(storage, LSTAR_CENTER);
    expect(HISTORY_LIMIT).toBe(200);
    expect(entries).toHaveLength(200);
    expect(entries[0]?.meanError).toBe(2);
    expect(entries[199]).toMatchObject({ meanError: 0.125, at: NOW.toISOString() });
  });

  it('SCO-26: ほかの組の履歴は変えない', () => {
    const saved = stored([entry(1)]);
    const storage = memoryStorage({ [KEY]: saved });
    recordHistory(storage, { ...LSTAR_CENTER, modeId: 'ghost' }, result(1), NOW);
    recordHistory(storage, { ...LSTAR_CENTER, input: 'pad' }, result(1), NOW);
    expect(storage.items.get(KEY)).toBe(saved);
  });

  it('SCO-29: 保存してある値が JSON として読めなければ、その結果の 1 件だけにする', () => {
    const storage = memoryStorage({ [KEY]: '{broken' });
    recordHistory(storage, LSTAR_CENTER, result(2), NOW);
    expect(loadHistory(storage, LSTAR_CENTER).map((e) => e.meanError)).toEqual([2]);
  });

  it('読み飛ばした要素は、次に足すときに除いて書き直す', () => {
    const storage = memoryStorage({ [KEY]: stored([entry(1), { at: 'x', meanError: 1 }]) });
    recordHistory(storage, LSTAR_CENTER, result(2), NOW);
    expect((JSON.parse(storage.items.get(KEY) ?? '') as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it('平均ズレが「なし」（1 発も撃っていない）なら足さない', () => {
    const storage = memoryStorage();
    recordHistory(storage, LSTAR_CENTER, score([], 1), NOW);
    expect(storage.items.size).toBe(0);
  });

  it('SCO-30: 書き込みが例外になっても投げず、同じページでは足した履歴を読める', () => {
    const storage = new SafeStorage(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    recordHistory(storage, LSTAR_CENTER, result(1), NOW);
    recordHistory(storage, LSTAR_CENTER, result(2), NOW);
    expect(storage.unavailable).toBe(true);
    expect(loadHistory(storage, LSTAR_CENTER).map((e) => e.meanError)).toEqual([1, 2]);
  });
});

describe('履歴を消す', () => {
  it('選んだ組の履歴だけを消し、ほかの組と自己ベストは残す', () => {
    const best = 'apex-training:best:mouse:lstar:center';
    const other = historyKey({ ...LSTAR_CENTER, modeId: 'ghost' });
    const storage = memoryStorage({ [KEY]: stored([entry(1)]), [other]: stored([entry(2)]), [best]: '{}' });
    clearHistory(storage, LSTAR_CENTER);
    expect(loadHistory(storage, LSTAR_CENTER)).toEqual([]);
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

describe('モードの比べる指標の履歴', () => {
  const AIM = { input: 'mouse', weaponId: NO_WEAPON_ID, modeId: 'flick' } as const;
  const AIM_KEY = 'apex-training:history:mouse:-:flick';

  it('SCO-42: 武器を使わないモードの履歴は - のキーに、version 1 と比べる指標の値を持つ件として保存する', () => {
    const storage = memoryStorage();
    recordHistoryEntry(storage, AIM, HIT_COUNT, { value: 9, fields: { shots: 12 } }, NOW);
    expect(historyKey(AIM)).toBe(AIM_KEY);
    expect(JSON.parse(storage.items.get(AIM_KEY) ?? '')).toEqual({ version: 1, entries: [{ at: NOW.toISOString(), hits: 9, shots: 12 }] });
  });

  it('値が求まらない結果は足さない', () => {
    const storage = memoryStorage();
    expect(recordHistoryEntry(storage, AIM, HIT_COUNT, { value: null }, NOW)).toEqual([]);
    expect(storage.items.size).toBe(0);
  });

  it('SCO-44: 比べる指標の項目が数でない件だけを読み飛ばし、ほかの件は推移・平均に使う', () => {
    const raw = JSON.stringify({
      version: 1,
      entries: [
        { at: '2026-11-25T01:00:00.000Z', hits: 10 },
        { at: '2026-11-25T02:00:00.000Z', hits: 'many' },
        { at: '2026-11-25T03:00:00.000Z' },
        { at: '2026-11-25T04:00:00.000Z', hits: 14 },
      ],
    });
    const entries = parseHistoryEntries(raw, HIT_COUNT);
    expect(historyValues(entries, HIT_COUNT)).toEqual([10, 14]);
    expect(historyAverages(entries, NOW, HIT_COUNT)).toEqual({ today: 12, recent: 12, overall: 12 });
    const storage = memoryStorage({ [AIM_KEY]: raw });
    expect(loadModeHistory(storage, AIM, HIT_COUNT)).toHaveLength(2);
  });

  it('SCO-44: 反復練習の履歴でも、meanError が数でない件だけを読み飛ばす', () => {
    const raw = JSON.stringify({ version: 1, entries: [entry(1), { ...entry(2), meanError: 'x' }, entry(3)] });
    expect(parseHistory(raw).map((e) => e.meanError)).toEqual([1, 3]);
  });

  it('足すときに読み飛ばした件は除き、上限を超えたら古い件から消す', () => {
    const many = Array.from({ length: HISTORY_LIMIT }, (_, i) => ({ at: NOW.toISOString(), hits: i }));
    const storage = memoryStorage({ [AIM_KEY]: JSON.stringify({ version: 1, entries: [{ at: 'bad', hits: 1 }, ...many] }) });
    const kept = recordHistoryEntry(storage, AIM, HIT_COUNT, { value: 999 }, NOW);
    expect(kept).toHaveLength(HISTORY_LIMIT);
    expect(kept[0]?.hits).toBe(1);
    expect(kept.at(-1)?.hits).toBe(999);
  });
});
