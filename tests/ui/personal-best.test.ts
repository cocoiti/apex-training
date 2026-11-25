import { describe, expect, it } from 'vitest';
import { score } from '../../src/sim/scoring';
import { parsePersonalBest, personalBestKey, recordPersonalBest } from '../../src/ui/personal-best';
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
  };
}

const NOW = new Date('2026-11-25T05:06:07.000Z');
const KEY = 'apex-training:best:mouse:r301:center';
/** 全弾の水平のズレが h 度の 10 発の採点（平均ズレ h 度）。 */
const result = (h: number) => score(Array.from({ length: 10 }, () => ({ yaw: h, pitch: 0 })), 1);
const stored = (meanError: number) =>
  JSON.stringify({ version: 1, meanError, groupingRadius: 0, hitRate: 100, shots: 10, achievedAt: '2026-01-01T00:00:00.000Z' });

describe('自己ベストのキー', () => {
  it('apex-training:best:<入力方式>:<武器の id>:<モードの id>', () => {
    expect(personalBestKey('mouse', 'r301', 'center')).toBe(KEY);
    expect(personalBestKey('pad', 'r99', 'ghost')).toBe('apex-training:best:pad:r99:ghost');
  });
});

describe('自己ベストの読み出し', () => {
  it('保存の形の JSON を読む', () => {
    expect(parsePersonalBest(stored(0.5))?.meanError).toBe(0.5);
  });

  it.each([
    ['値がない', null],
    ['JSON として読めない', '{not json'],
    ['オブジェクトでない', '[1]'],
    ['null', 'null'],
    ['version が 1 でない', JSON.stringify({ version: 2, meanError: 0.5 })],
    ['version がない', JSON.stringify({ meanError: 0.5 })],
    ['meanError が負', JSON.stringify({ version: 1, meanError: -0.1 })],
    ['meanError が数でない', JSON.stringify({ version: 1, meanError: '0.5' })],
    ['meanError がない', JSON.stringify({ version: 1 })],
  ])('%s ときは自己ベストがないものとする', (_, raw) => {
    expect(parsePersonalBest(raw)).toBeNull();
  });

  it('meanError が 0 でも自己ベストとして読む', () => {
    expect(parsePersonalBest(stored(0))?.meanError).toBe(0);
  });
});

describe('自己ベストの更新', () => {
  it('SCO-18: 自己ベストがなければ更新し、保存の形の JSON で保存する', () => {
    const storage = memoryStorage();
    const outcome = recordPersonalBest(storage, KEY, result(0.25), NOW);
    expect(outcome.updated).toBe(true);
    expect(JSON.parse(storage.items.get(KEY) ?? '')).toEqual({
      version: 1,
      meanError: 0.25,
      groupingRadius: 0,
      hitRate: 100,
      shots: 10,
      achievedAt: '2026-11-25T05:06:07.000Z',
    });
    expect(outcome.best?.meanError).toBe(0.25);
  });

  it('SCO-5: 保存してある自己ベストより平均ズレが小さければ更新する', () => {
    const storage = memoryStorage({ [KEY]: stored(0.5) });
    expect(recordPersonalBest(storage, KEY, result(0.375), NOW).updated).toBe(true);
    expect(parsePersonalBest(storage.items.get(KEY) ?? null)?.meanError).toBe(0.375);
  });

  it.each([0.5, 0.8])('SCO-19: 平均ズレ %s 度（自己ベスト 0.5 度以上）では更新せず、保存してある値を変えない', (h) => {
    const storage = memoryStorage({ [KEY]: stored(0.5) });
    const outcome = recordPersonalBest(storage, KEY, result(h), NOW);
    expect(outcome.updated).toBe(false);
    expect(outcome.best?.meanError).toBe(0.5);
    expect(storage.items.get(KEY)).toBe(stored(0.5));
  });

  it('SCO-20: ほかのキーの自己ベストは比べず、変えない', () => {
    const storage = memoryStorage({ [KEY]: stored(0.1) });
    const other = personalBestKey('mouse', 'r301', 'ghost');
    expect(recordPersonalBest(storage, other, result(0.9), NOW).updated).toBe(true);
    expect(storage.items.get(KEY)).toBe(stored(0.1));
  });

  it('SCO-21: 保存してある値が JSON として読めなければ、その結果を自己ベストとして保存する', () => {
    const storage = memoryStorage({ [KEY]: '{broken' });
    expect(recordPersonalBest(storage, KEY, result(2), NOW).updated).toBe(true);
    expect(parsePersonalBest(storage.items.get(KEY) ?? null)?.meanError).toBe(2);
  });

  it('平均ズレが「なし」（1 発も撃っていない）なら更新しない', () => {
    const storage = memoryStorage();
    expect(recordPersonalBest(storage, KEY, score([], 1), NOW)).toEqual({ updated: false, best: null });
    expect(storage.items.size).toBe(0);
  });

  it('SCO-22: 書き込みが例外になっても投げず、ページを開いているあいだは自己ベストが残る', () => {
    const storage = new SafeStorage(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(recordPersonalBest(storage, KEY, result(0.5), NOW).updated).toBe(true);
    expect(storage.unavailable).toBe(true);
    const again = recordPersonalBest(storage, KEY, result(0.7), NOW);
    expect(again).toMatchObject({ updated: false, best: { meanError: 0.5 } });
  });
});
