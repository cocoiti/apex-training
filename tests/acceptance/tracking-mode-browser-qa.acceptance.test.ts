// docs/spec/modes.md「追いエイム」（MODE-36・MODE-41〜MODE-45）、docs/spec/scoring.md「追いエイムの採点」「自己ベスト」（SCO-49〜SCO-54）、
// docs/spec/screens.md「トップ画面」「履歴の画面」「結果のシェア」「セットのまとめ」（UI-101〜UI-106）の、ブラウザで確かめる受け入れテスト。
// QA が SPEC だけから書いたもの（#73）。ブラウザなしで確かめる部分（的の動き・採点の式・リコイルのオフセット・ゴースト）は
// tests/acceptance/tracking-mode-qa.acceptance.test.ts が確かめる。
// 公開された入口（ビルドの結果を /apex-training/ で配信した画面、index.html の要素、SPEC に書かれた localStorage のキーと値の形）だけを使う。
// 画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、ページの時計はテストから進める（clock=manual）。
// 3D は、画面写しで的の動きを読むテスト（MODE-36・MODE-44・MODE-45）のほかは描画しない（render=off）。
// 練習の種はテストから決められないので、決まった値を求める条件（SCO-51 の等しい・小さい・大きい）は、照準を上に大きく外して
// 乗っていた割合が 0% になる練習と、照準を動かさずに割合が 0% より大きくなる練習（開始時は照準が的の中心を向いている）で作る。
// パッドは Gamepad API（navigator.getGamepads）の形で与える。音は Web Audio の OscillatorNode の start を包んで数える（音はすべて Web Audio で合成する、という SPEC による）。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';
import { decodePng, type Image } from '../helpers/png';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
/** ページを開く練習の乱数の種（docs/spec/architecture.md「テストのための乱数の種の固定」）。テストが失敗したときのメッセージにも出る。 */
const SEED = 12345;
const CX = 640;
const CY = 400;
const chromium = findChromium();

/** SPEC の値と文言（実装の定数には依存しない）。 */
const REPEAT = '反復練習';
const TRACK = '追いエイム';
const TRACK_RECOIL = '追いエイム＋リコイル';
const SLOW = '遅い';
const NORMAL = 'ふつう';
const FAST = '速い';
const PREVIEW = 'パターンの音を聞く';
const BEST_UPDATED = '自己ベスト更新';
const RATE = '乗っていた割合';
const OFF_ERROR = '外していたときのズレ';
const REACQUIRE = '乗り直すまでの時間';
const LSTAR = { id: 'lstar', name: 'L-STAR', magSize: 28 };
const CAR = { id: 'car', name: 'C.A.R. SMG', magSize: 30 };
const DURATION = 20;
const bestKey = (input: string, weapon: string, mode: string, speed: string) => `apex-training:best:${input}:${weapon}:${mode}:${speed}`;
const historyKey = (input: string, weapon: string, mode: string, speed: string) => `apex-training:history:${input}:${weapon}:${mode}:${speed}`;

/** パッドの標準配置のボタン番号。 */
const A = 0;
const UP = 12;
const DOWN = 13;
const LEFT = 14;
const RIGHT = 15;

// ---------------------------------------------------------------------------
// ページに入れるスクリプト
// ---------------------------------------------------------------------------

const PAGE_INIT = `
  window.__vis = (sel) => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    return !!el && !el.closest('[hidden]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0; };
  window.__num = (sel) => { const m = (document.querySelector(sel)?.textContent ?? '').match(/-?\\d+(?:\\.\\d+)?/); return m ? Number(m[0]) : NaN; };
  window.__ammo = () => window.__num('[data-hud="ammo"]');
  window.__clockNow = () => window.__apexTestClock.now();
  window.__interlude = () => window.__vis('#interlude');
  window.__focused = () => { const els = [...document.querySelectorAll('.pad-focus')]; return els.length === 1 ? (els[0].getAttribute('data-card-choice') || els[0].id || els[0].textContent.trim()) : ''; };
  window.__resultAt = undefined;
  addEventListener('hashchange', () => { if (location.hash === '#/result' && window.__apexTestClock) window.__resultAt = window.__apexTestClock.now(); });
  window.__shareCalls = [];
  Object.defineProperty(Navigator.prototype, 'share', { value: function (data) { window.__shareCalls.push(data?.text); return Promise.resolve(); }, configurable: true, writable: true });
  Object.defineProperty(Navigator.prototype, 'canShare', { value: () => true, configurable: true, writable: true });
  window.__oscStarts = 0;
  (() => {
    const proto = (window.AudioScheduledSourceNode ?? window.OscillatorNode)?.prototype;
    if (!proto) return;
    const start = proto.start;
    proto.start = function (...a) { if (this instanceof OscillatorNode) window.__oscStarts += 1; return start.apply(this, a); };
  })();
`;

/** 標準配置のパッド 1 台。__btn(番号, 押す) で操作する。 */
const FAKE_PAD = `
  window.__pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) };
  navigator.getGamepads = () => [{ id: 'acceptance pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard',
    timestamp: performance.now(), axes: window.__pad.axes.slice(), buttons: window.__pad.buttons.map((b) => ({ ...b })), vibrationActuator: null }];
  window.__btn = (i, on) => { window.__pad.buttons[i] = { value: on ? 1 : 0, pressed: on, touched: on }; };
`;

// ---------------------------------------------------------------------------
// 画面の操作と読み取り
// ---------------------------------------------------------------------------

/** 選択肢の表示名（または数）から値を選ぶ（キーボードで選んだときと同じく input と change を出す）。 */
async function choose(page: Page, selector: string, label: string | number) {
  const ok = await page.evaluate<boolean>(`(() => {
    const s = document.querySelector(${JSON.stringify(selector)});
    if (!s) return false;
    const want = ${JSON.stringify(label)};
    const o = [...s.options].find((x) => typeof want === 'number' ? Number((x.textContent.match(/\\d+/) ?? [NaN])[0]) === want : x.textContent.trim() === want);
    if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  if (!ok) throw new Error(`${selector} に ${label} の選択肢がない`);
  await page.frames(2);
}

const TOP_READY = `window.__vis('[data-screen="top"]') && document.querySelector('#mode').options.length > 0 && document.querySelector('#count').options.length > 0`;

async function openTop(page: Page) {
  await page.evaluate(`location.hash = '#/'`);
  await page.waitFor(TOP_READY);
}

interface TopState {
  modes: string[];
  mode: string;
  weaponVisible: boolean;
  weapon: string;
  previewVisible: boolean;
  speedVisible: boolean;
  speeds: string[];
  speed: string;
}
const topState = (page: Page) =>
  page.evaluate<TopState>(`(() => {
    const mode = document.querySelector('#mode'); const weapon = document.querySelector('#weapon'); const speed = document.querySelector('#speed');
    const preview = [...document.querySelectorAll('[data-screen="top"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(PREVIEW)});
    return { modes: [...mode.options].map((o) => o.textContent.trim()), mode: mode.selectedOptions[0]?.textContent.trim() ?? '',
      weaponVisible: window.__vis('#weapon-cards'), weapon: weapon.selectedOptions[0]?.textContent.trim() ?? '', previewVisible: !!preview && window.__vis(preview),
      speedVisible: !!speed && window.__vis(speed), speeds: speed ? [...speed.options].map((o) => o.textContent.trim()) : [],
      speed: speed?.selectedOptions[0]?.textContent.trim() ?? '' }; })()`);

/** HUD の見えている文字（見えていない欄は空文字）。 */
const hud = (page: Page, key: string) =>
  page.evaluate<string>(`(() => { const el = document.querySelector('[data-hud="${key}"]'); return el && window.__vis(el) ? el.textContent.trim() : ''; })()`);
const hash = (page: Page) => page.evaluate<string>('location.hash');

/** ページごとの、最後にマウスの事件を送った位置の y（ポインターロック中の動きの量は、前の位置からの差になる）。 */
const lastY = new WeakMap<Page, number>();
const mouseButton = (page: Page, type: 'mousePressed' | 'mouseReleased') => {
  lastY.set(page, CY);
  return page.send('Input.dispatchMouseEvent', { type, x: CX, y: CY, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
};

const key = async (page: Page, k: { key: string; code: string; vk: number; text?: string }) => {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, ...(k.text ? { text: k.text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
};
const KEY_R = { key: 'r', code: 'KeyR', vk: 82, text: 'r' };
const KEY_Q = { key: 'q', code: 'KeyQ', vk: 81, text: 'q' };

/** プレイ画面でクリックしてポインターロックを掛ける（掛かっていれば何もしない）。 */
async function lock(page: Page) {
  await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]') && !window.__interlude()`);
  if (await page.evaluate<boolean>('!!document.pointerLockElement')) return;
  await page.frames(3);
  await mouseButton(page, 'mousePressed');
  await mouseButton(page, 'mouseReleased');
  await page.waitFor('!!document.pointerLockElement', 5000);
  await page.frames(2);
}

interface StartOptions {
  mode: string;
  weapon?: string;
  speed?: string;
  count?: number;
}

/** トップ画面でモード（と武器・速さ・回数）を選び「開始」を押して、プレイ画面でポインターロックを掛ける。開始したときのページの時計を返す。 */
async function start(page: Page, opts: StartOptions): Promise<number> {
  await openTop(page);
  await choose(page, '#mode', opts.mode);
  if (opts.weapon) await choose(page, '#weapon', opts.weapon);
  if (opts.speed) await choose(page, '#speed', opts.speed);
  await choose(page, '#count', opts.count ?? 1);
  await page.clickSelector('[data-screen="top"] a[href="#/play"]');
  await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]')`);
  const startedAt = await page.evaluate<number>('window.__clockNow()');
  await lock(page);
  return startedAt;
}

/**
 * 照準を上に大きく外す（マウスを前へ 400 カウント。既定の感度 1.5 で 13.2 度。的の高さ 1 メートルは 8 メートル先で上下に約 3.6 度）。
 * 的は高さを変えずに左右に動くので、この向きでは乗らない。
 */
async function aimAway(page: Page) {
  // 前の位置から 400 カウント動かす。上に余地がなければ下へ（下に 13.2 度でも乗らない）。
  const from = lastY.get(page) ?? CY;
  const dir = from - 400 >= 0 ? -1 : 1;
  for (let i = 1; i <= 20; i += 1) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: CX, y: from + dir * 20 * i, button: 'none', buttons: 0 });
  lastY.set(page, from + dir * 400);
  await page.frames(2);
}

/** ページの時計を進めてリザルト画面が表示されるまで待つ。 */
async function untilResult(page: Page, step = 1 / 60) {
  await page.advanceClockUntil(`location.hash === '#/result'`, { step, limit: DURATION + 5 });
  await page.evaluate('document.exitPointerLock()');
  await page.waitFor(`window.__vis('[data-screen="result"]') && document.querySelector('#result-metrics').children.length > 0`);
  await page.frames(2);
}

/** 1 回練習してリザルト画面を表示する。away なら照準を上に外したまま。 */
async function practice(page: Page, opts: StartOptions & { away?: boolean }) {
  const startedAt = await start(page, opts);
  if (opts.away) await aimAway(page);
  await untilResult(page);
  return startedAt;
}

interface ResultState {
  metrics: Record<string, string>;
  best: string;
  text: string;
  svgs: number;
}
const resultState = (page: Page) =>
  page.evaluate<ResultState>(`(() => {
    const screen = document.querySelector('[data-screen="result"]');
    const metrics = {};
    for (const dt of screen.querySelectorAll('dt')) { if (!window.__vis(dt)) continue; const dd = dt.nextElementSibling; if (dd && dd.tagName === 'DD') metrics[dt.textContent.trim()] = dd.textContent.trim(); }
    const best = [...screen.querySelectorAll('*')].filter((e) => window.__vis(e) && e.children.length === 0 && e.textContent.includes('自己ベスト')).map((e) => e.textContent.trim()).join('|');
    return { metrics, best, text: screen.innerText, svgs: [...screen.querySelectorAll('svg')].filter((s) => window.__vis(s)).length }; })()`);
const hasMetric = (r: { metrics: Record<string, string> }, label: string) => Object.keys(r.metrics).some((k) => k.includes(label));
const metric = (r: { metrics: Record<string, string> }, label: string) => {
  const k = Object.keys(r.metrics).find((x) => x.includes(label));
  if (!k) throw new Error(`${label} がない: ${JSON.stringify(r.metrics)}`);
  return r.metrics[k]!;
};
const num = (s: string) => {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) throw new Error(`数がない: ${s}`);
  return Number(m[0]);
};

const storage = (page: Page) =>
  page.evaluate<Record<string, string>>(`(() => { const out = {}; for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i);
    if (k.startsWith('apex-training:best:') || k.startsWith('apex-training:history:')) out[k] = localStorage.getItem(k); } return out; })()`);
const stored = async <T>(page: Page, k: string) => JSON.parse((await storage(page))[k] ?? 'null') as T | null;

interface HistoryState {
  weaponVisible: boolean;
  speedVisible: boolean;
  modes: string[];
  headers: string[];
  rows: string[][];
  points: number;
}
const historyState = (page: Page) =>
  page.evaluate<HistoryState>(`(() => {
    const screen = document.querySelector('[data-screen="history"]');
    const table = [...screen.querySelectorAll('table')].find((t) => window.__vis(t));
    const svg = [...screen.querySelectorAll('svg')].find((s) => window.__vis(s) && s.querySelectorAll('circle').length > 0);
    return { weaponVisible: window.__vis('#history-weapon'), speedVisible: window.__vis('#history-speed'),
      modes: [...document.querySelectorAll('#history-mode option')].map((o) => o.textContent.trim()),
      headers: table ? [...table.querySelectorAll('thead th')].map((c) => c.textContent.trim()) : [],
      rows: table ? [...table.querySelectorAll('tbody tr')].filter((tr) => window.__vis(tr)).map((tr) => [...tr.cells].map((c) => c.textContent.trim())) : [],
      points: svg ? svg.querySelectorAll('circle').length : 0 }; })()`);

async function openHistory(page: Page) {
  await page.evaluate(`location.hash = '#/history'`);
  await page.waitFor(`window.__vis('[data-screen="history"]') && document.querySelectorAll('#history-mode option').length > 0`);
  await page.frames(2);
}

async function share(page: Page): Promise<string> {
  const box = await page.evaluate<{ x: number; y: number } | null>(`(() => {
    const el = [...document.querySelectorAll('[data-screen="result"] button')].find((b) => b.textContent.trim() === '結果をシェア' && window.__vis(b));
    if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  expect(box).not.toBeNull();
  await page.click(box!.x, box!.y);
  await page.waitFor('window.__shareCalls.length > 0');
  return (await page.evaluate<string[]>('window.__shareCalls'))[0]!;
}

// パッド ----------------------------------------------------------------

const btn = (page: Page, b: number, on: boolean) => page.evaluate(`window.__btn(${b}, ${on})`);
async function padTap(page: Page, b: number) {
  await btn(page, b, true);
  await page.advanceClock(3 / 60);
  await btn(page, b, false);
  await page.advanceClock(3 / 60);
}
const focused = (page: Page) => page.evaluate<string>('window.__focused()');
async function padFocus(page: Page, id: string, dir = DOWN) {
  const seen: string[] = [];
  for (let i = 0; i < 14 && (await focused(page)) !== id; i += 1) {
    await padTap(page, dir);
    seen.push(await focused(page));
  }
  expect(await focused(page), seen.join(' → ')).toBe(id);
}

// 画面写し --------------------------------------------------------------

/** HTML の画面（HUD・クロスヘア）を隠し、キャンバスだけを写す。 */
async function canvasOnly(page: Page): Promise<Image> {
  await page.evaluate(`document.getElementById('ui').style.visibility = 'hidden'`);
  await page.frames(2);
  const img = decodePng(await page.screenshot());
  await page.evaluate(`document.getElementById('ui').style.visibility = ''`);
  return img;
}

/** 2 つの画面写しで色が変わった画素の数と、その外接の箱。 */
function diff(a: Image, b: Image) {
  let count = 0;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const p = a.pixel(x, y);
      const q = b.pixel(x, y);
      if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) <= 24) continue;
      count += 1;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return { count, width: count ? x1 - x0 + 1 : 0, height: count ? y1 - y0 + 1 : 0, cy: count ? (y0 + y1) / 2 : NaN, cx: count ? (x0 + x1) / 2 : NaN };
}

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('QA: 追いエイムの練習モード（#73）', () => {
  let work = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));
  const noExceptions = (page: Page) => expect(exceptions(page), page.errors.join('\n')).toEqual([]);

  /** 新しいタブで localStorage を空にし（seed を入れ）、読み込み直したトップ画面を開く。 */
  async function openFresh(opts: { seed?: Record<string, string>; pad?: boolean; render?: boolean } = {}): Promise<Page> {
    const page = await browser!.newPage();
    await page.goto(appUrl(origin, BASE, '#/', { render: opts.render ?? false, manualClock: true, seed: SEED }));
    await page.evaluate(`(() => { localStorage.clear(); const seed = ${JSON.stringify(opts.seed ?? {})}; for (const k in seed) localStorage.setItem(k, seed[k]); })()`);
    await page.addInitScript(PAGE_INIT);
    if (opts.pad) await page.addInitScript(FAKE_PAD);
    await page.evaluate(`location.hash = '#/'; window.__beforeReload = true`);
    await page.reload({ ignoreCache: false });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && ${TOP_READY}`, 15_000);
    return page;
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'tracking-qa-'));
    const dist = join(work, 'dist');
    const build = spawnSync(`npm run build -- --outDir "${dist}" --emptyOutDir`, {
      cwd: ROOT,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, APEX_ACCEPTANCE_NESTED: '1', FORCE_COLOR: '0' },
    });
    if (build.status !== 0) throw new Error(`ビルドが失敗した:\n${build.stdout}${build.stderr}`);
    server = await serveStatic(dist, BASE);
    origin = originOf(server);
    browser = await launchBrowser(chromium!);
  }, 300_000);

  afterEach(async () => {
    await browser?.closePages();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((ok) => (server ? server.close(ok) : ok(undefined)));
    if (work) rmSync(work, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  describe('プレイ画面', () => {
    it('MODE-36: 追いエイムを開始すると、撃たなくても fire を離して 2 秒たっても 20 秒たつまでプレイ画面のままで、20 秒でリザルト画面に移る', async () => {
      const page = await openFresh();
      const startedAt = await start(page, { mode: TRACK });
      await page.advanceClock(1);
      // 1 回押して離し、2 秒より長く待つ。
      await mouseButton(page, 'mousePressed');
      await page.advanceClock(0.05);
      await mouseButton(page, 'mouseReleased');
      await page.advanceClock(2.5);
      expect(await hash(page)).toBe('#/play');
      // 撃たずに 19.8 秒まで進める。
      await page.advanceClock(19.8 - (await page.evaluate<number>('window.__clockNow()')) + startedAt);
      expect(await hash(page)).toBe('#/play');
      await untilResult(page);
      const resultAt = await page.evaluate<number>('window.__resultAt');
      expect(resultAt - startedAt).toBeGreaterThan(19.9);
      expect(resultAt - startedAt).toBeLessThan(20.2);
      noExceptions(page);
    }, 120_000);

    it('MODE-36: プレイ画面で的が左右に動く（3D を描画した画面写しで、的が同じ高さのまま一方の向きへ離れていく）', async () => {
      const page = await openFresh({ render: true });
      await start(page, { mode: TRACK });
      // 開始した直後（ステップを進める前）の画面には練習の的が描かれていないので、それを背景にして、的の位置を変わった画素の範囲で読む。
      const bg = await canvasOnly(page);
      const at: ReturnType<typeof diff>[] = [];
      for (const dt of [0.1, 0.15, 0.15]) {
        await page.advanceClock(dt);
        at.push(diff(bg, await canvasOnly(page)));
      }
      for (const d of at) {
        expect(d.count, JSON.stringify(at)).toBeGreaterThan(200);
        // 的の幅（0.5 メートル）ほどの範囲だけが変わる。
        expect(d.width, JSON.stringify(at)).toBeLessThan(d.height);
      }
      // 最初の切り返し（0.5 秒以上あと）の前なので、0.1・0.25・0.4 秒で同じ向きに中心から離れていく。高さは変わらない。
      const off = at.map((d) => d.cx - CX);
      expect(Math.sign(off[1]!), JSON.stringify(at)).toBe(Math.sign(off[2]!));
      expect(Math.abs(off[1]!), JSON.stringify(at)).toBeGreaterThan(Math.abs(off[0]!) + 5);
      expect(Math.abs(off[2]!), JSON.stringify(at)).toBeGreaterThan(Math.abs(off[1]!) + 5);
      for (const d of at) {
        expect(Math.abs(d.cy - at[0]!.cy)).toBeLessThanOrEqual(2);
        expect(Math.abs(d.height - at[0]!.height)).toBeLessThanOrEqual(3);
      }
      noExceptions(page);
    }, 120_000);

    it('MODE-41: 追いエイム（リコイルなし）で fire を押し続けても、HUD に武器名と残弾が出ず、補正のパネルが出ない', async () => {
      const page = await openFresh();
      await start(page, { mode: TRACK });
      await mouseButton(page, 'mousePressed');
      for (let i = 0; i < 6; i += 1) {
        await page.advanceClock(0.5);
        expect(await hud(page, 'weapon')).toBe('');
        expect(await hud(page, 'ammo')).toBe('');
        expect(await page.evaluate<boolean>(`window.__vis('.correction-panel')`)).toBe(false);
      }
      expect(await hud(page, 'time')).not.toBe('');
      await mouseButton(page, 'mouseReleased');
      noExceptions(page);
    }, 60_000);

    it('MODE-42: 追いエイム＋リコイルで L-STAR を撃ち切ってもリザルトに移らず撃たない。離すと残弾が装弾数に戻り、押し直すと撃て、20 秒でリザルトに移る', async () => {
      const page = await openFresh();
      const startedAt = await start(page, { mode: TRACK_RECOIL, weapon: LSTAR.name });
      expect(await hud(page, 'weapon')).toContain(LSTAR.name);
      expect(num(await hud(page, 'ammo'))).toBe(LSTAR.magSize);
      await mouseButton(page, 'mousePressed');
      await page.advanceClockUntil('window.__ammo() === 0', { step: 1 / 60, limit: 8 });
      await page.advanceClock(1.5);
      expect(await hash(page)).toBe('#/play');
      expect(await page.evaluate<number>('window.__ammo()')).toBe(0);
      await mouseButton(page, 'mouseReleased');
      await page.advanceClockUntil(`window.__ammo() === ${LSTAR.magSize}`, { step: 1 / 60, limit: 1 });
      await page.advanceClock(2.5);
      expect(await hash(page)).toBe('#/play');
      await mouseButton(page, 'mousePressed');
      await page.advanceClockUntil(`window.__ammo() < ${LSTAR.magSize}`, { step: 1 / 60, limit: 1 });
      await mouseButton(page, 'mouseReleased');
      await untilResult(page);
      const resultAt = await page.evaluate<number>('window.__resultAt');
      expect(resultAt - startedAt).toBeGreaterThan(19.9);
      expect(resultAt - startedAt).toBeLessThan(20.2);
      noExceptions(page);
    }, 120_000);

    it('MODE-43: 追いエイム＋リコイルでは、音とゴースト表示が ON でも、撃っているあいだ補正のパネルが出ず向きの音が鳴らない（比べ: 反復練習では鳴る）', async () => {
      const page = await openFresh();
      // ゴースト表示を ON にする（設定画面の項目）。音は既定で ON。
      await page.evaluate(`location.hash = '#/settings'`);
      await page.waitFor(`window.__vis('[data-screen="settings"]')`);
      await page.evaluate(`(() => { const g = document.querySelector('#setting-ghost'); if (!g.checked) g.click(); const s = document.querySelector('#setting-sound'); if (!s.checked) s.click(); })()`);
      await page.frames(2);
      expect(await page.evaluate<boolean>(`document.querySelector('#setting-sound').checked && document.querySelector('#setting-ghost').checked`)).toBe(true);

      await start(page, { mode: TRACK_RECOIL, weapon: LSTAR.name });
      const before = await page.evaluate<number>('window.__oscStarts');
      await mouseButton(page, 'mousePressed');
      for (let i = 0; i < 8; i += 1) {
        await page.advanceClock(0.25);
        expect(await page.evaluate<boolean>(`window.__vis('.correction-panel')`)).toBe(false);
        expect(await page.evaluate<boolean>(`window.__vis('.pad-guide')`)).toBe(false);
      }
      await mouseButton(page, 'mouseReleased');
      expect(await page.evaluate<number>('window.__ammo()')).toBeLessThan(LSTAR.magSize);
      expect(await page.evaluate<number>('window.__oscStarts')).toBe(before);
      await untilResult(page);

      // 比べ: 同じ設定の反復練習では、撃つと向きの音が鳴り、補正のパネルが出る（数え方の確かめ）。
      await start(page, { mode: REPEAT, weapon: LSTAR.name });
      const before2 = await page.evaluate<number>('window.__oscStarts');
      await mouseButton(page, 'mousePressed');
      await page.advanceClock(0.5);
      expect(await page.evaluate<boolean>(`window.__vis('.correction-panel')`)).toBe(true);
      await mouseButton(page, 'mouseReleased');
      expect(await page.evaluate<number>('window.__oscStarts')).toBeGreaterThan(before2);
      noExceptions(page);
    }, 120_000);

    it('MODE-44: パッドを接続して追いエイムを始め、右スティックで照準が動き、20 秒でリザルト画面に移って乗っていた割合が出て、パッドの組に保存される', async () => {
      const page = await openFresh({ pad: true, render: true });
      await padFocus(page, 'mode');
      for (let i = 0; i < 4 && (await topState(page)).mode !== TRACK; i += 1) await padTap(page, RIGHT);
      expect((await topState(page)).mode).toBe(TRACK);
      await padFocus(page, 'start');
      await btn(page, A, true);
      await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]')`);
      const startedAt = await page.evaluate<number>('window.__clockNow()');
      await btn(page, A, false);
      await page.advanceClock(2 / 60);
      const before = await canvasOnly(page);
      await page.evaluate('window.__pad.axes[2] = 0.8');
      await page.advanceClock(0.3);
      await page.evaluate('window.__pad.axes[2] = 0');
      await page.advanceClock(2 / 60);
      const after = await canvasOnly(page);
      // 照準（カメラ）が動くと、壁の端など画面の広い範囲が変わる。
      const d = diff(before, after);
      expect(d.count, '右スティックで照準が動く').toBeGreaterThan(2000);
      expect(d.width).toBeGreaterThan(300);
      await page.advanceClockUntil(`location.hash === '#/result'`, { step: 0.25, limit: DURATION + 5 });
      await page.waitFor(`window.__vis('[data-screen="result"]') && document.querySelector('#result-metrics').children.length > 0`);
      const resultAt = await page.evaluate<number>('window.__resultAt');
      expect(resultAt - startedAt).toBeGreaterThan(19.9);
      expect(resultAt - startedAt).toBeLessThan(20.3);
      const r = await resultState(page);
      const rate = num(metric(r, RATE));
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(100);
      const s = await storage(page);
      expect(Object.keys(s).sort()).toEqual([bestKey('pad', '-', 'tracking', 'normal'), historyKey('pad', '-', 'tracking', 'normal')].sort());
      noExceptions(page);
    }, 180_000);

    it('MODE-45: 追いエイム（速い）の練習中に R でやり直すと、プレイ画面のまま経過時間が 0.0 に、的が基準の点に戻り、同じモード・速さで練習が続く', async () => {
      const page = await openFresh({ render: true });
      await start(page, { mode: TRACK, speed: FAST });
      // 開始した直後（ステップを進める前）の画面には練習の的が描かれていないので、それを背景にして、的の位置を変わった画素の範囲で読む。
      const bg = await canvasOnly(page);
      await page.advanceClock(1 / 60);
      const first = diff(bg, await canvasOnly(page));
      expect(first.count).toBeGreaterThan(200);
      await page.advanceClock(1.3);
      expect(num(await hud(page, 'time'))).toBeGreaterThan(1);
      const moved = diff(bg, await canvasOnly(page));
      await key(page, KEY_R);
      await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]')`);
      await page.frames(2);
      expect(await hud(page, 'time')).toMatch(/(^|[^\d.])0\.0([^\d]|$)/);
      await page.advanceClock(1 / 60);
      const again = diff(bg, await canvasOnly(page));
      // 1/60 秒では速い（毎秒 4.5 メートル）でも 0.075 メートル（約 6 画素）しか動かないので、的は基準の点（画面の中心）にある。
      expect(Math.abs(again.cx - CX), JSON.stringify({ first, moved, again })).toBeLessThanOrEqual(10);
      expect(Math.abs(first.cx - CX), JSON.stringify({ first, moved, again })).toBeLessThanOrEqual(10);
      expect(Math.abs(again.cy - first.cy)).toBeLessThanOrEqual(2);
      await lock(page);
      await page.advanceClockUntil(`location.hash === '#/result'`, { step: 0.25, limit: DURATION + 5 });
      await page.evaluate('document.exitPointerLock()');
      await page.waitFor(`window.__vis('[data-screen="result"]') && document.querySelector('#result-metrics').children.length > 0`);
      const r = await resultState(page);
      expect(r.text).toContain(TRACK);
      expect(r.text).not.toContain(TRACK_RECOIL);
      expect(r.text).toContain(FAST);
      const s = await storage(page);
      expect(Object.keys(s).sort()).toEqual([bestKey('mouse', '-', 'tracking', 'fast'), historyKey('mouse', '-', 'tracking', 'fast')].sort());
      // やり直した練習は 1 回の練習として保存されない（終えたのはやり直したあとの 1 回）。
      expect((JSON.parse(s[historyKey('mouse', '-', 'tracking', 'fast')]!) as { entries: unknown[] }).entries).toHaveLength(1);
      noExceptions(page);
    }, 180_000);
  });

  // -------------------------------------------------------------------------
  describe('リザルト・自己ベスト・履歴', () => {
    it('SCO-49: 追いエイムのリザルト画面に乗っていた割合・外していたときのズレ・乗り直すまでの時間・速さ・自己ベストが出て、平均ズレ・グルーピング半径・散布図・軌道・苦手な区間は出ない', async () => {
      const page = await openFresh();
      await practice(page, { mode: TRACK });
      const r = await resultState(page);
      expect(metric(r, RATE)).toMatch(/^\d+\.\d%$/);
      expect(metric(r, OFF_ERROR)).toMatch(/^(\d+\.\d{2}°|なし)$/);
      expect(metric(r, REACQUIRE)).toMatch(/^(\d+\.\d{2}\s*秒|なし)$/);
      expect(r.text).toContain('速さ');
      expect(r.text).toContain(NORMAL);
      expect(r.best).toContain('自己ベスト');
      for (const label of ['平均ズレ', 'グルーピング半径', '命中率', '撃った弾数']) expect(hasMetric(r, label), label).toBe(false);
      expect(r.text).not.toContain('平均ズレ');
      expect(r.text).not.toContain('グルーピング半径');
      expect(r.text).not.toContain('苦手な区間');
      expect(r.svgs, '散布図・照準の軌道の図').toBe(0);
      noExceptions(page);
    }, 60_000);

    it('SCO-50: 自己ベストがない状態でマウス・ふつうの追いエイムを終えると「自己ベスト更新」が出て、best と history の tracking:normal のキーに version 1 と onTargetRate が保存される', async () => {
      const page = await openFresh();
      await practice(page, { mode: TRACK });
      const r = await resultState(page);
      expect(r.best).toContain(BEST_UPDATED);
      const rate = num(metric(r, RATE));
      const s = await storage(page);
      const bk = bestKey('mouse', '-', 'tracking', 'normal');
      const hk = historyKey('mouse', '-', 'tracking', 'normal');
      expect(Object.keys(s).sort()).toEqual([bk, hk].sort());
      const best = JSON.parse(s[bk]!) as Record<string, unknown>;
      expect(best.version).toBe(1);
      expect(Math.abs((best.onTargetRate as number) - rate)).toBeLessThanOrEqual(0.05 + 1e-9);
      const history = JSON.parse(s[hk]!) as { version: number; entries: Record<string, unknown>[] };
      expect(history.version).toBe(1);
      expect(history.entries).toHaveLength(1);
      expect(Math.abs((history.entries[0]!.onTargetRate as number) - rate)).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(Number.isNaN(Date.parse(String(history.entries[0]!.at)))).toBe(false);
      // 追いエイム（リコイルなし）は命中率・撃った弾数を持たない。
      expect(best).not.toHaveProperty('hitRate');
      expect(history.entries[0]).not.toHaveProperty('shots');
      noExceptions(page);
    }, 60_000);

    it('SCO-51: 乗っていた割合が大きいほど良い。自己ベストより小さい結果と等しい結果では更新せず、大きい結果で更新する', async () => {
      const bk = bestKey('mouse', '-', 'tracking', 'normal');
      const seedBest = (v: number) => ({ [bk]: JSON.stringify({ version: 1, achievedAt: '2026-01-01T00:00:00.000Z', onTargetRate: v }) });

      // 60% の自己ベストに、照準を外し続けた 0% の結果（小さい）。
      let page = await openFresh({ seed: seedBest(60) });
      await practice(page, { mode: TRACK, away: true });
      let r = await resultState(page);
      expect(metric(r, RATE)).toBe('0.0%');
      expect(r.best).not.toContain(BEST_UPDATED);
      expect(r.best).toContain('60');
      expect((await stored<{ onTargetRate: number }>(page, bk))?.onTargetRate).toBe(60);
      await browser!.closePages();

      // 0% の自己ベストに 0% の結果（等しい）。
      page = await openFresh({ seed: seedBest(0) });
      await practice(page, { mode: TRACK, away: true });
      r = await resultState(page);
      expect(metric(r, RATE)).toBe('0.0%');
      expect(r.best).not.toContain(BEST_UPDATED);
      expect((await stored<{ onTargetRate: number }>(page, bk))?.onTargetRate).toBe(0);

      // 同じ組で、照準を動かさない（開始時は的の中心を向いている）0% より大きい結果では更新する。
      await practice(page, { mode: TRACK });
      r = await resultState(page);
      const rate = num(metric(r, RATE));
      expect(rate).toBeGreaterThan(0);
      expect(r.best).toContain(BEST_UPDATED);
      const now = (await stored<{ onTargetRate: number }>(page, bk))!.onTargetRate;
      expect(now).toBeGreaterThan(0);
      expect(Math.abs(now - rate)).toBeLessThanOrEqual(0.05 + 1e-9);
      noExceptions(page);
    }, 120_000);

    it('SCO-52: 追いエイム・ふつうの記録がある状態で、追いエイム・速い、追いエイム＋リコイルの L-STAR・ふつう、C.A.R. SMG・ふつうを初めて終えると、どれも更新され別のキーに保存され、ふつうの記録は変わらない', async () => {
      const bk = bestKey('mouse', '-', 'tracking', 'normal');
      const hk = historyKey('mouse', '-', 'tracking', 'normal');
      const seed = {
        [bk]: JSON.stringify({ version: 1, achievedAt: '2026-01-01T00:00:00.000Z', onTargetRate: 99.9, offTargetError: 0.5, reacquireTime: 0.1 }),
        [hk]: JSON.stringify({ version: 1, entries: [{ at: '2026-01-01T00:00:00.000Z', onTargetRate: 99.9, offTargetError: 0.5, reacquireTime: 0.1 }] }),
      };
      const page = await openFresh({ seed });
      const runs: { opts: StartOptions; best: string; history: string }[] = [
        { opts: { mode: TRACK, speed: FAST }, best: bestKey('mouse', '-', 'tracking', 'fast'), history: historyKey('mouse', '-', 'tracking', 'fast') },
        { opts: { mode: TRACK_RECOIL, weapon: LSTAR.name, speed: NORMAL }, best: bestKey('mouse', LSTAR.id, 'tracking-recoil', 'normal'), history: historyKey('mouse', LSTAR.id, 'tracking-recoil', 'normal') },
        { opts: { mode: TRACK_RECOIL, weapon: CAR.name, speed: NORMAL }, best: bestKey('mouse', CAR.id, 'tracking-recoil', 'normal'), history: historyKey('mouse', CAR.id, 'tracking-recoil', 'normal') },
      ];
      const expected = new Set([bk, hk]);
      for (const run of runs) {
        await practice(page, run.opts);
        const r = await resultState(page);
        expect(r.best, JSON.stringify(run.opts)).toContain(BEST_UPDATED);
        const s = await storage(page);
        expected.add(run.best);
        expected.add(run.history);
        expect(Object.keys(s).sort(), JSON.stringify(run.opts)).toEqual([...expected].sort());
        expect(s[bk]).toBe(seed[bk]);
        expect(s[hk]).toBe(seed[hk]);
        expect((JSON.parse(s[run.history]!) as { entries: unknown[] }).entries).toHaveLength(1);
      }
      noExceptions(page);
    }, 180_000);

    it('SCO-53: 追いエイム＋リコイルの L-STAR で的の中心に向けて fire を押し続けると、リザルト画面に撃った弾数と命中率が出て、自己ベストと履歴に hitRate と shots が入る', async () => {
      const page = await openFresh();
      // 開始時の照準は的の中心を向いている（modes.md「追いエイム」）。そのまま撃ち始める。
      await start(page, { mode: TRACK_RECOIL, weapon: LSTAR.name });
      await mouseButton(page, 'mousePressed');
      await page.advanceClockUntil('window.__ammo() === 0', { step: 1 / 60, limit: 8 });
      await mouseButton(page, 'mouseReleased');
      await untilResult(page);
      const r = await resultState(page);
      const shots = num(metric(r, '撃った弾数'));
      expect(shots).toBe(LSTAR.magSize);
      const hitRate = num(metric(r, '命中率'));
      expect(metric(r, '命中率')).toMatch(/^\d+\.\d%$/);
      expect(hitRate).toBeGreaterThan(0);
      expect(hitRate).toBeLessThanOrEqual(100);
      // 命中率は撃った弾のうち的に当たった弾の割合なので、28 発のうちの整数の発の割合。
      const hits = Math.round((hitRate / 100) * shots);
      expect(Math.abs((hits / shots) * 100 - hitRate)).toBeLessThanOrEqual(0.05 + 1e-9);
      const best = await stored<Record<string, number>>(page, bestKey('mouse', LSTAR.id, 'tracking-recoil', 'normal'));
      const history = await stored<{ entries: Record<string, number>[] }>(page, historyKey('mouse', LSTAR.id, 'tracking-recoil', 'normal'));
      expect(best?.shots).toBe(shots);
      expect(Math.abs(best!.hitRate! - hitRate)).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(history?.entries[0]?.shots).toBe(shots);
      expect(Math.abs(history!.entries[0]!.hitRate! - hitRate)).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(typeof best?.onTargetRate).toBe('number');
      noExceptions(page);
    }, 60_000);

    it('SCO-54: 追いエイム（リコイルなし）で fire を何度か押して終えても、リザルト画面に命中率と撃った弾数が出ない', async () => {
      const page = await openFresh();
      await start(page, { mode: TRACK });
      for (let i = 0; i < 5; i += 1) {
        await mouseButton(page, 'mousePressed');
        await page.advanceClock(0.1);
        await mouseButton(page, 'mouseReleased');
        await page.advanceClock(1);
      }
      await untilResult(page);
      const r = await resultState(page);
      expect(hasMetric(r, RATE)).toBe(true);
      expect(hasMetric(r, '命中率')).toBe(false);
      expect(hasMetric(r, '撃った弾数')).toBe(false);
      expect(r.text).not.toContain('命中率');
      expect(r.text).not.toContain('撃った弾数');
      noExceptions(page);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('トップ画面・履歴の画面・シェア・セットのまとめ', () => {
    it('UI-101: 追いエイムでは武器の欄と試聴が隠れて速さの欄（ふつう）が出る。追いエイム＋リコイルでは武器と速さの両方、反復練習では速さの欄が出ない', async () => {
      const page = await openFresh();
      const initial = await topState(page);
      expect(initial.mode).toBe(REPEAT);
      expect(initial.speedVisible).toBe(false);
      await choose(page, '#mode', TRACK);
      const t = await topState(page);
      expect(t.weaponVisible).toBe(false);
      expect(t.previewVisible).toBe(false);
      expect(t.speedVisible).toBe(true);
      expect(t.speeds).toEqual([SLOW, NORMAL, FAST]);
      expect(t.speed).toBe(NORMAL);
      await choose(page, '#mode', TRACK_RECOIL);
      const tr = await topState(page);
      expect(tr.weaponVisible).toBe(true);
      expect(tr.speedVisible).toBe(true);
      await choose(page, '#mode', REPEAT);
      const back = await topState(page);
      expect(back.speedVisible).toBe(false);
      expect(back.weaponVisible).toBe(true);
      noExceptions(page);
    }, 60_000);

    it('UI-102: 追いエイム・速いで練習を終え「武器変更」でトップ画面に戻ると、追いエイムと速いが選ばれたままで、開始すると速いで練習が始まる', async () => {
      const page = await openFresh();
      await practice(page, { mode: TRACK, speed: FAST });
      await page.clickSelector('#change-weapon');
      await page.waitFor(TOP_READY);
      await page.frames(2);
      const top = await topState(page);
      expect(top.mode).toBe(TRACK);
      expect(top.speedVisible).toBe(true);
      expect(top.speed).toBe(FAST);
      // 選び直さずに開始する。
      await page.clickSelector('[data-screen="top"] a[href="#/play"]');
      await lock(page);
      await untilResult(page);
      expect((await resultState(page)).text).toContain(FAST);
      const s = await storage(page);
      expect(Object.keys(s).sort()).toEqual([bestKey('mouse', '-', 'tracking', 'fast'), historyKey('mouse', '-', 'tracking', 'fast')].sort());
      expect((JSON.parse(s[historyKey('mouse', '-', 'tracking', 'fast')]!) as { entries: unknown[] }).entries).toHaveLength(2);
      noExceptions(page);
    }, 120_000);

    it('UI-103: パッドだけで追いエイムと速さ「遅い」を選んで開始すると遅いの練習になり、反復練習のときは十字キーで速さの欄にフォーカスが移らない', async () => {
      const page = await openFresh({ pad: true });
      // 反復練習（開いたとき）は、上下に動かしても速さの欄に移らない。
      const seen: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        await padTap(page, DOWN);
        seen.push(await focused(page));
      }
      for (let i = 0; i < 10; i += 1) {
        await padTap(page, UP);
        seen.push(await focused(page));
      }
      expect(seen, seen.join(' → ')).toContain('mode');
      expect(seen.filter((f) => f === 'speed'), seen.join(' → ')).toEqual([]);

      await padFocus(page, 'mode');
      for (let i = 0; i < 4 && (await topState(page)).mode !== TRACK; i += 1) await padTap(page, RIGHT);
      expect((await topState(page)).mode).toBe(TRACK);
      await padTap(page, DOWN);
      expect(await focused(page)).toBe('speed');
      await padTap(page, LEFT);
      expect((await topState(page)).speed).toBe(SLOW);
      await padFocus(page, 'start');
      await btn(page, A, true);
      await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]')`);
      await btn(page, A, false);
      await page.advanceClockUntil(`location.hash === '#/result'`, { step: 1 / 60, limit: DURATION + 5 });
      await page.waitFor(`window.__vis('[data-screen="result"]') && document.querySelector('#result-metrics').children.length > 0`);
      expect((await resultState(page)).text).toContain(SLOW);
      const keys = Object.keys(await storage(page));
      expect(keys.length).toBe(2);
      expect(keys.every((k) => k.endsWith(':-:tracking:slow')), keys.join('\n')).toBe(true);
      noExceptions(page);
    }, 120_000);

    it('UI-104: ふつうを 2 回・速いを 1 回練習したあと、履歴の画面で追いエイム・ふつう・マウスを選ぶと武器の欄が出ず 2 回分の乗っていた割合が出て、速いに選び直すと 1 回分になる', async () => {
      const page = await openFresh();
      await practice(page, { mode: TRACK, speed: NORMAL });
      await practice(page, { mode: TRACK, speed: NORMAL, away: true });
      await practice(page, { mode: TRACK, speed: FAST });
      await openHistory(page);
      await choose(page, '#history-mode', TRACK);
      await page.waitFor(`window.__vis('#history-speed')`);
      await choose(page, '#history-speed', NORMAL);
      await choose(page, '#history-input', 'マウス');
      const h = await historyState(page);
      expect(h.weaponVisible).toBe(false);
      expect(h.speedVisible).toBe(true);
      expect(h.rows).toHaveLength(2);
      expect(h.points).toBe(2);
      const col = h.headers.findIndex((x) => x.includes(RATE));
      expect(col, JSON.stringify(h.headers)).toBeGreaterThanOrEqual(0);
      const normal = JSON.parse((await storage(page))[historyKey('mouse', '-', 'tracking', 'normal')]!) as { entries: { onTargetRate: number }[] };
      expect(h.rows.map((r) => num(r[col]!)).sort((a, b) => a - b)).toEqual(normal.entries.map((e) => Math.round(e.onTargetRate * 10) / 10).sort((a, b) => a - b));
      await choose(page, '#history-speed', FAST);
      const f = await historyState(page);
      expect(f.rows).toHaveLength(1);
      expect(f.points).toBe(1);
      noExceptions(page);
    }, 180_000);

    it('UI-105: 追いエイム・ふつうのリザルト画面のシェアの文は、2 行目が「モード: 追いエイム / 速さ: ふつう」、3 行目が「乗っていた割合: <リザルトの値>」', async () => {
      const page = await openFresh();
      await practice(page, { mode: TRACK });
      const rate = metric(await resultState(page), RATE);
      const lines = (await share(page)).split('\n');
      expect(lines[1]).toBe(`モード: ${TRACK} / 速さ: ${NORMAL}`);
      expect(lines[2]).toBe(`${RATE}: ${rate}`);
      noExceptions(page);
    }, 60_000);

    it('UI-106: 追いエイムで 3 回分のセットを終えると、セットのまとめの見出しにモードと速さが出て、3 回分の乗っていた割合が並び、いちばん大きい回に印が付く', async () => {
      // 回数の選択肢は 1・5・10・20（UI-31）で 3 はないので、回数 5 で 3 回終えたところでやめる（Q）。
      // セットのまとめの対象は最後まで終えた回だけなので、3 回分のセットのまとめになる。
      // 1 回目と 3 回目は照準を上に外して 0%、2 回目は照準を動かさず 0% より大きくして、2 回目をいちばん大きくする。
      const page = await openFresh();
      await start(page, { mode: TRACK, count: 5 });
      for (let i = 0; i < 3; i += 1) {
        await lock(page);
        if (i !== 1) await aimAway(page);
        await page.advanceClockUntil('window.__interlude()', { step: 1 / 60, limit: DURATION + 5 });
        await page.frames(2);
        if (i < 2) await page.advanceClockUntil(`!window.__interlude() && location.hash === '#/play'`, { step: 1 / 60, limit: 10 });
      }
      await key(page, KEY_Q);
      await page.evaluate('document.exitPointerLock()');
      await page.waitFor(`window.__vis('[data-screen="set-result"]')`);
      await page.frames(2);
      const set = await page.evaluate<{ summary: string; rounds: { text: string; sig: string }[]; best: string }>(`(() => ({
        summary: document.querySelector('#set-summary').innerText,
        rounds: [...document.querySelectorAll('#set-rounds li')].filter((e) => window.__vis(e)).map((e) => ({ text: e.textContent.trim(),
          sig: [e.className, ...[...e.attributes].filter((a) => a.name !== 'class').map((a) => a.name + '=' + a.value), e.innerHTML].join('|').replace(/\\d+(?:\\.\\d+)?/g, '#') })),
        best: document.querySelector('#set-best')?.innerText.trim() ?? '' }))()`);
      expect(set.summary).toContain(TRACK);
      expect(set.summary).toContain(NORMAL);
      expect(set.rounds).toHaveLength(3);
      const rates = set.rounds.map((r) => {
        const m = r.text.match(/(\d+\.\d)%/);
        expect(m, r.text).not.toBeNull();
        return Number(m![1]);
      });
      expect(rates[0]).toBe(0);
      expect(rates[2]).toBe(0);
      expect(rates[1]).toBeGreaterThan(0);
      // 印: いちばん大きい回（2 回目）だけが、ほかの回と違う見た目（クラス・属性・数のほかの中身）になる。
      expect(set.rounds[0]!.sig).toBe(set.rounds[2]!.sig);
      expect(set.rounds[1]!.sig).not.toBe(set.rounds[0]!.sig);
      expect(set.best).toMatch(/2\s*回目/);
      noExceptions(page);
    }, 180_000);
  });
});
