// docs/spec/screens.md の受け入れ条件 UI-18〜UI-23（壁のパネル・的のリング・床と空・ADS 中のスコープの表示）の QA の受け入れテスト。
// 公開された入口だけを使う: ビルドの結果を /apex-training/ で配信した画面（キャンバス・.crosshair・設定画面の入力欄）、
// 開発サーバーから読み込む公開関数（createPractice・RecordingInput・replayRecording・SceneRenderer・ImpactMarks・showAimDisplay など）、
// マップと武器の JSON。画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、画面写しの画素を読んで確かめる。
// マウスは DevTools プロトコルで実際の入力として送る（ポインターロック中は座標の差が movementX / movementY になる）。
// UI-20 の「randomness が 0 で pattern がすべて 0 の武器」は、ビルドの結果の武器の JSON をそう書き換えた配信物で再現する。
// 設定は localStorage に残るので、各タブは開いたあとに localStorage を空にしてから使う。
// ポートは OS に選ばせ（ARC-18）、決まった時間ではなく画面の状態を待つ（ARC-22）。Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { InputRecording } from '../../src/input/recording';
import { fieldOfView } from '../../src/render/fov';
import { parseMap, type MapData } from '../../src/sim/map';
import { replayRecording } from '../../src/sim/practice';
import { parseWeapon, type WeaponData } from '../../src/sim/weapon';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';
import { decodePng, type Image } from '../helpers/png';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
/** ページを開く練習の乱数の種（docs/spec/architecture.md「テストのための乱数の種の固定」）。テストが失敗したときのメッセージにも出る。 */
const SEED = 12345;
const chromium = findChromium();
const rad = (d: number) => (d * Math.PI) / 180;

type RGB = [number, number, number];
const distance = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const lum = (c: RGB) => c[0] + c[1] + c[2];
const hex = (s: string): RGB => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

function rangeMap(): MapData {
  const result = parseMap(JSON.parse(readFileSync(join(ROOT, 'src/data/maps/range.json'), 'utf8')));
  if (!result.ok) throw new Error(`range を読み込めない: ${JSON.stringify(result.errors)}`);
  return result.map;
}

function weaponFile(name: string): WeaponData {
  const result = parseWeapon(JSON.parse(readFileSync(join(ROOT, 'src/data/weapons', name), 'utf8')));
  if (!result.ok) throw new Error(`${name} を読み込めない: ${JSON.stringify(result.errors)}`);
  return result.weapon;
}

/** 縦 height px の画面で、照準から tan = 1 だけずれた方向が中心から何 px 離れて描かれるか（screens.md「FOV と画面への投影」）。 */
const pxPerTan = (fov: number, width: number, height: number) => height / 2 / Math.tan(rad(fieldOfView(fov, width / height).vertical / 2));

/** 画面写し。HUD の時間などが動くので、見た目を変えたあとに描画が 2 回進むのを待ってから撮る。 */
async function screenshot(page: Page): Promise<Image> {
  await page.frames(2);
  return decodePng(await page.screenshot());
}

/** HTML の画面を見えなくし、キャンバスの描画が止まる（照準の動きや弾痕の描画が終わる）のを待ってから、キャンバスだけを写す。 */
async function canvasOnly(page: Page): Promise<Image> {
  await page.evaluate(`document.getElementById('ui').style.visibility = 'hidden'`);
  // 隠した状態で描画し直されるまで待ち、続けて撮った画面写しが同じになったものを使う。
  await page.frames(2);
  const img = decodePng(await page.stableScreenshot());
  await page.evaluate(`document.getElementById('ui').style.visibility = ''`);
  await page.frames(2);
  return img;
}

const mouseButton = (page: Page, type: 'mousePressed' | 'mouseReleased', x: number, y: number, button: 'left' | 'right') =>
  page.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button,
    buttons: type === 'mousePressed' ? (button === 'left' ? 1 : 2) : 0,
    clickCount: 1,
  });

/** HUD の残弾（表示の最初の数）。まだ出ていなければ NaN。 */
const AMMO = `Number((document.querySelector('[data-hud="ammo"]').textContent.match(/(\\d+)/) || [])[1])`;

const noExceptions = (page: Page) => expect(page.errors.filter((e) => e.startsWith('exception:')), page.errors.join('\n')).toEqual([]);

/** 要素が画面に出ているか（hidden・display: none・visibility: hidden・opacity 0 のどれでもない）。祖先も見る。 */
const SHOWN = (selector: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
    const s = getComputedStyle(e);
    if (e.hidden || s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
  }
  return true;
})()`;

/**
 * 中心 (cx, cy) から角度 dir（度、0 が右、90 が下）の向きに 0.25 px 刻みで進み、暗い画素（明るさが dark 未満）の
 * まとまりの中点の距離（px）を返す。from から to までを見る。
 */
function darkRuns(img: Image, cx: number, cy: number, dir: number, from: number, to: number, dark: number): number[] {
  const runs: number[] = [];
  let start: number | undefined;
  const ux = Math.cos(rad(dir));
  const uy = Math.sin(rad(dir));
  for (let r = from; r <= to; r += 0.25) {
    // 画素 (i, j) は [i, i+1) × [j, j+1) を覆うので、中心が整数の座標なら位置をそのまま切り捨てる。
    const isDark = lum(img.pixel(Math.floor(cx + ux * r), Math.floor(cy + uy * r))) < dark;
    if (isDark && start === undefined) start = r;
    if (!isDark && start !== undefined) {
      runs.push((start + r - 0.25) / 2);
      start = undefined;
    }
  }
  if (start !== undefined) runs.push((start + to) / 2);
  return runs;
}

/**
 * 中心 (cx, cy) から角度 dir（度）の向きに 1 px 刻みで from から to まで進み、前後 3 px のどちらの側よりも明るさが
 * depth 以上低い所（細い暗い線）のまとまりの中点の距離（px）を返す。地の色が板・壁と変わっても線を拾えるようにする。
 */
function dipRuns(img: Image, cx: number, cy: number, dir: number, from: number, to: number, depth = 120): number[] {
  const ux = Math.cos(rad(dir));
  const uy = Math.sin(rad(dir));
  const v = (r: number) => lum(img.pixel(Math.floor(cx + ux * r), Math.floor(cy + uy * r)));
  const runs: number[] = [];
  let start: number | undefined;
  for (let r = from; r <= to + 1; r += 1) {
    const left = Math.max(v(r - 1), v(r - 2), v(r - 3));
    const right = Math.max(v(r + 1), v(r + 2), v(r + 3));
    const isDip = r <= to && Math.min(left, right) - v(r) >= depth;
    if (isDip && start === undefined) start = r;
    if (!isDip && start !== undefined) {
      runs.push((start + r - 1) / 2);
      start = undefined;
    }
  }
  return runs;
}

/**
 * 反復練習の人形（docs/spec/architecture.md「人形の的」、縮尺 1）の部分の箱の正面の縁（地より暗い線）が、画面の中心（人形の中心）から
 * 角度 dir（度）の向きに進んだどの距離（px）にあるか。pxPerMeter は人形の正面（目から 9.6 m）の 1 m の画素数。
 * 縁の線はリングと同じく暗いので、リングを探すときにこの距離の近くを除く。
 */
const DUMMY_PARTS = [
  { w: 0.25, h: 0.25, x: 0, y: 0.4 },
  { w: 0.5, h: 0.55, x: 0, y: 0 },
  { w: 0.12, h: 0.6, x: 0.35, y: -0.025 },
  { w: 0.12, h: 0.6, x: -0.35, y: -0.025 },
  { w: 0.2, h: 1.0, x: 0.13, y: -0.775 },
  { w: 0.2, h: 1.0, x: -0.13, y: -0.775 },
];
const DUMMY_FRONT = 9.6;
function dummyEdges(dir: number, pxPerMeter: number): number[] {
  const ux = Math.cos(rad(dir));
  const uy = Math.sin(rad(dir));
  const out: number[] = [];
  for (const p of DUMMY_PARTS) {
    // 画面の座標（右が +x、下が +y、px）の長方形。
    const [x0, x1] = [(p.x - p.w / 2) * pxPerMeter, (p.x + p.w / 2) * pxPerMeter];
    const [y0, y1] = [-(p.y + p.h / 2) * pxPerMeter, -(p.y - p.h / 2) * pxPerMeter];
    for (const X of [x0, x1]) {
      if (Math.abs(ux) < 1e-9) continue;
      const r = X / ux;
      if (r > 0 && r * uy >= y0 - 1 && r * uy <= y1 + 1) out.push(r);
    }
    for (const Y of [y0, y1]) {
      if (Math.abs(uy) < 1e-9) continue;
      const r = Y / uy;
      if (r > 0 && r * ux >= x0 - 1 && r * ux <= x1 + 1) out.push(r);
    }
  }
  return out;
}
const nearEdge = (r: number, edges: readonly number[], margin = 2.5) => edges.some((e) => Math.abs(e - r) <= margin);

describe.skipIf(NESTED || !chromium)('QA: 壁のパネル・的のリング・床と空・ADS 中のスコープの表示（UI-18〜UI-23）', () => {
  const temps: string[] = [];
  const servers: Server[] = [];
  let dev: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let staticOrigin = '';
  let zeroOrigin = '';
  let devOrigin = '';
  let zeroWeaponFiles = 0;

  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), 'ui16-dist-'));
    temps.push(out);
    const build = spawnSync(`npm run build -- --outDir "${out}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`ビルドが失敗した:\n${build.stdout}${build.stderr}`);
    // 同じ配信物を写し、武器の JSON（pattern と randomness を持つもの）を randomness 0・pattern すべて 0 にする。
    const zero = mkdtempSync(join(tmpdir(), 'ui18-dist-'));
    temps.push(zero);
    cpSync(out, zero, { recursive: true });
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
    for (const file of walk(zero).filter((f) => f.endsWith('.json'))) {
      let json: unknown;
      try {
        json = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      if (!json || typeof json !== 'object' || !Array.isArray((json as { pattern?: unknown }).pattern)) continue;
      const w = json as { pattern: { dx: number; dy: number }[]; randomness: number };
      w.randomness = 0;
      w.pattern = w.pattern.map(() => ({ dx: 0, dy: 0 }));
      writeFileSync(file, JSON.stringify(w));
      zeroWeaponFiles += 1;
    }
    const staticServer = await serveStatic(out, BASE);
    servers.push(staticServer);
    staticOrigin = originOf(staticServer);
    const zeroServer = await serveStatic(zero, BASE);
    servers.push(zeroServer);
    zeroOrigin = originOf(zeroServer);
    // 依存の事前バンドルの置き場（cacheDir）はファイルごとの一時ディレクトリにし、並行に流すほかのファイルと node_modules/.vite を取り合わない。
    const cache = mkdtempSync(join(tmpdir(), 'ui16-vite-cache-'));
    temps.push(cache);
    dev = await createServer({ root: ROOT, cacheDir: cache, server: { port: 0, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' });
    await dev.listen();
    devOrigin = originOf(dev.httpServer as Server);
    browser = await launchBrowser(chromium!);
  }, 300_000);

  // テストが終わるたびに開いたタブを閉じ、裏で描画し続けるタブを残さない。

  afterEach(async () => {

    await browser?.closePages();

  });


  afterAll(async () => {
    await browser?.close();
    await dev?.close();
    for (const s of servers) await new Promise((ok) => s.close(ok));
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  interface OpenOptions {
    origin?: string;
    width?: number;
    height?: number;
    fov?: number;
    crosshair?: { color: string; shape: string };
    /** clock=manual で開く（撃つ長さ・ads を押している長さを、テストが進めるページの時計で決める）。 */
    manualClock?: boolean;
  }

  /**
   * 新しいタブで、localStorage を空にし、必要なら設定画面で FOV・クロスヘアを変えてから、トップ画面の「開始」でプレイ画面に入る。
   * 反復練習（ゴースト表示は既定の OFF）で始める。補正のパネルは設定で消せないので、画面写しに HTML の重ね表示が入らないよう、
   * ページにスタイルを足してパネルを見えなくする（パネルは表示だけのもので、3D・弾痕・スコープを変えない）。
   */
  async function openPlay(options: OpenOptions = {}): Promise<Page> {
    const { origin = staticOrigin, width = 1280, height = 800, manualClock = false } = options;
    const page = await browser!.newPage();
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await page.goto(appUrl(origin, BASE, '', { manualClock, seed: SEED }));
    await page.evaluate('localStorage.clear()');
    await page.goto(appUrl(origin, BASE, '#/settings', { manualClock, seed: SEED }));
    // 読み込み直す前の文書に印を付け、印のない（読み込み直した）文書で設定画面の入力欄が埋まるまで待つ。
    await page.evaluate('window.__beforeReload = true; location.reload()');
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && document.getElementById('setting-fov') && document.getElementById('setting-fov').value !== ''`);
    if (options.fov !== undefined) {
      await page.clickSelector('#setting-fov');
      await page.evaluate(`document.getElementById('setting-fov').select()`);
      await page.send('Input.insertText', { text: String(options.fov) });
      for (const type of ['keyDown', 'keyUp']) {
        await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined });
      }
      await page.waitFor(`document.getElementById('setting-fov').value === ${JSON.stringify(String(options.fov))}`);
      expect(await page.evaluate<string>(`document.getElementById('setting-fov').value`)).toBe(String(options.fov));
    }
    if (options.crosshair) {
      for (const [id, value] of [['setting-crosshair-color', options.crosshair.color], ['setting-crosshair-shape', options.crosshair.shape]]) {
        await page.evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await page.waitFor(`document.getElementById(${JSON.stringify(id)}).value === ${JSON.stringify(value)}`);
      }
    }
    await page.evaluate(`location.hash = '#/'`);
    await page.waitFor(`!document.querySelector('[data-screen="top"]').hidden && document.querySelector('#mode').options.length > 0`);
    await page.evaluate(`(() => { const el = document.querySelector('#mode'); el.value = 'ghost';
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      const style = document.createElement('style'); style.textContent = '.correction-panel { visibility: hidden !important; }';
      document.head.append(style); })()`);
    await page.clickSelector('[data-screen="top"] a[href="#/play"]');
    // プレイ画面に入り、練習が始まって（残弾が出て）シーンが何度か描画されるまで待つ。
    await page.waitFor(`!document.querySelector('[data-screen="play"]').hidden && ${AMMO} > 0`);
    // clock=manual では、時計を進めるまでステップが進まず、的が最初のステップのあとの姿で描かれない。比べる元の画面を写す前に少し進めておく。
    if (manualClock) await page.advanceClock(2 / 60);
    await page.frames(5);
    return page;
  }

  /** キャンバスの中心をクリックしてポインターロックを掛ける。 */
  async function lock(page: Page, cx: number, cy: number) {
    await page.click(cx, cy);
    await page.waitFor('!!document.pointerLockElement', 5000);
    // ロックが掛かったあとの画面が描画されるまで待つ。
    await page.frames(2);
  }

  const ammo = (page: Page) => page.evaluate<number | undefined>(`(() => { const n = ${AMMO}; return Number.isNaN(n) ? undefined : n; })()`);

  // -------------------------------------------------------------------------
  describe('UI-18: プレイ画面の中心にリングと中心点の的、壁に 1 m ごとの目地、壁の下に床、壁の上に空が見え、赤い箱はない', () => {
    const W = 1280;
    const H = 800;
    const cx = W / 2;
    const cy = H / 2;
    // FOV 90・1280x800 で、目から 10 m の壁の 1 m は約 53.3 px。
    const k = pxPerTan(90, W, H);
    /** 壁の正面（z = -10、目の高さ 1.6 m）の点 (x, y) メートルの画面上の位置。 */
    const onWall = (x: number, y: number): [number, number] => [cx + (k * x) / 10, cy - (k * (y - 1.6)) / 10];

    // 同じ画面写しを読むテストが続くので、画面写しは 1 回だけ撮る。各テストはページを使わず、この画素を読む。
    let img: Image;
    beforeAll(async () => {
      const page = await openPlay();
      img = await canvasOnly(page);
      noExceptions(page);
    }, 60_000);

    it('画面の中心に、中心点と、それを囲む同心円の暗いリング（6 本）が描かれている', () => {
      const wall = img.pixel(cx + 120, cy + 20);
      const dark = lum(wall) - 90;
      // 中心点: 中心を囲む 2x2 の画素のうち暗いものがある。
      const centerPixels = [img.pixel(cx - 1, cy - 1), img.pixel(cx, cy - 1), img.pixel(cx - 1, cy), img.pixel(cx, cy)];
      expect(centerPixels.some((c) => lum(c) < dark), `中心 ${JSON.stringify(centerPixels)} 壁 ${wall}`).toBe(true);
      // リング: 右・左・下・斜めのどの向きにも、0.5〜3.0 度の 6 本の暗い線が、中心から同じ距離（その角度の投影）にある。
      // 既定の画面（1280x800）では細いリングは 1 px ほどの太さなので、前後より暗い所として拾う。
      // 壁の上ではリングの白い縁取りの間の壁の地も前後より暗く見えるので、本数ではなく、各リングの距離に線があるかを見る。
      // 反復練習では、リングは壁の手前の人形の正面にも描かれる。人形の部分の箱の縁の線（暗い線）と重なるリングは確かめない。
      const dirs = [0, 45, 90, 135, 180];
      const all = dirs.map((dir) => dipRuns(img, cx, cy, dir, 3, 31));
      for (const theta of [0.5, 1, 1.5, 2, 2.5, 3]) {
        const expected = k * Math.tan(rad(theta));
        all.forEach((runs, i) => {
          if (nearEdge(expected, dummyEdges(dirs[i]!, k / DUMMY_FRONT))) return;
          expect(runs.some((r) => Math.abs(r - expected) <= 1.5), `${theta} 度（${expected} px）: ${JSON.stringify(all)}`).toBe(true);
        });
      }
    });

    it('壁に 1 m ごとのパネルの目地（壁の地より暗い線）が、壁の左下の角を起点に縦横に描かれている', () => {
      // 横に並ぶ縦の目地: 高さ 4.4 m の行で、x = -5〜5 m に暗い線があり、パネルの中ほどは暗くない。
      const [, rowY] = onWall(0, 4.45);
      const base = img.pixel(onWall(0.5, 4.45)[0], rowY);
      const darker = (c: RGB) => lum(c) < lum(base) - 25;
      for (let x = -5; x <= 5; x += 1) {
        const [px] = onWall(x, 4.45);
        const near = [-2, -1, 0, 1].map((d) => img.pixel(Math.round(px) + d, rowY));
        expect(near.some(darker), `x = ${x} m（${px} px）: ${JSON.stringify(near)} 地 ${base}`).toBe(true);
        const [mid] = onWall(x + 0.5, 4.45);
        if (x < 5) expect(darker(img.pixel(Math.round(mid), rowY)), `x = ${x + 0.5} m はパネルの中`).toBe(false);
      }
      // 縦に並ぶ横の目地: x = 2.5 m の列で、y = 1・2・3・4 m に暗い線があり、パネルの中ほどは暗くない。
      const [colX] = onWall(2.5, 0);
      for (let y = 1; y <= 4; y += 1) {
        const [, py] = onWall(2.5, y);
        const near = [-2, -1, 0, 1].map((d) => img.pixel(colX, Math.round(py) + d));
        expect(near.some(darker), `y = ${y} m（${py} px）: ${JSON.stringify(near)} 地 ${base}`).toBe(true);
        const [, mid] = onWall(2.5, y + 0.5);
        expect(darker(img.pixel(colX, Math.round(mid))), `y = ${y + 0.5} m はパネルの中`).toBe(false);
      }
    });

    it('壁の下（足元から壁まで、壁の外も）に、壁と見分けられる床と 1 m ごとの格子の線が見える', () => {
      const wall = img.pixel(cx + 120, cy + 20);
      // 壁の下端は高さ 0 m（約 cy + 85 px）。その下は床。
      const [, bottom] = onWall(0, 0);
      // 列 cx + 20（x = 0 の格子の線の横）の、距離 3〜9 m の格子の線の間の点を床の地とする。
      const floorAt = (d: number) => Math.round(cy + (k * 1.6) / d);
      const col = cx + 20;
      const base = img.pixel(col, Math.round((floorAt(6) + floorAt(5)) / 2));
      expect(distance(base, wall), `床 ${base} 壁 ${wall}`).toBeGreaterThan(30);
      expect(floorAt(9)).toBeGreaterThan(bottom);
      for (let d = 3; d <= 9; d += 1) {
        const y = floorAt(d);
        const near = [-2, -1, 0, 1, 2].map((dy) => img.pixel(col, y + dy));
        expect(near.some((c) => distance(c, base) > 12), `距離 ${d} m（${y} px）: ${JSON.stringify(near)} 地 ${base}`).toBe(true);
      }
      for (let d = 3; d <= 8; d += 1) {
        const mid = Math.round((floorAt(d) + floorAt(d + 1)) / 2);
        expect(distance(img.pixel(col, mid), base), `距離 ${d}〜${d + 1} m の間（${mid} px）`).toBeLessThan(12);
      }
      // 壁より先の床: 壁の右の外（x ≈ 13 m、距離 ≈ 14 m）の、目の高さより下も床の色に近い（空ではない）。
      const beyond = img.pixel(cx + 500, cy + 60);
      const sky = img.pixel(cx, 10);
      expect(distance(beyond, sky), `壁の外の床 ${beyond} 空 ${sky}`).toBeGreaterThan(40);
      expect(distance(beyond, wall), `壁の外の床 ${beyond} 壁 ${wall}`).toBeGreaterThan(20);
    });

    it('壁の上と壁の外（目の高さより上）は空で、上ほど明るいグラデーションになっている', () => {
      const wall = img.pixel(cx + 120, cy + 20);
      const [, top] = onWall(0, 5);
      const low = img.pixel(cx, Math.round(top) - 15);
      const high = img.pixel(cx, 5);
      expect(distance(low, wall), `空 ${low} 壁 ${wall}`).toBeGreaterThan(30);
      expect(lum(high), `上 ${high} 下 ${low}`).toBeGreaterThan(lum(low) + 10);
      // 上から下へ、明るさが増えることがない（上ほど明るい）。
      let prev = Infinity;
      for (let y = 5; y < top - 10; y += 20) {
        const l = lum(img.pixel(cx, y));
        expect(l, `y = ${y}`).toBeLessThanOrEqual(prev + 3);
        prev = l;
      }
      // 壁の外（右の外、目の高さより上）も空の色。
      const side = img.pixel(cx + 500, cy - 60);
      // 壁の地は灰色（青みが少ない）で、空は青みのある色。
      expect(wall[2] - wall[0], `壁 ${wall}`).toBeLessThan(15);
      expect(side[2] - side[0], `壁の外の空 ${side} は青み`).toBeGreaterThanOrEqual(25);
      expect(low[2] - low[0], `壁の上の空 ${low} は青み`).toBeGreaterThanOrEqual(25);
    });

    it('赤い箱の的は表示されない（画面に赤い画素がない）', () => {
      let red = 0;
      for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
        const [r, g, b] = img.pixel(x, y);
        if (r > 140 && r > 2 * g && r > 2 * b) red += 1;
      }
      expect(red).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('UI-19: 角度 θ のリングは、照準と面の交点を中心とした半径 D × tan(θ) の円として描かれる', () => {
    it('FOV 70・1280x1600 の画面で、6 本のリングがどの向きにも D × tan(θ)（D = 9.9 m の板と 10 m の壁）を投影した距離に描かれる', async () => {
      const W = 1280;
      const H = 1600;
      const cx = W / 2;
      const cy = H / 2;
      const page = await openPlay({ width: W, height: H, fov: 70 });
      const img = await canvasOnly(page);
      const k = pxPerTan(70, W, H);
      const wall = img.pixel(cx + 140, cy + 30);
      const dark = lum(wall) - 90;
      const angles = [0.5, 1, 1.5, 2, 2.5, 3];
      // 的の板の正面は z = -9.9（半分の大きさ 0.3 m）、壁の正面は z = -10。目は (0, 1.6, 0)。
      const plateHalf = 0.3;
      // 真上は高さ 2 m の目地（約 61 px）と重なるので避ける。
      const result: Record<number, number[]> = {};
      for (const dir of [0, 45, 90, 135, 180, 225, 315]) {
        // 人形の部分の箱の縁の線（暗い線）の近くの線は除き、縁と重なるリングは確かめない。
        const edges = dummyEdges(dir, k / DUMMY_FRONT);
        const runs = darkRuns(img, cx, cy, dir, 6, 84, dark).filter((r) => !nearEdge(r, edges));
        result[dir] = runs;
        const checked = angles.filter((theta) => !nearEdge(k * Math.tan(rad(theta)), edges));
        expect(runs, `向き ${dir} 度: ${JSON.stringify(runs)}（縁 ${JSON.stringify(edges)}）`).toHaveLength(checked.length);
        expect(checked.length, `向き ${dir} 度で確かめられるリング`).toBeGreaterThanOrEqual(3);
        checked.forEach((theta, i) => {
          // この向きで、リングが板と壁のどちらの面にあるか（板の正面の、照準との交点からの距離 D tan θ が板の内か）。
          const D = 9.9;
          const r = D * Math.tan(rad(theta));
          const along = Math.max(Math.abs(Math.cos(rad(dir))), Math.abs(Math.sin(rad(dir)))) * r;
          const face = along <= plateHalf ? 9.9 : 10;
          // 面の上で半径 face × tan θ の円は、目から見て face 離れた面にあるので、画面では k × tan θ に描かれる。
          const expected = (k * (face * Math.tan(rad(theta)))) / face;
          expect(Math.abs(runs[i]! - expected), `向き ${dir} 度・${theta} 度（${face} m の面）: ${runs[i]} 期待 ${expected}`).toBeLessThanOrEqual(1.5);
        });
      }
      // 対照: 半径が D × θ（ラジアン）や D × sin θ でも数 px の差しかないが、D × tan(θ) と別の距離（たとえば 2 倍の角度）とは区別できる。
      expect(k * Math.tan(rad(3)) - k * Math.tan(rad(2.5))).toBeGreaterThan(10);
      noExceptions(page);
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  describe('UI-20: 照準を動かさずに randomness 0・pattern すべて 0 の武器で撃つと、弾痕が的の中心点の上に表示される', () => {
    it('計算: その武器で撃った弾の位置は、開始時の照準と的の板の正面の交点（的の中心）になる', () => {
      expect(zeroWeaponFiles).toBeGreaterThan(0);
      const base = weaponFile('flatline.json');
      const weapon: WeaponData = { ...base, randomness: 0, pattern: base.pattern.map(() => ({ dx: 0, dy: 0 })) };
      const recording: InputRecording = {
        seed: 12345,
        actions: [
          { time: 0.05, action: { type: 'fire', pressed: true } },
          { time: 0.6, action: { type: 'fire', pressed: false } },
        ],
      };
      const result = replayRecording(recording, { map: rangeMap(), weapon, targetRadius: 1 });
      expect(result.shots.length).toBeGreaterThan(3);
      for (const s of result.shots) {
        expect(s.position).not.toBeNull();
        const { x, y, z } = s.position!;
        expect(x).toBeCloseTo(0, 6);
        expect(y).toBeCloseTo(1.6, 6);
        expect(z).toBeCloseTo(-9.9, 6);
      }
    });

    it('画面: 撃つ前は中心に的の中心点（暗い点）があり、撃ったあとはその上に黄色の弾痕が 1 つ、中心に重なって表示される', async () => {
      const W = 1280;
      const H = 1600;
      const cx = W / 2;
      const cy = H / 2;
      const page = await openPlay({ origin: zeroOrigin, width: W, height: H, fov: 70, manualClock: true });
      const before = await canvasOnly(page);
      const wall = before.pixel(cx + 140, cy + 30);
      const center = [before.pixel(cx - 1, cy - 1), before.pixel(cx, cy - 1), before.pixel(cx - 1, cy), before.pixel(cx, cy)];
      for (const c of center) expect(lum(c), `中心点 ${JSON.stringify(center)} 壁 ${wall}`).toBeLessThan(lum(wall) - 90);

      await lock(page, cx, cy);
      const full = await ammo(page);
      await mouseButton(page, 'mousePressed', cx, cy, 'left');
      // 押したままページの時計を進め、何発か撃てた（残弾が 3 減った）ところで離す。
      await page.advanceClockUntil(`${full} - ${AMMO} >= 3`, { limit: 2 });
      await mouseButton(page, 'mouseReleased', cx, cy, 'left');
      // 離したあと、リコイルの戻りが終わるまで時計を進める（撃ち終わり、照準が戻る）。
      await page.advanceClock(0.6);
      const left = await ammo(page);
      expect(full! - left!, `残弾 ${full} → ${left}`).toBeGreaterThanOrEqual(2);
      const after = await canvasOnly(page);

      const yellow = hex('#ffd84a');
      const hits: [number, number][] = [];
      for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (distance(after.pixel(x, y), yellow) < 60) hits.push([x + 0.5, y + 0.5]);
      expect(hits.length, '黄色の弾痕の画素').toBeGreaterThan(4);
      // 弾痕は 1 つにまとまり（全弾が同じ位置）、中心に重なる。
      const mx = hits.reduce((s, p) => s + p[0], 0) / hits.length;
      const my = hits.reduce((s, p) => s + p[1], 0) / hits.length;
      expect(Math.abs(mx - cx), `重心 (${mx}, ${my})`).toBeLessThanOrEqual(1);
      expect(Math.abs(my - cy), `重心 (${mx}, ${my})`).toBeLessThanOrEqual(1);
      for (const [x, y] of hits) expect(Math.hypot(x - cx, y - cy), `(${x}, ${y})`).toBeLessThan(10);
      // 中心点のあった画素は、弾痕の黄色で覆われる。
      for (const [x, y] of [[cx - 1, cy - 1], [cx, cy - 1], [cx - 1, cy], [cx, cy]] as const) {
        expect(distance(after.pixel(x, y), yellow), `(${x}, ${y}) ${after.pixel(x, y)}`).toBeLessThan(60);
      }
      noExceptions(page);
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  describe('UI-21・UI-22: ads を押している間はスコープの表示になり、離すと戻る。視野角は変わらない', () => {
    const W = 1280;
    const H = 800;
    const cx = W / 2;
    const cy = H / 2;
    // スコープの視野の直径は画面の短い辺の 80%。
    const R = (Math.min(W, H) * 0.8) / 2;
    const outside: [number, number][] = [
      [60, cy], [W - 60, cy], [cx, 40], [cx, H - 40], [200, 200], [W - 200, H - 160], [cx + R + 30, cy], [cx - R - 30, cy + 20],
    ];

    /** レティクル（十字と点）が色 c で中心に描かれているか。 */
    function reticle(img: Image, c: RGB) {
      const is = (x: number, y: number) => distance(img.pixel(x, y), c) < 60;
      const arm = (dx: number, dy: number) => Array.from({ length: 120 }, (_, i) => i + 15).some((n) => is(cx + dx * n, cy + dy * n));
      const near = (dx: number, dy: number) => [-1, 0].some((o) => (dx ? is(cx + dx * 8, cy + o) : is(cx + o, cy + dy * 8)));
      return {
        dot: [[cx - 1, cy - 1], [cx, cy - 1], [cx - 1, cy], [cx, cy]].some(([x, y]) => is(x!, y!)),
        arms: [arm(1, 0), arm(-1, 0), arm(0, 1), arm(0, -1)],
        // 十字の中心の近く（中心から 8 px）は空いている。
        gap: [near(1, 0), near(-1, 0), near(0, 1), near(0, -1)].every((v) => !v),
        diagonal: [20, 40, 80].some((n) => is(cx + n, cy + n) || is(cx - n, cy - n)),
      };
    }

    it('UI-21: 既定の色で、押している間はクロスヘアが消え、周りが暗く覆われた円形の視野と十字と点のレティクル。離すと戻る', async () => {
      const page = await openPlay({ manualClock: true });
      await lock(page, cx, cy);
      const hip = await screenshot(page);
      const hipCanvas = await canvasOnly(page);
      expect(await page.evaluate<boolean>(SHOWN('[data-screen="play"] .crosshair'))).toBe(true);
      const color = hex('#77ccff');
      const hipReticle = reticle(hip, color);
      expect(hipReticle.dot, '腰撃ちのクロスヘア（点）').toBe(true);
      expect(hipReticle.arms.some(Boolean), '腰撃ちでは十字の腕がない').toBe(false);

      await mouseButton(page, 'mousePressed', cx, cy, 'right');
      // 押したままページの時計を 2 描画分進める（押している長さを実時間で決めない）。
      await page.advanceClock(2 / 60);
      // スコープの表示に切り替わり（クロスヘアが消えてスコープが出る）、その画面が描画されるまで待つ。
      await page.waitFor(`!${SHOWN('[data-screen="play"] .crosshair')} && ${SHOWN('[data-screen="play"] .scope')}`);
      const ads = await screenshot(page);
      expect(await page.evaluate<boolean>(SHOWN('[data-screen="play"] .crosshair')), '腰撃ちのクロスヘアが消える').toBe(false);
      // 視野の外はほぼ不透明な暗い色で覆われる（腰撃ちのときの壁・床・空の色は見えない）。
      for (const [x, y] of outside) {
        expect(lum(ads.pixel(x, y)), `(${x}, ${y}) ${ads.pixel(x, y)} 腰撃ち ${hip.pixel(x, y)}`).toBeLessThan(70);
        expect(distance(hip.pixel(x, y), ads.pixel(x, y)), `(${x}, ${y}) は腰撃ちと違う`).toBeGreaterThan(30);
      }
      // 視野の中（中心から 0.9 R までの、レティクルの線から離れた所）は、シーンがそのまま見える。
      for (const [x, y] of [[cx + 150, cy + 100], [cx - 180, cy - 120], [cx + 60, cy - 200], [cx - 90, cy + 220], [cx + 200, cy - 180]] as const) {
        expect(Math.hypot(x - cx, y - cy)).toBeLessThan(R * 0.9);
        expect(distance(ads.pixel(x, y), hipCanvas.pixel(x, y)), `(${x}, ${y}) ${ads.pixel(x, y)} シーン ${hipCanvas.pixel(x, y)}`).toBeLessThan(25);
      }
      // 視野は円形: 斜め 4 方向と上下左右で、見える所から暗い所に変わる距離が同じ（直径は短い辺の 80%）。
      // 比べる相手は HTML の画面も写した腰撃ちの写し。環境によって出る HUD の文（Linux の Chromium では、加速を外した
      // ポインターロックを使えない旨が視野の上に重なる）は両方に同じく写り、視野の縁だけが違いとして残る。
      const edges: number[] = [];
      for (const dir of [20, 70, 110, 160, 200, 250, 290, 340]) {
        const ux = Math.cos(rad(dir));
        const uy = Math.sin(rad(dir));
        let edge = -1;
        for (let r = 100; r < 400; r += 1) {
          const x = Math.round(cx + ux * r);
          const y = Math.round(cy + uy * r);
          if (x < 0 || y < 0 || x >= W || y >= H) break;
          if (distance(ads.pixel(x, y), hip.pixel(x, y)) > 40) {
            edge = r;
            break;
          }
        }
        edges.push(edge);
      }
      for (const e of edges) {
        expect(e, JSON.stringify(edges)).toBeGreaterThan(R - 40);
        expect(e, JSON.stringify(edges)).toBeLessThanOrEqual(R + 2);
      }
      expect(Math.max(...edges) - Math.min(...edges), JSON.stringify(edges)).toBeLessThanOrEqual(4);
      // レティクル: 中心の点と、上下左右の細い十字の線（中心の近くは空ける）。斜めにはない。
      const r = reticle(ads, color);
      expect(r, JSON.stringify(r)).toEqual({ dot: true, arms: [true, true, true, true], gap: true, diagonal: false });

      await mouseButton(page, 'mouseReleased', cx, cy, 'right');
      // 腰撃ちのクロスヘアに戻り（スコープが消える）、その画面が描画されるまで待つ。
      await page.waitFor(`${SHOWN('[data-screen="play"] .crosshair')} && !${SHOWN('[data-screen="play"] .scope')}`);
      const back = await screenshot(page);
      expect(await page.evaluate<boolean>(SHOWN('[data-screen="play"] .crosshair')), 'クロスヘアに戻る').toBe(true);
      for (const [x, y] of outside) expect(distance(back.pixel(x, y), hip.pixel(x, y)), `(${x}, ${y})`).toBeLessThan(20);
      const backReticle = reticle(back, color);
      expect(backReticle.dot).toBe(true);
      expect(backReticle.arms.some(Boolean), '十字のレティクルは消える').toBe(false);
      noExceptions(page);
    }, 90_000);

    it('UI-21: レティクルはクロスヘアの色で描かれ、形はクロスヘアの形（輪）によらず十字と点', async () => {
      const page = await openPlay({ crosshair: { color: '#ff3030', shape: 'circle' }, manualClock: true });
      await lock(page, cx, cy);
      await mouseButton(page, 'mousePressed', cx, cy, 'right');
      // 押したままページの時計を 2 描画分進める（押している長さを実時間で決めない）。
      await page.advanceClock(2 / 60);
      // スコープの表示に切り替わり（クロスヘアが消えてスコープが出る）、その画面が描画されるまで待つ。
      await page.waitFor(`!${SHOWN('[data-screen="play"] .crosshair')} && ${SHOWN('[data-screen="play"] .scope')}`);
      const ads = await screenshot(page);
      expect(await page.evaluate<boolean>(SHOWN('[data-screen="play"] .crosshair'))).toBe(false);
      const r = reticle(ads, hex('#ff3030'));
      expect(r, JSON.stringify(r)).toEqual({ dot: true, arms: [true, true, true, true], gap: true, diagonal: false });
      // 既定の色のレティクルではない。
      expect(reticle(ads, hex('#77ccff')).arms.some(Boolean)).toBe(false);
      await mouseButton(page, 'mouseReleased', cx, cy, 'right');
      // 腰撃ちのクロスヘアに戻り（スコープが消える）、その画面が描画されるまで待つ。
      await page.waitFor(`${SHOWN('[data-screen="play"] .crosshair')} && !${SHOWN('[data-screen="play"] .scope')}`);
      expect(await page.evaluate<boolean>(SHOWN('[data-screen="play"] .crosshair'))).toBe(true);
      noExceptions(page);
    }, 90_000);

    it.each([90, 110])('UI-22: FOV %d で、ads を押している間と離している間でキャンバスの描画（視野角）が同じで、FOV から求めた視野角の投影に一致する', async (fov) => {
      const page = await openPlay({ fov, manualClock: true });
      await lock(page, cx, cy);
      const hip = await canvasOnly(page);
      await mouseButton(page, 'mousePressed', cx, cy, 'right');
      // 押したままページの時計を 2 描画分進める（押している長さを実時間で決めない）。
      await page.advanceClock(2 / 60);
      // スコープの表示に切り替わり（クロスヘアが消えてスコープが出る）、その画面が描画されるまで待つ。
      await page.waitFor(`!${SHOWN('[data-screen="play"] .crosshair')} && ${SHOWN('[data-screen="play"] .scope')}`);
      expect(await page.evaluate<boolean>(SHOWN('[data-screen="play"] .crosshair')), 'ads が効いている').toBe(false);
      const ads = await canvasOnly(page);
      await mouseButton(page, 'mouseReleased', cx, cy, 'right');
      // 腰撃ちのクロスヘアに戻り（スコープが消える）、その画面が描画されるまで待つ。
      await page.waitFor(`${SHOWN('[data-screen="play"] .crosshair')} && !${SHOWN('[data-screen="play"] .scope')}`);
      const after = await canvasOnly(page);
      let diff = 0;
      let diffAfter = 0;
      for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
        if (distance(hip.pixel(x, y), ads.pixel(x, y)) > 30) diff += 1;
        if (distance(hip.pixel(x, y), after.pixel(x, y)) > 30) diffAfter += 1;
      }
      expect(diff, 'ads を押している間のキャンバスが腰撃ちと違う画素の数').toBe(0);
      expect(diffAfter).toBe(0);
      // 壁の上の縁（高さ 5 m、正面まで 10 m）の画面上の位置が、その FOV から求めた縦の視野角の投影と一致する。
      const k = pxPerTan(fov, W, H);
      const expectedTop = cy - (k * (5 - 1.6)) / 10;
      const col = cx + Math.round(k * 0.15);
      const sky = ads.pixel(col, 5);
      let top = -1;
      for (let y = 5; y < cy; y += 1) {
        if (distance(ads.pixel(col, y), sky) > 40 && distance(ads.pixel(col, y + 2), ads.pixel(col, y - 3)) > 40) {
          top = y;
          break;
        }
      }
      expect(Math.abs(top - expectedTop), `壁の上の縁 ${top} 期待 ${expectedTop}`).toBeLessThanOrEqual(4);
      noExceptions(page);
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  describe('UI-23: 壁・的・床・空・スコープの表示を描画した状態で同じ入力の記録を再生すると、弾痕の位置と採点結果が記録したときと一致する', () => {
    it('描画しながら練習した記録を再生すると（同じページでも、ブラウザなしでも）、弾痕の位置と採点結果が一致する', async () => {
      const W = 1280;
      const H = 800;
      const cx = W / 2;
      const cy = H / 2;
      const page = await openPlay({ origin: devOrigin });
      await page.evaluate(`(async () => {
        const src = '${BASE}src/';
        const [practiceMod, recordingMod, loopMod, timeMod, sceneMod, impactsMod, playerMod, mapMod, weaponMod, scopeMod] = await Promise.all(
          ['sim/practice.ts', 'input/recording.ts', 'core/loop.ts', 'core/time.ts', 'render/scene.ts', 'render/impacts.ts',
           'sim/player.ts', 'sim/map.ts', 'sim/weapon.ts', 'ui/scope.ts'].map((p) => import(src + p)));
        const map = mapMod.parseMap(await (await fetch(src + 'data/maps/range.json')).json()).map;
        const weapon = weaponMod.parseWeapon(await (await fetch(src + 'data/weapons/flatline.json')).json()).weapon;
        const view = document.getElementById('view');
        const canvas = document.createElement('canvas');
        canvas.id = 'qa-canvas';
        const z = getComputedStyle(view).zIndex;
        canvas.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;' + (z === 'auto' ? '' : 'z-index:' + z);
        view.after(canvas);
        const input = new recordingMod.RecordingInput(20261125);
        const practice = practiceMod.createPractice({ map, weapon, input, seed: input.seed });
        const renderer = new sceneMod.SceneRenderer(canvas, practice.world);
        renderer.resize();
        const marks = new impactsMod.ImpactMarks(renderer.view.layer);
        const time = new timeMod.ManualTimeSource();
        const draw = () => {
          marks.sync(practice.gun.shots, practice.world.player.position);
          renderer.render(practice.world, playerMod.viewAngles(practice.world.player));
        };
        const loop = new loopMod.FixedStepLoop({ timeSource: time, update: () => practice.sim.step(), render: draw });
        const elements = {
          crosshair: document.querySelector('[data-screen="play"] .crosshair'),
          scope: document.querySelector('[data-screen="play"] .scope'),
        };
        let ads = false;
        // 撃ちながら下へ引き、途中で床と空の方向へ撃ち、ADS を切り替える。
        const plan = [
          { at: 0.05, action: { type: 'ads', pressed: true } },
          { at: 0.1, action: { type: 'fire', pressed: true } },
          { at: 0.9, action: { type: 'fire', pressed: false } },
          { at: 1.0, action: { type: 'look', yaw: 0, pitch: -25 } },
          { at: 1.1, action: { type: 'fire', pressed: true } },
          { at: 1.35, action: { type: 'fire', pressed: false } },
          { at: 1.45, action: { type: 'look', yaw: 5, pitch: 60 } },
          { at: 1.55, action: { type: 'fire', pressed: true } },
          { at: 1.8, action: { type: 'fire', pressed: false } },
          { at: 1.9, action: { type: 'look', yaw: -5, pitch: -35 } },
          { at: 2.0, action: { type: 'ads', pressed: false } },
          { at: 2.1, action: { type: 'fire', pressed: true } },
          { at: 2.5, action: { type: 'fire', pressed: false } },
        ];
        for (let i = 0; i < 30; i += 1) plan.push({ at: 0.12 + i * 0.026, action: { type: 'look', yaw: Math.sin(i) * 0.05, pitch: -0.12 } });
        plan.sort((a, b) => a.at - b.at);
        let frame = 0;
        window.__qa = {
          async run(until) {
            while (frame < until) {
              frame += 1;
              time.advance(1 / 60);
              while (plan.length > 0 && plan[0].at <= time.now()) {
                const { action } = plan.shift();
                input.push(loop.currentTime(), action);
                if (action.type === 'ads') { ads = scopeMod.adsAfter(ads, action); scopeMod.showAimDisplay(elements, ads); }
              }
              loop.frame();
              await new Promise((r) => requestAnimationFrame(() => r()));
            }
            return { ads, shots: practice.gun.shots.length };
          },
          result() {
            const recording = input.recording();
            const rendered = practiceMod.practiceOutcome(practice, 1);
            const replayed = practiceMod.replayRecording(recording, { map, weapon, targetRadius: 1 });
            return JSON.parse(JSON.stringify({ recording, rendered: { shots: rendered.shots, score: rendered.score },
              replayed: { shots: replayed.shots, score: replayed.score } }));
          },
        };
      })()`);

      // 始める前: 確認用のキャンバスに、壁・的のリング・床・空が描かれている。
      await page.evaluate('window.__qa.run(1)');
      const start = await canvasOnly(page);
      const wall = start.pixel(cx + 120, cy + 20);
      expect(dipRuns(start, cx, cy, 0, 3, 31), 'リング').toHaveLength(6);
      expect(distance(start.pixel(cx + 20, cy + 250), wall), '床').toBeGreaterThan(30);
      expect(distance(start.pixel(cx, 10), wall), '空').toBeGreaterThan(30);

      // ADS で撃っている途中: スコープの表示が出ていて、視野の外が暗い。
      const mid = (await page.evaluate<{ ads: boolean; shots: number }>('window.__qa.run(40)'));
      expect(mid.ads).toBe(true);
      expect(mid.shots).toBeGreaterThan(0);
      const scoped = await screenshot(page);
      for (const [x, y] of [[60, cy], [W - 60, cy], [200, 200]] as const) expect(lum(scoped.pixel(x, y)), `(${x}, ${y})`).toBeLessThan(70);
      expect(await page.evaluate<boolean>(SHOWN('[data-screen="play"] .scope'))).toBe(true);

      const end = await page.evaluate<{ ads: boolean; shots: number }>('window.__qa.run(180)');
      expect(end.ads).toBe(false);
      const out = await page.evaluate<{
        recording: InputRecording;
        rendered: { shots: { position: unknown }[]; score: unknown };
        replayed: { shots: { position: unknown }[]; score: unknown };
      }>('window.__qa.result()');

      const positions = (shots: readonly { position: unknown }[]) => shots.map((s) => s.position);
      expect(out.rendered.shots.length).toBeGreaterThan(10);
      // 壁・的に当たった弾と、床や空の方向へ撃ってどの箱にも当たらなかった弾の両方がある。
      expect(out.rendered.shots.some((s) => s.position !== null)).toBe(true);
      expect(out.rendered.shots.some((s) => s.position === null)).toBe(true);
      // 同じページで再生した結果。
      expect(positions(out.replayed.shots)).toEqual(positions(out.rendered.shots));
      expect(out.replayed.score).toEqual(out.rendered.score);
      // ブラウザなし（描画なし）で再生した結果。
      const node = replayRecording(out.recording, { map: rangeMap(), weapon: weaponFile('flatline.json'), targetRadius: 1 });
      expect(positions(JSON.parse(JSON.stringify(node.shots)) as { position: unknown }[])).toEqual(positions(out.rendered.shots));
      expect(JSON.parse(JSON.stringify(node.score))).toEqual(out.rendered.score);
      noExceptions(page);
    }, 120_000);
  });
});
