// docs/spec/pad.md「接続と配置」「入力に使うパッド」「パッドの一覧」「ボタン割り当て」「パッドの設定画面」「キャリブレーション」「振動」と、
// docs/spec/screens.md のパッドの区分の QA の受け入れテスト（PAD-2・PAD-3・PAD-8・PAD-9・PAD-21〜PAD-30、UI-40〜UI-42）。
// 公開された入口（ビルドの結果を /apex-training/ で配信した画面、index.html の要素、武器の JSON、SPEC の localStorage のキー）
// だけを使い、実装の内部には依存しない。画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、
// パッドは Gamepad API（navigator.getGamepads と vibrationActuator.playEffect）の形で与える。
// 照準の反応は、反復練習の中心の的の色が画面の中心から外れるか（画面写しの中心の画素）で読む。
// ヨーの量（PAD-28）は、clock=manual で開いたページの時計をテストが進め、
// 回した結果の画面写しを、同じヨーになるはずの別の回し方（既定のヨー速度 300 で左に 0.7 秒 = −210 度 ≡ +150 度）の画面写しと比べて読む。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
const NOT_FOUND = 'パッドが見つかりません。パッドのボタンを押してください';
const NOT_STANDARD = '標準配置でないパッドです（ボタン割り当てが必要）';
const NO_VIBRATION = 'このパッドまたはブラウザは振動に対応していません';
const AIM_ASSIST = 'エイムアシストは再現しません。エイムアシストなしの素のリコイル制御を練習します';
const NOT_EXACT = 'ゲームと完全に一致するものではなく、近い感覚で練習できます';
const IN_USE = '使用中';
const MODE = '反復練習';
const MOUSE_KEY = 'apex-training:settings:mouse';

/** パッドの名前（Gamepad API の id）。HUD では最初の「 (」より前を表示する（pad.md）。 */
const STD_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const STD_NAME = 'Xbox Wireless Controller';
const GENERIC_ID = 'Generic USB Joystick (Vendor: 0079 Product: 0006)';
const GENERIC_NAME = 'Generic USB Joystick';

interface WeaponJson {
  id: string;
  name: string;
  rpm: number;
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

type RGB = [number, number, number];
const distance = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** テストで与えるパッド 1 台の定義（sessionStorage に入れ、再読み込みしても同じパッドがつながっている）。 */
interface PadDef {
  index: number;
  id: string;
  mapping: string;
  connected?: boolean;
  /** 'ok': playEffect のある vibrationActuator を持つ。'none': vibrationActuator のプロパティがない。 */
  vibration?: 'ok' | 'none';
}
const standardPad = (index = 0, vibration: 'ok' | 'none' = 'ok'): PadDef => ({ index, id: STD_ID, mapping: 'standard', vibration });
const genericPad = (index = 0, id = GENERIC_ID): PadDef => ({ index, id, mapping: '', vibration: 'none' });

/**
 * Gamepad API の形のパッド。sessionStorage の __qaPads の定義から作り、navigator.getGamepads は長さ 4 の配列（空きは null）を返す。
 * __axis(番号, 軸, 値)・__button(番号, ボタン, 値) で操作する。振動の要求は __rumble に残す。
 * __clock.step(ms) は、clock=manual で開いたページの時計を ms だけ進め、描画を 1 回行う。
 */
const PAGE_INIT = `
(() => {
  let defs = [];
  try { defs = JSON.parse(sessionStorage.getItem('__qaPads') || '[]'); } catch {}
  window.__rumble = [];
  window.__pads = defs.map((d) => ({ ...d, connected: d.connected !== false, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) }));
  const actuators = new Map();
  const actuatorOf = (p) => {
    if (!actuators.has(p.index)) actuators.set(p.index, { type: 'dual-rumble',
      playEffect: (type, params) => { window.__rumble.push({ index: p.index, type, params: { ...params } }); return Promise.resolve('complete'); },
      reset: () => Promise.resolve('complete') });
    return actuators.get(p.index);
  };
  navigator.getGamepads = () => {
    const out = [null, null, null, null];
    for (const p of window.__pads) {
      const g = { id: p.id, index: p.index, connected: p.connected, mapping: p.mapping, timestamp: performance.now(),
        axes: p.axes.slice(), buttons: p.buttons.map((b) => ({ ...b })) };
      if (p.vibration !== 'none') g.vibrationActuator = actuatorOf(p);
      out[p.index] = g;
    }
    return out;
  };
  const padAt = (i) => window.__pads.find((p) => p.index === i);
  window.__axis = (i, a, v) => { padAt(i).axes[a] = v; };
  window.__button = (i, b, v) => { padAt(i).buttons[b] = { value: v, pressed: v >= 0.5, touched: v > 0 }; };
  window.__releaseAll = (i) => { const p = padAt(i); p.axes = p.axes.map(() => 0); p.buttons = p.buttons.map(() => ({ value: 0, pressed: false, touched: false })); };
  window.__ammo = () => { const m = (document.querySelector('[data-hud="ammo"]')?.textContent ?? '').match(/\\d+/); return m ? Number(m[0]) : NaN; };
  window.__hudTime = () => (document.querySelector('[data-hud="time"]')?.textContent ?? '').trim();
  window.__shown = (sel) => { const el = document.querySelector(sel); if (!el || el.closest('[hidden]')) return false;
    const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0; };
  window.__text = (sel) => (document.querySelector(sel)?.textContent ?? '').replace(/\\s+/g, ' ').trim();

  window.__clock = { step(ms) { window.__apexTestClock.advance(ms / 1000, ms / 1000); } };
})();
`;

/** パッドの状態を読める画面の要素。 */
const HUD_PAD = '[data-hud="pad"]';
const SETTINGS_PAD = '#settings-pad-status';
const CALIBRATION_PAD = '#calibration-status';

const ammo = (page: Page) => page.evaluate<number>('window.__ammo()');
const hash = (page: Page) => page.evaluate<string>('location.hash');
const text = (page: Page, sel: string) => page.evaluate<string>(`window.__text(${JSON.stringify(sel)})`);
const shown = (page: Page, sel: string) => page.evaluate<boolean>(`window.__shown(${JSON.stringify(sel)})`);
const axis = (page: Page, pad: number, a: number, v: number) => page.evaluate(`window.__axis(${pad}, ${a}, ${v})`);
const button = (page: Page, pad: number, b: number, v: number) => page.evaluate(`window.__button(${pad}, ${b}, ${v})`);
const screenVisible = (name: string) => `!!document.querySelector('[data-screen="${name}"]') && !document.querySelector('[data-screen="${name}"]').hidden`;
const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));
const noExceptions = (page: Page) => expect(exceptions(page), page.errors.join('\n')).toEqual([]);

/** 選択肢の表示名から値を選ぶ（キーボードで選んだときと同じく change を出す）。 */
async function choose(page: Page, selector: string, label: string) {
  const ok = await page.evaluate<boolean>(`(() => {
    const s = document.querySelector(${JSON.stringify(selector)});
    const o = [...s.options].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  if (!ok) throw new Error(`${selector} に ${label} の選択肢がない`);
}
const selectedLabel = (page: Page, selector: string) =>
  page.evaluate<string>(`document.querySelector(${JSON.stringify(selector)}).selectedOptions[0]?.textContent.trim() ?? ''`);
const value = (page: Page, selector: string) => page.evaluate<string>(`document.querySelector(${JSON.stringify(selector)}).value`);

async function press(page: Page, key: 'Enter') {
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
  }
}

/** 入力欄にキーボードで入力し、Enter で確定する。 */
async function typeInto(page: Page, selector: string, value: string) {
  await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); document.activeElement?.blur?.(); el.scrollIntoView({ block: 'center' }); el.focus(); el.select(); })()`);
  await page.send('Input.insertText', { text: value });
  await press(page, 'Enter');
  await page.frames(3);
}

/** 要素を見える位置に出してからマウスでクリックする。 */
async function clickOn(page: Page, selector: string) {
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`);
  await page.frames(2);
  await page.clickSelector(selector);
}

async function openSettings(page: Page) {
  await page.evaluate(`location.hash = '#/settings'`);
  await page.waitFor(screenVisible('settings'));
  await page.frames(3);
}

/** 設定画面で入力方式を選ぶ。 */
async function setInputMethod(page: Page, label: string) {
  await openSettings(page);
  await choose(page, '#setting-input-method', label);
  await page.frames(3);
}

/**
 * トップ画面で武器とモードを選び、「開始」をキーボード（フォーカスして Enter）で押してプレイ画面に入る
 * （screens.md「武器とモードはマウスのクリック（またはキーボード）で選ぶ」）。
 */
async function start(page: Page, weapon: WeaponJson, mode = MODE) {
  await page.evaluate(`location.hash = '#/'`);
  await page.waitFor(`${screenVisible('top')} && document.querySelector('#weapon').options.length > 0 && document.querySelector('#mode').options.length > 0`);
  await choose(page, '#weapon', weapon.name);
  await choose(page, '#mode', mode);
  await page.evaluate(`document.querySelector('[data-screen="top"] a[href="#/play"]').focus()`);
  await press(page, 'Enter');
  await page.waitFor(`location.hash === '#/play' && ${screenVisible('play')} && window.__ammo() === ${weapon.magSize}`, 10_000);
  await page.frames(31);
}

/** HTML の画面を見えなくし、キャンバスだけを写す（HUD の文字は textContent で読める）。 */
async function hideHtml(page: Page) {
  await page.evaluate(`document.getElementById('ui').style.visibility = 'hidden'`);
  await page.frames(19);
}

async function screenshot(page: Page): Promise<Image> {
  const { data } = await page.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  return decodePng(Buffer.from(data, 'base64'));
}
const center = async (page: Page) => (await screenshot(page)).pixel(CX, CY);

/** 照準が動いて、画面の中心の色が的の色から外れるまで待つ。 */
const waitAimMoved = (page: Page, target: RGB, what: string) =>
  waitUntil(async () => distance(await center(page), target) > 30, what, { timeout: 5000 });

/** ボタン割り当て画面の表示に、番号 n が出ているか（「ボタン 5」「5」などの表記によらない）。 */
const showsNumber = (page: Page, sel: string, n: number) =>
  page.evaluate<boolean>(`new RegExp('(^|\\\\D)${n}(\\\\D|$)').test(window.__text(${JSON.stringify(sel)}))`);

/**
 * ボタン割り当て画面で、番号 pad のパッドに fire = ボタン 5、ads = ボタン 4、右スティックの左右 = 軸 0、上下 = 軸 1 を割り当てる。
 * 項目ごとに「割り当てる」を押してから操作する（pad.md「ボタン割り当て」）。
 */
async function assignAll(page: Page, pad = 0) {
  await page.waitFor(`${screenVisible('settings-pad-mapping')} && window.__shown('#mapping-body')`);
  const steps: { item: string; act: (v: number) => Promise<unknown>; n: number; guide?: string }[] = [
    { item: 'fire', act: (v) => button(page, pad, 5, v), n: 5 },
    { item: 'ads', act: (v) => button(page, pad, 4, v), n: 4 },
    { item: 'lookX', act: (v) => axis(page, pad, 0, v * 0.9), n: 0, guide: '右に倒してください' },
    { item: 'lookY', act: (v) => axis(page, pad, 1, -v * 0.9), n: 1, guide: '上に倒してください' },
  ];
  for (const s of steps) {
    await clickOn(page, `[data-assign="${s.item}"]`);
    await page.frames(3);
    if (s.guide) {
      await page.waitFor(`document.querySelector('[data-screen="settings-pad-mapping"]').innerText.includes(${JSON.stringify(s.guide)})`, 3000);
    }
    await s.act(1);
    await waitUntil(() => showsNumber(page, `#mapping-${s.item}`, s.n), `${s.item} の割り当ての表示に ${s.n} が出る`, { timeout: 3000 });
    await s.act(0);
    await page.frames(3);
  }
}

/** キャリブレーション画面の一覧の行（セルの文字）。 */
const calibrationRows = (page: Page) =>
  page.evaluate<string[][]>(`[...document.querySelectorAll('#calibration-list tr')].map((tr) => [...tr.cells].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()))`);

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('QA: パッドの設定・キャリブレーション・ボタン割り当て・振動・パッドの状態の表示', () => {
  let work = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';

  /**
   * 新しいタブで localStorage を空にし（seed を入れ）、pads のパッドをつないだ状態で読み込み直したトップ画面を開く。
   * clock なら、ページの時計をテストが進める（clock=manual）。render のときだけ 3D を描画する（画面の中心の色を読むテスト）。
   */
  async function openFresh({
    pads = [standardPad()],
    seed = {},
    clock = false,
    render = false,
  }: { pads?: PadDef[]; seed?: Record<string, string>; clock?: boolean; render?: boolean } = {}): Promise<Page> {
    const page = await browser!.newPage();
    await page.addInitScript(PAGE_INIT);
    await page.goto(appUrl(origin, BASE, '#/', { render, manualClock: clock, seed: SEED }));
    await page.evaluate(`(() => { localStorage.clear(); const seed = ${JSON.stringify(seed)}; for (const k in seed) localStorage.setItem(k, seed[k]);
      sessionStorage.setItem('__qaPads', ${JSON.stringify(JSON.stringify(pads))}); })()`);
    await reload(page);
    await page.waitFor(screenVisible('top'), 15_000);
    return page;
  }

  /** 再読み込みする（つないだパッドの定義と localStorage は残る）。 */
  async function reload(page: Page) {
    await page.evaluate('window.__beforeReload = true');
    await page.send('Page.reload', { ignoreCache: false });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && !!window.__pads`, 15_000);
    await page.frames(5);
  }

  /** つないでいるパッドを入れ替えて再読み込みする。 */
  async function replacePads(page: Page, pads: PadDef[]) {
    await page.evaluate(`sessionStorage.setItem('__qaPads', ${JSON.stringify(JSON.stringify(pads))})`);
    await reload(page);
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'pad-settings-qa-'));
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
  describe('PAD-2: パッドが 1 つも見つかっていないとき、設定画面と「自動」の練習中の HUD に「見つかりません」が出る', () => {
    it('パッドの設定画面', async () => {
      const page = await openFresh({ pads: [] });
      await openSettings(page);
      await page.waitFor(`window.__text('${SETTINGS_PAD}').includes(${JSON.stringify(NOT_FOUND)})`, 3000);
      expect(await shown(page, SETTINGS_PAD)).toBe(true);
      noExceptions(page);
    });

    it('入力方式の設定が「自動」の練習中の HUD', async () => {
      const page = await openFresh({ pads: [] });
      expect(await selectedLabel(page, '#setting-input-method')).toBe('自動');
      await start(page, byId('lstar'));
      await page.waitFor(`window.__text('${HUD_PAD}').includes(${JSON.stringify(NOT_FOUND)})`, 3000);
      expect(await shown(page, HUD_PAD)).toBe(true);
      noExceptions(page);
    });
  });

  // -------------------------------------------------------------------------
  it('PAD-3: 標準配置でないパッドだけでトップ画面でボタンを押すと割り当て画面が出て、割り当てたボタンで撃て、割り当てた軸で照準が動く', async () => {
    const page = await openFresh({ pads: [genericPad()], render: true });
    expect(await hash(page)).toBe('#/');
    // トップ画面で、そのパッドのボタン（0）を押す。
    await button(page, 0, 0, 1);
    await page.waitFor(`location.hash === '#/settings/pad/mapping' && ${screenVisible('settings-pad-mapping')}`, 5000);
    await button(page, 0, 0, 0);
    // 割り当て画面の対象の名前は次の描画で出るので、出るまで待つ。
    await page.waitFor(`window.__text('#mapping-target').includes(${JSON.stringify(GENERIC_NAME)})`, 3000);
    expect(await text(page, '#mapping-target')).toContain(GENERIC_NAME);
    await assignAll(page);

    // 練習を始める（入力方式は既定の「自動」）。
    const w = byId('lstar');
    await start(page, w);
    expect(await text(page, HUD_PAD)).not.toContain(NOT_STANDARD);
    await hideHtml(page);
    const target = await center(page);
    // 割り当てた軸（軸 0）を倒すと照準が動く。
    await axis(page, 0, 0, 0.5);
    await waitAimMoved(page, target, '割り当てた軸（軸 0）で照準が動き、画面の中心の色が的の色から外れる');
    await axis(page, 0, 0, 0);
    // fire に割り当てたボタン（5）で撃てる。
    await button(page, 0, 5, 1);
    await page.waitFor(`window.__ammo() < ${w.magSize}`, 3000);
    await button(page, 0, 5, 0);
    expect(await hash(page)).toBe('#/play');
    noExceptions(page);
  }, 90_000);

  // -------------------------------------------------------------------------
  describe('PAD-8: 振動 OFF では振動の要求が出ず、ON では 1 発ごとに 60 ms・強 0.2・弱 0.5 の dual-rumble が 1 回出る', () => {
    it('振動 ON（既定）: 撃った弾の数と同じ回数、SPEC の値で要求が出る', async () => {
      const page = await openFresh({ pads: [standardPad(0, 'ok')], clock: true });
      await openSettings(page);
      expect(await page.evaluate<boolean>(`document.getElementById('setting-pad-vibration').checked`)).toBe(true);
      const w = byId('lstar');
      await start(page, w);
      expect(await page.evaluate<number>('window.__rumble.length')).toBe(0);
      // 何発か撃って離し、その時点の要求の数が撃った弾の数と同じ。
      await button(page, 0, 7, 1);
      await page.frames(2);
      await page.advanceClockUntil(`window.__ammo() <= ${w.magSize - 5}`);
      await button(page, 0, 7, 0);
      await page.frames(6);
      const mid = await page.evaluate<{ ammo: number; count: number }>(`({ ammo: window.__ammo(), count: window.__rumble.length })`);
      expect(mid.count).toBe(w.magSize - mid.ammo);
      // 撃ち切る。
      await button(page, 0, 7, 1);
      await page.frames(2);
      await page.advanceClockUntil(`location.hash === '#/result'`);
      await button(page, 0, 7, 0);
      const rumble = await page.evaluate<{ index: number; type: string; params: Record<string, number> }[]>('window.__rumble');
      expect(rumble).toHaveLength(w.magSize);
      for (const r of rumble) {
        expect(r.index).toBe(0);
        expect(r.type).toBe('dual-rumble');
        expect(r.params.duration).toBe(60);
        expect(r.params.strongMagnitude).toBeCloseTo(0.2, 9);
        expect(r.params.weakMagnitude).toBeCloseTo(0.5, 9);
      }
      noExceptions(page);
    }, 60_000);

    it('振動 OFF: 撃ち切っても要求が出ない', async () => {
      const page = await openFresh({ pads: [standardPad(0, 'ok')], clock: true });
      await openSettings(page);
      await clickOn(page, '#setting-pad-vibration');
      await page.waitFor(`!document.getElementById('setting-pad-vibration').checked`);
      const w = byId('lstar');
      await start(page, w);
      await button(page, 0, 7, 1);
      await page.frames(2);
      await page.advanceClockUntil(`location.hash === '#/result'`);
      await button(page, 0, 7, 0);
      expect(await page.evaluate<number>('window.__rumble.length')).toBe(0);
      noExceptions(page);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  it('PAD-9: パッドの設定画面に、エイムアシストを再現しないことと、ゲームと完全一致ではないことが表示される', async () => {
    const page = await openFresh();
    await openSettings(page);
    const visible = await page.evaluate<string>(`document.querySelector('[data-screen="settings"]').innerText`);
    expect(visible).toContain(AIM_ASSIST);
    expect(visible).toContain(NOT_EXACT);
    noExceptions(page);
  });

  // -------------------------------------------------------------------------
  it('PAD-21: キャリブレーション画面で、右スティックの軸を 0.6 にすると 0.60、R2 を 0.3 にすると 0.30 と表示される', async () => {
    const page = await openFresh({ pads: [standardPad()] });
    await page.evaluate(`location.hash = '#/settings/pad'`);
    await page.waitFor(`${screenVisible('settings-pad')} && document.querySelectorAll('#calibration-axes li').length >= 4 && document.querySelectorAll('#calibration-buttons li').length >= 8`);
    const axisText = () => page.evaluate<string>(`document.querySelectorAll('#calibration-axes li')[2].textContent`);
    const buttonText = () => page.evaluate<string>(`document.querySelectorAll('#calibration-buttons li')[7].textContent`);
    expect(await axisText()).toContain('0.00');
    expect(await buttonText()).toContain('0.00');
    await axis(page, 0, 2, 0.6);
    await page.waitFor(`document.querySelectorAll('#calibration-axes li')[2].textContent.includes('0.60')`, 3000);
    await button(page, 0, 7, 0.3);
    await page.waitFor(`document.querySelectorAll('#calibration-buttons li')[7].textContent.includes('0.30')`, 3000);
    // ほかの軸・ボタンは 0 のまま。
    expect(await page.evaluate<string>(`document.querySelectorAll('#calibration-axes li')[0].textContent`)).toContain('0.00');
    expect(await page.evaluate<string>(`document.querySelectorAll('#calibration-buttons li')[6].textContent`)).toContain('0.00');
    noExceptions(page);
  });

  // -------------------------------------------------------------------------
  it('PAD-22: キャリブレーション画面でデッドゾーンを 10 から 20 に変えると、デッドゾーンの円の半径が 2 倍になる', async () => {
    const page = await openFresh({ pads: [standardPad()] });
    await page.evaluate(`location.hash = '#/settings/pad'`);
    await page.waitFor(screenVisible('settings-pad'));
    await page.frames(3);
    expect(await value(page, '#calibration-deadzone-input')).toBe('10');
    const radius = () => page.evaluate<number>(`document.getElementById('calibration-deadzone').getBBox().width / 2`);
    const edge = () => page.evaluate<number>(`document.querySelector('#calibration-stick .stick-edge').getBBox().width / 2`);
    const before = await radius();
    expect(before).toBeGreaterThan(0);
    // 半径は傾き 1 の円の 0.1 倍（デッドゾーン ÷ 100）。
    expect(before / (await edge())).toBeCloseTo(0.1, 3);
    await typeInto(page, '#calibration-deadzone-input', '20');
    await waitUntil(async () => Math.abs((await radius()) / before - 2) < 1e-6, 'デッドゾーンの円の半径が 2 倍になる', { timeout: 3000 });
    expect(await value(page, '#calibration-deadzone-input')).toBe('20');
    // パッドの設定のデッドゾーンも同じ値になる。
    await openSettings(page);
    expect(await value(page, '#setting-pad-deadzone')).toBe('20');
    noExceptions(page);
  });

  // -------------------------------------------------------------------------
  describe('PAD-23: 振動に対応しないパッドで撃ってもエラーにならず、撃ち切るとリザルトに移り、設定画面に案内が出る', () => {
    it('vibrationActuator がないパッドで撃ち切る', async () => {
      const page = await openFresh({ pads: [standardPad(0, 'none')], clock: true });
      const w = byId('lstar');
      await start(page, w);
      await button(page, 0, 7, 1);
      await page.frames(2);
      await page.advanceClockUntil(`window.__ammo() <= ${w.magSize - 3}`);
      expect(await hash(page)).toBe('#/play');
      await page.advanceClockUntil(`location.hash === '#/result'`);
      await page.waitFor(`location.hash === '#/result' && ${screenVisible('result')}`, 20_000);
      await button(page, 0, 7, 0);
      noExceptions(page);
    }, 60_000);

    it('パッドの設定画面に「このパッドまたはブラウザは振動に対応していません」と出る（対応するパッドでは出ない）', async () => {
      const page = await openFresh({ pads: [standardPad(0, 'none')] });
      await openSettings(page);
      await page.waitFor(`window.__shown('#settings-pad-vibration-notice')`, 3000);
      const visible = await page.evaluate<string>(`document.querySelector('[data-screen="settings"]').innerText`);
      expect(visible).toContain(NO_VIBRATION);

      const ok = await openFresh({ pads: [standardPad(0, 'ok')] });
      await openSettings(ok);
      await ok.frames(10);
      expect(await ok.evaluate<string>(`document.querySelector('[data-screen="settings"]').innerText`)).not.toContain(NO_VIBRATION);
      noExceptions(page);
    });
  });

  // -------------------------------------------------------------------------
  describe('PAD-24: 標準配置でないパッド（割り当てなし）だけのとき、HUD と設定画面に案内と名前が出て、操作しても照準と射撃は反応しない', () => {
    it('パッドの設定画面', async () => {
      const page = await openFresh({ pads: [genericPad()] });
      await openSettings(page);
      await page.waitFor(`window.__text('${SETTINGS_PAD}').includes(${JSON.stringify(NOT_STANDARD)})`, 3000);
      expect(await text(page, SETTINGS_PAD)).toContain(GENERIC_NAME);
      noExceptions(page);
    });

    for (const method of ['自動', 'パッド']) {
      it(`入力方式「${method}」の練習中の HUD と、操作しても反応しないこと`, async () => {
        const page = await openFresh({ pads: [genericPad()], render: true });
        await setInputMethod(page, method);
        const w = byId('lstar');
        await start(page, w);
        await page.waitFor(`window.__text('${HUD_PAD}').includes(${JSON.stringify(NOT_STANDARD)})`, 3000);
        expect(await text(page, HUD_PAD)).toContain(GENERIC_NAME);
        expect(await shown(page, HUD_PAD)).toBe(true);
        await hideHtml(page);
        const target = await center(page);
        // すべての軸を倒し、すべてのボタンを押したまま 1 秒ほど保つ。
        await page.evaluate(`(() => { const p = window.__pads[0]; p.axes = [1, 1, 1, 1];
          p.buttons = p.buttons.map(() => ({ value: 1, pressed: true, touched: true })); })()`);
        await page.frames(60);
        expect(await ammo(page), '撃たない').toBe(w.magSize);
        expect(distance(await center(page), target), '照準が動かない').toBeLessThan(20);
        expect(await hash(page)).toBe('#/play');
        await page.evaluate('window.__releaseAll(0)');
        noExceptions(page);
      }, 60_000);
    }
  });

  // -------------------------------------------------------------------------
  describe('PAD-25: 番号 0 に標準配置でないパッド、番号 1 に標準配置のパッドがあるとき、番号 1 のパッドを使う', () => {
    const pads = [genericPad(0), standardPad(1)];

    it('番号 1 のパッドで照準と射撃ができ、HUD に番号 1 のパッドの名前が出る（番号 0 のパッドの操作は無視される）', async () => {
      const page = await openFresh({ pads, render: true });
      const w = byId('lstar');
      await start(page, w);
      await page.waitFor(`window.__text('${HUD_PAD}').includes(${JSON.stringify(STD_NAME)})`, 3000);
      expect(await text(page, HUD_PAD)).not.toContain(NOT_STANDARD);
      expect(await text(page, HUD_PAD)).not.toContain(GENERIC_NAME);
      await hideHtml(page);
      const target = await center(page);
      // 番号 0 のパッドの右スティック（軸 2）と R2（ボタン 7）は反応しない。
      await axis(page, 0, 2, 1);
      await button(page, 0, 7, 1);
      await page.frames(40);
      expect(await ammo(page)).toBe(w.magSize);
      expect(distance(await center(page), target)).toBeLessThan(20);
      await page.evaluate('window.__releaseAll(0)');
      // 番号 1 のパッドの右スティックで照準が動き、R2 で撃てる。
      await axis(page, 1, 2, 0.5);
      await waitAimMoved(page, target, '番号 1 のパッドの右スティックで照準が動く');
      await axis(page, 1, 2, 0);
      await button(page, 1, 7, 1);
      await page.waitFor(`window.__ammo() < ${w.magSize}`, 3000);
      await button(page, 1, 7, 0);
      noExceptions(page);
    }, 60_000);

    it('キャリブレーション画面の一覧で番号 1 の行だけに「使用中」が出る', async () => {
      const page = await openFresh({ pads });
      await page.evaluate(`location.hash = '#/settings/pad'`);
      await page.waitFor(`${screenVisible('settings-pad')} && document.querySelectorAll('#calibration-list tr').length === 2`);
      const rows = await calibrationRows(page);
      const row0 = rows.find((r) => r[0] === '0')!;
      const row1 = rows.find((r) => r[0] === '1')!;
      expect(row0, JSON.stringify(rows)).toBeDefined();
      expect(row1, JSON.stringify(rows)).toBeDefined();
      expect(row1.join('|')).toContain(IN_USE);
      expect(row0.join('|')).not.toContain(IN_USE);
      // キャリブレーション画面の状態の表示も番号 1 のパッドの名前になる。
      await page.waitFor(`window.__text('${CALIBRATION_PAD}').includes(${JSON.stringify(STD_NAME)})`, 3000);
      noExceptions(page);
    });
  });

  // -------------------------------------------------------------------------
  it('PAD-26: キャリブレーション画面の一覧に、番号・名前・配置・標準配置・割り当て・接続が出る', async () => {
    const MAPPED_ID = 'Mapped Arcade Pad (Vendor: 1234 Product: 5678)';
    const GONE_ID = 'Unplugged Pad (Vendor: abcd Product: 0001)';
    // 割り当てのあるパッドを作る（ボタン割り当て画面で割り当てる）。
    const page = await openFresh({ pads: [genericPad(0, MAPPED_ID)] });
    await page.evaluate(`location.hash = '#/settings/pad/mapping'`);
    await assignAll(page, 0);
    await replacePads(page, [standardPad(0), genericPad(1, GENERIC_ID), genericPad(2, MAPPED_ID), { ...genericPad(3, GONE_ID), connected: false }]);
    await page.evaluate(`location.hash = '#/settings/pad'`);
    await page.waitFor(`${screenVisible('settings-pad')} && window.__shown('#calibration-table') && document.querySelectorAll('#calibration-list tr').length === 4`);
    await page.frames(5);
    const rows = await calibrationRows(page);
    const headers = await page.evaluate<string[]>(`[...document.querySelectorAll('#calibration-table thead th')].map((th) => th.textContent.trim())`);
    const col = (name: string) => headers.indexOf(name);
    for (const h of ['番号', '名前', '配置', '標準配置', '割り当て', '接続']) expect(col(h), h).toBeGreaterThanOrEqual(0);
    const expected = [
      { 番号: '0', 名前: STD_ID, 配置: 'standard', 標準配置: 'はい', 割り当て: '—', 接続: 'はい' },
      { 番号: '1', 名前: GENERIC_ID, 配置: '（空）', 標準配置: 'いいえ', 割り当て: 'なし', 接続: 'はい' },
      { 番号: '2', 名前: MAPPED_ID, 配置: '（空）', 標準配置: 'いいえ', 割り当て: '済み', 接続: 'はい' },
      { 番号: '3', 名前: GONE_ID, 配置: '（空）', 標準配置: 'いいえ', 割り当て: 'なし', 接続: 'いいえ' },
    ];
    expect(rows.map((r) => r[col('番号')])).toEqual(['0', '1', '2', '3']);
    for (const [i, e] of expected.entries()) {
      const r = rows[i]!;
      for (const [k, v] of Object.entries(e)) expect(r[col(k)], `${i} 行目の ${k}: ${JSON.stringify(rows)}`).toBe(v);
    }
    noExceptions(page);
  }, 90_000);

  // -------------------------------------------------------------------------
  it('PAD-27: 割り当てを保存して再読み込みしても残っていて使えるパッドになり、「割り当てを消す」で標準配置でないパッドの扱いに戻る', async () => {
    const page = await openFresh({ pads: [genericPad()], render: true });
    await page.evaluate(`location.hash = '#/settings/pad/mapping'`);
    await assignAll(page);
    expect(await page.evaluate<string | null>(`localStorage.getItem('apex-training:pad-mapping')`)).toContain(GENERIC_ID);

    await reload(page);
    await page.evaluate(`location.hash = '#/settings/pad/mapping'`);
    await page.waitFor(`${screenVisible('settings-pad-mapping')} && window.__shown('#mapping-body')`);
    await page.frames(3);
    expect(await showsNumber(page, '#mapping-fire', 5)).toBe(true);
    expect(await showsNumber(page, '#mapping-ads', 4)).toBe(true);
    expect(await showsNumber(page, '#mapping-lookX', 0)).toBe(true);
    expect(await showsNumber(page, '#mapping-lookY', 1)).toBe(true);
    // 使えるパッドになっている（設定画面の状態が名前になり、練習で割り当てたボタンで撃てる）。
    await openSettings(page);
    await page.waitFor(`window.__text('${SETTINGS_PAD}').includes(${JSON.stringify(GENERIC_NAME)})`, 3000);
    expect(await text(page, SETTINGS_PAD)).not.toContain(NOT_STANDARD);
    const w = byId('lstar');
    await start(page, w);
    expect(await text(page, HUD_PAD)).not.toContain(NOT_STANDARD);
    await button(page, 0, 5, 1);
    await page.waitFor(`window.__ammo() < ${w.magSize}`, 3000);
    await button(page, 0, 5, 0);

    // 割り当てを消す。
    await page.evaluate(`location.hash = '#/settings/pad/mapping'`);
    await page.waitFor(`${screenVisible('settings-pad-mapping')} && window.__shown('#mapping-clear')`);
    await clickOn(page, '#mapping-clear');
    await page.frames(5);
    await openSettings(page);
    await page.waitFor(`window.__text('${SETTINGS_PAD}').includes(${JSON.stringify(NOT_STANDARD)})`, 3000);
    // 再読み込みしても標準配置でないパッドの扱いのまま。
    await reload(page);
    await openSettings(page);
    await page.waitFor(`window.__text('${SETTINGS_PAD}').includes(${JSON.stringify(NOT_STANDARD)})`, 3000);
    noExceptions(page);
  }, 120_000);

  // -------------------------------------------------------------------------
  describe('PAD-28: 設定画面でヨー速度を 150 にして始め、デッドゾーン 0・外側 0・カーブ 0 で右に倒し切って 1 秒保つと、ヨーが 150 度変わる', () => {
    /**
     * 設定画面で入力方式をパッドにし、デッドゾーン 0・外側しきい値 0・レスポンスカーブ 0・ヨー速度 yaw にして練習を始める。
     * ページの時計をテストが進めるようにし、右スティックを x（1 で右、−1 で左）に seconds 秒倒してから戻し、
     * 照準が止まったあとのキャンバスの画面写しを返す。
     */
    async function turn(yaw: number, x: number, seconds: number): Promise<{ image: Image; elapsed: [string, string] }> {
      const page = await openFresh({ pads: [standardPad()], clock: true, render: true });
      await setInputMethod(page, 'パッド');
      await typeInto(page, '#setting-pad-deadzone', '0');
      await typeInto(page, '#setting-pad-outer-threshold', '0');
      await typeInto(page, '#setting-pad-response-curve', '0');
      await typeInto(page, '#setting-pad-yaw', String(yaw));
      expect(await value(page, '#setting-pad-yaw')).toBe(String(yaw));
      expect(await value(page, '#setting-pad-deadzone')).toBe('0');
      await start(page, byId('lstar'));
      await page.evaluate(`document.getElementById('ui').style.visibility = 'hidden'`);
      await page.frames(5);
      // ここから、ページの時計はテストが進めたぶんだけ進む。固定ステップ（1/120 秒）の境目を HUD の経過時間の変わり目で見つけ、
      // そこから半ステップほどずらして、以後の 50 ms（6 ステップ）ごとの描画がステップの境目に当たらないようにする。
      const elapsed = await page.evaluate<[string, string]>(`(() => {
        const first = window.__hudTime();
        for (let i = 0; i < 400 && window.__hudTime() === first; i += 1) window.__clock.step(1);
        if (window.__hudTime() === first) throw new Error('HUD の経過時間が変わらない');
        window.__clock.step(4);
        const before = window.__hudTime();
        window.__axis(0, 2, ${x});
        for (let i = 0; i < ${Math.round(seconds * 20)}; i += 1) window.__clock.step(50);
        window.__axis(0, 2, 0);
        for (let i = 0; i < 10; i += 1) window.__clock.step(50);
        return [before, window.__hudTime()];
      })()`);
      const image = await screenshot(page);
      expect(await hash(page)).toBe('#/play');
      noExceptions(page);
      return { image, elapsed };
    }

    /** 2 枚の画面写しの、画素ごとの色の差の平均。 */
    function meanDiff(a: Image, b: Image): number {
      let sum = 0;
      let n = 0;
      for (let y = 0; y < a.height; y += 4) {
        for (let x = 0; x < a.width; x += 4) {
          sum += distance(a.pixel(x, y), b.pixel(x, y));
          n += 1;
        }
      }
      return sum / n;
    }

    it('ヨー速度 150 で右に 1 秒 = 既定のヨー速度 300 で左に 0.7 秒（−210 度 ≡ +150 度）と同じ向きになり、300 で右に 1 秒とは違う', async () => {
      const a = await turn(150, 1, 1);
      const b = await turn(300, -1, 0.7);
      const c = await turn(300, 1, 1);
      const start0 = await turn(150, 0, 1);
      // 時計を進めたぶん、練習の時刻が進んでいる（1 秒 + 0.5 秒）。
      const seconds = (t: string) => Number(t.match(/[\d.]+/)?.[0] ?? NaN);
      expect(seconds(a.elapsed[1]) - seconds(a.elapsed[0]), JSON.stringify(a.elapsed)).toBeCloseTo(1.5, 1);
      const ab = meanDiff(a.image, b.image);
      const ac = meanDiff(a.image, c.image);
      const a0 = meanDiff(a.image, start0.image);
      expect(a0, '150 度回すと開始時と違う画面になる').toBeGreaterThan(3);
      expect(ac, '300 度回したときとは違う画面になる').toBeGreaterThan(3);
      expect(ab, `150 度 と −210 度は同じ画面になる（差 ${ab}、300 度との差 ${ac}）`).toBeLessThan(1);
    }, 240_000);
  });

  // -------------------------------------------------------------------------
  it('PAD-29: 簡易設定の間は詳細設定の欄が対応表の値を表示して変更できず、詳細設定に戻すと前の値が表示される', async () => {
    const page = await openFresh();
    await openSettings(page);
    // 詳細設定で、既定と違う値にしておく。
    await typeInto(page, '#setting-pad-yaw', '150');
    await typeInto(page, '#setting-pad-deadzone', '5');
    expect(await value(page, '#setting-pad-yaw')).toBe('150');
    expect(await value(page, '#setting-pad-deadzone')).toBe('5');

    await choose(page, '#setting-pad-mode', '簡易設定');
    await choose(page, '#setting-pad-simple-look', '2');
    await choose(page, '#setting-pad-simple-ads', '5');
    await choose(page, '#setting-pad-simple-curve', 'リニア');
    await page.frames(3);
    const fields: [string, string][] = [
      ['#setting-pad-deadzone', '10'],
      ['#setting-pad-outer-threshold', '2'],
      ['#setting-pad-response-curve', '0'],
      ['#setting-pad-yaw', '180'],
      ['#setting-pad-pitch', '156'],
      ['#setting-pad-ads-yaw', '105'],
      ['#setting-pad-ads-pitch', '91'],
    ];
    for (const [sel, v] of fields) {
      expect(await value(page, sel), sel).toBe(v);
      expect(await page.evaluate<boolean>(`(() => { const el = document.querySelector('${sel}'); return el.disabled || el.readOnly || !!el.closest('fieldset:disabled'); })()`), `${sel} は変更できない`).toBe(true);
    }
    // キーボードで入力しようとしても変わらない。
    await typeInto(page, '#setting-pad-yaw', '999');
    expect(await value(page, '#setting-pad-yaw')).toBe('180');

    await choose(page, '#setting-pad-mode', '詳細設定');
    await page.frames(3);
    const back: [string, string][] = [
      ['#setting-pad-deadzone', '5'],
      ['#setting-pad-outer-threshold', '2'],
      ['#setting-pad-response-curve', '2'],
      ['#setting-pad-yaw', '150'],
      ['#setting-pad-pitch', '260'],
      ['#setting-pad-ads-yaw', '90'],
      ['#setting-pad-ads-pitch', '78'],
    ];
    for (const [sel, v] of back) {
      expect(await value(page, sel), sel).toBe(v);
      expect(await page.evaluate<boolean>(`(() => { const el = document.querySelector('${sel}'); return el.disabled || el.readOnly || !!el.closest('fieldset:disabled'); })()`), `${sel} は変更できる`).toBe(false);
    }
    noExceptions(page);
  });

  // -------------------------------------------------------------------------
  it('PAD-30: 入力方式の設定が「マウス」のとき、練習中の HUD にパッドの状態が出ない（「自動」では出る）', async () => {
    const page = await openFresh({ pads: [standardPad()] });
    await setInputMethod(page, 'マウス');
    await start(page, byId('lstar'));
    await page.frames(10);
    const hidden = !(await shown(page, HUD_PAD)) || (await text(page, HUD_PAD)) === '';
    expect(hidden, `HUD のパッドの状態: ${await text(page, HUD_PAD)}`).toBe(true);
    expect(await page.evaluate<string>(`document.querySelector('[data-screen="play"]').innerText`)).not.toContain(STD_NAME);

    // 対照: 「自動」では出る。
    const auto = await openFresh({ pads: [standardPad()] });
    await start(auto, byId('lstar'));
    await auto.waitFor(`window.__shown('${HUD_PAD}') && window.__text('${HUD_PAD}').includes(${JSON.stringify(STD_NAME)})`, 3000);
    noExceptions(page);
  }, 60_000);

  // -------------------------------------------------------------------------
  it('UI-40: パッドの設定を一度も変えずに開くと、詳細設定・10・2・2・300・260・90・78、振動 ON と表示される', async () => {
    const page = await openFresh();
    await openSettings(page);
    expect(await selectedLabel(page, '#setting-pad-mode')).toBe('詳細設定');
    const fields: [string, string][] = [
      ['#setting-pad-deadzone', '10'],
      ['#setting-pad-outer-threshold', '2'],
      ['#setting-pad-response-curve', '2'],
      ['#setting-pad-yaw', '300'],
      ['#setting-pad-pitch', '260'],
      ['#setting-pad-ads-yaw', '90'],
      ['#setting-pad-ads-pitch', '78'],
    ];
    for (const [sel, v] of fields) expect(await value(page, sel), sel).toBe(v);
    expect(await page.evaluate<boolean>(`document.getElementById('setting-pad-vibration').checked`)).toBe(true);
    noExceptions(page);
  });

  // -------------------------------------------------------------------------
  it('UI-41: パッドの区分の値（簡易設定・視点感度 2・振動 OFF）を変えて再読み込みすると残っていて、マウスの区分の値は変わらない', async () => {
    const page = await openFresh();
    await openSettings(page);
    const mouseFields = ['#setting-dpi', '#setting-sensitivity', '#setting-ads-multiplier'];
    const mouseBefore = await Promise.all(mouseFields.map((s) => value(page, s)));
    const mouseStoredBefore = await page.evaluate<string | null>(`localStorage.getItem('${MOUSE_KEY}')`);

    await choose(page, '#setting-pad-mode', '簡易設定');
    await choose(page, '#setting-pad-simple-look', '2');
    await clickOn(page, '#setting-pad-vibration');
    await page.waitFor(`!document.getElementById('setting-pad-vibration').checked`);
    await page.frames(3);

    await reload(page);
    await openSettings(page);
    expect(await selectedLabel(page, '#setting-pad-mode')).toBe('簡易設定');
    expect(await selectedLabel(page, '#setting-pad-simple-look')).toBe('2');
    expect(await page.evaluate<boolean>(`document.getElementById('setting-pad-vibration').checked`)).toBe(false);
    expect(await Promise.all(mouseFields.map((s) => value(page, s)))).toEqual(mouseBefore);
    expect(await page.evaluate<string | null>(`localStorage.getItem('${MOUSE_KEY}')`)).toBe(mouseStoredBefore);
    noExceptions(page);
  });

  // -------------------------------------------------------------------------
  it('UI-42: パッドの区分のリンクからキャリブレーション画面とボタン割り当て画面を開け、それぞれから設定画面に戻れる', async () => {
    const page = await openFresh();
    await openSettings(page);
    for (const [link, url, screen] of [
      ['#link-pad-calibration', '#/settings/pad', 'settings-pad'],
      ['#link-pad-mapping', '#/settings/pad/mapping', 'settings-pad-mapping'],
    ] as const) {
      await clickOn(page, `[data-screen="settings"] ${link}`);
      await page.waitFor(`location.hash === '${url}' && ${screenVisible(screen)} && document.querySelector('[data-screen="settings"]').hidden`, 3000);
      await page.frames(3);
      await clickOn(page, `[data-screen="${screen}"] a[href="#/settings"]`);
      await page.waitFor(`location.hash === '#/settings' && ${screenVisible('settings')} && document.querySelector('[data-screen="${screen}"]').hidden`, 3000);
      await page.frames(3);
    }
    noExceptions(page);
  });
});
