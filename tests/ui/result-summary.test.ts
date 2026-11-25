import { describe, expect, it } from 'vitest';
import type { ShotRecord } from '../../src/sim/gun';
import type { WeaponData } from '../../src/sim/weapon';
import { resultSummaryText } from '../../src/ui/result-summary';

const shot = (n: number, position: ShotRecord['position']): ShotRecord => ({
  shot: n,
  time: n * 0.1,
  angles: { yaw: 0, pitch: 0 },
  position,
  deviation: position ? { yaw: 0, pitch: 0 } : null,
});

describe('リザルトの要約', () => {
  it('武器・モード・撃った弾の数を出し、壁の弾痕を当たりと数えない', () => {
    const shots = [shot(1, { x: 0, y: 1.5, z: -10 }), shot(2, { x: 3, y: 2, z: -10 }), shot(3, null)];
    const text = resultSummaryText({
      weapon: { name: 'L-STAR' } as WeaponData,
      mode: { id: 'center-hold', name: 'センター維持', category: 'recoil' },
      shots,
    });
    expect(text).toBe('L-STAR / センター維持 — 3 発');
    expect(text).not.toContain('当たり');
  });
});
