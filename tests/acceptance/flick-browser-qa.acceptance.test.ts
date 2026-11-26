// docs/spec/modes.md「フリック」（MODE-46・MODE-53・MODE-55）、docs/spec/scoring.md「フリックの採点」「自己ベスト」「練習の履歴」
// （SCO-56〜SCO-60）、docs/spec/screens.md「トップ画面」「履歴の画面」「結果のシェア」「セットのまとめ」（UI-107〜UI-111）の
// ブラウザで確かめる受け入れテスト。QA が SPEC だけから書いたもの。
// 公開された入口（ビルドの結果を /apex-training/ で配信した画面、SPEC に書かれた localStorage のキーと値の形、画面写し）だけを使う。
// ブラウザを使わないフリックの受け入れテストは flick-qa.acceptance.test.ts にある。
//
// 的の位置はページの中から読めないので、的を狙う練習では 3D を描画して（render を付けない）画面写しを撮り、練習の的の色
// （壁・リング・弾痕と見分けられる色）の画素の重心を探して、ポインターロック中のマウスの移動（DevTools の mouseMoved の座標の差が
// movementX / movementY のカウントになる）で照準を合わせる。照準の向きは、動かしたカウントから mouse.md の換算
// （既定の感度 1.5 で 1 カウント 0.033 度。右がヨーの正、前（movementY が負）がピッチの正）で求める。
// ページの時計はテストから進める（clock=manual）。的を狙わない練習は 3D を描画しない（render=off）。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';
import { decodePng } from '../helpers/png';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const CX = 640;
const CY = 400;
const chromium = findChromium();
/** 固定ステップ（architecture.md、既定 1/120 秒）。 */
const DT = 1 / 120;
/** 既定の感度 1.5 の 1 カウントの角度（mouse.md）。 */
const DEG_PER_COUNT = 1.5 * 0.022;

/** SPEC の値と文言。 */
const REPEAT = '反復練習';
const FLICK = 'フリック';
const BEST_UPDATED = '自己ベスト更新';
const LSTAR = 'L-STAR';
const key = (kind: 'best' | 'history', input: 'mouse' | 'pad', range: string, size: string) => `apex-training:${kind}:${input}:-:flick:${range}:${size}`;
const FAR_SMALL_BEST = key('best', 'mouse', 'far', 'small');
const FAR_SMALL_HISTORY = key('history', 'mouse', 'far', 'small');

/** パッドの標準配置のボタン番号。 */
const A = 0;
const R2 = 7;
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
  window.__clockNow = () => window.__apexTestClock.now();
  window.__interlude = () => window.__vis('#interlude');
  window.__focused = () => { const els = [...document.querySelectorAll('.pad-focus')]; return els.length === 1 ? (els[0].getAttribute('data-card-choice') || els[0].id || els[0].textContent.trim()) : els.length > 1 ? 'MULTIPLE' : ''; };
  window.__hudMode = () => (document.querySelector('[data-hud="mode"]')?.textContent ?? '').trim();
  window.__shareCalls = [];
  Object.defineProperty(Navigator.prototype, 'share', { value: function (data) { window.__shareCalls.push(data?.text); return Promise.resolve(); }, configurable: true, writable: true });
  Object.defineProperty(Navigator.prototype, 'canShare', { value: () => true, configurable: true, writable: true });
`;

/** 標準配置のパッド 1 台。__btn(番号, 押す)・__axis(軸, 値) で操作する。 */
const FAKE_PAD = `
  window.__pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) };
  navigator.getGamepads = () => [{ id: 'acceptance pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard',
    timestamp: performance.now(), axes: window.__pad.axes.slice(), buttons: window.__pad.buttons.map((b) => ({ ...b })), vibrationActuator: null }];
  window.__btn = (i, on) => { window.__pad.buttons[i] = { value: on ? 1 : 0, pressed: on, touched: on }; };
  window.__axis = (a, v) => { window.__pad.axes[a] = v; };
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
}

/** ラベルの文字（「出る範囲」など）を含む label の中の select。見えているものだけ。 */
const settingSelect = (screen: 'top' | 'history', label: string) =>
  `[...document.querySelectorAll('[data-screen="${screen}"] select')].find((s) => window.__vis(s) && (s.closest('label')?.textContent ?? '').includes(${JSON.stringify(label)}))`;

async function chooseSetting(page: Page, screen: 'top' | 'history', label: string, value: string) {
  const ok = await page.evaluate<boolean>(`(() => { const s = ${settingSelect(screen, label)}; if (!s) return false;
    const o = [...s.options].find((x) => x.textContent.trim() === ${JSON.stringify(value)}); if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  if (!ok) throw new Error(`${screen} の「${label}」で ${value} を選べない`);
}

const TOP_READY = `window.__vis('[data-screen="top"]') && document.querySelector('#mode').options.length > 0 && document.querySelector('#count').options.length > 0`;

interface TopState {
  modeVisible: boolean;
  modes: string[];
  mode: string;
  weaponVisible: boolean;
  previewVisible: boolean;
  /** 見えている練習の設定の欄（見出し → [選ばれている値, 選択肢]）。 */
  settings: Record<string, { value: string; options: string[] }>;
}
const topState = (page: Page) =>
  page.evaluate<TopState>(`(() => {
    const screen = document.querySelector('[data-screen="top"]');
    const mode = document.querySelector('#mode'); const weapon = document.querySelector('#weapon');
    const preview = [...screen.querySelectorAll('button')].find((b) => b.textContent.trim() === 'パターンの音を聞く');
    const settings = {};
    for (const s of screen.querySelectorAll('select')) {
      if (s === mode || s === weapon || s.id === 'count' || !window.__vis(s)) continue;
      const label = (s.closest('label')?.textContent ?? '').replace(s.textContent, '').trim();
      settings[label] = { value: s.selectedOptions[0]?.textContent.trim() ?? '', options: [...s.options].map((o) => o.textContent.trim()) };
    }
    return { modeVisible: window.__vis('#mode-cards'), modes: [...mode.options].map((o) => o.textContent.trim()), mode: mode.selectedOptions[0]?.textContent.trim() ?? '',
      weaponVisible: window.__vis('#weapon-cards'), previewVisible: !!preview && window.__vis(preview), settings }; })()`);

/** HUD の見えている文字（見えていない欄は空文字）。 */
const hud = (page: Page, k: string) =>
  page.evaluate<string>(`(() => { const el = document.querySelector('[data-hud="${k}"]'); return el && window.__vis(el) ? el.textContent.trim() : ''; })()`);

const hash = (page: Page) => page.evaluate<string>('location.hash');
const now = (page: Page) => page.evaluate<number>('window.__clockNow()');

/** ページの時計を時刻 t まで進める（過ぎていたら失敗）。 */
async function advanceTo(page: Page, t: number) {
  const d = t - (await now(page));
  if (d < -1e-9) throw new Error(`時計がすでに ${t} を過ぎている（今 ${await now(page)}）`);
  if (d > 1e-9) await page.advanceClock(d);
}

// マウス -------------------------------------------------------------------

/** ポインターロック中のマウスの位置（mouseMoved の座標）と、練習の開始から動かしたカウントの合計。 */
interface Mouse {
  x: number;
  y: number;
  /** 練習の開始から動かしたカウント（右・下が正）。 */
  cx: number;
  cy: number;
}

const mouseButton = (page: Page, m: Mouse, type: 'mousePressed' | 'mouseReleased') =>
  page.send('Input.dispatchMouseEvent', { type, x: m.x, y: m.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });

async function moveBy(page: Page, m: Mouse, dx: number, dy: number) {
  if (dx === 0 && dy === 0) return;
  m.x += dx;
  m.y += dy;
  m.cx += dx;
  m.cy += dy;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: m.x, y: m.y, button: 'none', buttons: 0 });
}

/** 今の照準（練習の開始時の照準からのヨー・ピッチ、度）。 */
const aimOf = (m: Mouse) => ({ yaw: m.cx * DEG_PER_COUNT, pitch: -m.cy * DEG_PER_COUNT });

/** プレイ画面でクリックしてポインターロックを掛ける（掛かっていれば何もしない）。 */
async function lock(page: Page, m: Mouse) {
  await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]') && !window.__interlude()`);
  if (await page.evaluate<boolean>('!!document.pointerLockElement')) return;
  await page.frames(3);
  await mouseButton(page, m, 'mousePressed');
  await mouseButton(page, m, 'mouseReleased');
  await page.waitFor('!!document.pointerLockElement', 5000);
  await page.frames(2);
}

/** 押して 3 ステップ後に離す（1 つのステップの中で押して離さない）。 */
async function click(page: Page, m: Mouse) {
  await mouseButton(page, m, 'mousePressed');
  await page.advanceClock(3 * DT);
  await mouseButton(page, m, 'mouseReleased');
}

// 練習の的の色の画素 ---------------------------------------------------------

/** 画面写しの中の練習の的の画素の数と重心（画素の中心の座標）。的の色はテストの始めに 1 回求める。 */
let targetColor: [number, number, number] | undefined;
const CLIP = { x: CX - 480, y: CY - 160, width: 960, height: 320 };

async function findTarget(page: Page): Promise<{ n: number; x: number; y: number }> {
  if (!targetColor) throw new Error('的の色がまだ分からない');
  // 的を探すのは画面の中央の帯だけ（照準から左右 40 度・上下 15 度ほど）。撮る範囲を絞って速くする。
  const { data } = await page.send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    optimizeForSpeed: true,
    clip: { x: CLIP.x, y: CLIP.y, width: CLIP.width, height: CLIP.height, scale: 1 },
  });
  const img = decodePng(Buffer.from(data, 'base64'));
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const [r, g, b] = img.pixel(x, y);
      if (Math.abs(r - targetColor[0]) + Math.abs(g - targetColor[1]) + Math.abs(b - targetColor[2]) < 60) {
        n += 1;
        sx += CLIP.x + x + 0.5;
        sy += CLIP.y + y + 0.5;
      }
    }
  }
  return n === 0 ? { n, x: NaN, y: NaN } : { n, x: sx / n, y: sy / n };
}

/**
 * 1 個目の的が出る前と出たあとの画面写しの差から、練習の的の色を求める（ほかの画面の変化は HUD の文字だけで、色の数が少ない）。
 * before は的が出る前の画面写し。
 */
async function learnTargetColor(before: Buffer, after: Buffer) {
  const a = decodePng(before);
  const b = decodePng(after);
  const counts = new Map<string, number>();
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const p = a.pixel(x, y);
      const q = b.pixel(x, y);
      if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 60) counts.set(q.join(','), (counts.get(q.join(',')) ?? 0) + 1);
    }
  }
  const top = [...counts].sort((x, y) => y[1] - x[1])[0];
  if (!top || top[1] < 20) throw new Error(`的が出たあとの画面写しの差が見つからない: ${JSON.stringify([...counts].slice(0, 5))}`);
  targetColor = top[0].split(',').map(Number) as [number, number, number];
}

/** 画面の画素の差（中心から）を、照準を合わせるためのカウントにする（ピンホールの近似。閉じたループで詰める）。 */
const FOCAL_GUESS = 530;
const countsFor = (px: number) => Math.round((Math.atan(px / FOCAL_GUESS) * 180) / Math.PI / DEG_PER_COUNT);

/**
 * 画面写しで的を探して照準を的の中心へ合わせる（1 回動かすごとにページの時計を 1/60 秒進めて描画する）。
 * 合わせ終えたときの照準（度）を返す。
 */
async function aimAtTarget(page: Page, m: Mouse, limit = 10): Promise<{ yaw: number; pitch: number }> {
  const trail: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    const t = await findTarget(page);
    if (t.n === 0) throw new Error(`画面に練習の的が見えない（${trail.join(' → ')}）`);
    trail.push(`${(t.x - CX).toFixed(1)},${(t.y - CY).toFixed(1)}`);
    if (Math.hypot(t.x - CX, t.y - CY) <= 1) return aimOf(m);
    await moveBy(page, m, countsFor(t.x - CX), countsFor(t.y - CY));
    // 描画は直前と最後のステップの照準を補間するので、動かしたあと 4 ステップ進めて照準が止まった画面にする。
    await page.advanceClock(1 / 30);
  }
  throw new Error(`${limit} 回動かしても的の中心に合わない: ${trail.join(' → ')}`);
}

// 保存・リザルト ---------------------------------------------------------------

const storage = (page: Page) =>
  page.evaluate<Record<string, string>>(`(() => { const out = {}; for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i);
    if (k.startsWith('apex-training:best:') || k.startsWith('apex-training:history:')) out[k] = localStorage.getItem(k); } return out; })()`);

interface ResultState {
  metrics: Record<string, string>;
  best: string;
  text: string;
  summary: string;
  svgs: number;
}
const resultState = (page: Page) =>
  page.evaluate<ResultState>(`(() => {
    const screen = document.querySelector('[data-screen="result"]');
    const metrics = {};
    for (const dt of screen.querySelectorAll('dt')) { if (!window.__vis(dt)) continue; const dd = dt.nextElementSibling; if (dd && dd.tagName === 'DD') metrics[dt.textContent.trim()] = dd.textContent.trim(); }
    const best = [...screen.querySelectorAll('*')].filter((e) => window.__vis(e) && e.children.length === 0 && e.textContent.includes('自己ベスト')).map((e) => e.textContent.trim()).join('|');
    return { metrics, best, text: screen.innerText, summary: document.querySelector('#result-summary')?.innerText ?? '',
      svgs: [...screen.querySelectorAll('svg, canvas')].filter((s) => window.__vis(s)).length }; })()`);
const metric = (r: { metrics: Record<string, string> }, label: string) => {
  const k = Object.keys(r.metrics).find((x) => x.includes(label));
  if (k === undefined) throw new Error(`${label} がない: ${JSON.stringify(r.metrics)}`);
  return r.metrics[k]!;
};
const num = (s: string) => {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) throw new Error(`数がない: ${s}`);
  return Number(m[0]);
};

async function untilResult(page: Page) {
  await page.advanceClockUntil(`location.hash === '#/result'`, { step: 1 / 60, limit: 15 });
  await page.evaluate('document.pointerLockElement && document.exitPointerLock()');
  await page.waitFor(`window.__vis('[data-screen="result"]')`);
  await page.frames(2);
}

const pressKey = async (page: Page, k: string, code: string, vk: number) => {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: k });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
};

// パッド -------------------------------------------------------------------

const btn = (page: Page, b: number, on: boolean) => page.evaluate(`window.__btn(${b}, ${on})`);
async function padTap(page: Page, b: number) {
  await btn(page, b, true);
  await page.frames(3);
  await btn(page, b, false);
  await page.frames(3);
}
const focused = (page: Page) => page.evaluate<string>('window.__focused()');
async function padFocus(page: Page, target: string, limit = 20) {
  const seen: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    if ((await focused(page)) === target) return seen;
    await padTap(page, DOWN);
    seen.push(await focused(page));
  }
  throw new Error(`十字キーの下で ${target} にフォーカスが来ない: ${seen.join(' → ')}`);
}
async function padChoose(page: Page, selector: string, label: string) {
  for (let i = 0; i < 8; i += 1) {
    const st = await page.evaluate<{ now: number; want: number }>(`(() => { const s = document.querySelector(${JSON.stringify(selector)});
      return { now: s.selectedIndex, want: [...s.options].findIndex((o) => o.textContent.trim() === ${JSON.stringify(label)}) }; })()`);
    if (st.want < 0) throw new Error(`${selector} に ${label} がない`);
    if (st.now === st.want) return;
    await padTap(page, st.now < st.want ? RIGHT : LEFT);
  }
  throw new Error(`十字キーの左右で ${selector} に ${label} を選べない`);
}

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('QA: フリック（ブラウザ）', () => {
  let work = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));
  const noExceptions = (page: Page) => expect(exceptions(page), page.errors.join('\n')).toEqual([]);

  /** 新しいタブで localStorage を空にし（seed を入れ）、読み込み直したトップ画面を開く。 */
  async function openFresh(opts: { seed?: Record<string, string>; pad?: boolean; render?: boolean } = {}): Promise<Page> {
    const page = await browser!.newPage();
    const url = appUrl(origin, BASE, '#/', { render: opts.render ?? false, manualClock: true });
    await page.goto(url);
    await page.evaluate(`(() => { localStorage.clear(); const seed = ${JSON.stringify(opts.seed ?? {})}; for (const k in seed) localStorage.setItem(k, seed[k]); })()`);
    await page.addInitScript(PAGE_INIT);
    if (opts.pad) await page.addInitScript(FAKE_PAD);
    await page.evaluate(`location.hash = '#/'; window.__beforeReload = true`);
    await page.send('Page.reload', { ignoreCache: false });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && ${TOP_READY}`, 15_000);
    return page;
  }

  /** トップ画面でフリック（と練習の設定・回数）を選んで「開始」を押し、ポインターロックを掛ける。練習の開始の時計と、マウスの状態を返す。 */
  async function startFlick(page: Page, opts: { range?: string; size?: string; count?: number } = {}) {
    await page.evaluate(`location.hash = '#/'`);
    await page.waitFor(TOP_READY);
    await choose(page, '#mode', FLICK);
    if (opts.range) await chooseSetting(page, 'top', '出る範囲', opts.range);
    if (opts.size) await chooseSetting(page, 'top', '的の大きさ', opts.size);
    await choose(page, '#count', opts.count ?? 1);
    await page.clickSelector('[data-screen="top"] a[href="#/play"]');
    await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]')`);
    const startedAt = await now(page);
    const m: Mouse = { x: CX, y: CY, cx: 0, cy: 0 };
    await lock(page, m);
    return { startedAt, m };
  }

  /** 的の色をまだ知らなければ、1 個目の的が出る前後の画面写しから求める（3D を描画するページで、練習の開始直後に呼ぶ）。 */
  async function waitFirstTarget(page: Page, startedAt: number) {
    await advanceTo(page, startedAt + 1 - 0.03);
    const before = await page.screenshot();
    await advanceTo(page, startedAt + 1 + 0.05);
    if (!targetColor) await learnTargetColor(before, await page.screenshot());
  }

  /**
   * 3D を描画するページで、出ている的から順に、合わせて撃つ。times[i] は i 個目（0 始まり、hit が false の的は合わせずに撃つ）の、
   * 出現から撃つまでの時間（秒、固定ステップの倍数）。firstAppear は 1 個目の的の出現の時刻（ページの時計）。
   * 的を撃ったステップの終わりが次の的の出現の時刻になる（modes.md）ので、撃つ時刻はステップの真ん中にする。
   */
  async function shootTargets(page: Page, m: Mouse, firstAppear: number, plan: { time: number; hit: boolean }[]) {
    let appear = firstAppear;
    const aims: { yaw: number; pitch: number }[] = [];
    for (const [i, p] of plan.entries()) {
      if ((await now(page)) < appear + 1 / 60) await advanceTo(page, appear + 1 / 60);
      if (p.hit) aims.push(await aimAtTarget(page, m));
      const fireAt = appear + p.time - DT / 2;
      if ((await now(page)) > fireAt) throw new Error(`${i + 1} 個目の的に合わせ終える前に撃つ時刻を過ぎた`);
      await advanceTo(page, fireAt);
      await click(page, m);
      appear += p.time;
    }
    return aims;
  }

  const allHits = (time: number, n = 20) => Array.from({ length: n }, () => ({ time, hit: true }));
  const firstHitOnly = (time: number) => Array.from({ length: 20 }, (_, i) => ({ time, hit: i === 0 }));

  /** 合わせずに n 回撃つ（3D を描画しないページ）。1 回目は 1 個目の的が出たあと。 */
  async function shootBlind(page: Page, m: Mouse, startedAt: number, n = 20) {
    if ((await now(page)) < startedAt + 1.05) await advanceTo(page, startedAt + 1.05);
    for (let i = 0; i < n; i += 1) {
      await click(page, m);
      await page.advanceClock(0.05);
    }
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'flick-browser-qa-'));
    const dist = join(work, 'dist');
    const env = { ...process.env, APEX_ACCEPTANCE_NESTED: '1', FORCE_COLOR: '0' };
    const build = spawnSync(`npm run build -- --outDir "${dist}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8', env });
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
  describe('トップ画面', () => {
    it('UI-107: フリックを選ぶと出る範囲と的の大きさの欄が出て「ふつう」「中」が選ばれ、武器の欄と試聴は隠れる。選び直すと前の設定が残る', async () => {
      const page = await openFresh();
      const first = await topState(page);
      expect(first.mode).toBe(REPEAT);
      expect(first.settings).toEqual({});
      expect(first.weaponVisible).toBe(true);

      await choose(page, '#mode', FLICK);
      await page.frames(2);
      const flick = await topState(page);
      expect(flick.weaponVisible).toBe(false);
      expect(flick.previewVisible).toBe(false);
      const labels = Object.keys(flick.settings);
      const range = labels.find((l) => l.includes('出る範囲'));
      const size = labels.find((l) => l.includes('的の大きさ'));
      expect(range, JSON.stringify(flick.settings)).toBeDefined();
      expect(size, JSON.stringify(flick.settings)).toBeDefined();
      expect(flick.settings[range!]).toEqual({ value: 'ふつう', options: ['近い', 'ふつう', '遠い'] });
      expect(flick.settings[size!]).toEqual({ value: '中', options: ['大', '中', '小'] });

      await chooseSetting(page, 'top', '出る範囲', '遠い');
      await chooseSetting(page, 'top', '的の大きさ', '小');
      await choose(page, '#mode', REPEAT);
      await page.frames(2);
      const back = await topState(page);
      expect(back.settings).toEqual({});
      expect(back.weaponVisible).toBe(true);
      expect(back.previewVisible).toBe(true);

      await choose(page, '#mode', FLICK);
      await page.frames(2);
      const again = await topState(page);
      expect(again.settings[range!]!.value).toBe('遠い');
      expect(again.settings[size!]!.value).toBe('小');
      noExceptions(page);
    });

    it('UI-108: パッドだけでフリック・遠い・小を選んで開始するとその設定で始まる。反復練習のときは設定の欄にフォーカスが移らない', async () => {
      // 反復練習のとき: 十字キーの上下で回っても、出る範囲と的の大きさの欄にフォーカスが移らない。
      const page = await openFresh({ pad: true });
      const seen: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        await padTap(page, DOWN);
        seen.push(await focused(page));
      }
      for (let i = 0; i < 10; i += 1) {
        await padTap(page, UP);
        seen.push(await focused(page));
      }
      expect((await topState(page)).mode).toBe(REPEAT);
      expect(seen).toContain('mode');
      const settingIds = await page.evaluate<string[]>(`[...document.querySelectorAll('[data-screen="top"] select')].filter((s) => /範囲|大きさ/.test(s.closest('label')?.textContent ?? '')).map((s) => s.id)`);
      expect(settingIds.length).toBe(2);
      expect(seen.filter((f) => settingIds.includes(f)), seen.join(' → ')).toEqual([]);

      // フリック・遠い・小を選んで開始する。
      const page2 = await openFresh({ pad: true });
      await padFocus(page2, 'mode');
      await padChoose(page2, '#mode', FLICK);
      expect((await topState(page2)).mode).toBe(FLICK);
      const [rangeId, sizeId] = await page2.evaluate<string[]>(`[${settingSelect('top', '出る範囲')}?.id, ${settingSelect('top', '的の大きさ')}?.id]`);
      expect(rangeId).toBeTruthy();
      expect(sizeId).toBeTruthy();
      await padFocus(page2, rangeId!);
      await padChoose(page2, `#${rangeId}`, '遠い');
      await padFocus(page2, sizeId!);
      await padChoose(page2, `#${sizeId}`, '小');
      await padFocus(page2, 'start');
      await btn(page2, A, true);
      await page2.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]')`);
      await btn(page2, A, false);
      const startedAt = await now(page2);
      await page2.frames(3);
      expect(await page2.evaluate<string>('window.__hudMode()')).toBe('的: 0 / 20');
      await advanceTo(page2, startedAt + 1.05);
      for (let i = 0; i < 20; i += 1) {
        await btn(page2, R2, true);
        await page2.advanceClock(0.05);
        await btn(page2, R2, false);
        await page2.advanceClock(0.05);
      }
      await page2.waitFor(`location.hash === '#/result' && window.__vis('[data-screen="result"]')`);
      const r = await resultState(page2);
      expect(r.text).toMatch(/出る範囲: 遠い \/ 的の大きさ: 小|出る範囲\s*遠い[\s\S]*的の大きさ\s*小/);
      noExceptions(page);
      noExceptions(page2);
    });
  });

  // -------------------------------------------------------------------------
  describe('練習', () => {
    it('MODE-46: 開始から 1 秒後に的が出て HUD が「的: 0 / 20」（武器名・残弾なし）、当てると次の的が出て「1 / 20」、20 個目でリザルトに移る', { timeout: 240_000 }, async () => {
      const page = await openFresh({ render: true });
      const { startedAt, m } = await startFlick(page);
      await advanceTo(page, startedAt + 0.5);
      expect(await hud(page, 'mode')).toBe('的: 0 / 20');
      expect(await hud(page, 'weapon')).toBe('');
      expect(await hud(page, 'ammo')).toBe('');
      await advanceTo(page, startedAt + 1 - 0.03);
      const before = await page.screenshot();
      if (targetColor) expect((await findTarget(page)).n, '1 秒より前には的が出ていない').toBe(0);
      await advanceTo(page, startedAt + 1 + 1 / 60);
      if (!targetColor) await learnTargetColor(before, await page.screenshot());
      const first = await findTarget(page);
      expect(first.n, '1 秒のあとに的が出ている').toBeGreaterThan(20);
      expect(await hud(page, 'mode')).toBe('的: 0 / 20');

      await aimAtTarget(page, m);
      await click(page, m);
      await page.advanceClock(1 / 60);
      expect(await hud(page, 'mode')).toBe('的: 1 / 20');
      const second = await findTarget(page);
      expect(second.n, '次の的が出ている').toBeGreaterThan(5);
      // 照準を的に合わせて動かしたので、前の的は画面の中心にある。次の的は別の場所に出ている。
      expect(Math.hypot(second.x - CX, second.y - CY)).toBeGreaterThan(20);

      for (let i = 2; i <= 19; i += 1) {
        await click(page, m);
        await page.advanceClock(0.05);
        expect(await hud(page, 'mode')).toBe(`的: ${i} / 20`);
      }
      expect(await hash(page)).toBe('#/play');
      await click(page, m);
      await untilResult(page);
      expect(await hash(page)).toBe('#/result');
      noExceptions(page);
    });

    it('MODE-53: パッドだけでフリックを選んで開始し、右スティックで照準を動かして R2 で 20 個撃つとリザルトに移り、入力方式がパッドになる', async () => {
      const page = await openFresh({ pad: true });
      await padFocus(page, 'mode');
      await padChoose(page, '#mode', FLICK);
      await padFocus(page, 'start');
      await btn(page, A, true);
      await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]')`);
      await btn(page, A, false);
      const startedAt = await now(page);
      await page.frames(3);
      // 右スティックを右に倒して照準を動かす。
      await page.evaluate('window.__axis(2, 0.8)');
      await page.advanceClock(0.3);
      await page.evaluate('window.__axis(2, 0)');
      await advanceTo(page, startedAt + 1.05);
      for (let i = 1; i <= 20; i += 1) {
        await btn(page, R2, true);
        await page.advanceClock(0.05);
        await btn(page, R2, false);
        await page.advanceClock(0.05);
        if (i < 20) expect(await page.evaluate<string>('window.__hudMode()')).toBe(`的: ${i} / 20`);
      }
      await page.waitFor(`location.hash === '#/result' && window.__vis('[data-screen="result"]')`);
      const r = await resultState(page);
      expect(r.summary).toContain(FLICK);
      // リザルトの入力方式は、履歴の画面が開いたときに選ぶ「最後に終えた練習の入力方式」（screens.md「履歴の画面」）で確かめる。
      await page.evaluate(`location.hash = '#/history'`);
      await page.waitFor(`window.__vis('[data-screen="history"]') && document.querySelectorAll('#history-mode option').length > 0`);
      await page.frames(2);
      expect(await page.evaluate<string>(`document.querySelector('#history-mode').selectedOptions[0].textContent.trim()`)).toBe(FLICK);
      expect(await page.evaluate<string>(`document.querySelector('#history-input').selectedOptions[0].textContent.trim()`)).toBe('パッド');
      noExceptions(page);
    });

    it('MODE-55: 遠い・小で練習し、「もう一度」・やり直し・回数 5 のセットの 2 回目でも同じ遠い・小で始まり、的の角度の距離が 14 度以上 20 度未満', { timeout: 240_000 }, async () => {
      const page = await openFresh({ render: true });
      const firstDistance = async (startedAt: number, m: Mouse) => {
        await waitFirstTarget(page, startedAt);
        const a = await aimAtTarget(page, m);
        return Math.hypot(a.yaw, a.pitch);
      };
      const inFar = (d: number, what: string) => {
        expect(d, what).toBeGreaterThanOrEqual(14 - 0.1);
        expect(d, what).toBeLessThan(20 + 0.1);
      };

      // 1 回目と「もう一度」。
      let { startedAt, m } = await startFlick(page, { range: '遠い', size: '小' });
      inFar(await firstDistance(startedAt, m), '1 回目');
      await shootBlind(page, m, startedAt);
      await untilResult(page);
      expect((await resultState(page)).text).toMatch(/出る範囲: 遠い \/ 的の大きさ: 小|出る範囲\s*遠い[\s\S]*的の大きさ\s*小/);
      await page.clickSelector('#retry');
      await page.waitFor(`location.hash === '#/play'`);
      startedAt = await now(page);
      m = { x: m.x, y: m.y, cx: 0, cy: 0 };
      await lock(page, m);
      inFar(await firstDistance(startedAt, m), '「もう一度」');
      // 練習中のやり直し（R）。
      startedAt = await now(page);
      await pressKey(page, 'r', 'KeyR', 82);
      await page.advanceClock(1 / 60);
      m = { ...m, cx: 0, cy: 0 };
      expect(await hud(page, 'mode')).toBe('的: 0 / 20');
      inFar(await firstDistance(startedAt, m), 'やり直し');
      await shootBlind(page, m, startedAt);
      await untilResult(page);
      expect((await resultState(page)).text).toMatch(/出る範囲: 遠い \/ 的の大きさ: 小|出る範囲\s*遠い[\s\S]*的の大きさ\s*小/);

      // 回数 5 のセットの 2 回目。
      ({ startedAt, m } = await startFlick(page, { range: '遠い', size: '小', count: 5 }));
      await shootBlind(page, m, startedAt);
      await page.advanceClockUntil('window.__interlude()', { step: 1 / 60, limit: 15 });
      await page.advanceClockUntil(`!window.__interlude() && location.hash === '#/play'`, { step: 1 / 120, limit: 10 });
      startedAt = await now(page);
      m = { ...m, cx: 0, cy: 0 };
      await lock(page, m);
      await page.advanceClock(1 / 60);
      expect(await hud(page, 'mode')).toBe('的: 0 / 20');
      inFar(await firstDistance(startedAt, m), 'セットの 2 回目');
      await shootBlind(page, m, startedAt);
      await page.advanceClockUntil('window.__interlude()', { step: 1 / 60, limit: 15 });
      await pressKey(page, 'q', 'KeyQ', 81);
      await page.evaluate('document.pointerLockElement && document.exitPointerLock()');
      await page.waitFor(`window.__vis('[data-screen="set-result"]')`);
      expect(await page.evaluate<string>(`document.querySelector('[data-screen="set-result"]').innerText`)).toMatch(/出る範囲: 遠い \/ 的の大きさ: 小|出る範囲\s*遠い[\s\S]*的の大きさ\s*小/);
      noExceptions(page);
    });
  });

  // -------------------------------------------------------------------------
  describe('採点・リザルト・自己ベスト・履歴', () => {
    it('SCO-56: 1 個も命中しなかったとき、命中 1 回あたりの時間は「なし」で、自己ベストも履歴も保存しない', async () => {
      const page = await openFresh();
      const { startedAt, m } = await startFlick(page);
      await shootBlind(page, m, startedAt);
      await untilResult(page);
      const r = await resultState(page);
      expect(metric(r, '命中 1 回あたりの時間')).toBe('なし');
      expect(metric(r, '命中率')).toBe('0.0%');
      expect(metric(r, '命中数')).toBe('0 / 20');
      expect(metric(r, '時間の平均')).toMatch(/^\d+\.\d{3} 秒$/);
      expect(metric(r, 'ズレの平均')).toMatch(/^\d+\.\d{2}°$/);
      expect(r.best).not.toContain(BEST_UPDATED);
      expect(await storage(page)).toEqual({});
      noExceptions(page);
    });

    it('SCO-57・SCO-58: 遠い・小を終えると、リザルトに設定・指標・自己ベストが出て散布図などは出ず、best と history の flick:far:small に結果が保存される', { timeout: 240_000 }, async () => {
      const page = await openFresh({ render: true });
      const { startedAt, m } = await startFlick(page, { range: '遠い', size: '小' });
      await waitFirstTarget(page, startedAt);
      await shootTargets(page, m, startedAt + 1, allHits(0.5));
      await untilResult(page);
      const r = await resultState(page);
      // SCO-57
      expect(r.text).toMatch(/出る範囲: 遠い \/ 的の大きさ: 小|出る範囲\s*遠い[\s\S]*的の大きさ\s*小/);
      expect(metric(r, '命中 1 回あたりの時間')).toBe('0.500 秒');
      expect(metric(r, '時間の平均')).toBe('0.500 秒');
      expect(metric(r, '命中率')).toBe('100.0%');
      expect(metric(r, '命中数')).toBe('20 / 20');
      expect(metric(r, 'ズレの平均')).toMatch(/^0\.\d{2}°$/);
      expect(num(metric(r, 'ズレの平均'))).toBeLessThan(0.3);
      expect(r.best).toContain(BEST_UPDATED);
      expect(Object.keys(r.metrics).some((k) => k.includes('平均ズレ'))).toBe(false);
      expect(r.text).not.toContain('平均ズレ');
      expect(r.text).not.toContain('苦手な区間');
      expect(r.svgs, '散布図・照準の軌道の図').toBe(0);
      // SCO-58
      const s = await storage(page);
      expect(Object.keys(s).sort()).toEqual([FAR_SMALL_BEST, FAR_SMALL_HISTORY].sort());
      const best = JSON.parse(s[FAR_SMALL_BEST]!) as Record<string, unknown>;
      expect(Object.keys(best).sort()).toEqual(['achievedAt', 'hitRate', 'hits', 'meanError', 'meanTime', 'targets', 'timePerHit', 'version']);
      expect(best.version).toBe(1);
      expect(best.timePerHit as number).toBeCloseTo(0.5, 3);
      expect(best.meanTime as number).toBeCloseTo(0.5, 3);
      expect(best.hitRate).toBe(100);
      expect(best.hits).toBe(20);
      expect(best.targets).toBe(20);
      expect(best.meanError as number).toBeLessThan(0.3);
      expect(Number.isNaN(Date.parse(String(best.achievedAt)))).toBe(false);
      const history = JSON.parse(s[FAR_SMALL_HISTORY]!) as { version: number; entries: Record<string, unknown>[] };
      expect(history.version).toBe(1);
      const last = history.entries.at(-1)!;
      for (const f of ['timePerHit', 'meanTime', 'hitRate', 'hits', 'targets', 'meanError']) expect(last[f], f).toBe(best[f]);
      expect(Number.isNaN(Date.parse(String(last.at)))).toBe(false);
      noExceptions(page);
    });

    it('SCO-59: 自己ベスト 0.6 秒のとき 0.5 秒で更新して 0.5 になり、続けて 0.5 秒（等しい）と 0.7 秒では更新しない', { timeout: 240_000 }, async () => {
      const seed = {
        [FAR_SMALL_BEST]: JSON.stringify({ version: 1, timePerHit: 0.6, meanTime: 0.6, hitRate: 100, hits: 20, targets: 20, meanError: 0.1, achievedAt: '2026-01-01T00:00:00.000Z' }),
      };
      const page = await openFresh({ seed, render: true });
      const stored = async () => (JSON.parse((await storage(page))[FAR_SMALL_BEST] ?? 'null') as { timePerHit: number } | null)?.timePerHit;
      const run = async (time: number) => {
        const { startedAt, m } = await startFlick(page, { range: '遠い', size: '小' });
        await waitFirstTarget(page, startedAt);
        await shootTargets(page, m, startedAt + 1, allHits(time));
        await untilResult(page);
        return resultState(page);
      };
      let r = await run(0.5);
      expect(metric(r, '命中 1 回あたりの時間')).toBe('0.500 秒');
      expect(r.best).toContain(BEST_UPDATED);
      const v = await stored();
      expect(v).toBeCloseTo(0.5, 3);

      r = await run(0.5);
      expect(metric(r, '命中 1 回あたりの時間')).toBe('0.500 秒');
      expect(r.best, '等しいときは更新しない').not.toContain(BEST_UPDATED);
      expect(await stored()).toBe(v);

      r = await run(0.7);
      expect(metric(r, '命中 1 回あたりの時間')).toBe('0.700 秒');
      expect(r.best).not.toContain(BEST_UPDATED);
      expect(r.best).toContain('0.500');
      expect(await stored()).toBe(v);
      noExceptions(page);
    });

    it('SCO-60: 遠い・小の自己ベストと履歴があるとき、近い・大（と反復練習）を初めて終えると「自己ベスト更新」で、遠い・小の値は変わらない', { timeout: 240_000 }, async () => {
      const best = JSON.stringify({ version: 1, timePerHit: 0.45, meanTime: 0.45, hitRate: 100, hits: 20, targets: 20, meanError: 0.1, achievedAt: '2026-01-01T00:00:00.000Z' });
      const history = JSON.stringify({ version: 1, entries: [{ at: '2026-01-01T00:00:00.000Z', timePerHit: 0.45, meanTime: 0.45, hitRate: 100, hits: 20, targets: 20, meanError: 0.1 }] });
      const page = await openFresh({ seed: { [FAR_SMALL_BEST]: best, [FAR_SMALL_HISTORY]: history }, render: true });
      const { startedAt, m } = await startFlick(page, { range: '近い', size: '大' });
      await waitFirstTarget(page, startedAt);
      await shootTargets(page, m, startedAt + 1, firstHitOnly(0.4));
      await untilResult(page);
      const r = await resultState(page);
      expect(r.text).toMatch(/出る範囲: 近い \/ 的の大きさ: 大|出る範囲\s*近い[\s\S]*的の大きさ\s*大/);
      expect(num(metric(r, '命中数'))).toBeGreaterThanOrEqual(1);
      expect(r.best).toContain(BEST_UPDATED);
      let s = await storage(page);
      expect(s[FAR_SMALL_BEST]).toBe(best);
      expect(s[FAR_SMALL_HISTORY]).toBe(history);
      expect(s[key('best', 'mouse', 'near', 'large')]).toBeDefined();
      expect(s[key('history', 'mouse', 'near', 'large')]).toBeDefined();

      // 反復練習（L-STAR）を初めて終えたときも、遠い・小は変わらない。
      await page.evaluate(`location.hash = '#/'`);
      await page.waitFor(TOP_READY);
      await choose(page, '#mode', REPEAT);
      await choose(page, '#weapon', LSTAR);
      await page.clickSelector('[data-screen="top"] a[href="#/play"]');
      const m2: Mouse = { x: m.x, y: m.y, cx: 0, cy: 0 };
      await lock(page, m2);
      await mouseButton(page, m2, 'mousePressed');
      await page.advanceClockUntil(`location.hash === '#/result'`, { step: 1 / 60, limit: 15 });
      await mouseButton(page, m2, 'mouseReleased');
      await page.evaluate('document.pointerLockElement && document.exitPointerLock()');
      await page.waitFor(`window.__vis('[data-screen="result"]')`);
      expect((await resultState(page)).best).toContain(BEST_UPDATED);
      s = await storage(page);
      expect(s[FAR_SMALL_BEST]).toBe(best);
      expect(s[FAR_SMALL_HISTORY]).toBe(history);
      noExceptions(page);
    });
  });

  // -------------------------------------------------------------------------
  describe('履歴の画面・シェア・セットのまとめ', () => {
    it('UI-109: 履歴の画面でフリック・マウスを選ぶと武器の欄が隠れて設定の欄が出て、遠い・小と近い・大の組ごとに推移と一覧を表示する', async () => {
      const entry = (n: number, tph: number) => ({ at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), timePerHit: tph, meanTime: tph * 0.9, hitRate: 90, hits: 18, targets: 20, meanError: 0.4 });
      const far = [entry(1, 0.61), entry(2, 0.55), entry(3, 0.52)];
      const near = [entry(4, 0.41), entry(5, 0.38)];
      const page = await openFresh({
        seed: {
          [FAR_SMALL_HISTORY]: JSON.stringify({ version: 1, entries: far }),
          [key('history', 'mouse', 'near', 'large')]: JSON.stringify({ version: 1, entries: near }),
        },
      });
      await page.evaluate(`location.hash = '#/history'`);
      await page.waitFor(`window.__vis('[data-screen="history"]') && document.querySelectorAll('#history-mode option').length > 0`);
      expect(await page.evaluate<string[]>(`[...document.querySelector('#history-mode').options].map((o) => o.textContent.trim())`)).toEqual([REPEAT, '追いエイム', '追いエイム＋リコイル', FLICK]);
      await choose(page, '#history-mode', FLICK);
      await choose(page, '#history-input', 'マウス');
      await page.frames(2);
      expect(await page.evaluate<boolean>(`window.__vis('#history-weapon')`)).toBe(false);
      const state = () =>
        page.evaluate<{ headers: string[]; rows: string[][]; points: number; text: string }>(`(() => {
          const screen = document.querySelector('[data-screen="history"]');
          const table = [...screen.querySelectorAll('table')].find((t) => window.__vis(t));
          const svg = [...screen.querySelectorAll('svg')].find((s) => window.__vis(s) && s.querySelectorAll('circle').length > 0);
          return { headers: table ? [...table.querySelectorAll('thead th')].map((c) => c.textContent.trim()) : [],
            rows: table ? [...table.querySelectorAll('tbody tr')].filter((tr) => window.__vis(tr)).map((tr) => [...tr.cells].map((c) => c.textContent.trim())) : [],
            points: svg ? svg.querySelectorAll('circle').length : 0, text: screen.innerText }; })()`);
      const col = (h: { headers: string[]; rows: string[][] }, label: string) => {
        const i = h.headers.findIndex((x) => x.includes(label));
        if (i < 0) throw new Error(`一覧に ${label} の列がない: ${JSON.stringify(h.headers)}`);
        return h.rows.map((r) => r[i]!);
      };
      expect(await page.evaluate<boolean>(`!!(${settingSelect('history', '出る範囲')}) && !!(${settingSelect('history', '的の大きさ')})`)).toBe(true);

      await chooseSetting(page, 'history', '出る範囲', '遠い');
      await chooseSetting(page, 'history', '的の大きさ', '小');
      await page.frames(2);
      const f = await state();
      for (const label of ['命中 1 回あたりの時間', '時間の平均', '命中率', 'ズレの平均']) col(f, label);
      expect(col(f, '命中 1 回あたりの時間').map(num)).toEqual([0.61, 0.55, 0.52]);
      expect(f.points).toBe(3);
      expect(f.text).not.toContain('苦手な区間');

      await chooseSetting(page, 'history', '出る範囲', '近い');
      await chooseSetting(page, 'history', '的の大きさ', '大');
      await page.frames(2);
      const n = await state();
      expect(col(n, '命中 1 回あたりの時間').map(num)).toEqual([0.41, 0.38]);
      expect(n.points).toBe(2);
      noExceptions(page);
    });

    it('UI-110: 遠い・小のリザルトのシェアの文は、2 行目が「モード: フリック / 出る範囲: 遠い / 的の大きさ: 小」、3 行目が「命中 1 回あたりの時間: <値> 秒 / 命中率: <値>%」', { timeout: 240_000 }, async () => {
      const page = await openFresh({ render: true });
      const { startedAt, m } = await startFlick(page, { range: '遠い', size: '小' });
      await waitFirstTarget(page, startedAt);
      await shootTargets(page, m, startedAt + 1, firstHitOnly(0.4));
      await untilResult(page);
      const r = await resultState(page);
      await page.evaluate(`document.querySelector('#result-share').scrollIntoView({ block: 'center' })`);
      await page.clickSelector('#result-share');
      await page.waitFor('window.__shareCalls.length > 0');
      const text = (await page.evaluate<string[]>('window.__shareCalls'))[0]!;
      const lines = text.split('\n');
      expect(lines[0]).toBe('Hyper Aim Training（非公式ファンツール）の結果');
      expect(lines[1]).toBe('モード: フリック / 出る範囲: 遠い / 的の大きさ: 小');
      expect(lines[2]).toMatch(/^命中 1 回あたりの時間: \d+\.\d{3} 秒 \/ 命中率: \d+\.\d%$/);
      expect(lines[2]).toBe(`命中 1 回あたりの時間: ${metric(r, '命中 1 回あたりの時間')} / 命中率: ${metric(r, '命中率')}`);
      expect(lines.at(-1)).toBe('https://cocoiti.github.io/apex-training/');
      noExceptions(page);
    });

    it('UI-111: 3 回のセットを 0.6・0.5・0.7 秒で終えると、セットのまとめに設定と 3 回分が並び、平均 0.600 秒、いちばん良かった回が 2 回目（0.500 秒）', { timeout: 240_000 }, async () => {
      // 回数の選択肢は 1・5・10・20（screens.md「トップ画面」）で 3 はないので、回数 5 で 3 回終えたところでやめる（Q）。
      // セットのまとめの対象は最後まで終えた回だけ（screens.md「セットのまとめ」）なので、3 回分のセットのまとめになる。
      const page = await openFresh({ render: true });
      const times = [0.6, 0.5, 0.7];
      let { startedAt, m } = await startFlick(page, { count: 5 });
      for (let i = 0; i < times.length; i += 1) {
        if (i > 0) {
          await page.advanceClockUntil(`!window.__interlude() && location.hash === '#/play'`, { step: 1 / 120, limit: 10 });
          startedAt = await now(page);
          m = { ...m, cx: 0, cy: 0 };
          await lock(page, m);
        }
        await waitFirstTarget(page, startedAt);
        await shootTargets(page, m, startedAt + 1, allHits(times[i]!));
        await page.advanceClockUntil('window.__interlude()', { step: 1 / 60, limit: 15 });
        expect(await page.evaluate<string>(`document.querySelector('#interlude').innerText`)).toContain(times[i]!.toFixed(3));
      }
      await pressKey(page, 'q', 'KeyQ', 81);
      await page.evaluate('document.pointerLockElement && document.exitPointerLock()');
      await page.waitFor(`window.__vis('[data-screen="set-result"]')`);
      await page.frames(2);
      const set = await page.evaluate<{ summary: string; rounds: string[]; average: string; best: string }>(`(() => ({
        summary: document.querySelector('[data-screen="set-result"]').innerText,
        rounds: [...document.querySelectorAll('#set-rounds li')].filter((e) => window.__vis(e)).map((e) => e.textContent.trim()),
        average: document.querySelector('#set-average')?.textContent.trim() ?? '',
        best: document.querySelector('#set-best')?.textContent.trim() ?? '' }))()`);
      expect(set.summary).toMatch(/出る範囲: ふつう \/ 的の大きさ: 中|出る範囲\s*ふつう[\s\S]*的の大きさ\s*中/);
      expect(set.rounds).toHaveLength(3);
      set.rounds.forEach((t, i) => expect(t).toContain(`${times[i]!.toFixed(3)} 秒`));
      expect(set.average).toContain('0.600 秒');
      expect(set.best).toMatch(/2\s*回目/);
      expect(set.best).toContain('0.500 秒');
      noExceptions(page);
    });
  });
});
