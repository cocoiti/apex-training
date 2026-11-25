import { describe, expect, it } from 'vitest';
import { createRandom } from '../../src/core/random';

function take(seed: number, count: number): number[] {
  const random = createRandom(seed);
  return Array.from({ length: count }, () => random.next());
}

describe('種付きの乱数', () => {
  it('ARC-10: 同じ種で作った乱数は 100 個の列が一致する', () => {
    expect(take(12345, 100)).toEqual(take(12345, 100));
  });

  it('ARC-10: 違う種で作った乱数は列が一致しない', () => {
    expect(take(12345, 100)).not.toEqual(take(54321, 100));
  });

  it('0 以上 1 未満の数を返す', () => {
    for (const value of take(7, 1000)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
