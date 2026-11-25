import { defineConfig } from 'vitest/config';

// 配信先のサブパス。ビルドの結果は /apex-training/ に置いて配信する（docs/spec/architecture.md ARC-14）。
export const BASE_PATH = '/apex-training/';

export default defineConfig({
  base: BASE_PATH,
  build: {
    // 資産は大きさによらず data: URL に埋め込まず、ベースパス基準の URL のファイルとして出す。
    // データの JSON は fetch するため（ARC-11）、画像・音声・3D モデルは素材の一覧と照らして検査するため（overview.md OVR-14）。
    assetsInlineLimit: 0,
    // Three.js だけで 500 kB を超えるため、警告の基準を上げる。
    chunkSizeWarningLimit: 800,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
