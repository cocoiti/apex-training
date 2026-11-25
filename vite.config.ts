import { defineConfig } from 'vitest/config';

// 配信先のサブパス。ビルドの結果は /apex-training/ に置いて配信する（docs/spec/architecture.md ARC-14）。
export const BASE_PATH = '/apex-training/';

export default defineConfig({
  base: BASE_PATH,
  build: {
    // データの JSON は data: URL に埋め込まず、ベースパス基準の URL のファイルとして出して fetch する。
    assetsInlineLimit: (filePath) => (filePath.endsWith('.json') ? false : undefined),
    // Three.js だけで 500 kB を超えるため、警告の基準を上げる。
    chunkSizeWarningLimit: 800,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
