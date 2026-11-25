import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

// 配信先のサブパス。ビルドの結果は /apex-training/ に置いて配信する（docs/spec/architecture.md ARC-14）。
export const BASE_PATH = '/apex-training/';

/** テストのファイルの場所（src/ と同じ構成で tests/ に置く）。 */
export const TEST_DIR = 'tests';
export const TEST_SUFFIX = '.test.ts';

/**
 * テストのファイルが Chromium を使うか。Chromium は tests/helpers/browser.ts からしか起動しないので、
 * それを import しているファイルをブラウザを使うテストとする（docs/spec/architecture.md「テストの実行」、ARC-21）。
 */
export function usesChromium(source: string): boolean {
  return /(?:from|import)\s*\(?\s*['"](?:\.\.?\/)+(?:helpers\/)?browser(?:\.ts)?['"]/.test(source);
}

/** root の tests/ 以下のテストのファイル（root からの相対パス、/ 区切り、並べ替え済み）。tests/ がなければ空。 */
export function listTestFiles(root: string): string[] {
  const dir = join(root, TEST_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith(TEST_SUFFIX) && !f.split(sep).includes('node_modules'))
    .map((f) => relative(root, join(dir, f)).split(sep).join('/'))
    .sort();
}

/** ブラウザ（Chromium）を使うテストのファイル。 */
export function browserTestFiles(root: string): string[] {
  return listTestFiles(root).filter((f) => usesChromium(readFileSync(join(root, f), 'utf8')));
}

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const BROWSER_FILES = browserTestFiles(ROOT);

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
    environment: 'node',
    // git やビルドを子のプロセスで動かすテストは、マシンが重いと既定の 5 秒を超える。条件を待つ上限とは別に、
    // テスト 1 件の上限を伸ばして、負荷の中で 3 回続けて流しても落ちないようにする（docs/spec/architecture.md ARC-20）。
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // テストは 2 つの組に分ける（docs/spec/architecture.md「テストの実行」）。npm test は両方を流す。
    // unit（ブラウザを使わない）はファイル単位で並列に、browser（Chromium を使う）は 1 ファイルずつ流す。
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [`${TEST_DIR}/**/*${TEST_SUFFIX}`],
          exclude: [...configDefaults.exclude, ...BROWSER_FILES],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          // 当たるファイルがないときも既定の include に戻らないよう、当たらないパターンを置く。
          include: BROWSER_FILES.length > 0 ? BROWSER_FILES : [`${TEST_DIR}/__no_browser_tests__${TEST_SUFFIX}`],
          fileParallelism: false,
        },
      },
    ],
  },
});
