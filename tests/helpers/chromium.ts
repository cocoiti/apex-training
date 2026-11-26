// ブラウザを使うテストが起動する Chromium の実行ファイルを探す（tests/helpers/browser.ts が使い、そこから export する）。
// Chromium を起動しないので、ここだけを import するテストはブラウザを使うテストの組に入らない。
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 1 のとき、Chromium が見つからなければ findChromium が例外を投げる環境変数（CI で設定する）。 */
export const REQUIRE_CHROMIUM_ENV = 'APEX_REQUIRE_CHROMIUM';

/**
 * 使える Chromium の実行ファイルを探す。見つからなければ undefined（ブラウザを使うテストは飛ばす）。
 * 探すのは CHROMIUM_PATH、PLAYWRIGHT_BROWSERS_PATH（Playwright の公式の Docker イメージでは /ms-playwright）、home の下の Playwright のキャッシュの順。
 * ただし env の APEX_REQUIRE_CHROMIUM が 1 なら、見つからないときは探した場所を示して例外を投げる。
 * テストのファイルの読み込みが失敗になるので、CI でブラウザを使うテストが飛ばされて成功になることがない（ARC-60）。
 */
export function findChromium(env: Record<string, string | undefined> = process.env, home: string = homedir()): string | undefined {
  const caches = [
    ...(env.PLAYWRIGHT_BROWSERS_PATH?.trim() ? [env.PLAYWRIGHT_BROWSERS_PATH.trim()] : []),
    join(home, 'Library/Caches/ms-playwright'),
    join(home, '.cache/ms-playwright'),
  ];
  const found = searchChromium(env.CHROMIUM_PATH, caches);
  if (found === undefined && env[REQUIRE_CHROMIUM_ENV]?.trim() === '1') {
    throw new Error(`${REQUIRE_CHROMIUM_ENV}=1 なのに Chromium が見つからない（CHROMIUM_PATH: ${JSON.stringify(env.CHROMIUM_PATH ?? '')}、探した場所: ${caches.join(', ')}）`);
  }
  return found;
}

function searchChromium(fromEnv: string | undefined, caches: string[]): string | undefined {
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    const dirs = readdirSync(cache).sort().reverse();
    for (const dir of dirs.filter((d) => d.startsWith('chromium-'))) {
      for (const bin of [
        join(cache, dir, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        join(cache, dir, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
        join(cache, dir, 'chrome-linux/chrome'),
        join(cache, dir, 'chrome-linux64/chrome'),
        join(cache, dir, 'chrome-linux-arm64/chrome'),
      ]) {
        if (existsSync(bin)) return bin;
      }
    }
    for (const dir of dirs.filter((d) => d.startsWith('chromium_headless_shell-'))) {
      for (const sub of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell-linux64', 'chrome-headless-shell-linux-arm64']) {
        const bin = join(cache, dir, sub, 'chrome-headless-shell');
        if (existsSync(bin)) return bin;
      }
    }
  }
  return undefined;
}
