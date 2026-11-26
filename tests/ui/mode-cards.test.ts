import { describe, expect, it } from 'vitest';
import flick from '../../src/modes/aim/flick';
import tracking from '../../src/modes/aim/tracking';
import trackingRecoil from '../../src/modes/aim/tracking-recoil';
import ghost from '../../src/modes/recoil/ghost';
import { modeBestSummary, NO_BEST_SUMMARY } from '../../src/ui/mode-cards';

/** Map で代用した保存先。 */
const storage = (items: Record<string, string> = {}) => ({ get: (key: string) => items[key] ?? null });
const best = (fields: Record<string, number>) => JSON.stringify({ version: 1, ...fields, achievedAt: '2026-11-26T00:00:00.000Z' });
const mouse = (weaponId: string, options: Record<string, string> = {}) => ({ input: 'mouse' as const, weaponId, options });

describe('モードのカードの自己ベストの要約', () => {
  it('UI-114: 反復練習は選んでいる武器の自己ベストを「自己ベスト: 0.85°」と書き、ない武器では「まだ記録なし」', () => {
    const s = storage({ 'apex-training:best:mouse:lstar:ghost': best({ meanError: 0.85, groupingRadius: 1, hitRate: 50, shots: 10 }) });
    expect(modeBestSummary(s, ghost, mouse('lstar'))).toBe('自己ベスト: 0.85°');
    expect(modeBestSummary(s, ghost, mouse('car'))).toBe(NO_BEST_SUMMARY);
    expect(NO_BEST_SUMMARY).toBe('自己ベスト: まだ記録なし');
  });

  it('UI-114: 入力方式が違う組の自己ベストは出さない', () => {
    const s = storage({ 'apex-training:best:mouse:lstar:ghost': best({ meanError: 0.85 }) });
    expect(modeBestSummary(s, ghost, { input: 'pad', weaponId: 'lstar', options: {} })).toBe(NO_BEST_SUMMARY);
  });

  it('UI-114: 自己ベストが 1 つもないときは、すべてのモードで「まだ記録なし」', () => {
    for (const mode of [ghost, tracking, trackingRecoil, flick]) expect(modeBestSummary(storage(), mode, mouse('lstar')), mode.id).toBe(NO_BEST_SUMMARY);
  });

  it('追いエイムは武器を使わないので武器の id を `-` にし、選んでいる速さの組を小数第 1 位までの % で書く', () => {
    const s = storage({
      'apex-training:best:mouse:-:tracking:fast': best({ onTargetRate: 72.25 }),
      'apex-training:best:mouse:lstar:tracking-recoil:normal': best({ onTargetRate: 50 }),
    });
    expect(modeBestSummary(s, tracking, mouse('lstar', { speed: 'fast' }))).toBe('自己ベスト: 72.3%');
    expect(modeBestSummary(s, tracking, mouse('lstar', { speed: 'normal' }))).toBe(NO_BEST_SUMMARY);
    // 追いエイム＋リコイルは武器を使い、速さを選んでいなければ既定の「ふつう」。
    expect(modeBestSummary(s, trackingRecoil, mouse('lstar'))).toBe('自己ベスト: 50.0%');
    expect(modeBestSummary(s, trackingRecoil, mouse('car'))).toBe(NO_BEST_SUMMARY);
  });

  it('フリックは出る範囲と的の大きさの組を小数第 3 位までの秒で書く', () => {
    const s = storage({ 'apex-training:best:mouse:-:flick:far:small': best({ timePerHit: 0.5 }) });
    expect(modeBestSummary(s, flick, mouse('car', { 'flick-range': 'far', 'flick-size': 'small' }))).toBe('自己ベスト: 0.500 秒');
    expect(modeBestSummary(s, flick, mouse('car'))).toBe(NO_BEST_SUMMARY);
  });

  it('読めない値・版の違う値は自己ベストがないものとして扱う', () => {
    const s = storage({ 'apex-training:best:mouse:lstar:ghost': '{', 'apex-training:best:mouse:car:ghost': JSON.stringify({ version: 2, meanError: 1 }) });
    expect(modeBestSummary(s, ghost, mouse('lstar'))).toBe(NO_BEST_SUMMARY);
    expect(modeBestSummary(s, ghost, mouse('car'))).toBe(NO_BEST_SUMMARY);
  });
});
