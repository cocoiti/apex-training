// 公開（docs/spec/overview.md「公開」、docs/spec/architecture.md「公開のワークフロー」）の受け入れ条件 OVR-8・ARC-104-4 の受け入れテスト。
// 公開された入口（npm run build のビルド結果、公開先の画面）だけを使い、実装の内部には依存しない。
//
// ARC-104-4: 公開のワークフロー（.github/workflows/deploy.yml）と同じビルド（npm run build。依存は手元の node_modules を使う）で
//   作った dist/ を、GitHub Pages と同じ形（ルートを /apex-training/）で配信して #/settings を直接開く。
//   手元の dist/ を壊さないよう、ビルドの出力先は一時ディレクトリにする。
// OVR-8: 公開先（https://cocoiti.github.io/apex-training/）を開く確認はネットワークと実際の公開が要るため、
//   APEX_ACCEPTANCE_LIVE=1 のときだけ実行する。
// 画面の確認はヘッドレスの Chromium で行う（tests/helpers/browser.ts）。Chromium がなければ飛ばす。
// ARC-13 の clone の中で npm test を実行したときに入れ子で重い確認をしないよう、APEX_ACCEPTANCE_NESTED が立っていたら飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const LIVE = process.env.APEX_ACCEPTANCE_LIVE === '1';
const LIVE_URL = 'https://cocoiti.github.io/apex-training/';
const BASE = '/apex-training/';
/** ページを開く練習の乱数の種（docs/spec/architecture.md「テストのための乱数の種の固定」）。テストが失敗したときのメッセージにも出る。 */
const SEED = 12345;

const chromium = findChromium();

/** #/settings を直接開き、設定画面が表示され、武器データ（JSON）の読み込みが 404 にならないことを確かめる。 */
async function expectSettingsWithWeapons(page: Page, url: string) {
  await page.goto(url, { timeout: 20_000 });
  await page.waitFor(`document.querySelector('[data-screen="settings"]') && !document.querySelector('[data-screen="settings"]').hidden`, 20_000);
  // 武器データ（JSON）の読み込みが終わって選択肢に出るまで待つ。
  await page.waitFor(
    `document.querySelector('#weapon') && document.querySelector('#weapon').options.length > 0 && performance.getEntriesByType('resource').some((e) => new URL(e.name).pathname.endsWith('.json'))`,
    20_000,
  );
  const visible = await page.evaluate<string[]>(`[...document.querySelectorAll('[data-screen]')].filter((el) => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return !el.hidden && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  }).map((el) => el.dataset.screen)`);
  expect(visible).toEqual(['settings']);
  const resources = await page.evaluate<{ name: string; status: number }[]>(
    `performance.getEntriesByType('resource').map((e) => ({ name: e.name, status: e.responseStatus ?? 0 }))`,
  );
  const json = resources.filter((r) => new URL(r.name).pathname.endsWith('.json'));
  expect(json.length, `武器データ（JSON）の読み込みが見つからない: ${JSON.stringify(resources, null, 2)}`).toBeGreaterThan(0);
  // ブラウザが勝手に取りに行く /favicon.ico（サイトの外）は対象にしない。アプリが読み込むサブパスの下のものだけを見る。
  const failed = resources.filter((r) => new URL(r.name).pathname.startsWith(BASE) && r.status >= 400);
  expect(failed, JSON.stringify(resources, null, 2)).toEqual([]);
  for (const r of json) expect(new URL(r.name).pathname.startsWith(BASE), r.name).toBe(true);
  expect(page.errors).toEqual([]);
}

describe.skipIf(NESTED || !chromium)('公開した #/settings を直接開く', () => {
  let browser: Browser | undefined;

  beforeAll(async () => {
    browser = await launchBrowser(chromium!);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  describe('ARC-104-4: deploy.yml と同じビルド（npm run build）の dist/ を /apex-training/ で配信する', () => {
    let dist = '';
    let build = { status: null as number | null, output: '' };
    let server: Server | undefined;

    beforeAll(async () => {
      dist = mkdtempSync(join(tmpdir(), 'arc104-dist-'));
      const r = spawnSync(`npm run build -- --outDir "${dist}" --emptyOutDir`, {
        cwd: ROOT,
        shell: true,
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      build = { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
      if (build.status === 0) server = await serveStatic(dist, BASE);
    }, 300_000);

    afterAll(async () => {
      await new Promise((ok) => (server ? server.close(ok) : ok(undefined)));
      if (dist) rmSync(dist, { recursive: true, force: true });
    });

    it('#/settings で設定画面が表示され、武器データの読み込みが 404 にならない', async () => {
      expect(build.status, build.output).toBe(0);
      const page = await browser!.newPage();
      await expectSettingsWithWeapons(page, appUrl(originOf(server!), BASE, '#/settings', { seed: SEED }));
    }, 60_000);
  });

  describe.skipIf(!LIVE)(`OVR-8: 公開先 ${LIVE_URL}（APEX_ACCEPTANCE_LIVE=1 のときだけ）`, () => {
    it('#/settings で設定画面が表示され、武器データの読み込みが 404 にならない', async () => {
      const page = await browser!.newPage();
      await expectSettingsWithWeapons(page, `${LIVE_URL}#/settings`);
    }, 60_000);
  });
});
