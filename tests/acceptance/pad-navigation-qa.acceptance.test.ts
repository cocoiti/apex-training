// docs/spec/screens.md「パッドでの項目の移動と変更」、docs/spec/pad.md「接続と配置」、docs/spec/input.md「入力方式の切替」の
// QA の受け入れテスト（UI-43〜UI-54、PAD-32、PAD-33、INP-15、INP-16）。
// 公開された入口（ビルドの結果を /apex-training/ で配信した画面、index.html の要素、武器の JSON、SPEC の localStorage のキー、
// PadInput の公開のシグネチャ）だけを使い、実装の内部には依存しない。画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、
// パッドは Gamepad API（navigator.getGamepads）の形で与える。マウスとキーボードの操作は、SPEC がそれを求める場面
// （INP-16 の「もう一度」のクリック、UI-54 の割り当ての準備）のほかは送らない。
//
// フォーカスしている項目は、画面で観察できる印で読む。画面を動かして確かめたところ、パッドのフォーカスを置いた項目には
// pad-focus のクラスが付く（document.activeElement は動かない）。枠が背景と見分けられる形で表示されているか（UI-47）は、
// 画面写しで項目の周りの画素が、フォーカスがないときと変わるかで読む。
// 照準の反応は、反復練習の中心の的の色が画面の中心から外れるか（画面写しの中心の画素）で読む。
// 押し続けたときの繰り返し（UI-48）は、clock=manual で開き、ページの時計をテストが進めて読む。
// 画面写しでキャンバスの色を読むテスト（UI-46）のほかは、3D を描画せずに開く（render=off）。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Action } from '../../src/input/actions';
import { DEFAULT_PAD_SETTINGS } from '../../src/input/pad-curve';
import { PadInput, type GamepadLike } from '../../src/input/pad';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, waitUntil, type Browser, type Page } from '../helpers/browser';
import { decodePng, type Image } from '../helpers/png';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
/** ページを開く練習の乱数の種（docs/spec/architecture.md「テストのための乱数の種の固定」）。テストが失敗したときのメッセージにも出る。 */
const SEED = 12345;
const WIDTH = 1280;
const HEIGHT = 800;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;
const chromium = findChromium();

/** SPEC の文言と値（実装の定数には依存しない）。 */
const MODE = '反復練習';
const MOUSE_LABEL = 'マウス';
const PAD_LABEL = 'パッド';
const BEST_PREFIX = 'apex-training:best:';
const HISTORY_PREFIX = 'apex-training:history:';

/** 標準配置のボタンと軸の番号（pad.md・screens.md）。 */
const A = 0;
const B = 1;
const L2 = 6;
const R2 = 7;
const UP = 12;
const DOWN = 13;
const LEFT = 14;
const RIGHT = 15;

const STD_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const GENERIC_ID = 'Generic USB Joystick (Vendor: 0079 Product: 0006)';

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
const CAR = byId('car');

type RGB = [number, number, number];
const distance = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

interface PadDef {
  index: number;
  id: string;
  mapping: string;
}
const standardPad = (index = 0): PadDef => ({ index, id: STD_ID, mapping: 'standard' });
const genericPad = (index = 0): PadDef => ({ index, id: GENERIC_ID, mapping: '' });

/**
 * Gamepad API の形のパッド。sessionStorage の __qaPads の定義から作り、navigator.getGamepads は長さ 4 の配列（空きは null）を返す。
 * __axis(番号, 軸, 値)・__button(番号, ボタン, 値) で操作する。
 */
const PAGE_INIT = `
(() => {
  let defs = [];
  try { defs = JSON.parse(sessionStorage.getItem('__qaPads') || '[]'); } catch {}
  window.__pads = defs.map((d) => ({ ...d, connected: true, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) }));
  navigator.getGamepads = () => {
    const out = [null, null, null, null];
    for (const p of window.__pads) {
      out[p.index] = { id: p.id, index: p.index, connected: p.connected, mapping: p.mapping, timestamp: performance.now(),
        axes: p.axes.slice(), buttons: p.buttons.map((b) => ({ ...b })), vibrationActuator: null };
    }
    return out;
  };
  const padAt = (i) => window.__pads.find((p) => p.index === i);
  window.__axis = (i, a, v) => { padAt(i).axes[a] = v; };
  window.__button = (i, b, v) => { padAt(i).buttons[b] = { value: v, pressed: v >= 0.5, touched: v > 0 }; };
  window.__ammo = () => { const m = (document.querySelector('[data-hud="ammo"]')?.textContent ?? '').match(/\\d+/); return m ? Number(m[0]) : NaN; };
  window.__shown = (sel) => { const el = document.querySelector(sel); if (!el || el.closest('[hidden]')) return false;
    const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0; };
  window.__text = (sel) => (document.querySelector(sel)?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  // フォーカスしている項目（パッドのフォーカスの印が付いた要素）の id。id がなければ表示の文字。なければ ''。
  window.__focused = () => {
    const els = [...document.querySelectorAll('.pad-focus')];
    if (els.length === 0) return '';
    if (els.length > 1) return 'MULTIPLE:' + els.map((e) => e.getAttribute('data-card-choice') || e.id || e.textContent.trim()).join(',');
    const el = els[0];
    // トップ画面のカードの並びは、並びが選んでいる値を持つ select の id（weapon・mode）で表す。
    return el.getAttribute('data-card-choice') || el.id || el.textContent.replace(/\\s+/g, ' ').trim();
  };

})();
`;

const hash = (page: Page) => page.evaluate<string>('location.hash');
const text = (page: Page, sel: string) => page.evaluate<string>(`window.__text(${JSON.stringify(sel)})`);
const shown = (page: Page, sel: string) => page.evaluate<boolean>(`window.__shown(${JSON.stringify(sel)})`);
const ammo = (page: Page) => page.evaluate<number>('window.__ammo()');
const focused = (page: Page) => page.evaluate<string>('window.__focused()');
const axis = (page: Page, a: number, v: number, pad = 0) => page.evaluate(`window.__axis(${pad}, ${a}, ${v})`);
const button = (page: Page, b: number, v: number, pad = 0) => page.evaluate(`window.__button(${pad}, ${b}, ${v})`);
const screenVisible = (name: string) => `!!document.querySelector('[data-screen="${name}"]') && !document.querySelector('[data-screen="${name}"]').hidden`;
const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));
const noExceptions = (page: Page) => expect(exceptions(page), page.errors.join('\n')).toEqual([]);
const selectedLabel = (page: Page, selector: string) =>
  page.evaluate<string>(`document.querySelector(${JSON.stringify(selector)}).selectedOptions[0]?.textContent.trim() ?? ''`);
const selectedIndex = (page: Page, selector: string) => page.evaluate<number>(`document.querySelector(${JSON.stringify(selector)}).selectedIndex`);
const value = (page: Page, selector: string) => page.evaluate<string>(`document.querySelector(${JSON.stringify(selector)}).value`);
const checked = (page: Page, selector: string) => page.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}).checked`);
const hudInput = (page: Page) => text(page, '[data-hud="input"]');

/** パッドのボタンを押して離す（押している間と離したあとに数回描画させ、ポーリングで読まれるようにする）。 */
async function tap(page: Page, b: number, pad = 0) {
  await button(page, b, 1, pad);
  await page.frames(3);
  await button(page, b, 0, pad);
  await page.frames(3);
}

/** 軸を倒して戻す。 */
async function flick(page: Page, a: number, v: number, pad = 0) {
  await axis(page, a, v, pad);
  await page.frames(3);
  await axis(page, a, 0, pad);
  await page.frames(3);
}

/** 十字キーの下を押して、フォーカスが target の項目に来るまで進める（上限 limit 回）。 */
async function focusDownTo(page: Page, target: string, limit = 40) {
  const seen: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    await tap(page, DOWN);
    const f = await focused(page);
    seen.push(f);
    if (f === target) return;
  }
  throw new Error(`十字キーの下で ${target} にフォーカスが来ない。移った順: ${seen.join(' → ')}`);
}

/** フォーカスしている選択肢の欄で、十字キーの左右で label の選択肢を選ぶ。 */
async function chooseByPad(page: Page, selector: string, label: string) {
  const target = await page.evaluate<number>(
    `[...document.querySelector(${JSON.stringify(selector)}).options].findIndex((o) => o.textContent.trim() === ${JSON.stringify(label)})`,
  );
  if (target < 0) throw new Error(`${selector} に ${label} の選択肢がない`);
  for (let i = 0; i < 30; i += 1) {
    const now = await selectedIndex(page, selector);
    if (now === target) return;
    await tap(page, now < target ? RIGHT : LEFT);
  }
  throw new Error(`十字キーの左右で ${selector} に ${label} を選べない（今: ${await selectedLabel(page, selector)}）`);
}

/**
 * トップ画面でパッドだけ（十字キーと A / ×）で武器を選び、「開始」で A / × を押してプレイ画面に入る。
 * 登録されたモードは反復練習だけなので、モードの欄はなく、武器の次のフォーカスは回数になる（screens.md「トップ画面」）。
 * 画面を開いてからパッドを操作していない状態で呼ぶ。
 */
async function padStart(page: Page, weapon: WeaponJson) {
  await page.waitFor(`${screenVisible('top')} && document.querySelector('#weapon').options.length > 0 && document.querySelector('#mode').options.length > 0`);
  await tap(page, DOWN); // 最初の項目（武器）にフォーカスを置くだけ
  expect(await focused(page)).toBe('weapon');
  await chooseByPad(page, '#weapon', weapon.name);
  // 武器の次は「パターンの音を聞く」（screens.md「トップ画面」）、その次が回数（モードは反復練習だけで、モードの欄はない）。
  await focusDownTo(page, 'count');
  await focusDownTo(page, 'start');
  await button(page, A, 1);
  await page.waitFor(`location.hash === '#/play' && ${screenVisible('play')} && window.__ammo() === ${weapon.magSize}`, 10_000);
  await button(page, A, 0);
  await page.frames(31);
}

/** R2 / RT を押し続け、ページの時計（clock=manual）を進めて撃ち切り、リザルト画面になったら離す。 */
async function shootOut(page: Page) {
  await button(page, R2, 1);
  await page.frames(2);
  await page.advanceClockUntil(`location.hash === '#/result'`, { step: 0.05 });
  await page.waitFor(`location.hash === '#/result' && ${screenVisible('result')}`, 30_000);
  await button(page, R2, 0);
  await page.frames(3);
}

async function screenshot(page: Page): Promise<Image> {
  const { data } = await page.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  return decodePng(Buffer.from(data, 'base64'));
}
const center = async (page: Page) => (await screenshot(page)).pixel(CX, CY);

/** HTML の画面を見えなくし、キャンバスだけを写す（HUD の文字は textContent で読める）。 */
async function hideHtml(page: Page) {
  await page.evaluate(`document.getElementById('ui').style.visibility = 'hidden'`);
  await page.frames(19);
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
const rectOf = (page: Page, selector: string) =>
  page.evaluate<Rect>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`);

/** 項目の縁の内側 2 px から外側 8 px までの帯で、2 枚の画面写しの画素が目に見えて違う数。 */
function ringDiff(a: Image, b: Image, r: Rect): number {
  let count = 0;
  const x0 = Math.max(0, Math.floor(r.left) - 8);
  const x1 = Math.min(WIDTH - 1, Math.ceil(r.right) + 8);
  const y0 = Math.max(0, Math.floor(r.top) - 8);
  const y1 = Math.min(HEIGHT - 1, Math.ceil(r.bottom) + 8);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const inner = x > r.left + 2 && x < r.right - 2 && y > r.top + 2 && y < r.bottom - 2;
      if (inner) continue;
      if (distance(a.pixel(x, y), b.pixel(x, y)) > 40) count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('QA: すべての画面をパッドだけで操作する', () => {
  let work = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';

  async function reload(page: Page) {
    await page.evaluate('window.__beforeReload = true');
    await page.send('Page.reload', { ignoreCache: false });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && !!window.__pads`, 15_000);
    await page.frames(5);
  }

  /**
   * 新しいタブで localStorage を空にし（seed を入れ）、pads のパッドをつないだ状態で読み込み直して path を開く。
   * render が true のときだけ 3D を描画し、clock が true のときはページの時計をテストから進める（clock=manual）。
   */
  async function openFresh({
    pads = [standardPad()],
    seed = {},
    clock = false,
    render = false,
    path = '#/',
  }: { pads?: PadDef[]; seed?: Record<string, string>; clock?: boolean; render?: boolean; path?: string } = {}): Promise<Page> {
    const page = await browser!.newPage();
    await page.addInitScript(PAGE_INIT);
    await page.goto(appUrl(origin, BASE, '#/', { render, manualClock: clock, seed: SEED }));
    await page.evaluate(`(() => { localStorage.clear(); const seed = ${JSON.stringify(seed)}; for (const k in seed) localStorage.setItem(k, seed[k]);
      sessionStorage.setItem('__qaPads', ${JSON.stringify(JSON.stringify(pads))});
      location.hash = ${JSON.stringify(path)}; })()`);
    await reload(page);
    return page;
  }

  /** 画面を開く（ハッシュを変えるだけで、マウスやキーボードの操作は送らない）。 */
  async function open(page: Page, path: string, screen: string) {
    await page.evaluate(`location.hash = ${JSON.stringify(path)}`);
    await page.waitFor(screenVisible(screen));
    await page.frames(3);
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'pad-navigation-qa-'));
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
    if (work) rmSync(work, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  it('UI-43: パッドだけで L-STAR を選んで（モードを選ぶ操作はない）反復練習を始め、撃ち切り、A / × でもう一度、B / ○ でトップに戻ると L-STAR が選ばれている', async () => {
    const page = await openFresh({ clock: true });
    await padStart(page, LSTAR);
    expect(await text(page, '[data-hud="weapon"]')).toContain(LSTAR.name);
    expect(await page.evaluate<string>(`document.querySelector('#mode').value`), '反復練習で始まっていない').toBe('ghost');

    await shootOut(page);
    // リザルト画面で A / × を押すと、同じ武器・モードで新しい練習が始まる。
    await button(page, A, 1);
    await page.waitFor(`location.hash === '#/play' && ${screenVisible('play')} && window.__ammo() === ${LSTAR.magSize}`, 10_000);
    await button(page, A, 0);
    await page.frames(10);
    expect(await text(page, '[data-hud="weapon"]')).toContain(LSTAR.name);

    await shootOut(page);
    await button(page, B, 1);
    await page.waitFor(`location.hash === '#/' && ${screenVisible('top')}`, 5000);
    await button(page, B, 0);
    await page.frames(3);
    expect(await selectedLabel(page, '#weapon')).toBe(LSTAR.name);
    expect(await selectedLabel(page, '#mode')).toBe(MODE);
    noExceptions(page);
  }, 120_000);

  // -------------------------------------------------------------------------
  it('UI-44: 設定画面で十字キーの下で FOV に移り、右を 5 回押すと 95 になり、再読み込みしても 95', async () => {
    const page = await openFresh({ path: '#/settings' });
    await page.waitFor(screenVisible('settings'));
    expect(await value(page, '#setting-fov')).toBe('90');
    await focusDownTo(page, 'setting-fov');
    for (let i = 0; i < 5; i += 1) await tap(page, RIGHT);
    expect(await value(page, '#setting-fov')).toBe('95');
    await reload(page);
    await page.waitFor(screenVisible('settings'));
    expect(await value(page, '#setting-fov')).toBe('95');
    noExceptions(page);
  }, 60_000);

  // -------------------------------------------------------------------------
  describe('UI-45: 数の入力欄は範囲の端で止まり、感度は 0.1 の幅で減る', () => {
    it('UI-45: FOV が 110 のとき右を押しても 110 のまま', async () => {
      const page = await openFresh({ path: '#/settings' });
      await page.waitFor(screenVisible('settings'));
      await focusDownTo(page, 'setting-fov');
      // 右を押し続けて 110 まで上げ（範囲の上の端）、さらに右を押す。
      for (let i = 0; i < 25 && (await value(page, '#setting-fov')) !== '110'; i += 1) await tap(page, RIGHT);
      expect(await value(page, '#setting-fov')).toBe('110');
      await tap(page, RIGHT);
      expect(await value(page, '#setting-fov')).toBe('110');
      await reload(page);
      expect(await value(page, '#setting-fov')).toBe('110');
      noExceptions(page);
    }, 90_000);

    it('UI-45: 感度が 1.5 のとき左を押すと 1.4 で保存される', async () => {
      const page = await openFresh({ path: '#/settings' });
      await page.waitFor(screenVisible('settings'));
      expect(Number(await value(page, '#setting-sensitivity'))).toBe(1.5);
      await focusDownTo(page, 'setting-sensitivity');
      await tap(page, LEFT);
      expect(await value(page, '#setting-sensitivity')).toBe('1.4');
      await reload(page);
      expect(await value(page, '#setting-sensitivity')).toBe('1.4');
      noExceptions(page);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  it('UI-46 / PAD-32: 練習中の十字キーと左スティックはフォーカスも照準も射撃も動かさず、トップに戻ると選択はそのまま', async () => {
    const page = await openFresh({ render: true, clock: true });
    await padStart(page, CAR);
    const startWeapon = CAR.name;
    const startCount = await value(page, '#count');
    expect(await focused(page)).toBe('');
    await hideHtml(page);
    const target = await center(page);
    const before = await ammo(page);

    for (const b of [UP, DOWN, LEFT, RIGHT]) {
      await button(page, b, 1);
      await page.frames(2);
      await page.advanceClock(0.6, 0.1); // 押し続けて繰り返しの時間も過ぎる
      expect(await focused(page), `十字キー ${b} を押している間`).toBe('');
      await button(page, b, 0);
      await page.frames(3);
    }
    for (const [a, v] of [[0, -1], [0, 1], [1, -1], [1, 1]] as const) {
      await axis(page, a, v);
      await page.frames(2);
      await page.advanceClock(0.6, 0.1);
      expect(await focused(page), `左スティック 軸 ${a} = ${v}`).toBe('');
      await axis(page, a, 0);
      await page.frames(3);
    }
    await page.frames(10);
    expect(await focused(page)).toBe('');
    expect(await ammo(page)).toBe(before);
    expect(distance(await center(page), target), '照準が動いて中心の色が変わった').toBeLessThan(30);
    expect(await hash(page)).toBe('#/play');
    expect(await shown(page, '#paused')).toBe(false);

    await page.evaluate(`document.getElementById('ui').style.visibility = ''`);
    await shootOut(page);
    await button(page, B, 1);
    await page.waitFor(`location.hash === '#/' && ${screenVisible('top')}`, 5000);
    await button(page, B, 0);
    expect(await selectedLabel(page, '#weapon')).toBe(startWeapon);
    expect(await selectedLabel(page, '#mode')).toBe(MODE);
    expect(await value(page, '#count')).toBe(startCount);
    noExceptions(page);
  }, 120_000);

  it('PAD-32: 標準配置の十字キーと倒し切った左スティックからは look・fire・ads が出ない（PadInput）', () => {
    const emitted: Action[] = [];
    const input = new PadInput({ emit: (a) => emitted.push(a), settings: () => DEFAULT_PAD_SETTINGS });
    const states: { buttons?: number[]; axes?: [number, number] }[] = [
      { buttons: [UP] },
      { buttons: [DOWN] },
      { buttons: [LEFT] },
      { buttons: [RIGHT] },
      { buttons: [UP, DOWN, LEFT, RIGHT] },
      { axes: [1, 0] },
      { axes: [-1, 0] },
      { axes: [0, 1] },
      { axes: [0, -1] },
      { axes: [1, 1] },
      {},
    ];
    const looks: unknown[] = [];
    for (const s of states) {
      const buttons = Array.from({ length: 17 }, () => ({ value: 0, pressed: false }));
      for (const b of s.buttons ?? []) buttons[b] = { value: 1, pressed: true };
      const pad: GamepadLike = { connected: true, id: STD_ID, mapping: 'standard', axes: [s.axes?.[0] ?? 0, s.axes?.[1] ?? 0, 0, 0], buttons };
      for (let i = 0; i < 10; i += 1) {
        input.poll(pad);
        const look = input.step(1 / 120);
        if (look && (look.yaw !== 0 || look.pitch !== 0)) looks.push({ state: s, look });
      }
    }
    expect(emitted).toEqual([]);
    expect(looks).toEqual([]);
  });

  // -------------------------------------------------------------------------
  it('UI-47: 最初の下で武器にフォーカスの枠が出て選択は変わらず、次の下で次の項目へ、最後の項目で下を押しても動かない', async () => {
    const page = await openFresh();
    await page.waitFor(`${screenVisible('top')} && document.querySelector('#weapon').options.length > 0`);
    await page.frames(5);
    expect(await focused(page)).toBe('');
    const weaponBefore = await value(page, '#weapon');
    const noFocus = await screenshot(page);

    await tap(page, DOWN);
    expect(await focused(page)).toBe('weapon');
    expect(await value(page, '#weapon')).toBe(weaponBefore);
    await page.frames(3);
    const weaponFocused = await screenshot(page);
    const weaponRect = await rectOf(page, '#weapon-cards');
    expect(ringDiff(noFocus, weaponFocused, weaponRect), '武器の欄の周りに、フォーカスがないときと見分けられる枠が出る').toBeGreaterThan(20);

    // 武器の次の項目は「パターンの音を聞く」、その次がモード、その次が回数（反復練習では速さの欄は隠れていて、フォーカスが移らない）。
    await tap(page, DOWN);
    expect(await focused(page)).toBe('preview-sound');
    await tap(page, DOWN);
    expect(await focused(page)).toBe('mode');
    expect(await value(page, '#mode')).toBe('ghost');
    await tap(page, DOWN);
    expect(await focused(page)).toBe('count');
    expect(await value(page, '#weapon')).toBe(weaponBefore);

    // 最後の項目（表示の順で最後の「履歴」）まで進め、さらに下を押しても動かない。
    await focusDownTo(page, 'open-history');
    await tap(page, DOWN);
    expect(await focused(page)).toBe('open-history');
    await tap(page, DOWN);
    expect(await focused(page)).toBe('open-history');
    expect(await hash(page)).toBe('#/');
    noExceptions(page);
  }, 60_000);

  // -------------------------------------------------------------------------
  describe('UI-48: 押し続けると 0.4 秒後から 0.1 秒ごとに繰り返し、左スティックは 0.5 以上で十字キーと同じ', () => {
    it('UI-48: 十字キーの下を押し続けたときの移る時刻', async () => {
      const page = await openFresh({ path: '#/settings', clock: true });
      await page.waitFor(screenVisible('settings'));
      await tap(page, DOWN); // 最初の項目にフォーカスを置く
      const first = await focused(page);
      expect(first).not.toBe('');

      const FRAME = 1000 / 60;
      /** ページの時計を 1 描画分（1/60 秒）進める。 */
      const step = () => page.advanceClock(FRAME / 1000, FRAME / 1000);
      const moves: number[] = [];
      let last = first;
      let t = 0;
      await button(page, DOWN, 1);
      // 押し始めの描画（時刻 0）
      await step();
      for (let i = 0; i <= 45; i += 1) {
        const f = await focused(page);
        if (f !== last) {
          moves.push(Math.round(t));
          last = f;
        }
        t += FRAME;
        await step();
      }
      await button(page, DOWN, 0);
      await step();
      // 0 ms、400 ms、500 ms、600 ms、700 ms（1 描画の誤差を許す）に 1 つずつ移り、それ以外では移らない。
      expect(moves.length, `移った時刻: ${moves.join(', ')} ms`).toBe(5);
      const expected = [0, 400, 500, 600, 700];
      moves.forEach((m, i) => expect(Math.abs(m - expected[i]!), `移った時刻: ${moves.join(', ')} ms`).toBeLessThanOrEqual(FRAME + 1));
      noExceptions(page);
    }, 60_000);

    it('UI-48: 左スティックを下に 0.6 倒すと移り、0.4 では移らない', async () => {
      const page = await openFresh({ path: '#/settings' });
      await page.waitFor(screenVisible('settings'));
      await tap(page, DOWN);
      await tap(page, DOWN);
      const start = await focused(page);
      expect(start).toBe('setting-fov');

      await axis(page, 1, 0.4);
      await page.frames(40);
      expect(await focused(page), '0.4 倒しても移らない').toBe(start);
      await axis(page, 1, 0);
      await page.frames(3);

      await axis(page, 1, 0.6);
      await page.frames(3);
      const moved = await focused(page);
      expect(moved, '0.6 倒すと移る').not.toBe(start);
      await axis(page, 1, 0);
      await page.frames(3);
      // 十字キーの下と同じ（1 つ移る）: 上を押すと元の項目に戻る。
      await tap(page, UP);
      expect(await focused(page)).toBe(start);
      // 十字キーの下で 1 つ移った先と同じ項目。
      await tap(page, DOWN);
      expect(await focused(page)).toBe(moved);
      noExceptions(page);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('UI-49: B / ○ の戻る先', () => {
    for (const [path, screen, back, backScreen] of [
      ['#/settings', 'settings', '#/', 'top'],
      ['#/history', 'history', '#/', 'top'],
      ['#/settings/pad', 'settings-pad', '#/settings', 'settings'],
      ['#/settings/pad/mapping', 'settings-pad-mapping', '#/settings', 'settings'],
    ] as const) {
      it(`UI-49: ${path} で B / ○ を押すと ${back} に戻る`, async () => {
        const page = await openFresh({ path });
        await page.waitFor(screenVisible(screen));
        await page.frames(5);
        await button(page, B, 1);
        await page.waitFor(`location.hash === ${JSON.stringify(back)} && ${screenVisible(backScreen)}`, 5000);
        await button(page, B, 0);
        noExceptions(page);
      }, 60_000);
    }

    it('UI-49: トップ画面で B / ○ を押しても画面は変わらない', async () => {
      const page = await openFresh();
      await page.waitFor(screenVisible('top'));
      await tap(page, B);
      await page.frames(20);
      expect(await hash(page)).toBe('#/');
      expect(await page.evaluate<boolean>(screenVisible('top'))).toBe(true);
      // フォーカスがある状態でも変わらない。
      await tap(page, DOWN);
      await tap(page, B);
      await page.frames(20);
      expect(await hash(page)).toBe('#/');
      expect(await page.evaluate<boolean>(screenVisible('top'))).toBe(true);
      noExceptions(page);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('UI-50: ON/OFF の欄は A / × で切り替わり、色の欄は右で並びの次の色になる', () => {
    it('UI-50: ゴースト表示の欄で A / × を押すと ON で保存され、もう一度押すと OFF（既定は OFF）', async () => {
      const page = await openFresh({ path: '#/settings' });
      await page.waitFor(screenVisible('settings'));
      expect(await checked(page, '#setting-ghost')).toBe(false);
      await focusDownTo(page, 'setting-ghost');
      await tap(page, A);
      expect(await checked(page, '#setting-ghost')).toBe(true);
      await reload(page);
      expect(await checked(page, '#setting-ghost')).toBe(true);
      await focusDownTo(page, 'setting-ghost');
      await tap(page, A);
      expect(await checked(page, '#setting-ghost')).toBe(false);
      await reload(page);
      expect(await checked(page, '#setting-ghost')).toBe(false);
      noExceptions(page);
    }, 60_000);

    it('UI-50: クロスヘアの色が #77ccff のとき右を押すと #ffffff で保存される', async () => {
      const page = await openFresh({ path: '#/settings' });
      await page.waitFor(screenVisible('settings'));
      expect((await value(page, '#setting-crosshair-color')).toLowerCase()).toBe('#77ccff');
      await focusDownTo(page, 'setting-crosshair-color');
      await tap(page, RIGHT);
      expect((await value(page, '#setting-crosshair-color')).toLowerCase()).toBe('#ffffff');
      await reload(page);
      expect((await value(page, '#setting-crosshair-color')).toLowerCase()).toBe('#ffffff');
      noExceptions(page);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  it('UI-51: 簡易設定の間は、十字キーの上下で詳細設定の欄にフォーカスが移らない', async () => {
    const page = await openFresh({ path: '#/settings' });
    await page.waitFor(screenVisible('settings'));
    await focusDownTo(page, 'setting-pad-mode');
    await chooseByPad(page, '#setting-pad-mode', '簡易設定');
    await page.frames(3);
    const advanced = [
      'setting-pad-deadzone',
      'setting-pad-outer-threshold',
      'setting-pad-response-curve',
      'setting-pad-yaw',
      'setting-pad-pitch',
      'setting-pad-ads-yaw',
      'setting-pad-ads-pitch',
    ];
    const visited: string[] = [];
    // 下で最後まで、上で最初まで動かす。
    for (const dir of [DOWN, UP]) {
      let prev = '';
      for (let i = 0; i < 40; i += 1) {
        await tap(page, dir);
        const f = await focused(page);
        visited.push(f);
        if (f === prev) break;
        prev = f;
      }
    }
    expect(visited).toContain('setting-pad-simple-look');
    expect(visited).toContain('setting-pad-vibration');
    expect(visited.filter((v) => advanced.includes(v)), `移った順: ${visited.join(' → ')}`).toEqual([]);
    noExceptions(page);
  }, 90_000);

  // -------------------------------------------------------------------------
  it('UI-52: 「この履歴を消す」で A / × を押すと画面の中に確認が出て「取りやめる」にフォーカス、B / ○ で閉じ、「消す」で消える', async () => {
    // 履歴の画面を開いたときに選ばれている組（何も練習していないので一覧の最初の武器・最初の採点するモード・マウス）を読む。
    let page = await openFresh({ path: '#/history' });
    await page.waitFor(`${screenVisible('history')} && document.querySelector('#history-weapon').options.length > 0 && document.querySelector('#history-mode').options.length > 0`);
    const weapon = await value(page, '#history-weapon');
    const mode = await value(page, '#history-mode');
    const input = await value(page, '#history-input');
    const key = `${HISTORY_PREFIX}${input}:${weapon}:${mode}`;
    const entries = [1.2, 0.9].map((m, i) => ({ at: `2026-01-0${i + 1}T00:00:00.000Z`, meanError: m, hitRate: 50, groupingRadius: 1, shots: 28 }));
    const stored = JSON.stringify({ version: 1, entries });
    page = await openFresh({ path: '#/history', seed: { [key]: stored } });
    await page.waitFor(`${screenVisible('history')} && !document.querySelector('#history-clear').disabled`);
    await page.frames(5);
    const storedNow = () => page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(key)})`);

    await focusDownTo(page, 'history-clear');
    await tap(page, A);
    await page.waitFor(`window.__shown('#history-confirm')`, 3000);
    expect(await text(page, '#history-confirm')).toContain('消す');
    expect(await text(page, '#history-confirm')).toContain('取りやめる');
    expect(await focused(page)).toBe('history-confirm-cancel');

    await tap(page, B);
    await page.frames(5);
    expect(await shown(page, '#history-confirm')).toBe(false);
    expect(await hash(page)).toBe('#/history');
    expect(await storedNow()).toBe(stored);

    // もう一度開いて、「消す」に移って A / ×。
    if ((await focused(page)) !== 'history-clear') await focusDownTo(page, 'history-clear');
    await tap(page, A);
    await page.waitFor(`window.__shown('#history-confirm')`, 3000);
    expect(await focused(page)).toBe('history-confirm-cancel');
    await tap(page, UP);
    if ((await focused(page)) !== 'history-confirm-ok') await tap(page, LEFT);
    expect(await focused(page)).toBe('history-confirm-ok');
    await tap(page, A);
    await page.frames(5);
    expect(await shown(page, '#history-confirm')).toBe(false);
    const after = await storedNow();
    const left = after === null ? [] : ((JSON.parse(after) as { entries?: unknown[] }).entries ?? []);
    expect(left).toEqual([]);
    expect(await shown(page, '#history-empty')).toBe(true);
    noExceptions(page);
  }, 90_000);

  // -------------------------------------------------------------------------
  it('UI-53: 入力方式を「マウス」に固定していても、トップと設定でパッドの十字キーでフォーカスを移して値を変えられる', async () => {
    const page = await openFresh({ path: '#/settings' });
    await page.waitFor(screenVisible('settings'));
    // 入力方式をパッドで「マウス」にする。
    await tap(page, DOWN);
    expect(await focused(page)).toBe('setting-input-method');
    await chooseByPad(page, '#setting-input-method', MOUSE_LABEL);
    await reload(page);
    expect(await selectedLabel(page, '#setting-input-method')).toBe(MOUSE_LABEL);

    // 設定画面: FOV を右で 91 にする。
    await focusDownTo(page, 'setting-fov');
    await tap(page, RIGHT);
    expect(await value(page, '#setting-fov')).toBe('91');

    // トップ画面: 回数を次の選択肢にする。
    await open(page, '#/', 'top');
    await page.waitFor(`document.querySelector('#count').options.length > 1`);
    const countBefore = await selectedIndex(page, '#count');
    await focusDownTo(page, 'count');
    await tap(page, RIGHT);
    expect(await selectedIndex(page, '#count')).toBe(countBefore + 1);
    noExceptions(page);
  }, 60_000);

  // -------------------------------------------------------------------------
  it('UI-54: 標準配置でないパッド（割り当てを保存して使用中）のボタン 0・1・12〜15 と軸 0・1 では、トップのフォーカスと選択が変わらない', async () => {
    const page = await openFresh({ pads: [genericPad()], path: '#/settings/pad/mapping' });
    await page.waitFor(`${screenVisible('settings-pad-mapping')}`);
    // 割り当てを保存する（ボタン割り当ての画面をマウスで操作する。fire = 5、ads = 4、右スティックの左右 = 軸 2、上下 = 軸 3）。
    await page.waitFor(`window.__shown('#mapping-body')`, 5000);
    const steps: { item: string; act: (v: number) => Promise<unknown>; n: number }[] = [
      { item: 'fire', act: (v) => button(page, 5, v), n: 5 },
      { item: 'ads', act: (v) => button(page, 4, v), n: 4 },
      { item: 'lookX', act: (v) => axis(page, 2, v * 0.9), n: 2 },
      { item: 'lookY', act: (v) => axis(page, 3, -v * 0.9), n: 3 },
    ];
    for (const s of steps) {
      await page.evaluate(`document.querySelector('[data-assign="${s.item}"]').scrollIntoView({ block: 'center' })`);
      await page.frames(2);
      await page.clickSelector(`[data-assign="${s.item}"]`);
      await page.frames(5);
      await s.act(1);
      await waitUntil(
        () => page.evaluate<boolean>(`new RegExp('(^|\\\\D)${s.n}(\\\\D|$)').test(window.__text('#mapping-${s.item}'))`),
        `${s.item} の割り当ての表示に ${s.n} が出る`,
        { timeout: 3000 },
      );
      await s.act(0);
      await page.frames(3);
    }
    await open(page, '#/', 'top');
    await page.waitFor(`document.querySelector('#weapon').options.length > 0`);
    // 設定画面のパッドの状態が「使用中」（入力に使っている）ことを、HUD と同じ状態の表示で確かめる。
    expect(await text(page, '#settings-pad-status')).not.toContain('標準配置でない');

    const snapshot = () =>
      page.evaluate<{ weapon: string; mode: string; count: string; focus: string; hash: string }>(
        `({ weapon: document.querySelector('#weapon').value, mode: document.querySelector('#mode').value, count: document.querySelector('#count').value, focus: window.__focused(), hash: location.hash })`,
      );
    const before = await snapshot();
    expect(before.focus).toBe('');
    for (const b of [12, 13, 14, 15, 13, 15, 0, 1]) {
      await tap(page, b);
      expect(await snapshot(), `ボタン ${b}`).toEqual(before);
    }
    for (const [a, v] of [[1, 1], [0, 1], [1, -1], [0, -1]] as const) {
      await flick(page, a, v);
      expect(await snapshot(), `軸 ${a} = ${v}`).toEqual(before);
    }
    noExceptions(page);
  }, 90_000);

  // -------------------------------------------------------------------------
  describe('PAD-33: 右スティック・R2 / RT・L2 / LT は画面の項目の操作に使わない', () => {
    /** 右スティック・R2・L2 を押し続け（繰り返しの時間もページの時計で過ぎる）、離す。 */
    const aimButtons = async (page: Page) => {
      for (const [a, v] of [[2, 1], [2, -1], [3, 1], [3, -1]] as const) {
        await axis(page, a, v);
        await page.frames(2);
        await page.advanceClock(0.5);
        await axis(page, a, 0);
        await page.frames(3);
      }
      for (const b of [R2, L2]) {
        await button(page, b, 1);
        await page.frames(2);
        await page.advanceClock(0.5);
        await button(page, b, 0);
        await page.frames(3);
      }
    };

    it('PAD-33: トップ画面', async () => {
      const page = await openFresh({ clock: true });
      await page.waitFor(`${screenVisible('top')} && document.querySelector('#weapon').options.length > 0`);
      const state = () =>
        page.evaluate<unknown>(`({ weapon: document.querySelector('#weapon').value, mode: document.querySelector('#mode').value, count: document.querySelector('#count').value, focus: window.__focused(), hash: location.hash })`);
      // フォーカスがないとき
      const s0 = await state();
      await aimButtons(page);
      expect(await state()).toEqual(s0);
      // 武器にフォーカスがあるとき
      await tap(page, DOWN);
      const s1 = await state();
      expect((s1 as { focus: string }).focus).toBe('weapon');
      await aimButtons(page);
      expect(await state()).toEqual(s1);
      noExceptions(page);
    }, 60_000);

    it('PAD-33: 設定画面', async () => {
      const page = await openFresh({ path: '#/settings', clock: true });
      await page.waitFor(screenVisible('settings'));
      const state = () =>
        page.evaluate<unknown>(`({ fov: document.querySelector('#setting-fov').value, method: document.querySelector('#setting-input-method').value, focus: window.__focused(), hash: location.hash,
          stored: Object.keys(localStorage).sort().map((k) => k + '=' + localStorage.getItem(k)).join('|') })`);
      const s0 = await state();
      await aimButtons(page);
      expect(await state()).toEqual(s0);
      await focusDownTo(page, 'setting-fov');
      const s1 = await state();
      await aimButtons(page);
      expect(await state()).toEqual(s1);
      noExceptions(page);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  it('INP-15: 「自動」で今がマウスのとき、パッドのメニュー操作だけで始めると HUD はマウスのまま、R2 / RT でパッドに変わり、その練習はパッド', async () => {
    const page = await openFresh({ clock: true });
    expect(await selectedLabel(page, '#setting-input-method')).toBe('自動');
    await padStart(page, CAR);
    await page.frames(10);
    expect(await hudInput(page)).toContain(MOUSE_LABEL);
    expect(await hudInput(page)).not.toContain(PAD_LABEL);

    await button(page, R2, 1);
    await page.waitFor(`(document.querySelector('[data-hud="input"]')?.textContent ?? '').includes(${JSON.stringify(PAD_LABEL)})`, 3000);
    await page.advanceClockUntil(`location.hash === '#/result'`, { step: 0.05 });
    await button(page, R2, 0);
    const keys = await page.evaluate<string[]>('Object.keys(localStorage)');
    expect(keys).toContain(`${BEST_PREFIX}pad:${CAR.id}:ghost`);
    expect(keys).not.toContain(`${BEST_PREFIX}mouse:${CAR.id}:ghost`);
    expect(keys).toContain(`${HISTORY_PREFIX}pad:${CAR.id}:ghost`);
    expect(keys).not.toContain(`${HISTORY_PREFIX}mouse:${CAR.id}:ghost`);
    noExceptions(page);
  }, 90_000);

  // -------------------------------------------------------------------------
  it('INP-16: 「自動」で今がパッドのとき、リザルトでマウスで「もう一度」を押しても新しい練習の HUD はパッドのまま', async () => {
    const page = await openFresh({ clock: true });
    await padStart(page, CAR);
    await shootOut(page);
    await page.frames(5);
    await page.evaluate(`document.querySelector('#retry').scrollIntoView({ block: 'center' })`);
    await page.frames(2);
    await page.clickSelector('#retry');
    await page.waitFor(`location.hash === '#/play' && ${screenVisible('play')} && window.__ammo() === ${CAR.magSize}`, 10_000);
    await page.frames(20);
    expect(await hudInput(page)).toContain(PAD_LABEL);
    expect(await hudInput(page)).not.toContain(MOUSE_LABEL);
    noExceptions(page);
  }, 90_000);
});
