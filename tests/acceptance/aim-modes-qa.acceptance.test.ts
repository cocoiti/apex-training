// docs/spec/modes.md（MODE-32〜MODE-35）、docs/spec/scoring.md（SCO-40〜SCO-44）、docs/spec/screens.md（UI-96・UI-97・UI-99・UI-100）の
// エイムのモードの受け入れテスト。QA が SPEC だけから書いたもの。
// 公開された入口（ビルドの結果を /apex-training/ で配信した画面、練習モードの共通の型、SPEC に書かれた localStorage のキーと値の形）だけを使う。
// リポジトリの写しの src/modes/aim/ にエイムのモードのファイルを 2 つ足してビルドし、その画面で確かめる。
//   - QA 武器エイム（qa-weapon）: 武器を使う。制限時間 3 秒。並び順は反復練習より前。採点は弾痕のズレの採点（scoring を持たない）。
//   - QA タップ（qa-tap）: 武器を使わない。制限時間 10 秒。並び順は反復練習より後。正面 5 メートルに大きな練習の的を 1 つ置き、
//     比べる指標は「大きいほど良い」命中数（練習の的に当たった弾の数）。fire の押し始めごとに 1 発なので、押した回数が命中数になる。
// SCO-43 は、足す前のビルド（リポジトリそのまま）と足したビルドで同じ練習をして比べる。
// 画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、3D は描画せず（render=off）、ページの時計はテストから進める（clock=manual）。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const CX = 640;
const CY = 400;
const chromium = findChromium();
const APP = { render: false, manualClock: true };

/** SPEC の値と文言（実装の定数には依存しない）。 */
const REPEAT = '反復練習';
const REPEAT_ID = 'ghost';
const WEAPON_MODE = 'QA 武器エイム';
const TAP_MODE = 'QA タップ';
const TAP_ID = 'qa-tap';
const PREVIEW = 'パターンの音を聞く';
const BEST_UPDATED = '自己ベスト更新';
const LSTAR = { id: 'lstar', name: 'L-STAR', magSize: 28 };
const CAR = { id: 'car', name: 'C.A.R. SMG', magSize: 30 };
const tapBestKey = `apex-training:best:mouse:-:${TAP_ID}`;
const tapHistoryKey = `apex-training:history:mouse:-:${TAP_ID}`;

/** パッドの標準配置のボタン番号。 */
const UP = 12;
const DOWN = 13;
const RIGHT = 15;

// ---------------------------------------------------------------------------
// 足すモードのファイル（共通の型 TrainingMode を default で export する）
// ---------------------------------------------------------------------------

const WEAPON_AIM_MODE = `import type { TrainingMode } from '../types';

const mode: TrainingMode = {
  id: 'qa-weapon',
  name: ${JSON.stringify(WEAPON_MODE)},
  category: 'aim',
  order: -100000,
  usesWeapon: true,
  timeLimit: 3,
  setup(context) {
    context.targets.add({ id: 'qa-mover', size: { x: 1, y: 1, z: 0.2 }, position: (t) => ({ x: Math.sin(t), y: 1.6, z: -8 }) });
  },
  step() {
    return true;
  },
  result() {
    return {};
  },
  teardown() {},
};

export default mode;
`;

const TAP_AIM_MODE = `import type { TrainingMode } from '../types';

const mode: TrainingMode = {
  id: ${JSON.stringify(TAP_ID)},
  name: ${JSON.stringify(TAP_MODE)},
  category: 'aim',
  order: 100000,
  usesWeapon: false,
  timeLimit: 10,
  scoring: {
    compare: {
      id: 'hits',
      label: '命中数',
      unit: '',
      better: 'higher',
      format: (value) => String(value),
      valid: (value) => Number.isInteger(value) && value >= 0,
    },
    columns: [{ id: 'shots', label: '撃った弾数', unit: '', format: (value) => String(value) }],
    score({ shots }) {
      const hits = shots.filter((s) => s.target !== undefined).length;
      return {
        value: hits,
        metrics: [
          { label: '命中数', value: String(hits) },
          { label: '撃った弾数', value: String(shots.length) },
        ],
        fields: { shots: shots.length },
      };
    },
  },
  setup(context) {
    context.targets.add({ id: 'qa-board', size: { x: 3, y: 3, z: 0.2 }, position: { x: 0, y: 1.6, z: -5 } });
  },
  step() {
    return true;
  },
  result() {
    return {};
  },
  teardown() {},
};

export default mode;
`;

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
  window.__focused = () => { const els = [...document.querySelectorAll('.pad-focus')]; return els.length === 1 ? (els[0].id || els[0].textContent.trim()) : ''; };
  window.__resultAt = undefined;
  addEventListener('hashchange', () => { if (location.hash === '#/result' && window.__apexTestClock) window.__resultAt = window.__apexTestClock.now(); });
  window.__shareCalls = [];
  Object.defineProperty(Navigator.prototype, 'share', { value: function (data) { window.__shareCalls.push(data?.text); return Promise.resolve(); }, configurable: true, writable: true });
  Object.defineProperty(Navigator.prototype, 'canShare', { value: () => true, configurable: true, writable: true });
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
}

const TOP_READY = `window.__vis('[data-screen="top"]') && document.querySelector('#weapon').options.length > 0 && document.querySelector('#mode').options.length > 0 && document.querySelector('#count').options.length > 0`;

async function openTop(page: Page) {
  await page.evaluate(`location.hash = '#/'`);
  await page.waitFor(TOP_READY);
}

/** トップ画面の見えている状態。 */
const topState = (page: Page) =>
  page.evaluate<{ modeVisible: boolean; modes: string[]; mode: string; weaponVisible: boolean; weapon: string; previewVisible: boolean }>(`(() => {
    const mode = document.querySelector('#mode'); const weapon = document.querySelector('#weapon');
    const preview = [...document.querySelectorAll('[data-screen="top"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(PREVIEW)});
    return { modeVisible: window.__vis(mode), modes: [...mode.options].map((o) => o.textContent.trim()), mode: mode.selectedOptions[0]?.textContent.trim() ?? '',
      weaponVisible: window.__vis(weapon), weapon: weapon.selectedOptions[0]?.textContent.trim() ?? '', previewVisible: !!preview && window.__vis(preview) }; })()`);

/** HUD の見えている文字（見えていない欄は空文字）。 */
const hud = (page: Page, key: string) =>
  page.evaluate<string>(`(() => { const el = document.querySelector('[data-hud="${key}"]'); return el && window.__vis(el) ? el.textContent.trim() : ''; })()`);

const mouseButton = (page: Page, type: 'mousePressed' | 'mouseReleased') =>
  page.send('Input.dispatchMouseEvent', { type, x: CX, y: CY, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });

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

/** トップ画面でモード（と武器・回数）を選び「開始」を押して、プレイ画面でポインターロックを掛ける。開始したときのページの時計を返す。 */
async function start(page: Page, opts: { mode: string; weapon?: string; count?: number }): Promise<number> {
  await openTop(page);
  if (opts.weapon) await choose(page, '#weapon', opts.weapon);
  await choose(page, '#mode', opts.mode);
  await choose(page, '#count', opts.count ?? 1);
  await page.clickSelector('[data-screen="top"] a[href="#/play"]');
  await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]')`);
  const startedAt = await page.evaluate<number>('window.__clockNow()');
  await lock(page);
  return startedAt;
}

/** 左ボタンを n 回押し直す（押して 0.05 秒、離して 0.05 秒。ページの時計で進める）。 */
async function taps(page: Page, n: number) {
  for (let i = 0; i < n; i += 1) {
    await mouseButton(page, 'mousePressed');
    await page.advanceClock(0.05);
    await mouseButton(page, 'mouseReleased');
    await page.advanceClock(0.05);
  }
}

/** ページの時計を進めてリザルト画面が表示されるまで待つ。 */
async function untilResult(page: Page) {
  await page.advanceClockUntil(`location.hash === '#/result'`, { step: 1 / 60, limit: 15 });
  await page.evaluate('document.exitPointerLock()');
  await page.waitFor(`window.__vis('[data-screen="result"]')`);
  await page.frames(2);
}

/** QA タップを 1 回（n 回撃って制限時間まで待つ）練習し、リザルト画面を表示する。 */
async function tapPractice(page: Page, n: number) {
  await start(page, { mode: TAP_MODE });
  await taps(page, n);
  await untilResult(page);
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
const metric = (r: { metrics: Record<string, string> }, label: string) => {
  const key = Object.keys(r.metrics).find((k) => k.includes(label));
  if (!key) throw new Error(`${label} がない: ${JSON.stringify(r.metrics)}`);
  return r.metrics[key]!;
};
const num = (s: string) => {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) throw new Error(`数がない: ${s}`);
  return Number(m[0]);
};

const storage = (page: Page) =>
  page.evaluate<Record<string, string>>(`(() => { const out = {}; for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i);
    if (k.startsWith('apex-training:best:') || k.startsWith('apex-training:history:')) out[k] = localStorage.getItem(k); } return out; })()`);

// 履歴の画面 -------------------------------------------------------------

interface HistoryState {
  text: string;
  weaponVisible: boolean;
  headers: string[];
  rows: string[][];
  averages: Record<string, string>;
  points: { x: number; y: number }[];
  /** 「1〜5」のような発の番号の範囲の札（発の区間ごとのズレの図）。 */
  sectionLabels: string[];
}
const historyState = (page: Page) =>
  page.evaluate<HistoryState>(`(() => {
    const screen = document.querySelector('[data-screen="history"]');
    const table = [...screen.querySelectorAll('table')].find((t) => window.__vis(t));
    const averages = {};
    for (const dt of screen.querySelectorAll('dt')) { if (!window.__vis(dt)) continue; const dd = dt.nextElementSibling; if (dd && dd.tagName === 'DD') averages[dt.textContent.trim()] = dd.textContent.trim(); }
    const svg = [...screen.querySelectorAll('svg')].find((s) => window.__vis(s) && s.querySelectorAll('circle').length > 0);
    const points = svg ? [...svg.querySelectorAll('circle')].map((c) => { const p = new DOMPoint(c.cx.baseVal.value, c.cy.baseVal.value).matrixTransform(c.getScreenCTM()); return { x: p.x, y: p.y }; }) : [];
    const sectionLabels = [...screen.querySelectorAll('*')].filter((e) => window.__vis(e) && /^\\d+\\s*〜\\s*\\d+$/.test((e.textContent ?? '').trim())
      && ![...e.children].some((c) => (c.textContent ?? '').trim() === (e.textContent ?? '').trim())).map((e) => e.textContent.trim());
    return { text: screen.innerText, weaponVisible: window.__vis('#history-weapon'),
      headers: table ? [...table.querySelectorAll('thead th')].map((c) => c.textContent.trim()) : [],
      rows: table ? [...table.querySelectorAll('tbody tr')].filter((tr) => window.__vis(tr)).map((tr) => [...tr.cells].map((c) => c.textContent.trim())) : [],
      averages, points, sectionLabels }; })()`);
const column = (h: HistoryState, label: string) => {
  const i = h.headers.findIndex((x) => x.includes(label));
  if (i < 0) throw new Error(`一覧に ${label} の列がない: ${JSON.stringify(h.headers)}`);
  return h.rows.map((r) => r[i]!);
};

async function openHistory(page: Page) {
  await page.evaluate(`location.hash = '#/history'`);
  await page.waitFor(`window.__vis('[data-screen="history"]') && document.querySelectorAll('#history-mode option').length > 0`);
  await page.frames(2);
}
async function chooseHistory(page: Page, selector: string, label: string) {
  await choose(page, selector, label);
  await page.frames(2);
}

/** 反復練習の発の区間（L-STAR の 28 発）。 */
const sections = () => {
  const out = [];
  for (let s = 1; s <= 28; s += 5) out.push({ start: s, shots: Math.min(5, 28 - s + 1), meanH: 0.1, meanV: 0.1, meanError: 0.5 });
  return out;
};
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();

// パッド ----------------------------------------------------------------

const btn = (page: Page, b: number, on: boolean) => page.evaluate(`window.__btn(${b}, ${on})`);
async function padTap(page: Page, b: number) {
  await btn(page, b, true);
  await page.frames(3);
  await btn(page, b, false);
  await page.frames(3);
}

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('QA: エイムのモード（src/modes/aim/ にモードを足したビルド）', () => {
  const temps: string[] = [];
  let site = '';
  let mainDist = '';
  let aimDist = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));
  const noExceptions = (page: Page) => expect(exceptions(page), page.errors.join('\n')).toEqual([]);

  /** 配信する中身を切り替える（site はビルドの結果へのシンボリックリンク）。 */
  const serveDist = (dir: string) => {
    if (existsSync(site)) unlinkSync(site);
    symlinkSync(dir, site, 'dir');
  };

  /** 新しいタブで localStorage を空にし（seed を入れ）、読み込み直したトップ画面を開く。 */
  async function openFresh(opts: { seed?: Record<string, string>; pad?: boolean } = {}): Promise<Page> {
    const page = await browser!.newPage();
    await page.goto(appUrl(origin, BASE, '#/', APP));
    await page.evaluate(`(() => { localStorage.clear(); const seed = ${JSON.stringify(opts.seed ?? {})}; for (const k in seed) localStorage.setItem(k, seed[k]); })()`);
    await page.addInitScript(PAGE_INIT);
    if (opts.pad) await page.addInitScript(FAKE_PAD);
    await page.evaluate(`location.hash = '#/'; window.__beforeReload = true`);
    await page.send('Page.reload', { ignoreCache: false });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && ${TOP_READY}`, 15_000);
    return page;
  }

  beforeAll(async () => {
    const work = mkdtempSync(join(tmpdir(), 'aim-modes-qa-'));
    temps.push(work);
    const env = { ...process.env, APEX_ACCEPTANCE_NESTED: '1', FORCE_COLOR: '0' };
    mainDist = join(work, 'main-dist');
    const main = spawnSync(`npm run build -- --outDir "${mainDist}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8', env });
    if (main.status !== 0) throw new Error(`ビルドが失敗した:\n${main.stdout}${main.stderr}`);

    const copy = join(work, 'copy');
    for (const entry of ['src', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'eslint.config.js', 'scripts']) {
      if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
    }
    symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), 'dir');
    mkdirSync(join(copy, 'src/modes/aim'), { recursive: true });
    writeFileSync(join(copy, 'src/modes/aim/qa-weapon.ts'), WEAPON_AIM_MODE);
    writeFileSync(join(copy, 'src/modes/aim/qa-tap.ts'), TAP_AIM_MODE);
    aimDist = join(work, 'aim-dist');
    const aim = spawnSync(`npm run build -- --outDir "${aimDist}" --emptyOutDir`, { cwd: copy, shell: true, encoding: 'utf8', env });
    if (aim.status !== 0) throw new Error(`エイムのモードを足したビルドが失敗した:\n${aim.stdout}${aim.stderr}`);

    site = join(work, 'site');
    serveDist(aimDist);
    server = await serveStatic(site, BASE);
    origin = originOf(server);
    browser = await launchBrowser(chromium!);
  }, 300_000);

  afterEach(async () => {
    await browser?.closePages();
    serveDist(aimDist);
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((ok) => (server ? server.close(ok) : ok(undefined)));
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  describe('トップ画面とプレイ画面', () => {
    it('MODE-32: モードの選択欄が出て並び順の順に並び、武器を使うエイムのモードを選んで開始すると選んだ武器で始まり、HUD に武器名と残弾が出る', async () => {
      const page = await openFresh();
      const top = await topState(page);
      expect(top.modeVisible).toBe(true);
      expect(top.modes).toEqual([WEAPON_MODE, REPEAT, TAP_MODE]);
      await start(page, { mode: WEAPON_MODE, weapon: CAR.name });
      expect(await hud(page, 'weapon')).toContain(CAR.name);
      expect(num(await hud(page, 'ammo'))).toBe(CAR.magSize);
      noExceptions(page);
    });

    it('MODE-33: 武器を使わないモードを選ぶと武器の選択欄と「パターンの音を聞く」が出ず、開始すると HUD に武器名と残弾が出ず、反復練習に戻すと前の武器が選ばれている', async () => {
      const page = await openFresh();
      await choose(page, '#weapon', CAR.name);
      await choose(page, '#mode', REPEAT);
      const before = await topState(page);
      expect(before.weaponVisible).toBe(true);
      expect(before.previewVisible).toBe(true);
      await choose(page, '#mode', TAP_MODE);
      await page.frames(2);
      const hidden = await topState(page);
      expect(hidden.weaponVisible).toBe(false);
      expect(hidden.previewVisible).toBe(false);

      await page.clickSelector('[data-screen="top"] a[href="#/play"]');
      await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]')`);
      await page.advanceClock(0.5);
      expect(await hud(page, 'weapon')).toBe('');
      expect(await hud(page, 'ammo')).toBe('');
      expect(await hud(page, 'time')).not.toBe('');

      await openTop(page);
      await choose(page, '#mode', REPEAT);
      await page.frames(2);
      const back = await topState(page);
      expect(back.weaponVisible).toBe(true);
      expect(back.previewVisible).toBe(true);
      expect(back.weapon).toBe(CAR.name);
      noExceptions(page);
    });

    it('MODE-34: 制限時間 10 秒の武器を使わないモードでは、1 発撃って離し 2 秒以上たってもプレイ画面のままで、開始から 10 秒でリザルト画面に移る', async () => {
      const page = await openFresh();
      const startedAt = await start(page, { mode: TAP_MODE });
      await taps(page, 1);
      await page.advanceClock(2.5);
      expect(await page.evaluate<string>('location.hash')).toBe('#/play');
      await page.advanceClock(4);
      expect(await page.evaluate<string>('location.hash')).toBe('#/play');
      await untilResult(page);
      const resultAt = await page.evaluate<number>('window.__resultAt');
      expect(resultAt - startedAt).toBeGreaterThan(9.9);
      expect(resultAt - startedAt).toBeLessThan(10.2);
      noExceptions(page);
    });

    it('MODE-35: 制限時間 3 秒の武器を使うモードでは、撃ち切る前に 3 秒たつと残弾が残ったままリザルト画面に移る', async () => {
      const page = await openFresh();
      const startedAt = await start(page, { mode: WEAPON_MODE, weapon: LSTAR.name });
      // 撃たない時間（2 秒）で終わらないよう、1 秒ごとに短く撃つ。
      for (let i = 0; i < 3; i += 1) {
        await taps(page, 1);
        if (i < 2) await page.advanceClock(0.9);
      }
      const left = num(await hud(page, 'ammo'));
      expect(left).toBeGreaterThan(0);
      expect(left).toBeLessThan(LSTAR.magSize);
      await untilResult(page);
      const resultAt = await page.evaluate<number>('window.__resultAt');
      expect(resultAt - startedAt).toBeGreaterThan(2.9);
      expect(resultAt - startedAt).toBeLessThan(3.2);
      // 移ったときの残弾（HUD に最後に出ていた値）が残っている。
      expect(await page.evaluate<number>('window.__ammo()')).toBe(left);
      noExceptions(page);
    });

    it('UI-99: パッドの十字キーでモードに武器を使わないモードを選ぶと、そのあと上下に動かしても武器の選択欄と「パターンの音を聞く」にフォーカスが移らない', async () => {
      const page = await openFresh({ pad: true });
      const seen: string[] = [];
      for (let i = 0; i < 12 && (await page.evaluate<string>('window.__focused()')) !== 'mode'; i += 1) {
        await padTap(page, DOWN);
        seen.push(await page.evaluate<string>('window.__focused()'));
      }
      expect(await page.evaluate<string>('window.__focused()'), seen.join(' → ')).toBe('mode');
      // 武器を使うモード（最初に選ばれている QA 武器エイム）のあいだは、武器の選択欄にフォーカスが移る（比べ）。
      expect(seen, seen.join(' → ')).toContain('weapon');
      for (let i = 0; i < 6 && (await topState(page)).mode !== TAP_MODE; i += 1) await padTap(page, RIGHT);
      expect((await topState(page)).mode).toBe(TAP_MODE);
      const after: string[] = [];
      for (let i = 0; i < 8; i += 1) {
        await padTap(page, UP);
        after.push(await page.evaluate<string>('window.__focused()'));
      }
      for (let i = 0; i < 12; i += 1) {
        await padTap(page, DOWN);
        after.push(await page.evaluate<string>('window.__focused()'));
      }
      expect(after.filter((f) => f === 'weapon' || f === 'preview-sound' || f === PREVIEW), after.join(' → ')).toEqual([]);
      expect(after).toContain('mode');
      // 左右でモードを戻していないこと（選んだままである）。
      expect((await topState(page)).mode).toBe(TAP_MODE);
      noExceptions(page);
    });
  });

  // -------------------------------------------------------------------------
  describe('採点・自己ベスト・履歴', () => {
    it('SCO-40: 命中数の自己ベスト 12 のとき 13 で終えると「自己ベスト更新」で 13 になり、そのあと 13 と 11 では更新しない', async () => {
      const seed = { [tapBestKey]: JSON.stringify({ version: 1, achievedAt: '2026-01-01T00:00:00.000Z', hits: 12, shots: 12 }) };
      const page = await openFresh({ seed });
      const stored = async () => JSON.parse((await storage(page))[tapBestKey] ?? 'null') as { hits: number } | null;

      await tapPractice(page, 13);
      let r = await resultState(page);
      expect(num(metric(r, '命中数'))).toBe(13);
      expect(r.best).toContain(BEST_UPDATED);
      expect((await stored())?.hits).toBe(13);

      for (const n of [13, 11]) {
        await tapPractice(page, n);
        r = await resultState(page);
        expect(num(metric(r, '命中数')), `${n} 回撃った回`).toBe(n);
        expect(r.best, `${n} の回`).not.toContain(BEST_UPDATED);
        expect(r.best, `${n} の回`).toContain('13');
        expect((await stored())?.hits).toBe(13);
      }
      noExceptions(page);
    });

    it('SCO-41: 弾痕のズレの採点と苦手な区間を使わないモードのリザルト画面には、そのモードの指標と自己ベストが出て、平均ズレ・グルーピング半径・散布図・軌道・苦手な区間は出ない', async () => {
      const page = await openFresh();
      await tapPractice(page, 4);
      const r = await resultState(page);
      expect(num(metric(r, '命中数'))).toBe(4);
      expect(num(metric(r, '撃った弾数'))).toBe(4);
      expect(r.best).toContain('自己ベスト');
      for (const label of ['平均ズレ', 'グルーピング半径', '命中率']) expect(Object.keys(r.metrics).some((k) => k.includes(label)), label).toBe(false);
      expect(r.text).not.toContain('平均ズレ');
      expect(r.text).not.toContain('グルーピング半径');
      expect(r.text).not.toContain('苦手な区間');
      expect(r.svgs, '散布図・照準の軌道の図').toBe(0);

      // 2 回目（更新しない回）には、保存してある自己ベストの命中数が出る。
      await tapPractice(page, 2);
      const r2 = await resultState(page);
      expect(r2.best).toContain('4');
      expect(r2.best).not.toContain(BEST_UPDATED);
      expect(r2.svgs).toBe(0);
      noExceptions(page);
    });

    it('SCO-42: 武器を使わないモードをマウスで練習すると、自己ベストと履歴が武器の id の代わりに - のキーに保存され、どちらにも version 1 と比べる指標の値が入る', async () => {
      const page = await openFresh();
      await tapPractice(page, 3);
      const s = await storage(page);
      expect(Object.keys(s).sort()).toEqual([tapBestKey, tapHistoryKey].sort());
      const best = JSON.parse(s[tapBestKey]!) as Record<string, unknown>;
      expect(best.version).toBe(1);
      expect(best.hits).toBe(3);
      expect(typeof best.achievedAt).toBe('string');
      const history = JSON.parse(s[tapHistoryKey]!) as { version: number; entries: Record<string, unknown>[] };
      expect(history.version).toBe(1);
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]!.hits).toBe(3);
      expect(Number.isNaN(Date.parse(String(history.entries[0]!.at)))).toBe(false);
      noExceptions(page);
    });

    it('SCO-43: エイムのモードを足したビルドで L-STAR と反復練習を終えたとき、best と history の ghost のキーの項目とリザルト画面の表示が足す前と同じ', async () => {
      const practiceRepeat = async () => {
        const page = await openFresh();
        await start(page, { mode: REPEAT, weapon: LSTAR.name });
        await mouseButton(page, 'mousePressed');
        await page.advanceClockUntil(`location.hash === '#/result'`, { step: 1 / 60, limit: 15 });
        await mouseButton(page, 'mouseReleased');
        await page.evaluate('document.exitPointerLock()');
        await page.waitFor(`window.__vis('[data-screen="result"]')`);
        await page.frames(2);
        const r = await resultState(page);
        const s = await storage(page);
        noExceptions(page);
        return { r, s };
      };
      const bestKey = `apex-training:best:mouse:${LSTAR.id}:${REPEAT_ID}`;
      const historyKey = `apex-training:history:mouse:${LSTAR.id}:${REPEAT_ID}`;
      const shape = (x: { r: ResultState; s: Record<string, string> }) => {
        const best = JSON.parse(x.s[bestKey] ?? 'null') as Record<string, unknown> | null;
        const history = JSON.parse(x.s[historyKey] ?? 'null') as { entries: Record<string, unknown>[] } | null;
        return {
          keys: Object.keys(x.s).sort(),
          best: best ? Object.keys(best).sort() : null,
          entry: history ? Object.keys(history.entries[0] ?? {}).sort() : null,
          labels: Object.keys(x.r.metrics),
          best_line: x.r.best.replace(/[\d.]+/g, '#'),
          svgs: x.r.svgs,
          text: x.r.text.replace(/-?\d+(?:\.\d+)?/g, '#'),
        };
      };

      serveDist(mainDist);
      const before = shape(await practiceRepeat());
      await browser!.closePages();
      serveDist(aimDist);
      const after = shape(await practiceRepeat());

      expect(before.best).toEqual(['achievedAt', 'groupingRadius', 'hitRate', 'meanError', 'shots', 'version']);
      expect(before.entry).toEqual(['at', 'groupingRadius', 'hitRate', 'meanError', 'sections', 'shots']);
      expect(after).toEqual(before);
    });

    it('SCO-44: 履歴に比べる指標の項目が数でない件が混ざっているとき、その件だけが読み飛ばされ、ほかの件は推移・平均・一覧に使われる', async () => {
      const entries = [
        { at: at(1), hits: 4, shots: 4 },
        { at: at(2), hits: '9', shots: 9 },
        { at: at(3), hits: 8, shots: 8 },
        { at: at(4), hits: null, shots: 1 },
        { at: at(5), hits: 6, shots: 6 },
      ];
      const page = await openFresh({ seed: { [tapHistoryKey]: JSON.stringify({ version: 1, entries }) } });
      await openHistory(page);
      await chooseHistory(page, '#history-mode', TAP_MODE);
      await chooseHistory(page, '#history-input', 'マウス');
      const h = await historyState(page);
      expect(h.rows).toHaveLength(3);
      expect(column(h, '命中数').map(num)).toEqual([4, 8, 6]);
      expect(h.points).toHaveLength(3);
      const overall = Object.entries(h.averages).find(([k]) => k.includes('全体'));
      expect(overall, JSON.stringify(h.averages)).toBeDefined();
      expect(num(overall![1])).toBeCloseTo(6, 5);
      // 保存は消さない（読み飛ばすだけ）。
      const s = await storage(page);
      expect((JSON.parse(s[tapHistoryKey]!) as { entries: unknown[] }).entries).toHaveLength(5);
      noExceptions(page);
    });
  });

  // -------------------------------------------------------------------------
  describe('履歴の画面・セットのまとめ・シェア', () => {
    it('UI-96: 武器を使わないモードの履歴の画面には武器の選択欄が出ず、グラフと一覧がそのモードの比べる指標になり、発の区間の図と苦手な区間が出ない。反復練習に選び直すと戻る', async () => {
      const repeatEntries = [1, 2, 3, 4, 5].map((n) => ({ at: at(n), meanError: 1 + n / 10, hitRate: 50, groupingRadius: 1, shots: 28, sections: sections() }));
      const page = await openFresh({ seed: { [`apex-training:history:mouse:${LSTAR.id}:${REPEAT_ID}`]: JSON.stringify({ version: 1, entries: repeatEntries }) } });
      await tapPractice(page, 5);
      await tapPractice(page, 2);
      await openHistory(page);
      await chooseHistory(page, '#history-mode', TAP_MODE);
      await chooseHistory(page, '#history-input', 'マウス');
      const aim = await historyState(page);
      expect(aim.weaponVisible).toBe(false);
      expect(aim.headers.some((x) => x.includes('命中数')), JSON.stringify(aim.headers)).toBe(true);
      expect(aim.headers.some((x) => x.includes('平均ズレ'))).toBe(false);
      expect(column(aim, '命中数').map(num)).toEqual([5, 2]);
      // 縦軸は命中数: 点は 2 つで、命中数の大きい 1 回目の点が 2 回目の点より上にある。
      expect(aim.points).toHaveLength(2);
      expect(aim.points[0]!.y).toBeLessThan(aim.points[1]!.y);
      expect(aim.points[0]!.x).toBeLessThan(aim.points[1]!.x);
      expect(aim.text).not.toContain('苦手な区間');
      expect(aim.text).not.toContain('°');
      expect(aim.sectionLabels).toEqual([]);

      await chooseHistory(page, '#history-mode', REPEAT);
      await page.waitFor(`window.__vis('#history-weapon')`);
      await chooseHistory(page, '#history-weapon', LSTAR.name);
      await chooseHistory(page, '#history-input', 'マウス');
      const repeat = await historyState(page);
      expect(repeat.weaponVisible).toBe(true);
      expect(repeat.headers.some((x) => x.includes('平均ズレ'))).toBe(true);
      expect(repeat.rows).toHaveLength(5);
      expect(repeat.text).toContain('苦手な区間');
      expect(repeat.sectionLabels.length).toBeGreaterThan(0);
      expect(repeat.sectionLabels[0]!.replace(/\s+/g, '')).toBe('1〜5');
      noExceptions(page);
    });

    it('UI-97: 命中数のモードで 3 回分のセットを 10・14・12 で終えると、セットのまとめに 3 回分が並び、セットの平均 12、いちばん良かった回 2 回目（14）と出る', async () => {
      // 回数の選択肢は 1・5・10・20（screens.md「トップ画面」）で 3 はないので、回数 5 で 3 回終えたところでやめる（Q）。
      // セットのまとめの対象は最後まで終えた回だけ（screens.md「セットのまとめ」）なので、3 回分のセットのまとめになる。
      const page = await openFresh();
      await start(page, { mode: TAP_MODE, count: 5 });
      const hits = [10, 14, 12];
      for (let i = 0; i < hits.length; i += 1) {
        await lock(page);
        await taps(page, hits[i]!);
        await page.advanceClockUntil('window.__interlude()', { step: 1 / 60, limit: 15 });
        await page.frames(2);
        if (i < hits.length - 1) {
          // 次の回は短いリザルトの 3 秒のあとに自動で始まる。
          await page.advanceClockUntil(`!window.__interlude() && location.hash === '#/play'`, { step: 1 / 60, limit: 10 });
        }
      }
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, nativeVirtualKeyCode: 81, text: 'q' });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, nativeVirtualKeyCode: 81 });
      await page.evaluate('document.exitPointerLock()');
      await page.waitFor(`window.__vis('[data-screen="set-result"]')`);
      await page.frames(2);
      const set = await page.evaluate<{ rounds: string[]; average: string; best: string }>(`(() => ({
        rounds: [...document.querySelectorAll('[data-screen="set-result"] li')].filter((e) => window.__vis(e)).map((e) => e.textContent.trim()),
        average: document.querySelector('#set-average')?.textContent.trim() ?? '',
        best: document.querySelector('#set-best')?.textContent.trim() ?? '' }))()`);
      expect(set.rounds).toHaveLength(3);
      set.rounds.forEach((text, i) => expect((text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number), text).toContain(hits[i]));
      expect(set.average).toMatch(/(^|[^\d.])12([^\d.]|$)/);
      expect(set.average).not.toMatch(/12\.\d*[1-9]/);
      expect(set.best).toMatch(/2\s*回目/);
      expect(set.best).toContain('14');
      noExceptions(page);
    });

    it('UI-100: 武器を使わないモードのリザルト画面のシェアの文は、2 行目が「モード: <名前>」だけで、3 行目がそのモードの比べる指標になる', async () => {
      const page = await openFresh();
      await tapPractice(page, 3);
      const box = await page.evaluate<{ x: number; y: number } | null>(`(() => {
        const el = [...document.querySelectorAll('[data-screen="result"] button')].find((b) => b.textContent.trim() === '結果をシェア' && window.__vis(b));
        if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      expect(box).not.toBeNull();
      await page.click(box!.x, box!.y);
      await page.waitFor('window.__shareCalls.length > 0');
      const text = (await page.evaluate<string[]>('window.__shareCalls'))[0]!;
      const lines = text.split('\n');
      expect(lines[0]).toBe('リコイル練習（非公式ファンツール）の結果');
      expect(lines[1]).toBe(`モード: ${TAP_MODE}`);
      expect(lines[2]).toMatch(/^命中数[:：]\s*3$/);
      expect(text).not.toContain('武器');
      expect(text).not.toContain('平均ズレ');
      expect(lines.at(-1)).toBe('https://cocoiti.github.io/apex-training/');
      noExceptions(page);
    });
  });
});
