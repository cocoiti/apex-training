import { describe, expect, it } from 'vitest';
import type { ShotRecord } from '../../src/sim/gun';
import type { WeaponData } from '../../src/sim/weapon';
import { optionText, resultSummaryText } from '../../src/ui/result-summary';

const shot = (n: number, position: ShotRecord['position']): ShotRecord => ({
  shot: n,
  patternShot: n,
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
      mode: { id: 'ghost', name: '反復練習', category: 'recoil' },
      shots,
    });
    expect(text).toBe('L-STAR / 反復練習 — 3 発');
    expect(text).not.toContain('当たり');
  });

  it('練習の選択肢を持つモードは、モードのあとに選んだ値を書く', () => {
    const option = { id: 'fast', name: '速い', optionId: 'speed', label: '速さ' };
    expect(resultSummaryText({ weapon: undefined, mode: { id: 'tracking', name: '追いエイム', category: 'aim' }, shots: [], options: [option] })).toBe('追いエイム / 速さ: 速い — 0 発');
    expect(optionText([option])).toBe('速さ: 速い');
    expect(optionText([])).toBeUndefined();
    expect(optionText(undefined)).toBeUndefined();
  });
});
