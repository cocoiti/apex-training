// ARC-53 の確認のためにわざと失敗させるテスト（確かめたあとに消す）。
import { expect, it } from 'vitest';

it('ARC-53: わざと失敗させる', () => {
  expect(1).toBe(2);
});
