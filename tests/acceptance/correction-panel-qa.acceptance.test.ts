// docs/spec/screens.md「補正のパネル」と設定（UI-11・UI-13・UI-55〜UI-63）、docs/spec/modes.md の MODE-24〜MODE-27 の QA の受け入れテスト。
// 公開された入口だけを使う: ビルドの結果を /apex-training/ で配信した画面（トップ・設定・プレイ・リザルト）、index.html の要素、
// 武器とマップの JSON。画面はヘッドレスの Chromium で開く（tests/helpers/browser.ts）。
//
// パネルは index.html の .correction-panel（svg の [data-series="ideal"]・[data-series="aim"] の polyline、
// [data-series="aim-shots"] の各弾の点、[data-panel="current"] の次の発の点、[data-panel="aim"] の今の照準の印（data-yaw・data-pitch は
// 開始時の照準からの度）、[data-panel="heading"] の向かう先の線）で読む。パネルの座標の縮尺は SPEC にないので、
// 理想の線の点を SPEC の理想の補正軌道（weapons.md）に「原点 + 同じ縮尺 s × (ヨー, −ピッチ)」で合わせて求め、
// その当てはまり（縦横同じ縮尺・右と上が正・原点が開始時の照準）も確かめる。
//
// UI-57・UI-61 は randomness 0 の武器が要るため、リポジトリの写しに受け入れテスト用の武器（randomness 0・rpm 30・装弾数 5、
// pattern はマウスの 1 カウントの角度の整数倍）を足してビルドした画面で確かめる（ghost-follow-qa と同じ方法）。
// 照準はポインターロック中のマウスの移動（DevTools の mouseMoved の座標の差が movementX / movementY になる）で動かす。
// パッドは Gamepad API（navigator.getGamepads）の形で与え、R2 で撃つ。ゴーストはキャンバスだけの画面写しを、
// ゴーストを出さないパターン観察の画面写しと比べて見つける（違う画素がなければゴーストは出ていない）。
// 補正のパネルは、反復練習では設定によらず必ず、センター維持では設定の補正のパネルが ON（既定）のとき出し、パターン観察では出さない。
// ゴースト表示（3D の中のゴースト）の既定は OFF。
// サーバーと DevTools のポートは OS に選ばせる。待ちは sleep にせず、画面の状態の条件で待つ。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';
import { decodePng, type Image } from '../helpers/png';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const WIDTH = 1280;
const HEIGHT = 800;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;
const chromium = findChromium();

const PATTERN = 'パターン観察';
const GHOST = '反復練習';
const CENTER = 'センター維持';

/** SPEC の値（実装の定数には依存しない）。 */
const DEG_PER_COUNT = 1.5 * 0.022; // 既定の感度 1.5 での 1 カウントの角度（mouse.md）

interface WeaponJson {
  id: string;
  name: string;
  category: string;
  rpm: number;
  magSize: number;
  randomness: number;
  pattern: { dx: number; dy: number }[];
}
const WEAPONS: WeaponJson[] = readdirSync(join(ROOT, 'src/data/weapons'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(ROOT, 'src/data/weapons', f), 'utf8')) as WeaponJson);
const byId = (id: string) => {
  const w = WEAPONS.find((x) => x.id === id);
  if (!w) throw new Error(`武器がない: ${id}`);
  return w;
};

/** randomness 0 の受け入れテスト用の武器。rpm 30（発射間隔 2 秒）で、発の間に照準を動かして読めるように。 */
const ZERO_COUNTS: [number, number][] = [
  [0, 30],
  [9, 30],
  [-12, 27],
  [15, 24],
  [-6, 30],
];
const ZERO_WEAPON: WeaponJson & { version: string; source: string; measured: boolean } = {
  id: 'qa-panel-zero',
  name: 'QA-パネル',
  category: 'QA',
  version: 'S31-Cipher',
  source: '仮データ（受け入れテスト）',
  // 計測した武器だけが選択肢に出る（weapons.md）ので、受け入れテスト用の武器も measured にする。
  measured: true,
  rpm: 30,
  magSize: ZERO_COUNTS.length,
  randomness: 0,
  pattern: ZERO_COUNTS.map(([x, y]) => ({ dx: x * DEG_PER_COUNT, dy: y * DEG_PER_COUNT })),
};

type Pt = [number, number];
type RGB = [number, number, number];
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cdist = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** i 発目（1 から）の理想の補正軌道（ヨー, ピッチ）: 1〜i 発目の pattern の合計の反転（weapons.md）。i = 0 は原点。 */
function ideal(w: WeaponJson, i: number): Pt {
  let yaw = 0;
  let pitch = 0;
  for (let k = 0; k < i; k += 1) {
    yaw -= w.pattern[k]!.dx;
    pitch -= w.pattern[k]!.dy;
  }
  return [yaw, pitch];
}

// ---------------------------------------------------------------------------
// ページに足すスクリプト（パッドとパネルの読み出し）
// ---------------------------------------------------------------------------

const PAGE_INIT = `
  window.__pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) };
  navigator.getGamepads = () => [{ id: 'acceptance pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard',
    timestamp: performance.now(), axes: window.__pad.axes.slice(), buttons: window.__pad.buttons.map((b) => ({ ...b })), vibrationActuator: null }];
  window.__btn = (i, on) => { window.__pad.buttons[i] = { value: on ? 1 : 0, pressed: on, touched: on }; };
  window.__num = (sel) => { const m = (document.querySelector(sel)?.textContent ?? '').match(/-?\\d+(?:\\.\\d+)?/); return m ? Number(m[0]) : NaN; };
  window.__ammo = () => window.__num('[data-hud="ammo"]');
  window.__time = () => window.__num('[data-hud="time"]');
  window.__inputShown = () => (document.querySelector('[data-hud="input"]')?.textContent ?? '').trim();
  window.__vis = (sel) => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    return !!el && !el.closest('[hidden]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0; };
  window.__interlude = () => window.__vis('#interlude');
  window.__nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  window.__pts = (s) => { const n = String(s ?? '').trim().split(/[\\s,]+/).filter(Boolean).map(Number); const out = [];
    for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]); return out; };
  window.__center = (el) => {
    if (el.tagName.toLowerCase() === 'circle') return [el.cx.baseVal.value, el.cy.baseVal.value];
    const b = el.getBBox(); return [b.x + b.width / 2, b.y + b.height / 2];
  };
  window.__panel = () => {
    const fig = document.querySelector('.correction-panel');
    const svg = fig?.querySelector('svg');
    const q = (s) => svg?.querySelector(s);
    const cur = q('[data-panel="current"]');
    const aimEl = q('[data-panel="aim"]');
    const head = q('[data-panel="heading"]');
    const legend = [...(fig?.querySelectorAll('.plot-legend') ?? [])].map((el) => (el.textContent ?? '').trim());
    const dots = q('[data-series="aim-shots"]');
    const vb = svg?.viewBox?.baseVal;
    const r = fig?.getBoundingClientRect();
    const play = document.querySelector('[data-screen="play"]');
    const shots = dots ? [...dots.querySelectorAll('*')].filter((el) => ['circle', 'rect', 'path', 'use', 'ellipse'].includes(el.tagName.toLowerCase()))
      .map((el) => window.__center(el)) : [];
    const shotSizes = dots ? [...dots.querySelectorAll('*')].map((el) => { const b = el.getBBox(); return Math.max(b.width, b.height); }) : [];
    const aimBox = aimEl && aimEl.getAttribute('d') ? aimEl.getBBox() : null;
    return {
      visible: window.__vis(fig),
      ammo: window.__ammo(),
      hash: location.hash,
      viewBox: vb ? [vb.x, vb.y, vb.width, vb.height] : [0, 0, 0, 0],
      rect: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null,
      text: fig ? (fig.innerText ?? fig.textContent ?? '') : '',
      ideal: window.__pts(q('[data-series="ideal"]')?.getAttribute('points')),
      aim: window.__pts(q('[data-series="aim"]')?.getAttribute('points')),
      shots,
      shotSizes,
      current: cur ? { x: cur.cx.baseVal.value, y: cur.cy.baseVal.value, r: cur.r.baseVal.value, visible: window.__vis(cur) } : null,
      aimMark: aimEl ? { yaw: Number(aimEl.getAttribute('data-yaw')), pitch: Number(aimEl.getAttribute('data-pitch')),
        center: aimBox ? [aimBox.x + aimBox.width / 2, aimBox.y + aimBox.height / 2] : null,
        size: aimBox ? Math.max(aimBox.width, aimBox.height) : 0, visible: window.__vis(aimEl) } : null,
      heading: head ? { from: [head.x1.baseVal.value, head.y1.baseVal.value], to: [head.x2.baseVal.value, head.y2.baseVal.value],
        visible: window.__vis(head) } : null,
      legend,
    };
  };
`;

interface PanelDom {
  visible: boolean;
  ammo: number;
  hash: string;
  viewBox: [number, number, number, number];
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null;
  text: string;
  ideal: Pt[];
  aim: Pt[];
  shots: Pt[];
  /** 自分の各弾の点の大きさ（パネルの座標、外接する箱の長いほうの辺）。 */
  shotSizes: number[];
  current: { x: number; y: number; r: number; visible: boolean } | null;
  /** 今の照準の印。yaw・pitch は data-yaw・data-pitch（度）、center は描いた印の中心（パネルの座標）。 */
  aimMark: { yaw: number; pitch: number; center: Pt | null; size: number; visible: boolean } | null;
  /** 向かう先の線（パネルの座標）。 */
  heading: { from: Pt; to: Pt; visible: boolean } | null;
  /** 凡例の文字。 */
  legend: string[];
}

const panel = (page: Page) => page.evaluate<PanelDom>('window.__panel()');
const panelVisible = (page: Page) => page.evaluate<boolean>(`window.__vis('.correction-panel')`);
const ammo = (page: Page) => page.evaluate<number>('window.__ammo()');
const hash = (page: Page) => page.evaluate<string>('location.hash');

/**
 * パネルの理想の線を、SPEC の理想の補正軌道（原点と 1〜装弾数発目）に「原点 o + s × (ヨー, −ピッチ)」で合わせる。
 * s は最小二乗で求め、残差（各点のずれのいちばん大きいもの、パネルの座標）も返す。
 */
function fitIdeal(p: PanelDom, w: WeaponJson) {
  const o = p.ideal[0] ?? [NaN, NaN];
  let num = 0;
  let den = 0;
  for (let k = 1; k <= w.magSize; k += 1) {
    const [yaw, pitch] = ideal(w, k);
    const q = p.ideal[k];
    if (!q) continue;
    num += (q[0] - o[0]) * yaw + (q[1] - o[1]) * -pitch;
    den += yaw * yaw + pitch * pitch;
  }
  const s = num / den;
  const toPanel = (d: Pt): Pt => [o[0] + s * d[0], o[1] - s * d[1]];
  let resid = 0;
  for (let k = 0; k <= w.magSize; k += 1) {
    const q = p.ideal[k];
    resid = Math.max(resid, q ? dist(q, toPanel(ideal(w, k))) : Infinity);
  }
  return { o, s, toPanel, resid };
}

/** パネルの座標での「重なる」の許し: パネルの幅の 1%。 */
const tolOf = (p: PanelDom) => p.viewBox[2] * 0.01;

// ---------------------------------------------------------------------------
// 画面の操作
// ---------------------------------------------------------------------------

async function choose(page: Page, selector: string, label: string | number) {
  const ok = await page.evaluate<boolean>(`(() => {
    const s = document.querySelector(${JSON.stringify(selector)});
    const want = ${JSON.stringify(label)};
    const o = [...s.options].find((x) => typeof want === 'number'
      ? Number((x.textContent.match(/\\d+/) ?? [NaN])[0]) === want
      : x.textContent.trim() === want);
    if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  if (!ok) throw new Error(`${selector} に ${label} の選択肢がない`);
}

/** チェックボックスをクリックして checked にする（違うときだけ）。 */
async function setCheck(page: Page, id: string, on: boolean) {
  if ((await page.evaluate<boolean>(`document.getElementById(${JSON.stringify(id)}).checked`)) !== on) await page.clickSelector(`#${id}`);
  await page.waitFor(`document.getElementById(${JSON.stringify(id)}).checked === ${on}`);
}

/** 設定画面で入力方式・ゴースト表示・補正のパネルを選び、トップ画面に戻る。 */
async function configure(page: Page, opts: { input?: '自動' | 'マウス' | 'パッド'; ghost?: boolean; panel?: boolean }) {
  await page.evaluate(`location.hash = '#/settings'`);
  await page.waitFor(`window.__vis('[data-screen="settings"]')`);
  if (opts.input) await choose(page, '#setting-input-method', opts.input);
  if (opts.ghost !== undefined) await setCheck(page, 'setting-ghost', opts.ghost);
  if (opts.panel !== undefined) await setCheck(page, 'setting-correction-panel', opts.panel);
  await page.frames(3);
  await page.evaluate(`location.hash = '#/'`);
  await page.waitFor(`window.__vis('[data-screen="top"]')`);
}

/** トップ画面で武器・モード・回数を選んで「開始」を押し、練習が始まって描かれるまで待つ。 */
async function start(page: Page, w: WeaponJson, mode: string, count = 1) {
  await page.evaluate(`location.hash = '#/'`);
  await page.waitFor(`window.__vis('[data-screen="top"]') && document.querySelector('#weapon').options.length > 0 && document.querySelector('#mode').options.length > 0`);
  await choose(page, '#weapon', w.name);
  await choose(page, '#mode', mode);
  await choose(page, '#count', count);
  await page.clickSelector('[data-screen="top"] a[href="#/play"]');
  await waitStarted(page, w);
}

async function waitStarted(page: Page, w: WeaponJson, timeout = 10_000) {
  await page.waitFor(
    `location.hash === '#/play' && window.__vis('[data-screen="play"]') && !window.__interlude() && window.__ammo() === ${w.magSize} && window.__inputShown() !== ''`,
    timeout,
  );
  await page.waitFor('window.__time() >= 0.3', 10_000);
  await page.frames(3);
}

/** パッドの R2 で n 発だけ撃つ（残弾が n 減った描画で離す）。 */
async function padFire(page: Page, n: number) {
  await page.evaluate(`(async () => {
    const goal = window.__ammo() - ${n};
    window.__btn(7, true); const t0 = performance.now();
    while (window.__ammo() > goal && location.hash === '#/play' && performance.now() - t0 < 15000) await window.__nextFrame();
    window.__btn(7, false); })()`);
}

/** パッドの R2 で撃ち切る。 */
async function padFireAll(page: Page) {
  await page.evaluate(`(async () => {
    window.__btn(7, true); const t0 = performance.now();
    while (window.__ammo() > 0 && location.hash === '#/play' && !window.__interlude() && performance.now() - t0 < 20000) await window.__nextFrame();
    window.__btn(7, false); })()`);
}

const KEY_R = { key: 'r', code: 'KeyR', vk: 82, text: 'r' };
async function pressR(page: Page) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: KEY_R.key, code: KEY_R.code, windowsVirtualKeyCode: KEY_R.vk, nativeVirtualKeyCode: KEY_R.vk, text: KEY_R.text });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: KEY_R.key, code: KEY_R.code, windowsVirtualKeyCode: KEY_R.vk, nativeVirtualKeyCode: KEY_R.vk });
}

/** ポインターロック中のマウス（座標の差がカウントになる）。 */
class Mouse {
  x = CX;
  y = CY;
  held = 0;
  constructor(private readonly page: Page) {}
  async lock() {
    if (await this.page.evaluate<boolean>('!!document.pointerLockElement')) return;
    await this.page.click(this.x, this.y);
    await this.page.waitFor('!!document.pointerLockElement', 5000);
    await this.page.frames(6);
  }
  /** (dx, dy) カウント動かす（1 回の移動は 10 カウントまで）。 */
  async move(dx: number, dy: number) {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 10));
    const from: Pt = [this.x, this.y];
    for (let s = 1; s <= steps; s += 1) {
      await this.page.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: from[0] + Math.round((dx * s) / steps),
        y: from[1] + Math.round((dy * s) / steps),
        button: this.held ? 'left' : 'none',
        buttons: this.held,
      });
    }
    this.x = from[0] + dx;
    this.y = from[1] + dy;
  }
  async press() {
    this.held = 1;
    await this.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: this.x, y: this.y, button: 'left', buttons: 1, clickCount: 1 });
  }
  async release() {
    this.held = 0;
    await this.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: this.x, y: this.y, button: 'left', buttons: 0, clickCount: 1 });
  }
}

/** HTML の画面を隠し、キャンバスだけを写す（画面の動きが止まってから）。 */
async function canvasOnly(page: Page): Promise<Image> {
  await page.evaluate(`document.getElementById('ui').style.visibility = 'hidden'`);
  await page.frames(2);
  const img = decodePng(await page.stableScreenshot());
  await page.evaluate(`document.getElementById('ui').style.visibility = ''`);
  return img;
}
function changedPixels(a: Image, b: Image, tol = 40): number {
  let n = 0;
  for (let y = 0; y < a.height; y += 1) for (let x = 0; x < a.width; x += 1) if (cdist(a.pixel(x, y), b.pixel(x, y)) > tol) n += 1;
  return n;
}

/**
 * 練習中に少し撃ちながら、パネルが見えているかを描画ごとに読む。撃つ前・撃っている間・離したあとを読む。
 * 撃てたか（残弾が減ったか）と、読んでいる間ずっとプレイ画面だったかも返す。
 */
async function sampleWhilePractising(page: Page, input: 'mouse' | 'pad', w: WeaponJson) {
  const seen: boolean[] = [];
  const hashes = new Set<string>();
  /** n 回読む。stopAt を渡すと、残弾がそれ以下になったら（撃ち切ってリザルトに移る前に）やめる。 */
  const read = async (n: number, stopAt = -1) => {
    for (let i = 0; i < n; i += 1) {
      seen.push(await panelVisible(page));
      hashes.add(await hash(page));
      if ((await ammo(page)) <= stopAt) break;
      await page.frames(2);
    }
  };
  const mouse = new Mouse(page);
  if (input === 'mouse') await mouse.lock();
  await read(6);
  if (input === 'mouse') await mouse.press();
  else await page.evaluate('window.__btn(7, true)');
  // 撃っている間を読む。描画が遅いときに撃ち切らないよう、装弾数の半分を撃ったらやめる。
  await read(15, Math.floor(w.magSize / 2));
  if (input === 'mouse') await mouse.release();
  else await page.evaluate('window.__btn(7, false)');
  await read(4);
  return { seen, fired: w.magSize - (await ammo(page)), hashes: [...hashes] };
}

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('QA: 補正のパネル（UI-11・UI-13・UI-55〜UI-63・MODE-24〜MODE-27）', () => {
  const temps: string[] = [];
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  let opened: Page[] = [];
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));

  /** 新しいタブで localStorage を空にして読み込み直し、トップ画面を開く。 */
  async function openFresh(init = ''): Promise<Page> {
    const page = await browser!.newPage();
    opened.push(page);
    await page.addInitScript(PAGE_INIT + init);
    await page.goto(`${origin}${BASE}#/`);
    await page.evaluate('localStorage.clear()');
    await page.evaluate('window.__beforeReload = true');
    await page.send('Page.reload', { ignoreCache: false });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && window.__vis('[data-screen="top"]')`, 15_000);
    return page;
  }

  /** 再読み込みして設定画面を開き直す。 */
  async function reloadSettings(page: Page) {
    await page.evaluate('window.__beforeReload = true');
    await page.send('Page.reload', { ignoreCache: true });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete'`, 15_000);
    await page.evaluate(`location.hash = '#/settings'`);
    await page.waitFor(`window.__vis('[data-screen="settings"]') && document.getElementById('setting-fov').value !== ''`);
  }

  beforeAll(async () => {
    const work = mkdtempSync(join(tmpdir(), 'correction-panel-qa-'));
    temps.push(work);
    // リポジトリの写しに randomness 0 の武器を足してビルドする（ほかの武器はそのまま入る）。
    const repo = join(work, 'copy');
    for (const entry of ['src', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'eslint.config.js', 'scripts', 'public']) {
      if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(repo, entry), { recursive: true });
    }
    symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'), 'dir');
    writeFileSync(join(repo, 'src/data/weapons/qa-panel-zero.json'), JSON.stringify(ZERO_WEAPON, null, 2));
    const dist = join(work, 'dist');
    const r = spawnSync(`npm run build -- --outDir "${dist}" --emptyOutDir`, {
      cwd: repo,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, APEX_ACCEPTANCE_NESTED: '1', FORCE_COLOR: '0' },
    });
    if (r.status !== 0) throw new Error(`写しのビルドが失敗した:\n${r.stdout}${r.stderr}`);
    server = await serveStatic(dist, BASE);
    origin = originOf(server);
    browser = await launchBrowser(chromium!);
  }, 300_000);

  afterEach(async () => {
    for (const p of opened) await p.send('Page.close').catch(() => undefined);
    opened = [];
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((ok) => (server ? server.close(ok) : ok(undefined)));
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  describe('UI-13・UI-11: 補正のパネルの設定', () => {
    it('UI-13: 設定を一度も変えずに設定画面を開くと、ゴースト表示は OFF、補正のパネルは ON を含む既定値が表示される', async () => {
      const page = await openFresh();
      await page.evaluate(`location.hash = '#/settings'`);
      await page.waitFor(`window.__vis('[data-screen="settings"]') && document.getElementById('setting-fov').value !== ''`);
      const s = await page.evaluate<Record<string, string | boolean>>(`(() => {
        const v = (id) => document.getElementById(id).value;
        const c = (id) => document.getElementById(id).checked;
        return { input: document.getElementById('setting-input-method').selectedOptions[0].textContent.trim(), fov: v('setting-fov'),
          color: v('setting-crosshair-color').toLowerCase(), shape: document.getElementById('setting-crosshair-shape').selectedOptions[0].textContent.trim(),
          ghost: c('setting-ghost'), panel: c('setting-correction-panel'), sound: c('setting-sound'),
          dpi: v('setting-dpi'), sens: v('setting-sensitivity'), ads: v('setting-ads-multiplier'),
          ghostLabel: document.getElementById('setting-ghost').closest('label')?.textContent.trim() ?? '',
          panelLabel: document.getElementById('setting-correction-panel').closest('label')?.textContent.trim() ?? '' }; })()`);
      expect(s.input).toBe('自動');
      expect(s.fov).toBe('90');
      expect(s.shape).toBe('点');
      expect(s.color).toBe('#77ccff');
      expect(s.ghost, 'ゴースト表示は OFF').toBe(false);
      expect(s.panel, '補正のパネルは ON').toBe(true);
      // 項目に使うモードを添えて表示する（screens.md「設定画面」）。
      expect(s.ghostLabel).toContain('ゴースト表示（反復練習の 3D）');
      expect(s.panelLabel).toContain('補正のパネル（センター維持）');
      expect(s.sound).toBe(true);
      expect(s.dpi).toBe('800');
      expect(Number(s.sens)).toBe(1.5);
      expect(Number(s.ads)).toBe(1);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('UI-11: FOV・クロスヘアの色と形・ゴースト表示・補正のパネルを既定と違う値に変えて再読み込みすると、変えた値が残る', async () => {
      const page = await openFresh();
      await page.evaluate(`location.hash = '#/settings'`);
      await page.waitFor(`window.__vis('[data-screen="settings"]') && document.getElementById('setting-fov').value !== ''`);
      // FOV は欄に打って Enter で確定する。
      await page.clickSelector('#setting-fov');
      await page.evaluate(`document.getElementById('setting-fov').select()`);
      await page.send('Input.insertText', { text: '104' });
      for (const type of ['keyDown', 'keyUp']) {
        await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined });
      }
      await page.waitFor(`document.getElementById('setting-fov').value === '104'`);
      for (const [id, value] of [
        ['setting-crosshair-color', '#33cc66'],
        ['setting-crosshair-shape', 'circle'],
      ]) {
        await page.evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      }
      // 既定と違う値: ゴースト表示は ON（既定は OFF）、補正のパネルは OFF（既定は ON）。
      await setCheck(page, 'setting-ghost', true);
      await setCheck(page, 'setting-correction-panel', false);

      await reloadSettings(page);
      const s = await page.evaluate<Record<string, string | boolean>>(`(() => ({
        fov: document.getElementById('setting-fov').value, color: document.getElementById('setting-crosshair-color').value.toLowerCase(),
        shape: document.getElementById('setting-crosshair-shape').value, ghost: document.getElementById('setting-ghost').checked,
        panel: document.getElementById('setting-correction-panel').checked, sound: document.getElementById('setting-sound').checked }))()`);
      expect(s).toEqual({ fov: '104', color: '#33cc66', shape: 'circle', ghost: true, panel: false, sound: true });

      // 補正のパネルだけを ON に戻して再読み込みしても、その値が残る（ほかの変えた値もそのまま）。
      await setCheck(page, 'setting-correction-panel', true);
      await reloadSettings(page);
      expect(await page.evaluate<boolean>(`document.getElementById('setting-correction-panel').checked`)).toBe(true);
      expect(await page.evaluate<boolean>(`document.getElementById('setting-ghost').checked`)).toBe(true);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('UI-55: 撃つ前から理想の線と次の発の点が表示され、1 発ごとに次の発の点が次の発へ進む', () => {
    // センター維持は設定を変えずに（補正のパネルは既定の ON）、反復練習は設定によらず出る。入力方式だけをパッドにする。
    for (const mode of [CENTER, GHOST]) {
      it(`L-STAR（${mode}・パッド）: 撃つ前の理想の線と 1 発目の点、右端・大きさ・凡例、撃っている間の次の発の点`, async () => {
        const w = byId('lstar');
        const page = await openFresh();
        await configure(page, { input: 'パッド' });
        await start(page, w, mode);
        const p = await panel(page);
        expect(p.visible, '撃つ前からパネルが表示される').toBe(true);
        // 右端で、画面の短い辺の 45%（360px まで）を超えない大きさ。
        expect(p.rect).not.toBeNull();
        expect(p.rect!.left, `パネルが右端にない: ${JSON.stringify(p.rect)}`).toBeGreaterThan(WIDTH / 2);
        expect(WIDTH - p.rect!.right).toBeLessThan(WIDTH * 0.1);
        expect(Math.max(p.rect!.width, p.rect!.height)).toBeLessThanOrEqual(Math.min(Math.min(WIDTH, HEIGHT) * 0.45, 360) + 0.5);
        expect(p.text).toContain('理想');
        expect(p.text).toContain('自分');
        // 理想の線: 原点 + 1〜装弾数発目。同じ縮尺・右と上が正で SPEC の理想の補正軌道に重なる。
        expect(p.ideal.length, '理想の線の点の数（原点 + 装弾数）').toBe(w.magSize + 1);
        const f = fitIdeal(p, w);
        expect(f.s, '縮尺が正（右と上が正の向き）').toBeGreaterThan(0);
        expect(f.resid, `理想の線が理想の補正軌道に重ならない（ずれ ${f.resid}）`).toBeLessThanOrEqual(tolOf(p));
        // 理想の線は枠の中（縁に寄せられていない）。
        const [vx, vy, vw, vh] = p.viewBox;
        for (const q of p.ideal) {
          expect(q[0]).toBeGreaterThan(vx);
          expect(q[0]).toBeLessThan(vx + vw);
          expect(q[1]).toBeGreaterThan(vy);
          expect(q[1]).toBeLessThan(vy + vh);
        }
        // 次の発の点は 1 発目の理想の補正軌道の位置。自分の線はまだない。
        expect(p.current?.visible, '次の発の点が見える').toBe(true);
        expect(p.current!.r).toBeGreaterThan(0);
        expect(dist([p.current!.x, p.current!.y], f.toPanel(ideal(w, 1)))).toBeLessThanOrEqual(tolOf(p));
        expect(p.shots).toEqual([]);
        expect(p.aim.length).toBeLessThanOrEqual(0);

        // R2 を押し続け、描画ごとに次の発の点を読む。残弾から次に撃つ弾を数える。
        await page.evaluate('window.__btn(7, true)');
        const samples: PanelDom[] = [];
        for (;;) {
          const s = await panel(page);
          if (!(s.ammo > 1) || s.hash !== '#/play') break;
          samples.push(s);
          await page.frames(1);
        }
        await page.evaluate('window.__btn(7, false)');
        const mismatches: string[] = [];
        const covered = new Set<number>();
        for (const s of samples) {
          const next = w.magSize - s.ammo + 1;
          const at: Pt = [s.current!.x, s.current!.y];
          // HUD と同じ描画の状態で読めないこともあるので、1 発前も許す。
          const hit = [next, next - 1].find((k) => k >= 1 && dist(at, f.toPanel(ideal(w, k))) <= tolOf(p));
          if (hit === undefined) mismatches.push(`残弾 ${s.ammo}（次 ${next} 発目）: 点 (${at[0].toFixed(3)}, ${at[1].toFixed(3)})`);
          else covered.add(hit);
          expect(s.visible).toBe(true);
        }
        expect(mismatches, mismatches.join('\n')).toEqual([]);
        expect(covered.size, '多くの発で次の発の点を確かめた').toBeGreaterThan(15);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 90_000);
    }

    for (const mode of [CENTER, GHOST]) {
      it(`${ZERO_WEAPON.name}（rpm 30・${mode}）: i 発目を撃ったあと、次の発の点が i+1 発目の理想の補正軌道の位置に進む`, async () => {
        const w = ZERO_WEAPON;
        const page = await openFresh();
        await configure(page, { input: 'パッド' });
        await start(page, w, mode);
        const p0 = await panel(page);
        const f = fitIdeal(p0, w);
        expect(f.resid).toBeLessThanOrEqual(tolOf(p0));
        expect(dist([p0.current!.x, p0.current!.y], f.toPanel(ideal(w, 1)))).toBeLessThanOrEqual(tolOf(p0));
        await page.evaluate('window.__btn(7, true)');
        for (let i = 1; i < w.magSize; i += 1) {
          await page.waitFor(`window.__ammo() === ${w.magSize - i}`, 10_000);
          await page.frames(3);
          const s = await panel(page);
          expect(s.ammo, `${i} 発目のあと、次の発の前に読めていない`).toBe(w.magSize - i);
          expect(dist([s.current!.x, s.current!.y], f.toPanel(ideal(w, i + 1))), `${i} 発目のあとの次の発の点`).toBeLessThanOrEqual(tolOf(s));
          expect(s.shots.length, `${i} 発目のあとの自分の点の数`).toBe(i);
        }
        await page.evaluate('window.__btn(7, false)');
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 60_000);
    }
  });

  // -------------------------------------------------------------------------
  it('UI-56: 照準を動かさずに 5 発撃つと、自分の点はすべて原点にあり、k 発目の理想の点との距離が原点から k 発目の理想までの距離になる', async () => {
    const w = byId('lstar');
    const page = await openFresh();
    await configure(page, { input: 'パッド' });
    await start(page, w, CENTER);
    await padFire(page, 5);
    await page.frames(3);
    const p = await panel(page);
    expect(p.hash).toBe('#/play');
    expect(w.magSize - p.ammo, '撃った弾は 5 発').toBe(5);
    const f = fitIdeal(p, w);
    expect(f.resid).toBeLessThanOrEqual(tolOf(p));
    expect(p.shots.length, '自分の点は 5 つ').toBe(5);
    for (const [k, q] of p.shots.entries()) {
      expect(dist(q, f.o), `${k + 1} 発目の自分の点が原点にない`).toBeLessThanOrEqual(tolOf(p));
      // k 発目の自分の点と k 発目の理想の点の距離（度）= 原点から k 発目の理想の補正軌道までの距離（度）。
      const ik = f.toPanel(ideal(w, k + 1));
      const deg = dist(q, ik) / f.s;
      expect(deg).toBeCloseTo(Math.hypot(...ideal(w, k + 1)), 1);
    }
    for (const q of p.aim) expect(dist(q, f.o), '自分の線の点が原点にない').toBeLessThanOrEqual(tolOf(p));
    expect(p.aim.length, '自分の線がある').toBeGreaterThan(0);
    expect(exceptions(page), page.errors.join('\n')).toEqual([]);
  }, 60_000);

  // -------------------------------------------------------------------------
  it(`UI-57: ${ZERO_WEAPON.name} で各発の発射時に照準を「開始時の照準 + その発の理想の補正軌道」に合わせて撃つと、自分の点が理想の線の各発の点に重なる`, async () => {
    const w = ZERO_WEAPON;
    const page = await openFresh();
    await configure(page, { input: 'マウス' });
    await start(page, w, CENTER);
    const mouse = new Mouse(page);
    await mouse.lock();
    expect(await ammo(page), 'ポインターロックのクリックで撃った').toBe(w.magSize);
    // 右に動かすとヨーが増え、下（movementY が正）に動かすとピッチが減る（mouse.md）。理想の補正軌道は pattern の反転。
    await mouse.move(-ZERO_COUNTS[0]![0], ZERO_COUNTS[0]![1]);
    await page.frames(4);
    await mouse.press();
    let last: PanelDom | undefined;
    for (let i = 1; i < w.magSize; i += 1) {
      await page.waitFor(`window.__ammo() === ${w.magSize - i}`, 10_000);
      await mouse.move(-ZERO_COUNTS[i]![0], ZERO_COUNTS[i]![1]);
      await page.frames(4);
      last = await panel(page);
      expect(last.ammo, `${i + 1} 発目の前に読めていない`).toBe(w.magSize - i);
      const f = fitIdeal(last, w);
      expect(last.shots.length).toBe(i);
      for (const [k, q] of last.shots.entries()) {
        expect(dist(q, last.ideal[k + 1]!), `${k + 1} 発目の自分の点が理想の線の ${k + 1} 発目の点に重ならない`).toBeLessThanOrEqual(tolOf(last));
        expect(dist(q, f.toPanel(ideal(w, k + 1)))).toBeLessThanOrEqual(tolOf(last));
      }
      // 自分の線の点も、理想の線の各発の点に重なる。
      for (const [k, q] of last.aim.slice(-i).entries()) {
        expect(dist(q, last.ideal[k + 1]!), `自分の線の ${k + 1} 発目の点`).toBeLessThanOrEqual(tolOf(last));
      }
    }
    await page.waitFor(`location.hash === '#/result'`, 10_000);
    await mouse.release();
    // 対照として照準を合わせた撃ち方で全弾が中心に当たっている（照準が理想の補正軌道に合っていた）。
    await page.waitFor(`document.querySelector('[data-screen="result"]').innerText.includes('発')`);
    const text = await page.evaluate<string>(`document.querySelector('[data-screen="result"]').innerText`);
    expect(text, text).toMatch(/平均ズレ\s*0(\.0+)?\s*°/);
    expect(exceptions(page), page.errors.join('\n')).toEqual([]);
  }, 90_000);

  // -------------------------------------------------------------------------
  describe('UI-58: 補正のパネルを OFF にすると、マウスとパッドのどちらでもセンター維持の練習中に表示されず、反復練習では表示される', () => {
    for (const input of ['mouse', 'pad'] as const) {
      it(`${input === 'mouse' ? 'マウス' : 'パッド'}・${CENTER}: 表示されない`, async () => {
        const w = byId('lstar');
        const page = await openFresh();
        await configure(page, { input: input === 'mouse' ? 'マウス' : 'パッド', panel: false });
        await start(page, w, CENTER);
        const r = await sampleWhilePractising(page, input, w);
        expect(r.fired, '撃てている').toBeGreaterThan(0);
        expect(r.hashes).toEqual(['#/play']);
        expect(r.seen.some(Boolean), 'パネルが表示された').toBe(false);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 60_000);

      it(`${input === 'mouse' ? 'マウス' : 'パッド'}・${GHOST}: 同じ設定でも表示される`, async () => {
        const w = byId('lstar');
        const page = await openFresh();
        await configure(page, { input: input === 'mouse' ? 'マウス' : 'パッド', panel: false });
        await start(page, w, GHOST);
        const r = await sampleWhilePractising(page, input, w);
        expect(r.fired, '撃てている').toBeGreaterThan(0);
        expect(r.hashes).toEqual(['#/play']);
        expect(r.seen.every(Boolean), `パネルが表示されないときがあった: ${r.seen.join(',')}`).toBe(true);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 60_000);
    }
  });

  // -------------------------------------------------------------------------
  describe('UI-59: マウスとパッドのそれぞれで、反復練習と（補正のパネルが ON の）センター維持を練習するとパネルが表示され、入力方式が変わっても表示され続ける', () => {
    for (const input of ['mouse', 'pad'] as const) {
      for (const mode of [GHOST, CENTER]) {
        it(`${input === 'mouse' ? 'マウス' : 'パッド'}・${mode}`, async () => {
          const w = byId('lstar');
          const page = await openFresh();
          await configure(page, { input: input === 'mouse' ? 'マウス' : 'パッド', panel: true });
          await start(page, w, mode);
          const r = await sampleWhilePractising(page, input, w);
          expect(r.fired, '撃てている').toBeGreaterThan(0);
          expect(r.hashes).toEqual(['#/play']);
          expect(r.seen.every(Boolean), `パネルが表示されないときがあった: ${r.seen.join(',')}`).toBe(true);
          expect(exceptions(page), page.errors.join('\n')).toEqual([]);
        }, 60_000);
      }
    }

    for (const mode of [CENTER, GHOST]) {
      it(`入力方式「自動」で、マウスで撃ってからパッドで撃つと、入力方式の表示が変わってもパネルが表示され続ける（${mode}）`, async () => {
        const w = byId('lstar');
        const page = await openFresh();
        await configure(page, { input: '自動', panel: true });
        await start(page, w, mode);
        const seen: boolean[] = [];
        const inputs: string[] = [];
        const read = async (n: number) => {
          for (let i = 0; i < n; i += 1) {
            seen.push(await panelVisible(page));
            inputs.push(await page.evaluate<string>('window.__inputShown()'));
            await page.frames(2);
          }
        };
        const mouse = new Mouse(page);
        await mouse.lock();
        await mouse.move(20, 10);
        await mouse.press();
        await read(6);
        await mouse.release();
        await page.waitFor(`window.__inputShown().includes('マウス')`, 3000);
        await read(3);
        await page.evaluate('window.__btn(7, true)');
        await page.waitFor(`window.__inputShown().includes('パッド')`, 3000);
        await read(8);
        await page.evaluate('window.__btn(7, false)');
        await read(3);
        expect(await hash(page)).toBe('#/play');
        expect(inputs.some((t) => t.includes('マウス'))).toBe(true);
        expect(inputs.some((t) => t.includes('パッド'))).toBe(true);
        expect(seen.every(Boolean), `パネルが表示されないときがあった: ${seen.join(',')}`).toBe(true);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 60_000);
    }
  });

  // -------------------------------------------------------------------------
  describe('UI-60: リザルト画面と短いリザルトの表示中は表示されず、やり直しで自分の線が消えて次の発の点が 1 発目に戻る', () => {
    for (const mode of [CENTER, GHOST]) {
      it(`撃ち切ってリザルト画面に移ると、パネルは表示されない（${mode}）`, async () => {
        const w = byId('lstar');
        const page = await openFresh();
        await configure(page, { input: 'パッド', panel: true });
        await start(page, w, mode);
        expect(await panelVisible(page)).toBe(true);
        await padFireAll(page);
        await page.waitFor(`location.hash === '#/result' && window.__vis('[data-screen="result"]')`, 15_000);
        for (let i = 0; i < 6; i += 1) {
          expect(await panelVisible(page), 'リザルト画面でパネルが表示された').toBe(false);
          await page.frames(2);
        }
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 60_000);
    }

    for (const mode of [CENTER, GHOST]) {
      it(`連続練習の短いリザルトの表示中は表示されず、次の回で自分の線が消えて次の発の点が 1 発目に戻る（${mode}）`, async () => {
        const w = byId('lstar');
        const page = await openFresh();
        await configure(page, { input: 'パッド', panel: true });
        await start(page, w, mode, 5);
        await padFireAll(page);
        await page.waitFor('window.__interlude()', 5000);
        const during: boolean[] = [];
        for (let i = 0; i < 8; i += 1) {
          if (!(await page.evaluate<boolean>('window.__interlude()'))) break;
          during.push(await panelVisible(page));
          await page.frames(2);
        }
        expect(during.length).toBeGreaterThan(0);
        expect(during.some(Boolean), '短いリザルトの表示中にパネルが表示された').toBe(false);
        // 次の回が始まる（3 秒を待つ）。
        await waitStarted(page, w, 10_000);
        const p = await panel(page);
        expect(p.visible).toBe(true);
        const f = fitIdeal(p, w);
        expect(p.shots, '次の回で自分の点が消えていない').toEqual([]);
        expect(p.aim.length).toBe(0);
        expect(dist([p.current!.x, p.current!.y], f.toPanel(ideal(w, 1)))).toBeLessThanOrEqual(tolOf(p));
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 60_000);
    }

    for (const mode of [CENTER, GHOST]) {
      it(`やり直し（R）で練習を始め直すと、自分の線が消え、次の発の点が 1 発目の位置に戻る（${mode}）`, async () => {
        const w = byId('lstar');
        const page = await openFresh();
        await configure(page, { input: 'パッド', panel: true });
        await start(page, w, mode);
        // 5 発撃ち、fire を押したまま（次の発の点は 6 発目）でやり直す。
        await page.evaluate(`(async () => {
          const goal = window.__ammo() - 5; window.__btn(7, true); const t0 = performance.now();
          while (window.__ammo() > goal && performance.now() - t0 < 10000) await window.__nextFrame(); })()`);
        await page.evaluate('window.__btn(7, false)');
        await page.frames(2);
        const before = await panel(page);
        const f = fitIdeal(before, w);
        expect(before.shots.length, 'やり直す前に自分の点がある').toBeGreaterThanOrEqual(5);
        expect(dist([before.current!.x, before.current!.y], f.toPanel(ideal(w, 1))), 'やり直す前は 1 発目より先').toBeGreaterThan(tolOf(before));
        await pressR(page);
        await page.waitFor(`window.__ammo() === ${w.magSize} && location.hash === '#/play'`, 5000);
        await page.frames(3);
        const after = await panel(page);
        expect(after.visible).toBe(true);
        expect(after.shots, 'やり直したあとも自分の点が残っている').toEqual([]);
        expect(after.aim.length, 'やり直したあとも自分の線が残っている').toBe(0);
        expect(dist([after.current!.x, after.current!.y], f.toPanel(ideal(w, 1))), '次の発の点が 1 発目に戻っていない').toBeLessThanOrEqual(tolOf(after));
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 60_000);
    }
  });

  // -------------------------------------------------------------------------
  describe('UI-61: 同じ入力を補正のパネルが ON と OFF で与えると、弾痕の位置と採点結果が一致する', () => {
    /** リザルト画面の弾痕（散布図・軌道）と採点結果の表示。 */
    const resultOf = (page: Page) =>
      page.evaluate<{ summary: string; metrics: string; comments: string; plots: string }>(`(() => ({
        summary: document.getElementById('result-summary')?.innerText ?? '',
        metrics: document.getElementById('result-metrics')?.innerText ?? '',
        comments: document.getElementById('result-comments')?.innerText ?? '',
        plots: document.getElementById('result-plots')?.innerHTML ?? '' }))()`);

    it(`${ZERO_WEAPON.name}・センター維持・マウス: 同じ照準の動かし方と撃ち方`, async () => {
      const w = ZERO_WEAPON;
      const moves: Pt[] = [
        [4, 12],
        [-7, 20],
        [11, 15],
        [-3, 25],
        [6, 9],
      ];
      const run = async (on: boolean) => {
        const page = await openFresh();
        await configure(page, { input: 'マウス', panel: on });
        await start(page, w, CENTER);
        expect(await panelVisible(page)).toBe(on);
        const mouse = new Mouse(page);
        await mouse.lock();
        await mouse.move(...moves[0]!);
        await page.frames(4);
        await mouse.press();
        for (let i = 1; i < w.magSize; i += 1) {
          await page.waitFor(`window.__ammo() === ${w.magSize - i}`, 10_000);
          await mouse.move(...moves[i]!);
          await page.frames(4);
          expect(await ammo(page)).toBe(w.magSize - i);
        }
        await page.waitFor(`location.hash === '#/result'`, 10_000);
        await mouse.release();
        await page.waitFor(`document.getElementById('result-metrics').innerText.trim().length > 0`);
        await page.frames(3);
        const r = await resultOf(page);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
        await page.send('Page.close').catch(() => undefined);
        opened = opened.filter((x) => x !== page);
        return r;
      };
      const on = await run(true);
      const off = await run(false);
      expect(on.metrics.length).toBeGreaterThan(0);
      expect(on).toEqual(off);
    }, 90_000);

    // 反復練習では設定によらずパネルを出すので、設定でパネルの有無が変わるセンター維持で比べる。
    it('L-STAR・センター維持・パッド（乱数の元を決まった値にして同じ種で始める）: 撃ち切ったときの弾痕と採点', async () => {
      const w = byId('lstar');
      // 練習の種がページの乱数の元から決まるとき、両方の練習が同じ種になるよう、乱数の元を決まった列にする。
      const fixedRandom = `
        (() => { let s = 12345; const next = () => { s = (s * 1103515245 + 12345) >>> 0; return s; };
          Math.random = () => next() / 4294967296;
          const orig = crypto.getRandomValues.bind(crypto);
          crypto.getRandomValues = (a) => { if (a && typeof a.length === 'number') { for (let i = 0; i < a.length; i += 1) a[i] = next() & 0xffffffff; return a; } return orig(a); };
        })();`;
      const run = async (on: boolean) => {
        const page = await openFresh(fixedRandom);
        await configure(page, { input: 'パッド', panel: on });
        await start(page, w, CENTER);
        expect(await panelVisible(page)).toBe(on);
        await padFireAll(page);
        await page.waitFor(`location.hash === '#/result' && document.getElementById('result-metrics').innerText.trim().length > 0`, 15_000);
        await page.frames(3);
        const r = await resultOf(page);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
        await page.send('Page.close').catch(() => undefined);
        opened = opened.filter((x) => x !== page);
        return r;
      };
      const on = await run(true);
      const off = await run(false);
      expect(on.metrics.length).toBeGreaterThan(0);
      expect(on).toEqual(off);
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  /** パターン観察（ゴーストもパネルも出さない）で始めた直後のキャンバス。ゴーストを見つける対照。 */
  let patternBase: Image | undefined;
  const baseline = async () => {
    if (patternBase) return patternBase;
    const page = await openFresh();
    await configure(page, { input: 'マウス' });
    await start(page, byId('lstar'), PATTERN);
    patternBase = await canvasOnly(page);
    return patternBase;
  };

  /** パネルの要素の画面上の箱が、HUD・画面の操作・パッドのガイドの箱と重なるか。見えている要素だけを比べる。 */
  const overlaps = (page: Page) =>
    page.evaluate<string[]>(`(() => {
      const a = document.querySelector('.correction-panel').getBoundingClientRect();
      const out = [];
      for (const sel of ['.hud', '#play-controls', '.play-actions', '.pad-guide']) {
        const el = document.querySelector(sel);
        if (!el || !window.__vis(el)) continue;
        const b = el.getBoundingClientRect();
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) out.push(sel + ' ' + JSON.stringify(b));
      }
      return out; })()`);

  // -------------------------------------------------------------------------
  describe('MODE-24: 反復練習では設定の補正のパネルが ON でも OFF でもパネルが表示され、ゴースト表示を ON にするとゴースト（パッドのときはガイド）と同時に表示される', () => {
    for (const on of [true, false]) {
      it(`反復練習・マウス・補正のパネル ${on ? 'ON' : 'OFF'}・ゴースト表示 ON: パネルとゴーストが同時に表示される`, async () => {
        const base = await baseline();
        const page = await openFresh();
        await configure(page, { input: 'マウス', ghost: true, panel: on });
        await start(page, byId('lstar'), GHOST);
        const p = await panel(page);
        expect(p.visible).toBe(true);
        expect(p.ideal.length).toBe(byId('lstar').magSize + 1);
        expect(p.current?.visible).toBe(true);
        const ghostPixels = changedPixels(base, await canvasOnly(page));
        expect(await panelVisible(page), 'ゴーストを写したあともパネルが表示されている').toBe(true);
        expect(ghostPixels, 'ゴーストが表示されていない').toBeGreaterThan(0);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 60_000);

      it(`反復練習・パッド・補正のパネル ${on ? 'ON' : 'OFF'}・ゴースト表示 ON: パネルとゴーストとスティック型のガイドが同時に表示される`, async () => {
        const base = await baseline();
        const page = await openFresh();
        await configure(page, { input: 'パッド', ghost: true, panel: on });
        await start(page, byId('lstar'), GHOST);
        await page.waitFor(`window.__vis('.pad-guide')`, 3000);
        expect(await panelVisible(page)).toBe(true);
        const ghostPixels = changedPixels(base, await canvasOnly(page));
        expect(ghostPixels, 'ゴーストが表示されていない').toBeGreaterThan(0);
        expect(await panelVisible(page)).toBe(true);
        expect(await page.evaluate<boolean>(`window.__vis('.pad-guide')`)).toBe(true);
        // パネルとガイドは重ならない。
        expect((await overlaps(page)).filter((o) => o.startsWith('.pad-guide')), 'パネルとガイドが重なる').toEqual([]);
        // 撃っている間も 3 つとも表示される。
        await page.evaluate('window.__btn(7, true)');
        await page.waitFor(`window.__ammo() <= ${byId('lstar').magSize - 3}`, 5000);
        expect(await panelVisible(page)).toBe(true);
        expect(await page.evaluate<boolean>(`window.__vis('.pad-guide')`)).toBe(true);
        await page.evaluate('window.__btn(7, false)');
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 60_000);
    }
  });

  // -------------------------------------------------------------------------
  describe('MODE-25: 設定を一度も変えずに反復練習を始めると、3D の中にゴーストは表示されず、補正のパネルが表示され、パッドのときはスティック型のガイドも表示される', () => {
    it('L-STAR: 撃つ前のキャンバスがパターン観察と同じ（ゴーストがない）で、パネルが表示される', async () => {
      const page = await openFresh();
      await start(page, byId('lstar'), PATTERN);
      const pattern = await canvasOnly(page);
      await start(page, byId('lstar'), GHOST);
      expect(await panelVisible(page), 'パネルが表示されない').toBe(true);
      expect(changedPixels(pattern, await canvasOnly(page)), 'パターン観察と違う画素がある（ゴーストが表示された）').toBe(0);
      expect(await panelVisible(page)).toBe(true);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it(`${ZERO_WEAPON.name}・入力方式は既定の「自動」でパッドの R2 で撃つ: ガイドとパネルが表示され、ゴーストは表示されない`, async () => {
      const w = ZERO_WEAPON;
      /** R2 で 1 発撃って離し、戻りの時間（0.5 秒）がたってリコイルが戻ってから（撃たない時間 2 秒の前に）キャンバスを写す。 */
      const afterOneShot = async (page: Page, mode: string) => {
        await start(page, w, mode);
        await padFire(page, 1);
        const released = await page.evaluate<number>('window.__time()');
        await page.waitFor(`window.__time() >= ${released + 0.8}`, 5000);
        const state = await page.evaluate<{ hash: string; ammo: number; input: string; guide: boolean; panel: boolean }>(
          `({ hash: location.hash, ammo: window.__ammo(), input: window.__inputShown(), guide: window.__vis('.pad-guide'), panel: window.__vis('.correction-panel') })`,
        );
        const img = await canvasOnly(page);
        expect(await page.evaluate<number>('window.__time()'), '写すのが遅れた').toBeLessThan(released + 1.9);
        expect(await hash(page)).toBe('#/play');
        return { state, img };
      };
      const page = await openFresh();
      const pattern = await afterOneShot(page, PATTERN);
      const ghost = await afterOneShot(page, GHOST);
      expect(ghost.state.hash).toBe('#/play');
      expect(ghost.state.ammo, '1 発撃った').toBe(w.magSize - 1);
      expect(ghost.state.input, '入力方式がパッドになった').toContain('パッド');
      expect(ghost.state.guide, 'スティック型のガイドが表示されない').toBe(true);
      expect(ghost.state.panel, 'パネルが表示されない').toBe(true);
      expect(pattern.state.ammo).toBe(w.magSize - 1);
      // 同じ撃ち方のパターン観察（ゴーストを出さない）と同じキャンバス。
      expect(changedPixels(pattern.img, ghost.img), 'パターン観察と違う画素がある（ゴーストが表示された）').toBe(0);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('MODE-26: パターン観察では、設定の補正のパネルが ON でもパネルが表示されない', () => {
    for (const input of ['mouse', 'pad'] as const) {
      for (const explicit of [false, true]) {
        it(`${input === 'mouse' ? 'マウス' : 'パッド'}・補正のパネル ON（${explicit ? '設定画面で ON にした' : '既定'}）`, async () => {
          const w = byId('lstar');
          const page = await openFresh();
          await configure(page, { input: input === 'mouse' ? 'マウス' : 'パッド', ...(explicit ? { panel: true } : {}) });
          expect(await page.evaluate<boolean>('JSON.parse(localStorage.getItem("apex-training:settings:common") ?? "{}").correctionPanel ?? true')).toBe(true);
          await start(page, w, PATTERN);
          const r = await sampleWhilePractising(page, input, w);
          expect(r.fired, '撃てている').toBeGreaterThan(0);
          expect(r.hashes).toEqual(['#/play']);
          expect(r.seen.some(Boolean), 'パネルが表示された').toBe(false);
          expect(exceptions(page), page.errors.join('\n')).toEqual([]);
        }, 60_000);
      }
    }
  });

  // -------------------------------------------------------------------------
  describe('MODE-27: モードの表示名は「反復練習」で、セットの表示に「反復練習」の言葉が出ない', () => {
    it('トップ画面のモードの選択肢に「反復練習」「センター維持」「パターン観察」が出て、「ゴースト追従」は出ない', async () => {
      const page = await openFresh();
      await page.waitFor(`document.querySelector('#mode').options.length > 0`);
      const modes = await page.evaluate<string[]>(`[...document.querySelector('#mode').options].map((o) => o.textContent.trim())`);
      expect(modes).toEqual(expect.arrayContaining([GHOST, CENTER, PATTERN]));
      expect(modes).not.toContain('ゴースト追従');
      expect(modes.join(' ')).not.toContain('ゴースト追従');
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    for (const mode of [CENTER, GHOST]) {
      it(`回数 5 の${mode}のセット: HUD・短いリザルト・セットのまとめ`, async () => {
        const w = byId('lstar');
        const count = 5;
        const page = await openFresh();
        await configure(page, { input: 'パッド' });
        await start(page, w, mode, count);
        const hud = () => page.evaluate<string>(`document.querySelector('[data-screen="play"] .hud').innerText`);
        const texts: string[] = [];
        for (let round = 1; round <= count; round += 1) {
          const h = await hud();
          expect(h, h).toContain(`${round} / ${count}`);
          texts.push(`${round} 回目の HUD: ${h}`);
          await padFireAll(page);
          if (round === count) break;
          await page.waitFor('window.__interlude()', 5000);
          texts.push(`${round} 回目の短いリザルト: ${await page.evaluate<string>(`document.getElementById('interlude').innerText`)}`);
          // Space で次の回へ進む（3 秒を待たない）。
          for (const type of ['keyDown', 'keyUp']) {
            await page.send('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, ...(type === 'keyDown' ? { text: ' ' } : {}) });
          }
          await waitStarted(page, w, 10_000);
        }
        await page.waitFor(`location.hash === '#/set-result' && window.__vis('[data-screen="set-result"]')`, 15_000);
        await page.waitFor(`document.getElementById('set-rounds').children.length === ${count}`, 5000);
        const summary = await page.evaluate<string>(`document.querySelector('[data-screen="set-result"]').innerText`);
        expect(texts.length).toBe(2 * count - 1);
        for (const t of texts) expect(t, t).not.toContain('反復練習');
        // セットのまとめ: 「反復練習」はモードの名前（武器名と並ぶ練習の見出し）としてだけ出る。センター維持のセットでは出ない。
        const lines = summary.split('\n').filter((l) => l.includes('反復練習'));
        if (mode === CENTER) expect(lines, summary).toEqual([]);
        else {
          expect(lines.length, summary).toBeLessThanOrEqual(1);
          for (const l of lines) expect(l, 'モードの名前でない「反復練習」').toContain(w.name);
        }
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 90_000);
    }
  });

  // -------------------------------------------------------------------------
  it('UI-62: 1280×800 の画面で反復練習を始めると、パネルの一辺が短い辺の 40% 以上で、HUD・画面の操作・パッドのガイドと重ならず、次の発の点がほかの点より大きく、4 つの凡例がある', async () => {
    const w = byId('lstar');
    const page = await openFresh();
    await configure(page, { input: 'パッド' });
    await start(page, w, GHOST);
    expect(await page.evaluate<number[]>('[innerWidth, innerHeight]')).toEqual([WIDTH, HEIGHT]);
    await page.waitFor(`window.__vis('.pad-guide')`, 3000);
    const p0 = await panel(page);
    expect(p0.visible).toBe(true);
    // 凡例を含めたパネルは正方形で、一辺は短い辺の 40% 以上。
    const short = Math.min(WIDTH, HEIGHT);
    expect(p0.rect!.width, JSON.stringify(p0.rect)).toBeGreaterThanOrEqual(short * 0.4);
    expect(p0.rect!.height, JSON.stringify(p0.rect)).toBeGreaterThanOrEqual(short * 0.4);
    expect(Math.abs(p0.rect!.width - p0.rect!.height), '正方形でない').toBeLessThanOrEqual(1);
    expect(p0.rect!.right).toBeLessThanOrEqual(WIDTH);
    expect(p0.rect!.bottom).toBeLessThanOrEqual(HEIGHT);
    expect(await overlaps(page), '重なる').toEqual([]);
    // 凡例。
    for (const label of ['理想', '自分', '次の発', '今の照準']) expect(p0.legend, p0.legend.join(',')).toContain(label);
    // 何発か撃って自分の点が出たあと、次の発の点はそのどれより大きい（今の照準の印より目立つ大きさ）。
    await padFire(page, 4);
    await page.frames(3);
    const p = await panel(page);
    expect(p.hash).toBe('#/play');
    expect(p.shotSizes.length, '自分の点').toBeGreaterThanOrEqual(4);
    expect(p.current?.visible).toBe(true);
    const currentSize = 2 * p.current!.r;
    expect(currentSize, `次の発の点 ${currentSize}、自分の点 ${Math.max(...p.shotSizes)}`).toBeGreaterThan(Math.max(...p.shotSizes));
    expect(await overlaps(page), '撃ったあとに重なる').toEqual([]);
    expect(exceptions(page), page.errors.join('\n')).toEqual([]);
  }, 60_000);

  // -------------------------------------------------------------------------
  it('UI-63: 反復練習で撃つ前に照準を右に 2 度、上に 1 度動かすと、今の照準の印が (2, 1) に動き、今の照準から次の発の点（1 発目）へ向かう先の線が引かれる', async () => {
    const w = byId('lstar');
    const page = await openFresh();
    await configure(page, { input: 'マウス' });
    await start(page, w, GHOST);
    const mouse = new Mouse(page);
    await mouse.lock();
    expect(await ammo(page), 'ポインターロックのクリックで撃った').toBe(w.magSize);
    // 動かす前: 今の照準は原点、向かう先の線は原点から 1 発目の理想の補正軌道へ。
    const p0 = await panel(page);
    const f = fitIdeal(p0, w);
    expect(f.resid).toBeLessThanOrEqual(tolOf(p0));
    const first = f.toPanel(ideal(w, 1));
    expect(p0.aimMark?.visible, '今の照準の印が見える').toBe(true);
    expect(p0.aimMark!.yaw).toBeCloseTo(0, 3);
    expect(p0.aimMark!.pitch).toBeCloseTo(0, 3);
    expect(dist(p0.aimMark!.center!, f.o)).toBeLessThanOrEqual(tolOf(p0));
    expect(p0.heading?.visible, '向かう先の線が見える').toBe(true);
    expect(dist(p0.heading!.from, f.o)).toBeLessThanOrEqual(tolOf(p0));
    expect(dist(p0.heading!.to, first)).toBeLessThanOrEqual(tolOf(p0));

    // 右に 2 度（61 カウント ≒ 2.013 度）、上に 1 度（30 カウント ≒ 0.99 度）。上は movementY が負（mouse.md）。
    const cx = Math.round(2 / DEG_PER_COUNT);
    const cy = Math.round(1 / DEG_PER_COUNT);
    await mouse.move(cx, -cy);
    await page.frames(4);
    const p = await panel(page);
    expect(await ammo(page), '照準を動かしただけで撃った').toBe(w.magSize);
    const yaw = cx * DEG_PER_COUNT;
    const pitch = cy * DEG_PER_COUNT;
    expect(Math.abs(yaw - 2)).toBeLessThan(0.02);
    expect(Math.abs(pitch - 1)).toBeLessThan(0.02);
    expect(p.aimMark!.yaw, '今の照準のヨー').toBeCloseTo(yaw, 3);
    expect(p.aimMark!.pitch, '今の照準のピッチ').toBeCloseTo(pitch, 3);
    // (2, 1) は表示の範囲の中で、印は同じ縮尺・右と上が正でその位置に描かれる。
    const at = f.toPanel([yaw, pitch]);
    const [vx, vy, vw, vh] = p.viewBox;
    expect(at[0] > vx && at[0] < vx + vw && at[1] > vy && at[1] < vy + vh, '(2, 1) が表示の範囲の外').toBe(true);
    expect(p.aimMark!.visible).toBe(true);
    expect(dist(p.aimMark!.center!, at), `印 ${p.aimMark!.center} 期待 ${at}`).toBeLessThanOrEqual(tolOf(p));
    // 向かう先の線: 今の照準から次の発の点（1 発目の理想の補正軌道）へ。
    expect(p.heading?.visible).toBe(true);
    expect(dist(p.heading!.from, at), '線が今の照準から出ていない').toBeLessThanOrEqual(tolOf(p));
    expect(dist(p.heading!.to, first), '線が次の発の点へ向かっていない').toBeLessThanOrEqual(tolOf(p));
    expect(dist(p.heading!.to, [p.current!.x, p.current!.y])).toBeLessThanOrEqual(tolOf(p));
    expect(exceptions(page), page.errors.join('\n')).toEqual([]);
  }, 60_000);
});
