// docs/spec/mouse.md の受け入れ条件（MOU-2〜MOU-4、MOU-7〜MOU-11）の QA の受け入れテスト。
// 公開された入口だけを使う: ビルドの結果を /apex-training/ で配信した画面（キャンバス・#pointer-lock-notice・#paused・
// #status の残弾・#fullscreen）と、開発サーバーから読み込む公開関数（attachMouse・countsToLook・cmPer360 など）。
// 画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、マウスとキーは DevTools プロトコルで実際の入力として送る。
// ポインターロック中の DevTools の mouseMoved は、座標の差がそのまま movementX / movementY（カウント）になる。
// 加速を外したポインターロックの拒否は、ページのスクリプトより先に requestPointerLock を差し替えて再現する。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cmPer360, countsToLook, DEFAULT_MOUSE_SETTINGS, formatCmPer360 } from '../../src/input/mouse-sensitivity';
import { findChromium, launchBrowser, serveStatic, type Browser, type Page } from '../helpers/browser';
import { decodePng, type Image } from '../helpers/png';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const STATIC_PORT = 3110;
const DEBUG_PORT = 3111;
const DEV_PORT = 3112;
const WIDTH = 1280;
const HEIGHT = 800;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;
const chromium = findChromium();
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RGB = [number, number, number];
const distance = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

async function screenshot(page: Page): Promise<Image> {
  const { data } = await page.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  return decodePng(Buffer.from(data, 'base64'));
}

/** HTML の画面を見えなくし、キャンバスだけを写す。 */
async function canvasOnly(page: Page): Promise<Image> {
  await page.evaluate(`for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.visibility = 'hidden'`);
  await pause(200);
  const img = await screenshot(page);
  await page.evaluate(`for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.visibility = ''`);
  return img;
}

/** 2 枚の画面写しで、色が大きく違う画素の数（4 画素おきに数える）。 */
function differingPixels(a: Image, b: Image): number {
  let n = 0;
  for (let y = 0; y < HEIGHT; y += 4) for (let x = 0; x < WIDTH; x += 4) if (distance(a.pixel(x, y), b.pixel(x, y)) > 30) n += 1;
  return n;
}

/** 行 y で色 c に近い画素の区間の中心（いちばん長い区間）。 */
function blobCenterOnRow(img: Image, y: number, c: RGB): number | undefined {
  let best: [number, number] | undefined;
  let start = -1;
  for (let x = 0; x <= WIDTH; x += 1) {
    const inside = x < WIDTH && distance(img.pixel(x, y), c) < 30;
    if (inside && start < 0) start = x;
    if (!inside && start >= 0) {
      if (!best || x - start > best[1] - best[0]) best = [start, x - 1];
      start = -1;
    }
  }
  return best && (best[0] + best[1]) / 2;
}

const keyEscape = async (page: Page) => {
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  }
};

const mouseButton = (page: Page, type: 'mousePressed' | 'mouseReleased', x: number, y: number, button: 'left' | 'right' = 'left') =>
  page.send('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mousePressed' ? (button === 'left' ? 1 : 2) : 0, clickCount: 1 });

/** (x0, y0) から 10 カウントずつ (dx, dy) の向きへ steps 回動かす（ボタンを押したままなら buttons を渡す）。 */
async function drag(page: Page, x0: number, y0: number, dx: number, dy: number, steps: number, buttons = 0) {
  for (let i = 1; i <= steps; i += 1) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + dx * i, y: y0 + dy * i, buttons, button: buttons ? 'left' : 'none' });
  }
}

interface PlayState {
  locked: boolean;
  notice: { hidden: boolean; text: string };
  paused: { hidden: boolean; text: string };
  status: string;
  ammo: number | undefined;
  fullscreen: boolean;
}

const playState = (page: Page) =>
  page.evaluate<PlayState>(`(() => {
    const vis = (el) => ({ hidden: !el || el.hidden || getComputedStyle(el).display === 'none', text: el ? el.textContent.trim() : '' });
    const status = document.querySelector('#status').textContent;
    const m = status.match(/残弾\\s*(\\d+)/);
    return {
      locked: !!document.pointerLockElement,
      notice: vis(document.querySelector('#pointer-lock-notice')),
      paused: vis(document.querySelector('#paused')),
      status,
      ammo: m ? Number(m[1]) : undefined,
      fullscreen: !!document.fullscreenElement,
    };
  })()`);

/** requestPointerLock の要求を記録し、mode に応じて拒否させる（ページのスクリプトより先に実行する）。 */
const stubPointerLock = (mode: 'reject-unadjusted' | 'reject-all') => `
  (() => {
    const original = Element.prototype.requestPointerLock;
    window.__lockRequests = [];
    Element.prototype.requestPointerLock = function (options) {
      window.__lockRequests.push(options ? JSON.parse(JSON.stringify(options)) : null);
      const reject = ${JSON.stringify(mode)} === 'reject-all' || !!(options && options.unadjustedMovement);
      if (reject) {
        setTimeout(() => document.dispatchEvent(new Event('pointerlockerror')), 0);
        return Promise.reject(new DOMException('拒否（テスト）', 'NotSupportedError'));
      }
      return original.call(this);
    };
  })();
`;

describe.skipIf(NESTED || !chromium)('QA: マウス入力の受け入れ条件', () => {
  const temps: string[] = [];
  let server: Server | undefined;
  let dev: ViteDevServer | undefined;
  let browser: Browser | undefined;
  const staticOrigin = `http://127.0.0.1:${STATIC_PORT}`;
  const devOrigin = `http://127.0.0.1:${DEV_PORT}`;

  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), 'mouse-qa-dist-'));
    temps.push(out);
    const build = spawnSync(`npm run build -- --outDir "${out}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`ビルドが失敗した:\n${build.stdout}${build.stderr}`);
    server = await serveStatic(out, BASE, STATIC_PORT);
    dev = await createServer({ root: ROOT, server: { port: DEV_PORT, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' });
    await dev.listen();
    browser = await launchBrowser(chromium!, DEBUG_PORT);
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await dev?.close();
    await new Promise((ok) => (server ? server.close(ok) : ok(undefined)));
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  /** 新しいタブでトップ画面から「開始」を押してプレイ画面に入る。 */
  async function openPlay(init?: string): Promise<Page> {
    const page = await browser!.newPage();
    if (init) await page.addInitScript(init);
    await page.goto(`${staticOrigin}${BASE}`);
    await page.waitFor(`document.querySelector('[data-screen="top"]') && !document.querySelector('[data-screen="top"]').hidden`);
    await page.clickSelector('[data-screen="top"] a[href="#/play"]');
    await page.waitFor(`!document.querySelector('[data-screen="play"]').hidden`);
    await pause(800);
    return page;
  }

  const noExceptions = (page: Page) => expect(page.errors.filter((e) => e.startsWith('exception:')), page.errors.join('\n')).toEqual([]);

  /**
   * 開発サーバーの画面に、公開関数 attachMouse だけでつないだ確認用のキャンバス（画面全体を覆う）を置く。
   * 固定ステップのループは手動の時計で進め、ポインターロックが外れたら止め、掛かったら再開する（mouse.md「一時停止と再開」）。
   */
  async function openHarness(settings: { dpi: number; sensitivity: number; adsMultiplier: number }): Promise<Page> {
    const page = await browser!.newPage();
    await page.goto(`${devOrigin}${BASE}`);
    await page.waitFor(`document.querySelector('[data-screen="top"]') && !document.querySelector('[data-screen="top"]').hidden`);
    await page.evaluate(`(async () => {
      const src = '${BASE}src/';
      const [{ attachMouse }, { FixedStepLoop }, { ManualTimeSource }, { InputQueue }, { Simulation }, { loadWorld }, { Gun }, { createRandom }] =
        await Promise.all(['input/mouse.ts', 'core/loop.ts', 'core/time.ts', 'input/queue.ts', 'sim/simulation.ts', 'sim/world.ts', 'sim/gun.ts', 'core/random.ts']
          .map((p) => import(src + p)));
      const canvas = document.createElement('canvas');
      canvas.id = 'qa-canvas';
      canvas.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647;background:#000';
      document.body.appendChild(canvas);
      const loaded = loadWorld({ id: 'qa', name: 'qa', spawn: { position: [0, 1.6, 0], yaw: 0, pitch: 0 },
        boxes: [{ id: 'w', kind: 'wall', center: [0, 1.6, -10.1], size: [200, 200, 0.2] }] });
      if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
      const world = loaded.world;
      const queue = new InputQueue();
      const sim = new Simulation(world, queue);
      const weapon = { id: 'qa', name: 'qa', category: 'AR', version: 'qa', source: 'qa', rpm: 600, magSize: 30,
        pattern: Array.from({ length: 30 }, () => ({ dx: 0, dy: 0.5 })), randomness: 0 };
      const gun = new Gun(weapon, createRandom(1));
      sim.addStepHook((w, dt) => gun.step(w, dt));
      const time = new ManualTimeSource();
      const log = { looks: [], results: [], locks: [] };
      const loop = new FixedStepLoop({ timeSource: time, update: () => sim.step(), render: () => {} });
      attachMouse(canvas, {
        emit: (a) => { if (a.type === 'look') log.looks.push(a); queue.push(loop.currentTime(), a); },
        settings: () => (${JSON.stringify(settings)}),
        onLockResult: (r) => log.results.push(r),
        onLockChange: (locked) => { log.locks.push(locked); if (locked) loop.resume(); else loop.pause(); },
      });
      loop.frame();
      window.__qa = {
        tick(seconds, frames = 1) { for (let i = 0; i < frames; i += 1) { time.advance(seconds / frames); loop.frame(); } },
        state() {
          const sum = log.looks.reduce((s, a) => ({ yaw: s.yaw + a.yaw, pitch: s.pitch + a.pitch }), { yaw: 0, pitch: 0 });
          return { aim: { ...world.player.aim }, fire: world.player.fire, shots: gun.shots.length, steps: sim.stepCount,
            paused: loop.paused, sum, results: [...log.results], locks: [...log.locks], locked: document.pointerLockElement === canvas };
        },
      };
    })()`);
    return page;
  }

  interface HarnessState {
    aim: { yaw: number; pitch: number };
    fire: boolean;
    shots: number;
    steps: number;
    paused: boolean;
    sum: { yaw: number; pitch: number };
    results: string[];
    locks: boolean[];
    locked: boolean;
  }
  const harness = (page: Page) => page.evaluate<HarnessState>('window.__qa.state()');
  const tick = (page: Page, seconds: number, frames = 1) => page.evaluate(`window.__qa.tick(${seconds}, ${frames})`);
  /** 確認用のキャンバスのロックが掛かり（外れ）、attachMouse がそれを知らせるまで待つ。 */
  const harnessLock = (page: Page, locked: boolean) =>
    page.waitFor(`(() => { const s = window.__qa.state(); return s.locked === ${locked} && s.locks.at(-1) === ${locked}; })()`, 5000);

  // -------------------------------------------------------------------------
  describe('MOU-2: unadjustedMovement 付きの要求だけを拒否させると、通常のポインターロックになり、マウス加速の警告が表示される', () => {
    it('キャンバスをクリックすると、unadjustedMovement 付きの要求のあとに通常の要求をし、ロックされて加速の警告が出る', async () => {
      const page = await openPlay(stubPointerLock('reject-unadjusted'));
      expect((await playState(page)).notice.hidden).toBe(true);
      await page.click(CX, CY);
      await page.waitFor('!!document.pointerLockElement', 5000);
      await pause(300);
      const requests = await page.evaluate<({ unadjustedMovement?: boolean } | null)[]>('window.__lockRequests');
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(requests[0]?.unadjustedMovement).toBe(true);
      expect(requests.at(-1)?.unadjustedMovement ?? false).toBe(false);
      const state = await playState(page);
      expect(state.locked).toBe(true);
      expect(state.notice.hidden).toBe(false);
      expect(state.notice.text).toMatch(/加速/);
      // 通常のポインターロックでも、移動とボタンは照準の操作として受け付けられる（一時停止ではない）。
      expect(state.paused.hidden).toBe(true);
      noExceptions(page);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('MOU-3: Esc で練習が止まり一時停止の表示が出る。もう一度クリックすると表示が消えて再開する', () => {
    it('画面: Esc でロックが外れて一時停止の表示が出て、止まっている間はリコイルの戻りも進まない。クリックで表示が消えて再開する', async () => {
      const page = await openPlay();
      await page.click(CX, CY);
      await page.waitFor('!!document.pointerLockElement', 5000);
      expect((await playState(page)).paused.hidden).toBe(true);

      // 数発撃って離し、リコイルの戻り（0.5 秒）の途中で Esc を押す。
      await mouseButton(page, 'mousePressed', CX, CY);
      await pause(350);
      await mouseButton(page, 'mouseReleased', CX, CY);
      await keyEscape(page);
      await page.waitFor('!document.pointerLockElement', 5000);
      await pause(100);
      let state = await playState(page);
      expect(state.locked).toBe(false);
      expect(state.paused.hidden).toBe(false);
      expect(state.paused.text.length).toBeGreaterThan(0);
      const fired = 30 - (state.ammo ?? 30);
      expect(fired, state.status).toBeGreaterThan(0);

      // 止まっている間は描画が変わらない（リコイルの戻りが進まない）。
      const frozenA = await canvasOnly(page);
      await pause(800);
      const frozenB = await canvasOnly(page);
      expect(differingPixels(frozenA, frozenB)).toBe(0);
      expect((await playState(page)).ammo).toBe(state.ammo);

      // もう一度クリックすると、ロックし直して一時停止の表示が消え、止まっていた戻りが進む。
      await page.click(CX, CY);
      await page.waitFor('!!document.pointerLockElement', 5000);
      await pause(800);
      state = await playState(page);
      expect(state.paused.hidden).toBe(true);
      const resumed = await canvasOnly(page);
      expect(differingPixels(frozenB, resumed)).toBeGreaterThan(0);
      // 再開後は撃てる（練習が動いている）。
      const before = state.ammo!;
      await mouseButton(page, 'mousePressed', CX, CY);
      await pause(300);
      await mouseButton(page, 'mouseReleased', CX, CY);
      await pause(100);
      expect((await playState(page)).ammo!).toBeLessThan(before);
      noExceptions(page);
    }, 60_000);

    it('公開関数: attachMouse は Esc でロックが外れたことを知らせ、もう一度のクリックで掛かったことを知らせる', async () => {
      const page = await openHarness({ ...DEFAULT_MOUSE_SETTINGS });
      await page.click(CX, CY);
      await harnessLock(page, true);
      await tick(page, 0.1);
      let s = await harness(page);
      expect(s.locks.at(-1)).toBe(true);
      expect(s.paused).toBe(false);
      await keyEscape(page);
      await harnessLock(page, false);
      s = await harness(page);
      expect(s.locks.at(-1)).toBe(false);
      expect(s.paused).toBe(true);
      const steps = s.steps;
      await tick(page, 1, 10);
      // Chromium は Esc でロックを外した直後のロックの要求を拒否するので、少し待ってからクリックする。
      await pause(1500);
      expect((await harness(page)).steps).toBe(steps);
      await page.click(CX, CY);
      await harnessLock(page, true);
      await tick(page, 0.1);
      s = await harness(page);
      expect(s.locks.at(-1)).toBe(true);
      expect(s.paused).toBe(false);
      expect(s.steps).toBeGreaterThan(steps);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('MOU-4: DPI 800・感度 1.5 の cm/360 が 34.6 になる', () => {
    it('換算の計算（cmPer360）と表示の書式（formatCmPer360）', () => {
      expect(cmPer360(800, 1.5)).toBeCloseTo((360 / (800 * 1.5 * 0.022)) * 2.54, 9);
      expect(formatCmPer360(cmPer360(800, 1.5))).toBe('34.6');
    });
  });

  // -------------------------------------------------------------------------
  describe('MOU-7: ポインターロックの要求がすべて拒否されると、ポインターロックできなかった旨が表示される', () => {
    it('キャンバスをクリックすると失敗の旨が表示され、もう一度クリックするとまた要求する', async () => {
      const page = await openPlay(stubPointerLock('reject-all'));
      await page.click(CX, CY);
      await page.waitFor(`!document.querySelector('#pointer-lock-notice').hidden`, 5000);
      await pause(300);
      const state = await playState(page);
      expect(state.locked).toBe(false);
      expect(state.notice.hidden).toBe(false);
      expect(state.notice.text).toMatch(/ポインターロック/);
      expect(state.notice.text).toMatch(/でき(ませんでした|なかった|ません)|失敗/);
      const first = (await page.evaluate<unknown[]>('window.__lockRequests')).length;
      expect(first).toBeGreaterThanOrEqual(1);
      await page.click(CX, CY);
      await pause(300);
      expect((await page.evaluate<unknown[]>('window.__lockRequests')).length).toBeGreaterThan(first);
      noExceptions(page);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('MOU-8: 一時停止中に左ボタンを押したまま移動しても、照準のヨー・ピッチは変わらず、弾は出ない', () => {
    it('画面: 一時停止中に左ボタンを押したまま動かしても、描画も残弾も変わらない', async () => {
      const page = await openPlay();
      await page.click(CX, CY);
      await page.waitFor('!!document.pointerLockElement', 5000);
      await pause(200);
      await keyEscape(page);
      await page.waitFor('!document.pointerLockElement', 5000);
      await pause(700);
      const before = await canvasOnly(page);
      const ammo = (await playState(page)).ammo;
      expect(ammo).toBe(30);

      await mouseButton(page, 'mousePressed', 300, 300);
      await drag(page, 300, 300, 10, -5, 60, 1);
      await pause(800);
      const state = await playState(page);
      const after = await canvasOnly(page);
      await mouseButton(page, 'mouseReleased', 900, 0);
      expect(state.paused.hidden).toBe(false);
      expect(state.ammo).toBe(ammo);
      expect(differingPixels(before, after)).toBe(0);
      noExceptions(page);
    }, 60_000);

    it('公開関数: 一時停止中に左ボタンを押したまま動かしても、ヨー・ピッチは変わらず弾は出ない', async () => {
      const page = await openHarness({ dpi: 800, sensitivity: 2, adsMultiplier: 1 });
      await page.click(CX, CY);
      await harnessLock(page, true);
      await drag(page, CX, CY, 10, 0, 10);
      await tick(page, 0.1);
      await keyEscape(page);
      await harnessLock(page, false);
      await tick(page, 0.1);
      const before = await harness(page);
      expect(before.paused).toBe(true);

      await mouseButton(page, 'mousePressed', 300, 300);
      await drag(page, 300, 300, 10, -5, 60, 1);
      await tick(page, 1, 20);
      const after = await harness(page);
      await mouseButton(page, 'mouseReleased', 900, 0);
      expect(after.aim).toEqual(before.aim);
      expect(after.shots).toBe(0);
      expect(after.fire).toBe(false);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('MOU-9: 全画面の切替ボタンを押すと全画面になり、もう一度押すと解除される', () => {
    it('プレイ画面の切替ボタン', async () => {
      const page = await openPlay();
      expect((await playState(page)).fullscreen).toBe(false);
      await page.clickSelector('[data-screen="play"] #fullscreen');
      await page.waitFor('!!document.fullscreenElement', 5000);
      expect((await playState(page)).fullscreen).toBe(true);
      await page.clickSelector('[data-screen="play"] #fullscreen');
      await page.waitFor('!document.fullscreenElement', 5000);
      expect((await playState(page)).fullscreen).toBe(false);
      noExceptions(page);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('MOU-10: 感度 2.0 のとき、マウスを前に 1000 カウント動かすと照準のピッチが 44 度増える', () => {
    it('換算の計算（countsToLook）: 前（movementY が負）の 1000 カウントでピッチ +44 度、ヨーは変わらない', () => {
      const look = countsToLook(0, -1000, { dpi: 800, sensitivity: 2, adsMultiplier: 1 }, false);
      expect(look.pitch).toBeCloseTo(44, 9);
      expect(look.yaw).toBeCloseTo(0, 9);
    });

    it('公開関数: ポインターロック中にマウスを前に 1000 カウント動かすと、照準のピッチが 44 度増える', async () => {
      const page = await openHarness({ dpi: 800, sensitivity: 2, adsMultiplier: 1 });
      await page.click(CX, CY);
      await harnessLock(page, true);
      await tick(page, 0.05);
      const before = await harness(page);
      await drag(page, CX, CY, 0, -10, 100);
      await tick(page, 0.2, 4);
      const after = await harness(page);
      expect(after.sum.pitch).toBeCloseTo(44, 6);
      expect(after.aim.pitch - before.aim.pitch).toBeCloseTo(44, 6);
      expect(after.aim.yaw - before.aim.yaw).toBeCloseTo(0, 9);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('MOU-11: 設定していないときは DPI 800・感度 1.5・ADS 倍率 1.0 として換算される（水平 1000 カウントでヨー 33 度）', () => {
    it('既定値と換算の計算', () => {
      expect(DEFAULT_MOUSE_SETTINGS).toEqual({ dpi: 800, sensitivity: 1.5, adsMultiplier: 1 });
      expect(countsToLook(1000, 0, DEFAULT_MOUSE_SETTINGS, false).yaw).toBeCloseTo(33, 9);
      expect(countsToLook(1000, 0, DEFAULT_MOUSE_SETTINGS, true).yaw).toBeCloseTo(33, 9);
      expect(formatCmPer360(cmPer360(DEFAULT_MOUSE_SETTINGS.dpi, DEFAULT_MOUSE_SETTINGS.sensitivity))).toBe('34.6');
    });

    it('画面: 何も設定していない状態で右に 1000 カウント動かすと、的が 33 度ぶん左に動いて描画される', async () => {
      const page = await openPlay();
      const start = await canvasOnly(page);
      const target = start.pixel(CX, CY);
      const wall = start.pixel(CX + 80, CY);
      expect(distance(target, wall)).toBeGreaterThan(40);
      expect(Math.abs(blobCenterOnRow(start, CY, target)! - CX)).toBeLessThanOrEqual(2);

      await page.click(CX, CY);
      await page.waitFor('!!document.pointerLockElement', 5000);
      // クリックした位置（中心）から動かし始める（最初の移動の差もカウントになる）。
      await drag(page, CX, CY, 10, 0, 100);
      await pause(500);
      const moved = await canvasOnly(page);
      const center = blobCenterOnRow(moved, CY, target);
      // 照準から水平に θ ずれた方向は、中心から 幅の半分 × tan(θ) ÷ tan(水平視野角 / 2) 離れて描画される（screens.md）。
      // FOV 90・縦横比 1280:800 では tan(水平視野角 / 2) = tan(45°) × 1.6 ÷ (4/3) = 1.2。
      const expected = CX - ((WIDTH / 2) * Math.tan((33 * Math.PI) / 180)) / 1.2;
      // 30 度なら約 308 px、36 度なら約 388 px 左。33 度なら約 346 px 左。
      expect(center, `的の中心 ${center} 期待 ${expected}`).toBeDefined();
      expect(Math.abs(center! - expected), `的の中心 ${center} 期待 ${expected}`).toBeLessThanOrEqual(8);
      noExceptions(page);
    }, 60_000);
  });
});
