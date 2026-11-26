// docs/spec/overview.md「画面の表示の計測」（OVR-21〜OVR-27）と docs/spec/screens.md「計測の同意の案内」「計測の設定」（UI-112〜UI-116）の
// QA の受け入れテスト。
// 公開された入口（ビルドの結果を /apex-training/ で配信した画面、SPEC の localStorage のキー、ビルドのコンテナ ID を置き換える環境変数
// APEX_GTM_CONTAINER_ID（docs/adr/2026-11-26-gtm-container-id-in-vite-config.md）、window.dataLayer、ネットワークの要求、document.cookie）だけを使い、
// 実装の内部には依存しない。画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、3D は描画しない（render=off）。
//
// コンテナ ID を設定したビルド（受け入れ用の ID）と、ID が空のビルドの 2 つを作って配信する。
// googletagmanager.com への要求は DevTools の Network で数え、Fetch で止めて代わりのスクリプトを返す（外部へは出さない）。
// 代わりのスクリプトは dataLayer に何も積まず、Google Analytics と同じ名前の Cookie（_ga・_ga_<ID>・_gid）を作る。
// そのため dataLayer に積まれたものはすべてアプリが積んだものとして読める。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
/** ページを開く練習の乱数の種（docs/spec/architecture.md「テストのための乱数の種の固定」）。テストが失敗したときのメッセージにも出る。 */
const SEED = 12345;
const CX = 640;
const CY = 400;
const chromium = findChromium();

/** SPEC の値と文言（実装の定数には依存しない）。 */
const CONTAINER_ID = 'GTM-QA0078';
const GTM_URL = `https://www.googletagmanager.com/gtm.js?id=${CONTAINER_ID}`;
const CONSENT_KEY = 'apex-training:analytics-consent';
const GRANT = '許可';
const DENY = '許可しない';
const BANNER_TEXT =
  '画面の表示回数を Google Analytics（Google Tag Manager を通して）で計測します。送るのは表示した画面の名前とパスだけで、' +
  '成績・照準の動き・補正値・入力の記録は送りません。許可しますか？';
const SETTING_LABEL = '画面の表示の計測（Google Analytics）';
const SETTING_NOTE =
  '許可すると、表示した画面の名前とパスだけを Google Tag Manager に送り、Google Analytics で画面の表示回数を数えます。' +
  '成績・照準の動き・補正値・入力の記録・設定の値は送りません。';
const MODE = '反復練習';
const PATHS: Record<string, string> = {
  top: `${BASE}#/`,
  settings: `${BASE}#/settings`,
  play: `${BASE}#/play`,
  result: `${BASE}#/result`,
  history: `${BASE}#/history`,
};

/** 武器の JSON の表示名（dataLayer に武器の名前が出ないことを確かめる）。 */
const WEAPON_NAMES = readdirSync(join(ROOT, 'src/data/weapons'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => (JSON.parse(readFileSync(join(ROOT, 'src/data/weapons', f), 'utf8')) as { name: string }).name);

/** 標準配置のボタンの番号（pad.md）。 */
const A = 0;
const DOWN = 13;
const LEFT = 14;
const RIGHT = 15;

// ---------------------------------------------------------------------------
// ページに入れるスクリプト
// ---------------------------------------------------------------------------

/** GTM の代わりに返すスクリプト。dataLayer には触れず、GA と同じ名前の Cookie を作る。 */
const GTM_STUB = `
  window.__gtmStubRuns = (window.__gtmStubRuns || 0) + 1;
  document.cookie = '_ga=GA1.1.111.222; path=/';
  document.cookie = '_ga_QA0078=GS1.1.333; path=/';
  document.cookie = '_gid=GA1.1.444.555; path=/';
`;

const PAGE_INIT = `
  window.__num = (sel) => { const m = (document.querySelector(sel)?.textContent ?? '').match(/-?\\d+(?:\\.\\d+)?/); return m ? Number(m[0]) : NaN; };
  window.__ammo = () => window.__num('[data-hud="ammo"]');
  window.__vis = (sel) => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    return !!el && !el.closest('[hidden]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0; };
  window.__interlude = () => window.__vis('#interlude');
  window.__screens = () => [...document.querySelectorAll('[data-screen]')].filter((s) => window.__vis(s)).map((s) => s.getAttribute('data-screen'));
  window.__button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label && window.__vis(b));
  window.__focused = () => { const els = [...document.querySelectorAll('.pad-focus')]; return els.length === 1 ? (els[0].id || els[0].textContent.trim()) : els.length > 1 ? 'MULTIPLE' : ''; };
  window.__bannerShown = () => !!window.__button(${JSON.stringify(GRANT)}) && !!window.__button(${JSON.stringify(DENY)});
  window.__bannerText = () => { const g = window.__button(${JSON.stringify(GRANT)}); if (!g) return '';
    let el = g; while (el && !el.innerText.includes('許可しますか')) el = el.parentElement; return el ? el.innerText : ''; };
  window.__analyticsLabel = () => [...document.querySelectorAll('[data-screen="settings"] label')].find((l) => l.textContent.includes(${JSON.stringify(SETTING_LABEL)}));
  window.__analyticsToggle = () => { const l = window.__analyticsLabel(); return l ? (l.control ?? l.querySelector('input')) : null; };
  window.__pageViews = () => (Array.isArray(window.dataLayer) ? window.dataLayer : []).filter((e) => e && e.event === 'page_view')
    .map((e) => JSON.parse(JSON.stringify(e)));
`;

/** 標準配置のパッド 1 台。__btn(番号, 押す) で操作する。 */
const FAKE_PAD = `
  window.__pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) };
  navigator.getGamepads = () => [{ id: 'acceptance pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard',
    timestamp: performance.now(), axes: window.__pad.axes.slice(), buttons: window.__pad.buttons.map((b) => ({ ...b })), vibrationActuator: null }];
  window.__btn = (i, on) => { window.__pad.buttons[i] = { value: on ? 1 : 0, pressed: on, touched: on }; };
`;

/** シェアの機能を差し替え、ほんとうのシェアの画面を開かない。 */
const SHARE_STUB = `
  window.__shareCalls = [];
  Object.defineProperty(Navigator.prototype, 'share', { value: (data) => { window.__shareCalls.push(data?.text); return Promise.resolve(); }, configurable: true, writable: true });
  Object.defineProperty(Navigator.prototype, 'canShare', { value: () => true, configurable: true, writable: true });
`;

const STORAGE_THROWS: Record<string, string> = {
  'setItem が QuotaExceededError になる': `Storage.prototype.setItem = function () { throw new DOMException('quota', 'QuotaExceededError'); };`,
  'localStorage の参照が SecurityError になる': `Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });`,
};

// ---------------------------------------------------------------------------

interface Opened {
  page: Page;
  /** このページで出た要求の URL（出た順）。 */
  requests: string[];
}

const gtmRequests = (o: Opened) => o.requests.filter((u) => u.includes('googletagmanager.com'));
const pageViews = (page: Page) => page.evaluate<Record<string, unknown>[]>('window.__pageViews()');
const dataLayer = (page: Page) => page.evaluate<unknown[] | null>(`'dataLayer' in window ? JSON.parse(JSON.stringify(window.dataLayer)) : null`);
const hasDataLayer = (page: Page) => page.evaluate<boolean>(`'dataLayer' in window`);
const bannerShown = (page: Page) => page.evaluate<boolean>('window.__bannerShown()');
const consent = (page: Page) => page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(CONSENT_KEY)})`);
const gaCookies = (page: Page) =>
  page.evaluate<string[]>(`document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter((n) => n.startsWith('_ga') || n === '_gid')`);

/** 描画が何回か進むまで待つ（何かが起きないことを確かめる前に、起きるならもう起きている状態にする）。 */
const settle = (page: Page) => page.frames(10);

async function show(page: Page, hash: string, screen: string) {
  await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
  await page.waitFor(`window.__vis('[data-screen="${screen}"]')`);
  await page.frames(3);
}

/** ページを読み込み直し、screen が表示されるまで待つ。 */
async function reload(page: Page, screen: string) {
  await page.evaluate('window.__beforeReload = true');
  await page.send('Page.reload', { ignoreCache: false });
  await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && window.__vis('[data-screen="${screen}"]')`, 15_000);
  await page.frames(3);
}

async function clickButton(page: Page, label: string) {
  const box = await page.evaluate<{ x: number; y: number; hit: boolean } | null>(`(() => {
    const el = window.__button(${JSON.stringify(label)}); if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y); return { x, y, hit: !!top && (top === el || el.contains(top)) }; })()`);
  if (!box) throw new Error(`「${label}」のボタンが見えない`);
  expect(box.hit, `「${label}」がほかの要素に隠れている`).toBe(true);
  await page.click(box.x, box.y);
}

async function clickToggle(page: Page) {
  const box = await page.evaluate<{ x: number; y: number } | null>(`(() => {
    const el = window.__analyticsToggle(); if (!el) return null; el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!box) throw new Error('計測の欄が見えない');
  await page.click(box.x, box.y);
}

/** 選択肢の表示名（または表示の中の数）から値を選ぶ（キーボードで選んだときと同じく change を出す）。欄がなければ何もしない。 */
async function choose(page: Page, selector: string, label: string | number) {
  const ok = await page.evaluate<boolean | null>(`(() => {
    const s = document.querySelector(${JSON.stringify(selector)});
    if (!s) return null;
    const want = ${JSON.stringify(label)};
    const o = [...s.options].find((x) => typeof want === 'number' ? Number((x.textContent.match(/\\d+/) ?? [NaN])[0]) === want : x.textContent.trim() === want);
    if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  if (ok === false) throw new Error(`${selector} に ${label} の選択肢がない`);
}

/** マウスの左ボタン（ポインターロック中の位置で）。 */
const mouseButton = (page: Page, type: 'mousePressed' | 'mouseReleased') =>
  page.send('Input.dispatchMouseEvent', { type, x: CX, y: CY, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });

async function lock(page: Page) {
  if (await page.evaluate<boolean>('!!document.pointerLockElement')) return;
  await page.frames(5);
  await mouseButton(page, 'mousePressed');
  await mouseButton(page, 'mouseReleased');
  await page.waitFor('!!document.pointerLockElement', 5000);
  await page.frames(2);
}

async function key(page: Page, k: { key: string; code: string; vk: number; text: string }) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, text: k.text });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
}
const R_KEY = { key: 'r', code: 'KeyR', vk: 82, text: 'r' };

/** トップ画面で反復練習・回数 1 を選んで「開始」をクリックし、練習が始まるまで待つ。装弾数を返す。 */
async function start(page: Page): Promise<number> {
  await page.waitFor(`window.__vis('[data-screen="top"]') && document.querySelector('#weapon').options.length > 0 && document.querySelector('#count').options.length > 0`);
  await choose(page, '#mode', MODE);
  await choose(page, '#count', 1);
  await page.clickSelector('[data-screen="top"] a[href="#/play"]');
  await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]') && !window.__interlude() && window.__ammo() > 0`, 10_000);
  await page.frames(2);
  return page.evaluate<number>('window.__ammo()');
}

/** 撃ち切ってリザルト画面が表示されるまで待つ。 */
async function finish(page: Page) {
  await lock(page);
  await mouseButton(page, 'mousePressed');
  await page.advanceClockUntil(`window.__ammo() === 0 || location.hash !== '#/play'`);
  await mouseButton(page, 'mouseReleased');
  await page.advanceClockUntil(`location.hash === '#/result'`, { step: 1 / 60 });
  await page.evaluate('document.exitPointerLock()');
  await page.waitFor(`window.__vis('[data-screen="result"]') && !document.pointerLockElement`);
  await page.frames(3);
}

const btn = (page: Page, b: number, on: boolean) => page.evaluate(`window.__btn(${b}, ${on})`);
async function tap(page: Page, b: number) {
  await btn(page, b, true);
  await page.frames(3);
  await btn(page, b, false);
  await page.frames(3);
}

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('QA: 画面の表示の計測', () => {
  const temps: string[] = [];
  const servers: Server[] = [];
  let browser: Browser | undefined;
  let withId = '';
  let withoutId = '';
  let indexHtml = '';
  /** origin ごとの、アプリを動かさない同じ origin のファイルのパス。 */
  const blanks = new Map<string, string>();
  const noExceptions = (page: Page) => expect(page.errors.filter((e) => e.startsWith('exception:')), page.errors.join('\n')).toEqual([]);

  /**
   * 新しいタブで、同じ origin の空のページから localStorage と Cookie を空にし（seed を入れ）、init のスクリプトを足してから、
   * origin のビルドの hash を開く。googletagmanager.com への要求は止めて代わりのスクリプトを返す。
   */
  async function open(
    origin: string,
    hash: string,
    screen: string,
    opts: { seed?: Record<string, string>; init?: string[]; manualClock?: boolean; pad?: boolean } = {},
  ): Promise<Opened> {
    const page = await browser!.newPage();
    const requests: string[] = [];
    page.on('Network.requestWillBeSent', (p) => requests.push(String((p.request as { url: string }).url)));
    page.on('Fetch.requestPaused', (p) => {
      void page.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }],
        body: Buffer.from(GTM_STUB).toString('base64'),
      });
    });
    await page.send('Network.enable');
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*googletagmanager.com*' }] });
    await page.send('Network.clearBrowserCookies');
    // 同じ origin の、アプリを動かさない文書（ビルドの結果の JS のファイル）で保存を整える。
    await page.goto(`${origin}${BASE}${blanks.get(origin)}`);
    await page.evaluate(`(() => { localStorage.clear(); const seed = ${JSON.stringify(opts.seed ?? {})}; for (const k in seed) localStorage.setItem(k, seed[k]); })()`);
    await page.addInitScript(PAGE_INIT);
    if (opts.pad) await page.addInitScript(FAKE_PAD);
    for (const s of opts.init ?? []) await page.addInitScript(s);
    requests.length = 0;
    await page.goto(appUrl(origin, BASE, hash, { render: false, manualClock: opts.manualClock ?? false, seed: SEED }));
    await page.waitFor(`window.__vis('[data-screen="${screen}"]')`, 15_000);
    await page.frames(3);
    return { page, requests };
  }

  beforeAll(async () => {
    const build = async (id: string) => {
      const work = mkdtempSync(join(tmpdir(), 'analytics-consent-qa-'));
      temps.push(work);
      const dist = join(work, 'dist');
      const r = spawnSync(`npm run build -- --outDir "${dist}" --emptyOutDir`, {
        cwd: ROOT,
        shell: true,
        encoding: 'utf8',
        env: { ...process.env, APEX_GTM_CONTAINER_ID: id, APEX_ACCEPTANCE_NESTED: '1', FORCE_COLOR: '0' },
      });
      if (r.status !== 0) throw new Error(`ビルドが失敗した:\n${r.stdout}${r.stderr}`);
      const server = await serveStatic(dist, BASE);
      servers.push(server);
      const js = readdirSync(join(dist, 'assets')).find((f) => f.endsWith('.js'));
      if (!js) throw new Error('ビルドの結果に JS のファイルがない');
      blanks.set(originOf(server), `assets/${js}`);
      return { origin: originOf(server), dist };
    };
    const a = await build(CONTAINER_ID);
    withId = a.origin;
    indexHtml = readFileSync(join(a.dist, 'index.html'), 'utf8');
    withoutId = (await build('')).origin;
    browser = await launchBrowser(chromium!);
  }, 300_000);

  afterEach(async () => {
    await browser?.closePages();
  });

  afterAll(async () => {
    await browser?.close();
    for (const s of servers) await new Promise((ok) => s.close(ok));
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  it('OVR-21: コンテナ ID を設定したビルドを、同意の状態を保存していない状態で開くと案内が表示され、選ぶ前は GTM への要求・Cookie・dataLayer・noscript の iframe がない', async () => {
    const o = await open(withId, '#/', 'top');
    const { page } = o;
    await page.waitFor('window.__bannerShown()');
    await settle(page);
    expect(gtmRequests(o)).toEqual([]);
    expect(await page.evaluate<string>('document.cookie')).toBe('');
    expect(await hasDataLayer(page)).toBe(false);
    const iframe = await page.evaluate<boolean>(
      `[...document.querySelectorAll('iframe')].some((f) => (f.src || '').includes('googletagmanager')) ||
       [...document.querySelectorAll('noscript')].some((n) => n.innerHTML.includes('googletagmanager'))`,
    );
    expect(iframe).toBe(false);
    // HTML に最初から書かない。
    expect(indexHtml).not.toMatch(/<noscript[\s\S]*googletagmanager/);
    expect(indexHtml).not.toContain('googletagmanager.com/ns.html');
    noExceptions(page);
  }, 60_000);

  it('OVR-22: 案内で「許可しない」を選ぶと案内が消え、画面を切り替えても再読み込みしても GTM への要求が出ず、案内も出ない', async () => {
    const o = await open(withId, '#/', 'top');
    const { page } = o;
    await page.waitFor('window.__bannerShown()');
    await clickButton(page, DENY);
    await page.waitFor('!window.__bannerShown()');
    expect(await consent(page)).toBe('denied');
    await show(page, '#/settings', 'settings');
    expect(await bannerShown(page)).toBe(false);
    await show(page, '#/history', 'history');
    expect(await bannerShown(page)).toBe(false);
    await show(page, '#/', 'top');
    await settle(page);
    expect(gtmRequests(o)).toEqual([]);
    expect(await hasDataLayer(page)).toBe(false);
    await reload(page, 'top');
    await settle(page);
    expect(await bannerShown(page)).toBe(false);
    expect(gtmRequests(o)).toEqual([]);
    expect(await hasDataLayer(page)).toBe(false);
    noExceptions(page);
  }, 60_000);

  it('OVR-23: 案内で「許可」を選ぶと gtm.js?id=<ID> への要求が 1 回だけ出て今の画面の表示が積まれ、設定・履歴の画面の表示が 1 件ずつ積まれ、再読み込みすると案内なしに GTM が読み込まれる', async () => {
    const o = await open(withId, '#/', 'top');
    const { page } = o;
    await page.waitFor('window.__bannerShown()');
    await clickButton(page, GRANT);
    await page.waitFor('!window.__bannerShown()');
    await page.waitFor('window.__gtmStubRuns === 1');
    await settle(page);
    expect(gtmRequests(o)).toEqual([GTM_URL]);
    expect(await consent(page)).toBe('granted');
    expect((await pageViews(page)).map((e) => e.screen_name)).toEqual(['top']);
    await show(page, '#/settings', 'settings');
    await show(page, '#/history', 'history');
    await settle(page);
    expect((await pageViews(page)).map((e) => e.screen_name)).toEqual(['top', 'settings', 'history']);
    expect(gtmRequests(o)).toEqual([GTM_URL]);

    o.requests.length = 0;
    await reload(page, 'history');
    await page.waitFor('window.__gtmStubRuns === 1');
    await settle(page);
    expect(await bannerShown(page)).toBe(false);
    expect(gtmRequests(o)).toEqual([GTM_URL]);
    expect((await pageViews(page)).map((e) => e.screen_name)).toEqual(['history']);
    noExceptions(page);
  }, 60_000);

  it('OVR-24: 許可した状態でクエリ付きの URL を開き、反復練習を 1 回終えて「結果をシェア」まで操作しても、dataLayer には GTM の開始とトップ・プレイ・リザルトの画面の表示（3 項目だけ、クエリなし）だけが積まれる', async () => {
    const o = await open(withId, '#/', 'top', { seed: { [CONSENT_KEY]: 'granted' }, manualClock: true, init: [SHARE_STUB] });
    const { page } = o;
    expect(await page.evaluate<string>('location.search')).toContain('render=off');
    await page.waitFor('window.__gtmStubRuns === 1');
    await start(page);
    await finish(page);
    // 「結果をシェア」を押す（表示名で探す）。
    await page.evaluate(`[...document.querySelectorAll('[data-screen="result"] button')].find((b) => b.textContent.trim() === '結果をシェア' && window.__vis(b))?.scrollIntoView({ block: 'center' })`);
    const share = await page.evaluate<{ x: number; y: number } | null>(`(() => {
      const b = [...document.querySelectorAll('[data-screen="result"] button')].find((x) => x.textContent.trim() === '結果をシェア' && window.__vis(x));
      if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    expect(share, '「結果をシェア」が見えない').not.toBeNull();
    await page.click(share!.x, share!.y);
    await page.waitFor('window.__shareCalls.length > 0', 5000);
    await settle(page);

    const layer = (await dataLayer(page)) as Record<string, unknown>[];
    expect(layer).not.toBeNull();
    // GTM の開始の 1 件。
    const starts = layer.filter((e) => e.event === 'gtm.js');
    expect(starts).toHaveLength(1);
    expect(Object.keys(starts[0]!).sort()).toEqual(['event', 'gtm.start']);
    expect(typeof starts[0]!['gtm.start']).toBe('number');
    // 残りは画面の表示だけで、トップ・プレイ・リザルトの 1 件ずつ。
    const rest = layer.filter((e) => e.event !== 'gtm.js');
    expect(rest.map((e) => e.event)).toEqual(['page_view', 'page_view', 'page_view']);
    expect(rest.map((e) => e.screen_name)).toEqual(['top', 'play', 'result']);
    for (const e of rest) {
      expect(Object.keys(e).sort()).toEqual(['event', 'page_path', 'screen_name']);
      expect(String(e.page_path)).not.toContain('?');
      expect(e.page_path).toBe(PATHS[String(e.screen_name)]);
    }
    const text = JSON.stringify(rest);
    for (const name of WEAPON_NAMES) expect(text, `武器の名前 ${name} が積まれている`).not.toContain(name);
    // 成績・照準・補正値・入力の記録の数値を含まない（画面の表示の値は文字列だけ）。
    for (const e of rest) for (const v of Object.values(e)) expect(typeof v).toBe('string');
    expect(gtmRequests(o)).toEqual([GTM_URL]);
    noExceptions(page);
  }, 120_000);

  it('OVR-25: コンテナ ID が空のビルドでは、案内が出ず、設定画面に計測の区分がなく、GTM への要求も dataLayer もない', async () => {
    for (const seed of [{}, { [CONSENT_KEY]: 'granted' }]) {
      const o = await open(withoutId, '#/', 'top', { seed });
      const { page } = o;
      await settle(page);
      expect(await bannerShown(page), `保存した状態 ${JSON.stringify(seed)}`).toBe(false);
      await show(page, '#/settings', 'settings');
      expect(await bannerShown(page)).toBe(false);
      const settingsText = await page.evaluate<string>(`document.querySelector('[data-screen="settings"]').innerText`);
      expect(settingsText).not.toContain(SETTING_LABEL);
      expect(settingsText).not.toContain('Google Analytics');
      expect(await page.evaluate<boolean>(`(() => { const t = window.__analyticsToggle(); return !!t && window.__vis(t); })()`)).toBe(false);
      await show(page, '#/history', 'history');
      expect(await bannerShown(page)).toBe(false);
      await show(page, '#/', 'top');
      await settle(page);
      expect(gtmRequests(o)).toEqual([]);
      expect(await hasDataLayer(page)).toBe(false);
      noExceptions(page);
    }
  }, 60_000);

  for (const [name, init] of Object.entries(STORAGE_THROWS)) {
    it(`OVR-26: ${name}環境でコンテナ ID を設定したビルドを開くと、案内が出ず、GTM への要求も出ない`, async () => {
      const o = await open(withId, '#/', 'top', { init: [init] });
      const { page } = o;
      await settle(page);
      expect(await bannerShown(page)).toBe(false);
      await show(page, '#/settings', 'settings');
      expect(await bannerShown(page)).toBe(false);
      await show(page, '#/history', 'history');
      expect(await bannerShown(page)).toBe(false);
      await settle(page);
      expect(gtmRequests(o)).toEqual([]);
      noExceptions(page);
    }, 60_000);
  }

  for (const hash of ['#/unknown', '#/play']) {
    it(`OVR-27: 許可した状態で ${hash} を直接開くと、screen_name が top でハッシュが #/ の画面の表示が 1 件だけ積まれる`, async () => {
      const o = await open(withId, hash, 'top', { seed: { [CONSENT_KEY]: 'granted' } });
      const { page } = o;
      await page.waitFor('window.__gtmStubRuns === 1');
      await settle(page);
      const views = await pageViews(page);
      expect(views).toEqual([{ event: 'page_view', screen_name: 'top', page_path: PATHS.top }]);
      noExceptions(page);
    }, 60_000);
  }

  // -------------------------------------------------------------------------
  it('UI-112: 未選択でトップ画面を開くと、内容の上に案内の文と「許可」「許可しない」が出て、練習中とリザルト画面では出ず、トップ画面に戻るとまた出る', async () => {
    const o = await open(withId, '#/', 'top', { manualClock: true });
    const { page } = o;
    await page.waitFor('window.__bannerShown()');
    expect(await page.evaluate<string>('window.__bannerText()')).toContain(BANNER_TEXT);
    // 画面の内容（武器のカードの並び・「開始」）より上にあり、左が「許可」。
    const layout = await page.evaluate<{ grant: number; deny: number; grantLeft: number; denyLeft: number; weapon: number; start: number }>(`(() => {
      const r = (el) => el.getBoundingClientRect();
      const g = r(window.__button(${JSON.stringify(GRANT)})); const d = r(window.__button(${JSON.stringify(DENY)}));
      return { grant: g.bottom, deny: d.bottom, grantLeft: g.left, denyLeft: d.left,
        weapon: r(document.querySelector('#weapon-cards')).top, start: r(document.querySelector('[data-screen="top"] a[href="#/play"]')).top }; })()`);
    expect(layout.grant).toBeLessThanOrEqual(layout.weapon);
    expect(layout.deny).toBeLessThanOrEqual(layout.weapon);
    expect(layout.grant).toBeLessThanOrEqual(layout.start);
    expect(layout.grantLeft).toBeLessThan(layout.denyLeft);

    await start(page);
    expect(await bannerShown(page)).toBe(false);
    await finish(page);
    expect(await bannerShown(page)).toBe(false);
    await show(page, '#/', 'top');
    await page.waitFor('window.__bannerShown()');
    expect(await consent(page)).toBeNull();
    expect(gtmRequests(o)).toEqual([]);
    noExceptions(page);
  }, 120_000);

  it('UI-113: 案内を出したトップ画面で、パッドの十字キーの下を 2 回押して A を押すと「許可しない」が押され、再読み込みしても案内も GTM の要求も出ない', async () => {
    const o = await open(withId, '#/', 'top', { pad: true });
    const { page } = o;
    await page.waitFor('window.__bannerShown()');
    await tap(page, DOWN);
    await tap(page, DOWN);
    await tap(page, A);
    await page.waitFor('!window.__bannerShown()');
    expect(await consent(page)).toBe('denied');
    await reload(page, 'top');
    await settle(page);
    expect(await bannerShown(page)).toBe(false);
    expect(gtmRequests(o)).toEqual([]);
    noExceptions(page);
  }, 60_000);

  it('UI-113: 案内を出したトップ画面で、パッドの十字キーの下を 1 回押して A を押すと「許可」が押され、GTM が読み込まれる', async () => {
    const o = await open(withId, '#/', 'top', { pad: true });
    const { page } = o;
    await page.waitFor('window.__bannerShown()');
    await tap(page, DOWN);
    await tap(page, A);
    await page.waitFor('!window.__bannerShown()');
    await page.waitFor('window.__gtmStubRuns === 1');
    expect(await consent(page)).toBe('granted');
    expect(gtmRequests(o)).toEqual([GTM_URL]);
    noExceptions(page);
  }, 60_000);

  for (const state of [null, 'denied'] as const) {
    it(`UI-114: 同意の状態が${state === null ? '未選択' : '許可しない'}で設定画面を開くと、計測の区分に説明と OFF の欄があり、ON にすると GTM が読み込まれて設定画面の表示が積まれ、再読み込みしても ON`, async () => {
      const o = await open(withId, '#/settings', 'settings', { seed: state ? { [CONSENT_KEY]: state } : {} });
      const { page } = o;
      expect(await page.evaluate<boolean>(`(() => { const t = window.__analyticsToggle(); return !!t && window.__vis(t); })()`)).toBe(true);
      expect(await page.evaluate<string>(`document.querySelector('[data-screen="settings"]').innerText`)).toContain(SETTING_NOTE);
      expect(await page.evaluate<boolean>('window.__analyticsToggle().checked')).toBe(false);
      await settle(page);
      expect(gtmRequests(o)).toEqual([]);

      await page.evaluate('window.__noReload = true');
      await clickToggle(page);
      await page.waitFor('window.__analyticsToggle().checked');
      await page.waitFor('window.__gtmStubRuns === 1');
      await settle(page);
      expect(await page.evaluate<boolean>('window.__noReload === true'), 'ページが読み込み直された').toBe(true);
      expect(gtmRequests(o)).toEqual([GTM_URL]);
      expect((await pageViews(page)).map((e) => e.screen_name)).toEqual(['settings']);
      expect(await bannerShown(page)).toBe(false);
      expect(await consent(page)).toBe('granted');

      await reload(page, 'settings');
      expect(await page.evaluate<boolean>('window.__analyticsToggle().checked')).toBe(true);
      noExceptions(page);
    }, 60_000);
  }

  it('UI-115: 許可した状態で設定画面の計測の欄を OFF にすると、読み込み直した設定画面で OFF になり、GTM の要求も画面の表示も出ず、_ga・_gid の Cookie が残らない', async () => {
    const o = await open(withId, '#/settings', 'settings', { seed: { [CONSENT_KEY]: 'granted' } });
    const { page } = o;
    await page.waitFor('window.__gtmStubRuns === 1');
    expect(await page.evaluate<boolean>('window.__analyticsToggle().checked')).toBe(true);
    // 代わりの GTM が GA と同じ名前の Cookie を作っている。
    expect((await gaCookies(page)).sort()).toEqual(['_ga', '_ga_QA0078', '_gid']);

    await page.evaluate('window.__beforeReload = true');
    o.requests.length = 0;
    await clickToggle(page);
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && window.__vis('[data-screen="settings"]')`, 15_000);
    await page.frames(3);
    expect(await page.evaluate<string>('location.hash')).toBe('#/settings');
    expect(await page.evaluate<boolean>('window.__analyticsToggle().checked')).toBe(false);
    expect(await consent(page)).toBe('denied');
    expect(await gaCookies(page)).toEqual([]);
    await show(page, '#/', 'top');
    await show(page, '#/history', 'history');
    await show(page, '#/settings', 'settings');
    await settle(page);
    expect(gtmRequests(o)).toEqual([]);
    expect(await pageViews(page)).toEqual([]);
    expect(await gaCookies(page)).toEqual([]);
    noExceptions(page);
  }, 60_000);

  it('UI-116: 許可した状態で練習を始め、やり直しを 2 回してから終えると、プレイ画面の表示は 1 件だけで、次にリザルト画面の表示が 1 件積まれる', async () => {
    const o = await open(withId, '#/', 'top', { seed: { [CONSENT_KEY]: 'granted' }, manualClock: true });
    const { page } = o;
    await page.waitFor('window.__gtmStubRuns === 1');
    const mag = await start(page);
    await lock(page);
    for (let i = 0; i < 2; i += 1) {
      await mouseButton(page, 'mousePressed');
      await page.advanceClockUntil(`window.__ammo() < ${mag}`);
      await mouseButton(page, 'mouseReleased');
      await key(page, R_KEY);
      await page.waitFor(`location.hash === '#/play' && window.__ammo() === ${mag}`, 5000);
      await page.frames(3);
    }
    expect((await pageViews(page)).map((e) => e.screen_name)).toEqual(['top', 'play']);
    await finish(page);
    await settle(page);
    expect((await pageViews(page)).map((e) => e.screen_name)).toEqual(['top', 'play', 'result']);
    noExceptions(page);
  }, 120_000);

  // 追いエイム・フリックのモードの選択欄（#73・#74）と、同意の案内の「許可」「許可しない」が同じトップ画面に並んでも、パッドだけで選んで始められる。
  for (const [mode, setting, value] of [['追いエイム', '速さ', '遅い'], ['フリック', '的の大きさ', '小']] as const) {
    it(`UI-112・UI-113: 案内を出したまま、パッドだけで${mode}と${setting}「${value}」を選んで開始でき、プレイ画面では案内が出ない`, async () => {
      const o = await open(withId, '#/', 'top', { pad: true });
      const { page } = o;
      await page.waitFor('window.__bannerShown()');
      const focusTo = async (target: string) => {
        const seen: string[] = [];
        for (let i = 0; i < 20; i += 1) {
          const now = await page.evaluate<string>('window.__focused()');
          if (now === target) return seen;
          seen.push(now);
          await tap(page, DOWN);
        }
        throw new Error(`十字キーの下で ${target} にフォーカスが来ない: ${seen.join(' → ')}`);
      };
      const choose = async (selector: string, label: string) => {
        for (let i = 0; i < 8; i += 1) {
          const st = await page.evaluate<{ now: number; want: number }>(`(() => { const s = document.querySelector(${JSON.stringify(selector)});
            return { now: s.selectedIndex, want: [...s.options].findIndex((o) => o.textContent.trim() === ${JSON.stringify(label)}) }; })()`);
          if (st.want < 0) throw new Error(`${selector} に ${label} がない`);
          if (st.now === st.want) return;
          await tap(page, st.now < st.want ? RIGHT : LEFT);
        }
        throw new Error(`十字キーの左右で ${selector} に ${label} を選べない`);
      };
      const seen = await focusTo('mode-cards');
      // 案内の 2 つのボタンが項目の順の最初に来て、そのあとに画面の項目が続く。
      expect(seen.slice(1, 3)).toEqual(['consent-grant', 'consent-deny']);
      // モードのカードの並びは、隠した #mode の選択肢を十字キーの左右で変える。
      await choose('#mode', mode);
      const settingId = await page.evaluate<string>(
        `[...document.querySelectorAll('[data-screen="top"] select')].find((s) => window.__vis(s) && (s.closest('label')?.textContent ?? '').includes(${JSON.stringify(setting)}))?.id ?? ''`,
      );
      expect(settingId).toBeTruthy();
      await focusTo(settingId);
      await choose(`#${settingId}`, value);
      await focusTo('start');
      await tap(page, A);
      await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]')`);
      await settle(page);
      expect(await bannerShown(page)).toBe(false);
      // 案内では何も選んでいないので、計測しないまま（GTM の要求なし、同意の状態は未選択）。
      expect(await consent(page)).toBeNull();
      expect(gtmRequests(o)).toEqual([]);
      noExceptions(page);
    }, 90_000);
  }
});
