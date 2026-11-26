import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

// 配信先のサブパス。ビルドの結果は /apex-training/ に置いて配信する（docs/spec/architecture.md ARC-14）。
export const BASE_PATH = '/apex-training/';

/**
 * 画面の表示の計測に使う Google Tag Manager のコンテナ ID（docs/spec/overview.md「画面の表示の計測」）。ID を置くのはここだけ。
 * 空にすると計測に関わることを何もしないビルドになる。環境変数 APEX_GTM_CONTAINER_ID があればその値（空を含む）で置き換える。
 */
export const GTM_CONTAINER_ID = 'GTM-MNFCCG6N';
/** コンテナ ID を置き換える環境変数。 */
export const GTM_CONTAINER_ID_ENV = 'APEX_GTM_CONTAINER_ID';

/** ビルドに埋め込むコンテナ ID。環境変数があればその値、なければ GTM_CONTAINER_ID。 */
export function gtmContainerId(env: Record<string, string | undefined>): string {
  return env[GTM_CONTAINER_ID_ENV] ?? GTM_CONTAINER_ID;
}

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

/** ブラウザを使うテストのファイルを同時に流す数の既定値（docs/spec/architecture.md「テストの実行」。CLAUDE.md にも書く）。 */
export const DEFAULT_BROWSER_WORKERS = 3;
/** 同時に流すブラウザを使うテストのファイルの数を変える環境変数。 */
export const BROWSER_WORKERS_ENV = 'APEX_BROWSER_WORKERS';

/**
 * 同時に流すブラウザを使うテストのファイルの数。環境変数 APEX_BROWSER_WORKERS がなければ（空なら）既定値、
 * あれば 1 以上の整数として読む。1 以上の整数でなければ、テストを流す前にその環境変数の名前を示して失敗する（ARC-32, ARC-33）。
 */
export function browserWorkers(env: Record<string, string | undefined>): number {
  const raw = env[BROWSER_WORKERS_ENV]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_BROWSER_WORKERS;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${BROWSER_WORKERS_ENV} は 1 以上の整数で指定する（指定された値: ${JSON.stringify(env[BROWSER_WORKERS_ENV])}）`);
  }
  return Number(raw);
}

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const BROWSER_FILES = browserTestFiles(ROOT);
// 値を確かめるのは Vitest が設定を読むときだけにする（npm run dev・build は環境変数によらず動く）。
const BROWSER_WORKERS = process.env.VITEST ? browserWorkers(process.env) : DEFAULT_BROWSER_WORKERS;

export default defineConfig({
  base: BASE_PATH,
  define: {
    __GTM_CONTAINER_ID__: JSON.stringify(gtmContainerId(process.env)),
  },
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
    // テストが子のプロセスで行うビルドと開発サーバーは、既定でコンテナ ID を空にし、計測の案内を出さず googletagmanager.com へ要求しない。
    // 計測を確かめるテストだけが APEX_GTM_CONTAINER_ID を渡してビルドする（docs/adr/2026-11-26-gtm-container-id-in-vite-config.md）。
    env: { [GTM_CONTAINER_ID_ENV]: process.env[GTM_CONTAINER_ID_ENV] ?? '' },
    // テストは 2 つの組に分ける（docs/spec/architecture.md「テストの実行」）。npm test は両方を流す。
    // unit（ブラウザを使わない）はファイル単位で並列に、browser（Chromium を使う）は BROWSER_WORKERS ファイルずつ並行に流す。
    // browser のファイルは、ポート（0 で待ち受け）・Chromium のプロファイルと一時ディレクトリ・ビルドの結果・Vite の cacheDir を
    // ファイルごとの一時ディレクトリに持つので、並行に流しても取り合わない。
    // npm test では unit を流し終えてから browser を流す（sequence.groupOrder）。unit にはビルドや git の clone、入れ子の
    // npm test を子のプロセスで動かす重いテストがあり、同時に流すと描画の間隔が伸びて画面のテストが不安定になるため（ARC-20）。
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          sequence: { groupOrder: 0 },
          include: [`${TEST_DIR}/**/*${TEST_SUFFIX}`],
          exclude: [...configDefaults.exclude, ...BROWSER_FILES],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          sequence: { groupOrder: 1 },
          // 当たるファイルがないときも既定の include に戻らないよう、当たらないパターンを置く。
          include: BROWSER_FILES.length > 0 ? BROWSER_FILES : [`${TEST_DIR}/__no_browser_tests__${TEST_SUFFIX}`],
          // npm test でも npm run test:browser でも同じ数で流す（groupOrder が unit と違うので、組ごとの maxWorkers が効く）。
          maxWorkers: BROWSER_WORKERS,
        },
      },
    ],
  },
});
