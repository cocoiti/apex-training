// 画面の表示の計測（docs/spec/overview.md「画面の表示の計測」、docs/spec/screens.md「計測の同意の案内」「計測の設定」）を、
// コンテナ ID を設定したビルドと空のビルドで確かめる。googletagmanager.com への要求は DevTools の Fetch で止めて数え、
// 外へは出さずに GA の Cookie を作るだけのスクリプトを返す（GTM の代わり。dataLayer には何も積まない）。
// 受け入れ条件（OVR-21〜OVR-27、UI-112〜UI-116）の確認の表（tests/acceptance/README.md）には載せず、実装の確かめとして持つ。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ANALYTICS_CONSENT_KEY, CONSENT_MESSAGE } from '../../src/ui/analytics';
import { GTM_CONTAINER_ID, GTM_CONTAINER_ID_ENV } from '../../vite.config';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, waitUntil, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
/** ページを開く練習の乱数の種（docs/spec/architecture.md「テストのための乱数の種の固定」）。テストが失敗したときのメッセージにも出る。 */
const SEED = 12345;
const chromium = findChromium();
const A = 0;
const R2 = 7;
const DOWN = 13;

/** GTM の代わりのスクリプト。GA が作る Cookie だけを作る。 */
const FAKE_GTM = `document.cookie = '_ga=GA1.1.1.1; path=/'; document.cookie = '_ga_TEST=GS1.1; path=/'; document.cookie = '_gid=GA1.2.1; path=/';`;

/** パッド（window.__pad のボタンをテストが変える）と、navigator.share の差し替え。 */
const PAGE_INIT = `
  window.__pad = { buttons: [], axes: [0, 0, 0, 0] };
  const makePad = () => ({ id: 'analytics-pad', index: 0, connected: true, mapping: 'standard', timestamp: performance.now(),
    axes: window.__pad.axes.slice(),
    buttons: Array.from({ length: 17 }, (_, i) => { const p = window.__pad.buttons.includes(i); return { value: p ? 1 : 0, pressed: p, touched: p }; }) });
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: function () { return [makePad(), null, null, null]; } });
  window.__shared = [];
  Object.defineProperty(Navigator.prototype, 'share', { configurable: true, value: function (data) { window.__shared.push(data); return Promise.resolve(); } });
`;
/** localStorage への書き込みが例外になる環境。 */
const FAIL_WRITES = `Storage.prototype.setItem = function () { throw new DOMException('quota', 'QuotaExceededError'); };`;

/** 練習はパッドで撃つので、入力方式をパッドにしておく。 */
const COMMON_KEY = 'apex-training:settings:common';
const screenVisible = (name: string) => `!document.querySelector('[data-screen="${name}"]').hidden`;
const READY = `document.readyState === 'complete' && document.querySelector('#weapon').options.length > 0`;

interface Opened {
  readonly page: Page;
  /** googletagmanager.com へ出た要求の URL。 */
  readonly requests: string[];
}

const builds: { withId: string; withoutId: string } = { withId: '', withoutId: '' };

/** 保存した値を消すために開く、アプリでない空のページ。ビルドの結果に足す。 */
const RESET_PAGE = 'reset.html';

function build(outDir: string, containerId: string): void {
  const result = spawnSync(`npm run build -- --outDir "${outDir}" --emptyOutDir`, {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, [GTM_CONTAINER_ID_ENV]: containerId },
  });
  if (result.status !== 0) throw new Error(`ビルドが失敗した:\n${result.stdout}${result.stderr}`);
  writeFileSync(join(outDir, RESET_PAGE), '<!doctype html><title>reset</title>');
}

describe.skipIf(NESTED || !chromium)('画面の表示の計測', () => {
  let work = '';
  const servers: Server[] = [];
  let browser: Browser | undefined;
  const origins = { withId: '', withoutId: '' };

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'analytics-'));
    builds.withId = join(work, 'with-id');
    builds.withoutId = join(work, 'without-id');
    build(builds.withId, GTM_CONTAINER_ID);
    build(builds.withoutId, '');
    for (const key of ['withId', 'withoutId'] as const) {
      const server = await serveStatic(builds[key], BASE);
      servers.push(server);
      origins[key] = originOf(server);
    }
    browser = await launchBrowser(chromium!);
  }, 300_000);

  afterEach(async () => {
    await browser?.closePages();
  });

  afterAll(async () => {
    await browser?.close();
    for (const server of servers) await new Promise((ok) => server.close(ok));
    if (work) rmSync(work, { recursive: true, force: true });
  });

  /**
   * 保存した値と Cookie を消し（consent を渡せば同意の状態を保存し）、hash の画面を開く。
   * googletagmanager.com への要求は止めて数え、GTM の代わりのスクリプトを返す。
   */
  async function open(
    hash = '#/',
    {
      consent,
      build = 'withId',
      init = '',
      manualClock = false,
    }: { consent?: string; build?: 'withId' | 'withoutId'; init?: string; manualClock?: boolean } = {},
  ): Promise<Opened> {
    const page = await browser!.newPage();
    const requests: string[] = [];
    page.on('Fetch.requestPaused', (params) => {
      const request = params.request as { url: string };
      requests.push(request.url);
      void page.send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'text/javascript' }],
        body: Buffer.from(FAKE_GTM).toString('base64'),
      });
    });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*googletagmanager.com*' }] });
    await page.send('Network.clearBrowserCookies');
    // 開く前に、アプリでない空のページ（RESET_PAGE）で保存した値を消して入れ直す。前のテストの同意の状態で GTM を読み込まないように。
    const origin = origins[build];
    await page.goto(`${origin}${BASE}${RESET_PAGE}`);
    const saved: Record<string, string> = { [COMMON_KEY]: JSON.stringify({ inputMethod: 'pad' }) };
    if (consent) saved[ANALYTICS_CONSENT_KEY] = consent;
    await page.evaluate(`(() => { localStorage.clear(); for (const [k, v] of Object.entries(${JSON.stringify(saved)})) localStorage.setItem(k, v); })()`);
    await page.addInitScript(PAGE_INIT + init);
    await page.goto(appUrl(origin, BASE, hash, { render: false, manualClock, seed: SEED }));
    await page.waitFor(READY, 15_000);
    return { page, requests };
  }

  const dataLayer = (page: Page) => page.evaluate<Record<string, unknown>[] | null>('window.dataLayer ?? null');
  const pageViews = async (page: Page) => ((await dataLayer(page)) ?? []).filter((entry) => entry.event === 'page_view');
  const bannerShown = (page: Page) => page.evaluate<boolean>(`!document.querySelector('#consent-banner').hidden`);
  const go = async (page: Page, hash: string, screen: string) => {
    await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
    await page.waitFor(screenVisible(screen));
  };
  const reload = async (page: Page) => {
    await page.evaluate(`window.__beforeReload = true; location.reload()`);
    await page.waitFor(`!window.__beforeReload && ${READY}`, 15_000);
  };
  /**
   * パッドのボタンを押して離す。時計を手で進めて、押している間を 2 描画（1/30 秒）にする。
   * 描画の回数で待つと、マシンが重いときに押している間が押し続けの繰り返し（400 ms）を超え、項目が 1 つ余計に動く。
   */
  const tap = async (page: Page, button: number) => {
    await page.evaluate(`window.__pad.buttons = [${button}]`);
    await page.advanceClock(2 / 60);
    await page.evaluate(`window.__pad.buttons = []`);
    await page.advanceClock(2 / 60);
  };
  const gaCookies = (page: Page) =>
    page.evaluate<string[]>(`document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter((n) => n.startsWith('_ga') || n === '_gid')`);
  const view = (screen: string, hash: string) => ({ event: 'page_view', screen_name: screen, page_path: `${BASE}${hash}` });
  const GTM_URL = `https://www.googletagmanager.com/gtm.js?id=${GTM_CONTAINER_ID}`;
  /** googletagmanager.com への要求が count 件になるまで待つ。 */
  const requested = (requests: string[], count: number) => waitUntil(() => requests.length >= count, `GTM への要求が ${count} 件になる`);

  it('未選択では案内を出し、選ぶ前は GTM を読み込まず、Cookie・dataLayer・noscript の iframe もない', async () => {
    const { page, requests } = await open();
    expect(await bannerShown(page)).toBe(true);
    expect(await page.evaluate<string>(`document.querySelector('#consent-message').textContent`)).toBe(CONSENT_MESSAGE);
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('#consent-banner button')].map((b) => b.textContent)`)).toEqual(['許可', '許可しない']);
    // 案内は画面の内容より上にある。
    const above = await page.evaluate<boolean>(
      `document.querySelector('#consent-banner').getBoundingClientRect().bottom <= document.querySelector('[data-screen="top"] .panel').getBoundingClientRect().top`,
    );
    expect(above).toBe(true);
    await page.frames(3);
    expect(requests).toEqual([]);
    expect(await page.evaluate<string>('document.cookie')).toBe('');
    expect(await dataLayer(page)).toBeNull();
    expect(await page.evaluate<number>(`document.querySelectorAll('noscript, iframe').length`)).toBe(0);
  });

  it('練習中とリザルト画面では案内を出さず、未選択のままトップ画面に戻ると出す', async () => {
    const { page } = await open('#/', { manualClock: true });
    await page.evaluate(`(() => { const m = document.getElementById('mode'); m.value = 'ghost'; m.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await page.evaluate(`document.querySelector('#start').click()`);
    await page.waitFor(screenVisible('play'));
    expect(await bannerShown(page)).toBe(false);
    await page.evaluate(`window.__pad.buttons = [${R2}]`);
    await page.advanceClockUntil(`location.hash === '#/result'`, { step: 1 / 60, limit: 20 });
    await page.evaluate(`window.__pad.buttons = []`);
    await page.waitFor(screenVisible('result'));
    expect(await bannerShown(page)).toBe(false);
    await go(page, '#/', 'top');
    expect(await bannerShown(page)).toBe(true);
  });

  it('許可しないを選ぶと案内が消え、画面を切り替えても再読み込みしても GTM を読み込まない', async () => {
    const { page, requests } = await open();
    await page.evaluate(`document.querySelector('#consent-deny').click()`);
    expect(await bannerShown(page)).toBe(false);
    await go(page, '#/settings', 'settings');
    await go(page, '#/history', 'history');
    await go(page, '#/', 'top');
    await reload(page);
    expect(await bannerShown(page)).toBe(false);
    await page.frames(3);
    expect(requests).toEqual([]);
    expect(await dataLayer(page)).toBeNull();
  });

  it('許可すると gtm.js を 1 回だけ読み込み、今の画面と切り替えた画面の表示を積み、再読み込みでは案内なしで読み込む', async () => {
    const { page, requests } = await open();
    await page.evaluate(`document.querySelector('#consent-grant').click()`);
    expect(await bannerShown(page)).toBe(false);
    await go(page, '#/settings', 'settings');
    await go(page, '#/history', 'history');
    await requested(requests, 1);
    await page.waitFor(`document.cookie.includes('_ga=')`);
    expect(requests).toEqual([GTM_URL]);
    const entries = (await dataLayer(page)) ?? [];
    expect(entries[0]).toMatchObject({ event: 'gtm.js' });
    expect(typeof entries[0]?.['gtm.start']).toBe('number');
    expect(entries.slice(1)).toEqual([view('top', '#/'), view('settings', '#/settings'), view('history', '#/history')]);
    await reload(page);
    expect(await bannerShown(page)).toBe(false);
    await requested(requests, 2);
    expect(await page.evaluate<number>(`document.querySelectorAll('script[src*="googletagmanager"]').length`)).toBe(1);
    expect(await pageViews(page)).toEqual([view('history', '#/history')]);
    expect(requests).toEqual([GTM_URL, GTM_URL]);
  });

  it('許可した状態で練習を終えてシェアしても、積むのは GTM の開始と画面の表示だけで、やり直してもプレイ画面は 1 件', async () => {
    const { page } = await open('#/', { consent: 'granted', manualClock: true });
    expect(await page.evaluate<string>('location.search')).toContain('render=off');
    await page.evaluate(`(() => { const m = document.getElementById('mode'); m.value = 'ghost'; m.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await page.evaluate(`document.querySelector('#start').click()`);
    await page.waitFor(screenVisible('play'));
    // A / × で 2 回やり直す（練習中の画面の操作。docs/spec/screens.md「画面の操作」）。
    for (let i = 0; i < 2; i += 1) {
      await page.evaluate(`window.__pad.buttons = [${A}]`);
      await page.advanceClock(0.1);
      await page.evaluate(`window.__pad.buttons = []`);
      await page.advanceClock(0.1);
    }
    await page.evaluate(`window.__pad.buttons = [${R2}]`);
    await page.advanceClockUntil(`location.hash === '#/result'`, { step: 1 / 60, limit: 20 });
    await page.evaluate(`window.__pad.buttons = []`);
    await page.waitFor(screenVisible('result'));
    await page.evaluate(`document.querySelector('#result-share').click()`);
    await page.waitFor(`window.__shared.length === 1`);
    const entries = (await dataLayer(page)) ?? [];
    expect(entries).toHaveLength(4);
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual(['event', 'gtm.start']);
    expect(entries.slice(1)).toEqual([view('top', '#/'), view('play', '#/play'), view('result', '#/result')]);
    const weaponName = await page.evaluate<string>(`document.querySelector('#weapon').selectedOptions[0].textContent`);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('?');
    expect(serialized).not.toContain('render');
    expect(serialized).not.toContain(weaponName);
  });

  it('案内を出したトップ画面で、十字キーの下を 2 回と A / × で「許可しない」、1 回と A / × で「許可」を押す', async () => {
    const denied = await open('#/', { manualClock: true });
    await denied.page.advanceClock(10 / 60);
    await tap(denied.page, DOWN);
    await tap(denied.page, DOWN);
    expect(await denied.page.evaluate<string>(`document.querySelector('.pad-focus')?.id ?? ''`)).toBe('consent-deny');
    await tap(denied.page, A);
    expect(await bannerShown(denied.page)).toBe(false);
    await reload(denied.page);
    expect(await bannerShown(denied.page)).toBe(false);
    await denied.page.frames(3);
    expect(denied.requests).toEqual([]);

    const granted = await open('#/', { manualClock: true });
    await granted.page.advanceClock(10 / 60);
    await tap(granted.page, DOWN);
    expect(await granted.page.evaluate<string>(`document.querySelector('.pad-focus')?.id ?? ''`)).toBe('consent-grant');
    await tap(granted.page, A);
    expect(await bannerShown(granted.page)).toBe(false);
    await requested(granted.requests, 1);
    expect(granted.requests).toEqual([GTM_URL]);
  });

  it('未選択・許可しないの設定画面では計測の欄が OFF で、ON にすると GTM を読み込んで設定画面の表示を積み、再読み込みしても ON', async () => {
    for (const consent of [undefined, 'denied']) {
      const { page, requests } = await open('#/settings', consent ? { consent } : {});
      await page.waitFor(screenVisible('settings'));
      expect(await page.evaluate<boolean>(`!document.querySelector('#settings-analytics').hidden`)).toBe(true);
      expect(await page.evaluate<string>(`document.querySelector('#settings-analytics-note').textContent`)).toContain('Google Tag Manager');
      expect(await page.evaluate<boolean>(`document.querySelector('#setting-analytics').checked`)).toBe(false);
      await page.evaluate(`document.querySelector('#setting-analytics').click()`);
      await requested(requests, 1);
      expect(requests).toEqual([GTM_URL]);
      expect(await pageViews(page)).toEqual([view('settings', '#/settings')]);
      expect(await bannerShown(page)).toBe(false);
      await reload(page);
      await page.waitFor(screenVisible('settings'));
      expect(await page.evaluate<boolean>(`document.querySelector('#setting-analytics').checked`)).toBe(true);
      await page.send('Page.close');
    }
  });

  it('許可した状態で計測を OFF にすると読み込み直して設定画面を出し、そのあとは GTM を読み込まず積まず、GA の Cookie も残らない', async () => {
    const { page, requests } = await open('#/settings', { consent: 'granted' });
    await requested(requests, 1);
    await page.waitFor(`document.cookie.includes('_gid=')`);
    expect(requests).toHaveLength(1);
    expect(await page.evaluate<boolean>(`document.querySelector('#setting-analytics').checked`)).toBe(true);
    await page.evaluate(`window.__beforeReload = true; document.querySelector('#setting-analytics').click()`);
    await page.waitFor(`!window.__beforeReload && ${READY}`, 15_000);
    await page.waitFor(screenVisible('settings'));
    expect(await page.evaluate<boolean>(`document.querySelector('#setting-analytics').checked`)).toBe(false);
    expect(await gaCookies(page)).toEqual([]);
    await go(page, '#/', 'top');
    await go(page, '#/history', 'history');
    await page.frames(3);
    expect(requests).toHaveLength(1);
    expect(await dataLayer(page)).toBeNull();
    expect(await bannerShown(page)).toBe(false);
  });

  it('許可した状態で #/unknown と練習中でない #/play を開くと、トップ画面の表示が 1 件だけ積まれる', async () => {
    for (const hash of ['#/unknown', '#/play']) {
      const { page } = await open(hash, { consent: 'granted' });
      await page.waitFor(screenVisible('top'));
      await page.frames(3);
      expect(await pageViews(page)).toEqual([view('top', '#/')]);
      await page.send('Page.close');
    }
  });

  it('コンテナ ID が空のビルドでは、案内も計測の区分も出さず、GTM を読み込まず dataLayer もない', async () => {
    const { page, requests } = await open('#/', { build: 'withoutId' });
    expect(await bannerShown(page)).toBe(false);
    await go(page, '#/settings', 'settings');
    expect(await page.evaluate<boolean>(`document.querySelector('#settings-analytics').hidden`)).toBe(true);
    expect(await page.evaluate<boolean>(`document.querySelector('#settings-analytics').getClientRects().length === 0`)).toBe(true);
    await page.frames(3);
    expect(requests).toEqual([]);
    expect(await dataLayer(page)).toBeNull();
  });

  it('localStorage への書き込みが例外になる環境では、案内を出さず GTM を読み込まない', async () => {
    const { page, requests } = await open('#/', { init: FAIL_WRITES });
    expect(await page.evaluate<boolean>(`!document.querySelector('#storage-notice').hidden`)).toBe(true);
    expect(await bannerShown(page)).toBe(false);
    await go(page, '#/settings', 'settings');
    await page.frames(3);
    expect(requests).toEqual([]);
    expect(await dataLayer(page)).toBeNull();
  });
});
