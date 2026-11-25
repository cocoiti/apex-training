// docs/spec/scoring.md の「練習の履歴」の受け入れテスト（SCO-23〜SCO-30）と、
// docs/spec/screens.md の「履歴の画面」の受け入れテスト（UI-24〜UI-30）。
// 公開された入口（ビルドの結果を /apex-training/ で配信した画面、武器の JSON、SPEC に書かれた localStorage のキーと値の形）だけを使い、
// 実装の内部には依存しない。画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、マウス（ポインターロック + 左ボタン）で撃つ。
// 履歴の画面は、選択（武器・モード・入力方式の select）、平均の dt / dd、推移のグラフ（svg の circle を画面上の位置で読む）、
// 一覧（表の行）、「この履歴を消す」のボタン、「まだ履歴がありません」の表示を、見えている内容として読む。
// 消す前の確認は window.confirm を差し替えて答える（confirm を使わない作りなら、見えているダイアログのボタンを押す）。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, waitUntil, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const CX = 640;
const CY = 400;
const chromium = findChromium();
/** 3D は描画せず（render=off）、ページの時計はテストから進める（clock=manual）。撃ち切るまでを実時間で待たない。 */
const APP = { render: false, manualClock: true };

/** SPEC の文言と値（実装の定数には依存しない）。 */
const HISTORY_NOTICE = 'この環境では履歴を保存できません。ページを開いているあいだの練習だけが表示されます。';
const EMPTY = 'まだ履歴がありません';
const CLEAR = 'この履歴を消す';
const HISTORY_PREFIX = 'apex-training:history:';
const BEST_PREFIX = 'apex-training:best:';
const historyKey = (input: string, weapon: string, mode: string) => `${HISTORY_PREFIX}${input}:${weapon}:${mode}`;
const bestKey = (input: string, weapon: string, mode: string) => `${BEST_PREFIX}${input}:${weapon}:${mode}`;
const ALWAYS_THROW = `Storage.prototype.setItem = function () { throw new DOMException('quota', 'QuotaExceededError'); };`;

interface WeaponJson {
  id: string;
  name: string;
  magSize: number;
}
const WEAPONS: WeaponJson[] = readdirSync(join(ROOT, 'src/data/weapons'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(ROOT, 'src/data/weapons', f), 'utf8')) as WeaponJson);
const byId = (id: string) => {
  const w = WEAPONS.find((x) => x.id === id);
  if (!w) throw new Error(`武器がない: ${id}`);
  return w;
};
const LSTAR = byId('lstar');

interface Entry {
  at: string;
  meanError: number;
  hitRate: number;
  groupingRadius: number;
  shots: number;
}
interface Stored {
  version: number;
  entries: Entry[];
}
const entry = (meanError: number, at = '2026-01-01T00:00:00.000Z'): Entry => ({ at, meanError, hitRate: 50, groupingRadius: 1, shots: 28 });
const stored = (entries: Entry[]) => JSON.stringify({ version: 1, entries });

/** 「1.23°」「100.0%」などから数を取り出す。「なし」なら null。 */
const num = (s: string | undefined): number | null => {
  if (s === undefined) throw new Error('値がない');
  if (s.trim() === 'なし') return null;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) throw new Error(`数がない: ${s}`);
  return Number(m[0]);
};

// ---------------------------------------------------------------------------
// リザルト画面の読み取り
// ---------------------------------------------------------------------------

interface ResultState {
  visibleScreens: string[];
  metrics: Record<string, string>;
  footer: string;
}
const VISIBLE = `const visible = (el) => !!el && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0;`;
const resultState = (page: Page) =>
  page.evaluate<ResultState>(`(() => { ${VISIBLE}
    const screen = document.querySelector('[data-screen="result"]');
    const metrics = {};
    for (const dt of screen.querySelectorAll('dt')) { if (!visible(dt)) continue; const dd = dt.nextElementSibling; if (dd && dd.tagName === 'DD') metrics[dt.textContent.trim()] = dd.textContent.trim(); }
    return { visibleScreens: [...document.querySelectorAll('[data-screen]')].filter(visible).map((s) => s.getAttribute('data-screen')), metrics,
      footer: [...document.querySelectorAll('footer')].filter(visible).map((f) => f.innerText).join('\\n') }; })()`);
const metric = (r: { metrics: Record<string, string> }, label: string) => {
  const key = Object.keys(r.metrics).find((k) => k.includes(label));
  if (!key) throw new Error(`${label} がない: ${JSON.stringify(r.metrics)}`);
  return r.metrics[key]!;
};

// ---------------------------------------------------------------------------
// 履歴の画面の読み取り
// ---------------------------------------------------------------------------

interface HistoryState {
  hash: string;
  visibleScreens: string[];
  text: string;
  /** 見えている select ごとの選択肢の表示名と、選ばれている表示名。 */
  selects: { label: string; options: string[]; selected: string }[];
  averages: Record<string, string>;
  /** 推移のグラフの点（画面上の位置。y は下が正）。 */
  points: { x: number; y: number }[];
  /** 横軸の線の画面上の y（縦軸 0 の位置）。 */
  baseline: number | null;
  /** 一覧の行（見出しの行を除く）のセルの文字。 */
  rows: string[][];
  /** 一覧の見出し。 */
  headers: string[];
  emptyShown: boolean;
  clear: { exists: boolean; disabled: boolean };
  /** 見えている操作（a・button・input・select など）の種類と文字。 */
  controls: { tag: string; text: string; href: string | null; download: boolean; type: string | null }[];
}

const HISTORY_STATE = `(() => { ${VISIBLE}
  const screen = document.querySelector('[data-screen="history"]');
  const selects = [...screen.querySelectorAll('select')].filter(visible).map((s) => ({
    label: (s.closest('label')?.textContent ?? s.getAttribute('aria-label') ?? '').split('\\n')[0].trim(),
    options: [...s.options].map((o) => o.textContent.trim()),
    selected: s.selectedOptions[0]?.textContent.trim() ?? '' }));
  const averages = {};
  for (const dt of screen.querySelectorAll('dt')) { if (!visible(dt)) continue; const dd = dt.nextElementSibling; if (dd && dd.tagName === 'DD') averages[dt.textContent.trim()] = dd.textContent.trim(); }
  const svg = [...screen.querySelectorAll('svg')].find(visible);
  let points = []; let baseline = null;
  if (svg) {
    const toScreen = (el, x, y) => { const p = new DOMPoint(x, y).matrixTransform(el.getScreenCTM()); return { x: p.x, y: p.y }; };
    points = [...svg.querySelectorAll('circle')].map((c) => toScreen(c, c.cx.baseVal.value, c.cy.baseVal.value));
    const lines = [...svg.querySelectorAll('line')].map((l) => ({ a: toScreen(l, l.x1.baseVal.value, l.y1.baseVal.value), b: toScreen(l, l.x2.baseVal.value, l.y2.baseVal.value) }));
    const h = lines.find((l) => Math.abs(l.a.y - l.b.y) < 0.5);
    baseline = h ? h.a.y : null;
  }
  const table = [...screen.querySelectorAll('table')].find(visible);
  const rows = table ? [...table.querySelectorAll('tbody tr')].filter(visible).map((tr) => [...tr.cells].map((c) => c.textContent.trim())) : [];
  const headers = table ? [...table.querySelectorAll('thead th')].map((c) => c.textContent.trim()) : [];
  const clearEl = [...screen.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(CLEAR)});
  const controls = [...screen.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"]')].filter(visible).map((e) => ({
    tag: e.tagName.toLowerCase(), text: e.tagName === 'SELECT' ? '' : (e.textContent ?? '').trim(), href: e.getAttribute('href'),
    download: e.hasAttribute('download'), type: e.getAttribute('type') }));
  return {
    hash: location.hash,
    visibleScreens: [...document.querySelectorAll('[data-screen]')].filter(visible).map((s) => s.getAttribute('data-screen')),
    text: visible(screen) ? screen.innerText : '',
    selects, averages, points, baseline, rows, headers,
    emptyShown: visible(screen) && screen.innerText.includes(${JSON.stringify(EMPTY)}) && [...screen.querySelectorAll('*')].some((e) => visible(e) && e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(EMPTY)}),
    clear: { exists: !!clearEl && visible(clearEl), disabled: !!clearEl && (clearEl.disabled || clearEl.getAttribute('aria-disabled') === 'true') },
    controls,
  };
})()`;
const historyState = (page: Page) => page.evaluate<HistoryState>(HISTORY_STATE);

/** 一覧の行から、見出しが label の列の値を取り出す。 */
const column = (h: HistoryState, label: string) => {
  const i = h.headers.findIndex((x) => x.includes(label));
  if (i < 0) throw new Error(`一覧に ${label} の列がない: ${JSON.stringify(h.headers)}`);
  return h.rows.map((r) => r[i]!);
};

// ---------------------------------------------------------------------------
// 画面の操作
// ---------------------------------------------------------------------------

/** 選択肢の表示名から値を選ぶ（キーボードで選んだときと同じく input と change を出す）。 */
async function choose(page: Page, selector: string, label: string) {
  const ok = await page.evaluate<boolean>(`(() => {
    const s = document.querySelector(${JSON.stringify(selector)});
    if (!s) return false;
    const o = [...s.options].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  if (!ok) throw new Error(`${selector} に ${label} の選択肢がない`);
}

/** 履歴の画面の、表示名 caption の label の中の select で label を選ぶ。 */
async function chooseHistory(page: Page, caption: string, label: string) {
  const ok = await page.evaluate<boolean>(`(() => {
    const screen = document.querySelector('[data-screen="history"]');
    const s = [...screen.querySelectorAll('select')].find((x) => (x.closest('label')?.textContent ?? x.getAttribute('aria-label') ?? '').trim().startsWith(${JSON.stringify(caption)}));
    if (!s) return false;
    const o = [...s.options].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  if (!ok) throw new Error(`履歴の画面の ${caption} に ${label} の選択肢がない`);
  await page.frames(2);
}

/** 履歴の画面で武器・モード・入力方式を選ぶ。 */
async function selectGroup(page: Page, weapon: string, mode: string, input: string) {
  await chooseHistory(page, '武器', weapon);
  await chooseHistory(page, 'モード', mode);
  await chooseHistory(page, '入力方式', input);
}

/** 同じページのままハッシュで履歴の画面を開く。 */
async function openHistory(page: Page) {
  await page.evaluate(`location.hash = '#/history'`);
  await page.waitFor(`!!document.querySelector('[data-screen="history"]') && !document.querySelector('[data-screen="history"]').hidden && document.querySelectorAll('[data-screen="history"] select option').length > 0`);
  await page.frames(2);
}

const mouseButton = (page: Page, type: 'mousePressed' | 'mouseReleased') =>
  page.send('Input.dispatchMouseEvent', { type, x: CX, y: CY, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });

async function lock(page: Page) {
  await page.waitFor(`location.hash === '#/play' && !document.querySelector('[data-screen="play"]').hidden`);
  await page.frames(5);
  await waitUntil(() => page.lockPointerBy(() => page.click(CX, CY), 1_000), 'クリックでポインターロックが掛かる', { timeout: 15_000 });
  await page.frames(2);
}

async function start(page: Page, weapon: string, mode: string) {
  await page.evaluate(`location.hash = '#/'`);
  await page.waitFor(`!document.querySelector('[data-screen="top"]').hidden && document.querySelector('#weapon').options.length > 0 && document.querySelector('#mode').options.length > 0`);
  await choose(page, '#weapon', weapon);
  await choose(page, '#mode', mode);
  await page.clickSelector('[data-screen="top"] a[href="#/play"]');
  await page.waitFor(`window.__ammo() > 0`);
  await lock(page);
}

async function fireAll(page: Page) {
  await mouseButton(page, 'mousePressed');
  // ページの時計（clock=manual）を進めて撃ち切る。実時間では待たない。
  await page.advanceClockUntil(`location.hash === '#/result'`, { step: 1 / 60 });
  await mouseButton(page, 'mouseReleased');
  await page.evaluate('document.exitPointerLock()');
  await page.waitFor(`!document.querySelector('[data-screen="result"]').hidden`);
  await page.frames(2);
}

/** 練習を 1 回（武器とモードを選んで撃ち切る）。 */
async function practice(page: Page, weapon: string, mode: string) {
  await start(page, weapon, mode);
  await fireAll(page);
  return resultState(page);
}

/** 履歴の画面の、表示名が label のボタン（リンク）を、見える所に出してからクリックする。 */
async function clickHistoryButton(page: Page, label: string) {
  const box = await page.evaluate<{ x: number; y: number } | null>(`(() => {
    const el = [...document.querySelectorAll('[data-screen="history"] a, [data-screen="history"] button')].find((e) => e.textContent.trim() === ${JSON.stringify(label)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!box) throw new Error(`履歴の画面に「${label}」がない`);
  await page.click(box.x, box.y);
}

/**
 * 「この履歴を消す」を押し、確認に answer で答える。confirm が使われなければ、見えているダイアログのボタンで答える。
 */
async function clearWithAnswer(page: Page, answer: boolean) {
  await page.evaluate(`window.__confirmAnswer = ${answer}; window.__confirmCalls = 0;`);
  await clickHistoryButton(page, CLEAR);
  await page.frames(2);
  const viaConfirm = await page.evaluate<number>('window.__confirmCalls');
  if (viaConfirm > 0) return;
  const clicked = await page.evaluate<boolean>(`(() => { ${VISIBLE}
    const dialogs = [...document.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"]')].filter(visible);
    for (const d of dialogs) {
      const buttons = [...d.querySelectorAll('button')].filter(visible);
      const yes = buttons.find((b) => /消す|削除|はい|OK/.test(b.textContent));
      const no = buttons.find((b) => /取りやめ|キャンセル|やめる|いいえ|戻る/.test(b.textContent));
      const target = ${answer} ? yes : no;
      if (target) { target.click(); return true; }
    }
    return false; })()`);
  if (!clicked) throw new Error('消してよいかの確認が出ない');
  await page.frames(2);
}

const PAGE_INIT = `
  window.__ammo = () => { const m = (document.querySelector('[data-hud="ammo"]')?.textContent ?? '').match(/\\d+/); return m ? Number(m[0]) : NaN; };
  window.__confirmAnswer = false; window.__confirmCalls = 0;
  window.confirm = (msg) => { window.__confirmCalls += 1; window.__confirmMessage = String(msg); return window.__confirmAnswer; };
`;

/** 標準配置のパッドを 1 つつないだことにする。window.__r2 が R2（ボタン 7）のアナログ値。 */
const PAD_INIT = `
  window.__r2 = 0;
  const makePad = () => ({ id: 'qa-pad', index: 0, connected: true, mapping: 'standard', timestamp: performance.now(),
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, i) => { const v = i === 7 ? window.__r2 : 0; return { value: v, pressed: v >= 0.5, touched: v > 0 }; }) });
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: function () { return [makePad(), null, null, null]; } });
  window.addEventListener('load', () => { const e = new Event('gamepadconnected'); e.gamepad = makePad(); window.dispatchEvent(e); });
`;

const storedWith = (page: Page, prefix: string) =>
  page.evaluate<Record<string, string>>(`(() => { const out = {}; try { for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i);
    if (k.startsWith(${JSON.stringify(prefix)})) out[k] = localStorage.getItem(k); } } catch {} return out; })()`);
const storedHistories = (page: Page) => storedWith(page, HISTORY_PREFIX);

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('練習の履歴と履歴の画面', () => {
  const temps: string[] = [];
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));

  /** 新しいタブで localStorage を空にし（seed を入れ）、読み込み直したトップ画面を開く。 */
  async function openFresh(seed: Record<string, string> = {}, init?: string): Promise<Page> {
    const page = await browser!.newPage();
    await page.goto(appUrl(origin, BASE, '#/', APP));
    await page.evaluate(`(() => { localStorage.clear(); const seed = ${JSON.stringify(seed)}; for (const k in seed) localStorage.setItem(k, seed[k]); })()`);
    await page.addInitScript(PAGE_INIT);
    if (init) await page.addInitScript(init);
    await reload(page);
    return page;
  }
  async function reload(page: Page) {
    // 履歴の画面などから再読み込みするときも、トップ画面の表示を待てるようにハッシュをトップに戻してから読み込み直す。
    await page.evaluate(`location.hash = '#/'; window.__beforeReload = true`);
    await page.send('Page.reload', { ignoreCache: false });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && !!document.querySelector('[data-screen="top"]') && !document.querySelector('[data-screen="top"]').hidden`, 15_000);
  }
  async function modesOnTop(page: Page) {
    return page.evaluate<string[]>(`[...document.querySelector('#mode').options].map((o) => o.textContent.trim())`);
  }

  beforeAll(async () => {
    const work = mkdtempSync(join(tmpdir(), 'history-qa-'));
    temps.push(work);
    const dist = join(work, 'dist');
    const build = spawnSync(`npm run build -- --outDir "${dist}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8' });
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
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  describe('履歴の保存（scoring.md）', () => {
    it('SCO-23: 履歴がない状態で、マウスで L-STAR とセンター維持を 3 回練習して終えると、3 件が古い順に保存され、各件にその練習の値が入る', async () => {
      const page = await openFresh();
      expect(await storedHistories(page)).toEqual({});
      const results: ResultState[] = [];
      const startedAt = Date.now();
      for (let i = 0; i < 3; i += 1) {
        results.push(await practice(page, LSTAR.name, 'センター維持'));
      }
      const all = await storedHistories(page);
      const key = historyKey('mouse', 'lstar', 'center');
      expect(Object.keys(all)).toEqual([key]);
      const value = JSON.parse(all[key]!) as Stored;
      expect(value.version).toBe(1);
      expect(value.entries).toHaveLength(3);
      value.entries.forEach((e, i) => {
        const r = results[i]!;
        expect(Math.abs(e.meanError - num(metric(r, '平均ズレ'))!), `${i + 1} 件目の平均ズレ`).toBeLessThanOrEqual(0.006);
        expect(Math.abs(e.hitRate - num(metric(r, '命中率'))!), `${i + 1} 件目の命中率`).toBeLessThanOrEqual(0.06);
        expect(Math.abs(e.groupingRadius - num(metric(r, 'グルーピング半径'))!), `${i + 1} 件目のグルーピング半径`).toBeLessThanOrEqual(0.006);
        expect(e.shots, `${i + 1} 件目の弾数`).toBe(LSTAR.magSize);
        expect(e.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
        const t = Date.parse(e.at);
        expect(t).toBeGreaterThanOrEqual(startedAt - 1000);
        expect(t).toBeLessThanOrEqual(Date.now() + 1000);
      });
      // 古い順。
      for (let i = 1; i < 3; i += 1) expect(Date.parse(value.entries[i]!.at)).toBeGreaterThanOrEqual(Date.parse(value.entries[i - 1]!.at));
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 120_000);

    it('SCO-24: 同じ組の履歴が 200 件ある状態で練習を終えると、200 件のままで最も古い 1 件が消え、最後の件が今の練習の結果になる', async () => {
      const key = historyKey('mouse', 'lstar', 'center');
      // 平均ズレ 50 + i/1000 で各件を見分ける（今の練習の平均ズレとは重ならない）。
      const seedEntries = Array.from({ length: 200 }, (_, i) => entry(50 + i / 1000, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()));
      const page = await openFresh({ [key]: stored(seedEntries) });
      const r = await practice(page, LSTAR.name, 'センター維持');
      const value = JSON.parse((await storedHistories(page))[key]!) as Stored;
      expect(value.entries).toHaveLength(200);
      // 最も古い 1 件（i = 0）が消え、2 件目以降がそのまま前に詰まる。
      expect(value.entries.slice(0, 199)).toEqual(seedEntries.slice(1));
      const last = value.entries[199]!;
      expect(Math.abs(last.meanError - num(metric(r, '平均ズレ'))!)).toBeLessThanOrEqual(0.006);
      expect(last.shots).toBe(LSTAR.magSize);
      expect(Math.abs(Date.parse(last.at) - Date.now())).toBeLessThan(60_000);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);


    it('SCO-26: L-STAR とセンター維持の履歴がある状態で、L-STAR と反復練習を練習して終えると、L-STAR とセンター維持のマウスの履歴は変わらない', async (ctx) => {
      const key = historyKey('mouse', 'lstar', 'center');
      const old = stored([entry(3.21), entry(2.34, '2026-01-02T00:00:00.000Z')]);
      const page = await openFresh({ [key]: old });
      if (!(await modesOnTop(page)).includes('反復練習')) {
        console.warn('反復練習がモードの選択肢にない。この確認は飛ばす');
        ctx.skip();
      }
      const r = await practice(page, LSTAR.name, '反復練習');
      const all = await storedHistories(page);
      expect(all[key]).toBe(old);
      // 反復練習の履歴は別のキーに入る。
      const ghost = JSON.parse(all[historyKey('mouse', 'lstar', 'ghost')]!) as Stored;
      expect(ghost.entries).toHaveLength(1);
      expect(Math.abs(ghost.entries[0]!.meanError - num(metric(r, '平均ズレ'))!)).toBeLessThanOrEqual(0.006);
      expect(Object.keys(all).sort()).toEqual([historyKey('mouse', 'lstar', 'ghost'), key].sort());
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('SCO-26: L-STAR とセンター維持のマウスの履歴がある状態で、パッドで L-STAR とセンター維持を練習して終えると、マウスの履歴は変わらない', async () => {
      const key = historyKey('mouse', 'lstar', 'center');
      const old = stored([entry(3.21), entry(2.34, '2026-01-02T00:00:00.000Z')]);
      // Gamepad API の形の標準配置のパッド（R2 はボタン 7）で撃つ。
      const page = await openFresh({ [key]: old }, PAD_INIT);
      // 設定画面で入力方式をパッドに固定する。
      await page.evaluate(`location.hash = '#/settings'`);
      await page.waitFor(`!document.querySelector('[data-screen="settings"]').hidden && !!document.getElementById('setting-input-method')`);
      await choose(page, '#setting-input-method', 'パッド');
      await page.frames(2);
      await page.evaluate(`location.hash = '#/'`);
      await page.waitFor(`!document.querySelector('[data-screen="top"]').hidden && document.querySelector('#weapon').options.length > 0`);
      await choose(page, '#weapon', LSTAR.name);
      await choose(page, '#mode', 'センター維持');
      await page.clickSelector('[data-screen="top"] a[href="#/play"]');
      await page.waitFor(`location.hash === '#/play' && window.__ammo() > 0`);
      await page.frames(5);
      await page.evaluate('window.__r2 = 1');
      await page.frames(2);
      await page.advanceClockUntil(`location.hash === '#/result'`, { step: 1 / 60 });
      await page.evaluate('window.__r2 = 0');
      await page.waitFor(`!document.querySelector('[data-screen="result"]').hidden`);
      await page.frames(2);
      const r = await resultState(page);
      expect(r.visibleScreens).toEqual(['result']);
      const all = await storedHistories(page);
      expect(all[key]).toBe(old);
      const padValue = JSON.parse(all[historyKey('pad', 'lstar', 'center')]!) as Stored;
      expect(padValue.entries).toHaveLength(1);
      expect(Math.abs(padValue.entries[0]!.meanError - num(metric(r, '平均ズレ'))!)).toBeLessThanOrEqual(0.006);
      expect(Object.keys(all).sort()).toEqual([historyKey('pad', 'lstar', 'center'), key].sort());
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('SCO-29: 履歴のキーに JSON として読めない値が入っている状態で練習を終えると、エラーで止まらずにリザルト画面が表示され、履歴はその練習の 1 件だけになる', async () => {
      const key = historyKey('mouse', 'lstar', 'center');
      const page = await openFresh({ [key]: '{not json' });
      const r = await practice(page, LSTAR.name, 'センター維持');
      expect(r.visibleScreens).toEqual(['result']);
      const value = JSON.parse((await storedHistories(page))[key]!) as Stored;
      expect(value.version).toBe(1);
      expect(value.entries).toHaveLength(1);
      expect(Math.abs(value.entries[0]!.meanError - num(metric(r, '平均ズレ'))!)).toBeLessThanOrEqual(0.006);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('SCO-30: localStorage への書き込みが例外になる環境で 2 回練習して終えると、エラーで止まらずにリザルト画面が表示され、同じページで開いた履歴の画面にその 2 回が表示される', async () => {
      const page = await openFresh({}, ALWAYS_THROW);
      const results: ResultState[] = [];
      for (let i = 0; i < 2; i += 1) {
        const r = await practice(page, LSTAR.name, 'センター維持');
        expect(r.visibleScreens, `${i + 1} 回目`).toEqual(['result']);
        results.push(r);
      }
      await openHistory(page);
      await selectGroup(page, LSTAR.name, 'センター維持', 'マウス');
      const h = await historyState(page);
      expect(h.visibleScreens).toEqual(['history']);
      expect(h.rows).toHaveLength(2);
      expect(h.points).toHaveLength(2);
      expect(column(h, '平均ズレ').map(num)).toEqual(results.map((r) => num(metric(r, '平均ズレ'))));
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  describe('履歴の平均（scoring.md）', () => {
    it('SCO-27: 平均ズレ 1〜12 度の 12 件（古い順、最後の 2 件だけが今日）のとき、今日 11.5・直近 10 回 7.5・全体 6.5 度になる', async () => {
      // 今日（ブラウザの時間帯）の日時は、ページの中で今日の 0 時 1 分と 0 時 2 分（今より前）か、今の 2 分前と 1 分前で作る。
      const page = await openFresh();
      const ats = await page.evaluate<string[]>(`(() => {
        const now = new Date(); const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const out = [];
        for (let i = 0; i < 10; i += 1) out.push(new Date(midnight.getTime() - (12 - i) * 86400000 + 3600000 * 12).toISOString());
        const minutes = (now.getTime() - midnight.getTime()) / 60000;
        if (minutes >= 3) { out.push(new Date(now.getTime() - 120000).toISOString()); out.push(new Date(now.getTime() - 60000).toISOString()); }
        else { out.push(new Date(midnight.getTime() + 1000).toISOString()); out.push(new Date(midnight.getTime() + 2000).toISOString()); }
        return out; })()`);
      const entries = ats.map((at, i) => entry(i + 1, at));
      await page.evaluate(`localStorage.setItem(${JSON.stringify(historyKey('mouse', 'lstar', 'center'))}, ${JSON.stringify(stored(entries))})`);
      await reload(page);
      await openHistory(page);
      await selectGroup(page, LSTAR.name, 'センター維持', 'マウス');
      const h = await historyState(page);
      expect(num(metric({ metrics: h.averages }, '今日'))).toBeCloseTo(11.5, 2);
      expect(num(metric({ metrics: h.averages }, '直近 10 回'))).toBeCloseTo(7.5, 2);
      expect(num(metric({ metrics: h.averages }, '全体'))).toBeCloseTo(6.5, 2);
      expect(h.rows).toHaveLength(12);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('SCO-28: 履歴が 1 件もないとき、今日の平均・直近 10 回の平均・全体の平均がすべて「なし」になる', async () => {
      const page = await openFresh();
      await openHistory(page);
      await selectGroup(page, LSTAR.name, 'センター維持', 'マウス');
      const h = await historyState(page);
      expect(metric({ metrics: h.averages }, '今日')).toBe('なし');
      expect(metric({ metrics: h.averages }, '直近 10 回')).toBe('なし');
      expect(metric({ metrics: h.averages }, '全体')).toBe('なし');
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('履歴の画面（screens.md）', () => {
    it('UI-24: マウスで L-STAR とセンター維持を 3 回練習したあと、履歴の画面で選ぶと、グラフに 3 点が回の順に、一覧に 3 回分の平均ズレがリザルトと同じ順で表示される', async () => {
      const page = await openFresh();
      const results: ResultState[] = [];
      for (let i = 0; i < 3; i += 1) results.push(await practice(page, LSTAR.name, 'センター維持'));
      const means = results.map((r) => num(metric(r, '平均ズレ'))!);
      await openHistory(page);
      await selectGroup(page, LSTAR.name, 'センター維持', 'マウス');
      const h = await historyState(page);
      expect(h.visibleScreens).toEqual(['history']);
      // 一覧: 3 行、回 1・2・3 の順、平均ズレはリザルトの値と同じ順。
      expect(h.rows).toHaveLength(3);
      expect(column(h, '回').map(num)).toEqual([1, 2, 3]);
      expect(column(h, '平均ズレ').map(num)).toEqual(means);
      expect(h.emptyShown).toBe(false);
      // グラフ: 3 点、横軸（回）の順に左から右、縦の高さは平均ズレに比例する（0 が横軸の線）。
      expect(h.points).toHaveLength(3);
      expect(h.baseline).not.toBeNull();
      for (let i = 1; i < 3; i += 1) expect(h.points[i]!.x).toBeGreaterThan(h.points[i - 1]!.x);
      const heights = h.points.map((p) => h.baseline! - p.y);
      const maxIndex = means.indexOf(Math.max(...means));
      for (let i = 0; i < 3; i += 1) {
        const expected = (means[i]! / means[maxIndex]!) * heights[maxIndex]!;
        expect(Math.abs(heights[i]! - expected), `${i + 1} 回目の点の高さ`).toBeLessThanOrEqual(1.5);
      }
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 120_000);

    it('UI-25: トップ画面で「履歴」を押すと履歴の画面になり、トップ画面へ戻るリンクで戻れる', async () => {
      const page = await openFresh();
      const link = await page.evaluate<boolean>(`[...document.querySelectorAll('[data-screen="top"] a, [data-screen="top"] button')].some((e) => e.textContent.trim() === '履歴')`);
      expect(link).toBe(true);
      const box = await page.evaluate<{ x: number; y: number }>(`(() => {
        const el = [...document.querySelectorAll('[data-screen="top"] a, [data-screen="top"] button')].find((e) => e.textContent.trim() === '履歴');
        el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await page.click(box.x, box.y);
      await page.waitFor(`location.hash === '#/history'`);
      await page.frames(2);
      const h = await historyState(page);
      expect(h.visibleScreens).toEqual(['history']);
      const back = h.controls.find((c) => c.tag === 'a' && (c.href === '#/' || c.href === '#' || c.href === BASE));
      expect(back, JSON.stringify(h.controls)).toBeDefined();
      await clickHistoryButton(page, back!.text);
      await page.waitFor(`!document.querySelector('[data-screen="top"]').hidden`);
      await page.frames(2);
      const after = await page.evaluate<{ hash: string; screens: string[] }>(`(() => { ${VISIBLE} return { hash: location.hash,
        screens: [...document.querySelectorAll('[data-screen]')].filter(visible).map((s) => s.getAttribute('data-screen')) }; })()`);
      expect(after.hash === '#/' || after.hash === '').toBe(true);
      expect(after.screens).toEqual(['top']);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('UI-26: 履歴の画面のモードの選択肢に、反復練習とセンター維持だけが出る', async () => {
      const page = await openFresh();
      await openHistory(page);
      const h = await historyState(page);
      const mode = h.selects.find((s) => s.label.startsWith('モード'));
      expect(mode, JSON.stringify(h.selects)).toBeDefined();
      expect(mode!.options).toEqual(['反復練習', 'センター維持']);
      expect(h.text).not.toContain('パターン観察');
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('UI-27: 履歴がある組で「この履歴を消す」を押して消すことを選ぶと、空になり、再読み込みしても空で、ほかの組の履歴と自己ベストは残る', async () => {
      const target = historyKey('mouse', 'lstar', 'center');
      const others = {
        [historyKey('mouse', 'car', 'center')]: stored([entry(4.56)]),
        [historyKey('pad', 'lstar', 'center')]: stored([entry(5.67)]),
        [historyKey('mouse', 'lstar', 'ghost')]: stored([entry(6.78)]),
      };
      const best = { [bestKey('mouse', 'lstar', 'center')]: JSON.stringify({ version: 1, meanError: 1.11, groupingRadius: 0.5, hitRate: 40, shots: 28, achievedAt: '2026-01-01T00:00:00.000Z' }) };
      const page = await openFresh({ [target]: stored([entry(1.5), entry(2.5, '2026-01-02T00:00:00.000Z')]), ...others, ...best });
      await openHistory(page);
      await selectGroup(page, LSTAR.name, 'センター維持', 'マウス');
      const before = await historyState(page);
      expect(before.rows).toHaveLength(2);
      expect(before.clear).toEqual({ exists: true, disabled: false });
      await clearWithAnswer(page, true);
      const h = await historyState(page);
      expect(h.points).toHaveLength(0);
      expect(h.rows).toHaveLength(0);
      expect(h.emptyShown).toBe(true);
      // 再読み込みしても空。
      await reload(page);
      await openHistory(page);
      await selectGroup(page, LSTAR.name, 'センター維持', 'マウス');
      const reloaded = await historyState(page);
      expect(reloaded.points).toHaveLength(0);
      expect(reloaded.rows).toHaveLength(0);
      expect(reloaded.emptyShown).toBe(true);
      const histories = await storedHistories(page);
      for (const [k, v] of Object.entries(others)) expect(histories[k], k).toBe(v);
      if (target in histories) expect((JSON.parse(histories[target]!) as Stored).entries).toEqual([]);
      expect(await storedWith(page, BEST_PREFIX)).toEqual(best);
      // ほかの組は画面でも残っている。
      await selectGroup(page, byId('car').name, 'センター維持', 'マウス');
      expect(column(await historyState(page), '平均ズレ').map(num)).toEqual([4.56]);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('UI-28: 「この履歴を消す」を押して確認で取りやめると、履歴の表示と保存してある履歴が変わらない', async () => {
      const target = historyKey('mouse', 'lstar', 'center');
      const value = stored([entry(1.5), entry(2.5, '2026-01-02T00:00:00.000Z'), entry(0.75, '2026-01-03T00:00:00.000Z')]);
      const page = await openFresh({ [target]: value });
      await openHistory(page);
      await selectGroup(page, LSTAR.name, 'センター維持', 'マウス');
      const before = await historyState(page);
      expect(before.rows).toHaveLength(3);
      await clearWithAnswer(page, false);
      const after = await historyState(page);
      expect(after.rows).toEqual(before.rows);
      expect(after.points).toEqual(before.points);
      expect(after.averages).toEqual(before.averages);
      expect(after.emptyShown).toBe(false);
      expect((await storedHistories(page))[target]).toBe(value);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('UI-29: localStorage への書き込みが例外になる環境で履歴の画面を開くと、エラーで止まらずに表示され、保存できない旨が表示される', async () => {
      const page = await openFresh({}, ALWAYS_THROW);
      await openHistory(page);
      const h = await historyState(page);
      expect(h.visibleScreens).toEqual(['history']);
      expect(h.text).toContain(HISTORY_NOTICE);
      // 直接 #/history を開いても同じ。
      await page.goto(appUrl(origin, BASE, '#/history', APP));
      await page.waitFor(`!!document.querySelector('[data-screen="history"]') && !document.querySelector('[data-screen="history"]').hidden`);
      await page.frames(2);
      const direct = await historyState(page);
      expect(direct.visibleScreens).toEqual(['history']);
      expect(direct.text).toContain(HISTORY_NOTICE);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('UI-30: 履歴の画面に、履歴をファイルに書き出す操作や外部へ送る操作がない', async () => {
      const page = await openFresh({ [historyKey('mouse', 'lstar', 'center')]: stored([entry(1.5)]) });
      await openHistory(page);
      await selectGroup(page, LSTAR.name, 'センター維持', 'マウス');
      const h = await historyState(page);
      expect(h.rows).toHaveLength(1);
      const forbidden = /書き出|エクスポート|出力|保存する|ダウンロード|送信|送る|共有|コピー|export|download|share|send|copy|upload/i;
      for (const c of h.controls) {
        expect(c.text, JSON.stringify(c)).not.toMatch(forbidden);
        expect(c.download, JSON.stringify(c)).toBe(false);
        if (c.href !== null) expect(c.href, JSON.stringify(c)).toMatch(/^#/);
        if (c.tag === 'input') expect(c.type, JSON.stringify(c)).not.toBe('file');
      }
      // 見えている操作は、3 つの選択・「この履歴を消す」・トップ画面へ戻るリンクだけ。
      expect(h.controls.filter((c) => c.tag === 'select')).toHaveLength(3);
      expect(h.controls.filter((c) => c.tag === 'button').map((c) => c.text)).toEqual([CLEAR]);
      expect(h.controls.filter((c) => c.tag === 'a')).toHaveLength(1);
      expect(h.controls.filter((c) => !['select', 'button', 'a'].includes(c.tag))).toEqual([]);
      // ページの中に、ファイルの書き出し（download 属性のリンク・Blob の URL）を作る要素もない。
      expect(await page.evaluate<number>(`document.querySelectorAll('[data-screen="history"] a[download], [data-screen="history"] [href^="blob:"], [data-screen="history"] [href^="data:"]').length`)).toBe(0);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });
});
