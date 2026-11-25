// docs/spec/screens.md の受け入れ条件のうち、画面で確かめるもの（UI-6・UI-8・UI-9）の受け入れテスト。
// 公開された入口（ビルドの結果を /apex-training/ で配信した画面、開発サーバーの画面と公開関数）だけを使い、実装の内部には依存しない。
// 画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、画面写しの画素を読んで確かめる（tests/helpers/png.ts）。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findChromium, launchBrowser, serveStatic, type Browser, type Page } from '../helpers/browser';
import { decodePng, type Image } from '../helpers/png';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const STATIC_PORT = 3106;
const DEBUG_PORT = 3107;
const DEV_PORT = 3108;
const WIDTH = 1280;
const HEIGHT = 800;
const chromium = findChromium();

type RGB = [number, number, number];
const distance = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const hex = (s: string): RGB => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function screenshot(page: Page): Promise<Image> {
  const { data } = await page.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  return decodePng(Buffer.from(data, 'base64'));
}

/** トップ画面から「開始」でプレイ画面に入る。 */
async function enterPlay(page: Page, origin: string) {
  await page.goto(`${origin}${BASE}`);
  await page.waitFor(`document.querySelector('[data-screen="top"]') && !document.querySelector('[data-screen="top"]').hidden`);
  await page.clickSelector('[data-screen="top"] a[href="#/play"]');
  await page.waitFor(`!document.querySelector('[data-screen="play"]').hidden`);
  // 何度か描画されるのを待つ。ポインターロックはかけない（照準を動かさない）。
  await pause(1000);
}

/** HTML の画面を見えなくし、キャンバスだけを写す。 */
async function hideHtml(page: Page) {
  await page.evaluate(`for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.visibility = 'hidden'`);
  await pause(300);
}

/** (x, y) から dx, dy の向きに、色が base に近い画素が続く数。 */
function run(img: Image, x: number, y: number, dx: number, dy: number, base: RGB, tol: number) {
  let n = 0;
  for (;;) {
    const px = x + dx * (n + 1);
    const py = y + dy * (n + 1);
    if (px < 0 || py < 0 || px >= img.width || py >= img.height) return n;
    if (distance(img.pixel(px, py), base) > tol) return n;
    n += 1;
  }
}

describe.skipIf(NESTED || !chromium)('画面の 3D の表示とクロスヘア', () => {
  const temps: string[] = [];
  let server: Server | undefined;
  let dev: ViteDevServer | undefined;
  let browser: Browser | undefined;
  const staticOrigin = `http://127.0.0.1:${STATIC_PORT}`;
  const devOrigin = `http://127.0.0.1:${DEV_PORT}`;
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;

  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), 'ui-dist-'));
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

  describe('UI-6: HTML の画面の後ろにウィンドウ全体を覆うキャンバスが描画され、プレイ画面では壁と中心の的が見える', () => {
    it('トップ画面を開くと、ウィンドウ全体を覆うキャンバスが HTML の画面の後ろにあり、3D のシーンが描画されている', async () => {
      const page = await browser!.newPage();
      await page.goto(`${staticOrigin}${BASE}`);
      await page.waitFor(`!document.querySelector('[data-screen="top"]').hidden`);
      await pause(1000);
      const state = await page.evaluate<{ full: boolean; behind: boolean }>(`(() => {
        const canvas = [...document.querySelectorAll('canvas')].find((c) => { const r = c.getBoundingClientRect();
          return Math.abs(r.left) < 1 && Math.abs(r.top) < 1 && Math.abs(r.width - innerWidth) < 1 && Math.abs(r.height - innerHeight) < 1; });
        const link = document.querySelector('[data-screen="top"] a[href="#/play"]');
        const r = link.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { full: !!canvas, behind: !!el && el.tagName !== 'CANVAS' && (link === el || link.contains(el)) };
      })()`);
      expect(state.full).toBe(true);
      expect(state.behind).toBe(true);
      await hideHtml(page);
      const img = await screenshot(page);
      // 画面全体が 1 色ではない（シーンが描画されている）。
      const samples: RGB[] = [];
      for (let y = 50; y < HEIGHT; y += 100) for (let x = 50; x < WIDTH; x += 100) samples.push(img.pixel(x, y));
      const distinct = samples.filter((c, i) => samples.findIndex((d) => distance(c, d) < 10) === i);
      expect(distinct.length, JSON.stringify(distinct)).toBeGreaterThanOrEqual(2);
      expect(page.errors.filter((e) => e.startsWith('exception:')), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('プレイ画面では、画面の中心に的が、その後ろに壁が、色で区別されて見える', async () => {
      const page = await browser!.newPage();
      await enterPlay(page, staticOrigin);
      await hideHtml(page);
      const img = await screenshot(page);
      expect([img.width, img.height]).toEqual([WIDTH, HEIGHT]);
      const target = img.pixel(cx, cy);
      // 的の中は同じ色。
      for (const [dx, dy] of [[-5, 0], [5, 0], [0, -5], [0, 5]] as const) expect(distance(img.pixel(cx + dx, cy + dy), target)).toBeLessThan(20);
      // 的の周り（中心から 80 px 離れた所）は壁で、的とは違う色。
      const wall = img.pixel(cx + 80, cy);
      for (const [x, y] of [[cx - 80, cy], [cx, cy - 80], [cx, cy + 60], [cx + 150, cy - 100]] as [number, number][]) {
        expect(distance(img.pixel(x, y), wall), `(${x}, ${y})`).toBeLessThan(20);
      }
      expect(distance(target, wall), `的 ${target} と壁 ${wall}`).toBeGreaterThan(40);
      // 壁は有限の大きさ（画面の隅は壁ではない）。
      expect(distance(img.pixel(5, 5), wall)).toBeGreaterThan(10);
      // 的は画面の中心にある（上下左右に同じだけ広がる）。
      const left = run(img, cx, cy, -1, 0, target, 30);
      const right = run(img, cx, cy, 1, 0, target, 30);
      const up = run(img, cx, cy, 0, -1, target, 30);
      const down = run(img, cx, cy, 0, 1, target, 30);
      expect(Math.abs(left - right), `${left} ${right}`).toBeLessThanOrEqual(2);
      expect(Math.abs(up - down), `${up} ${down}`).toBeLessThanOrEqual(2);
      expect(page.errors.filter((e) => e.startsWith('exception:')), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  describe('UI-8: FOV を指定しないで始めた画面は FOV 90 から求めた視野角で描画される', () => {
    it('的（0.6 m 四方、手前の面まで 9.9 m）の画面上の大きさが、FOV 90 の視野角での投影と一致する', async () => {
      const page = await browser!.newPage();
      await enterPlay(page, staticOrigin);
      await hideHtml(page);
      const img = await screenshot(page);
      const target = img.pixel(cx, cy);
      const width = run(img, cx, cy, -1, 0, target, 40) + run(img, cx, cy, 1, 0, target, 40) + 1;
      const height = run(img, cx, cy, 0, -1, target, 40) + run(img, cx, cy, 0, 1, target, 40) + 1;
      // 縦の視野角 = 2 atan(tan(45°) × 3/4)。半分の高さ 0.3 m を 9.9 m 先に見る。
      const halfV = Math.atan(0.75);
      // 中心から縁までは 高さの半分 × (0.3 / 9.9) ÷ tan(縦の視野角 / 2)。全体の高さはその 2 倍（幅も同じ）。
      const expectedPx = ((0.3 / 9.9) / Math.tan(halfV)) * HEIGHT;
      // 別の FOV（たとえば縦 90 度）なら約 24 px、FOV 90 の換算なら約 32 px。
      expect(height, `高さ ${height} 期待 ${expectedPx}`).toBeGreaterThanOrEqual(expectedPx - 3);
      expect(height).toBeLessThanOrEqual(expectedPx + 3);
      expect(width, `幅 ${width} 期待 ${expectedPx}`).toBeGreaterThanOrEqual(expectedPx - 3);
      expect(width).toBeLessThanOrEqual(expectedPx + 3);
    }, 60_000);
  });

  describe('UI-9: プレイ画面のクロスヘア', () => {
    /** クロスヘアの要素の、中心と大きさ。 */
    const crosshairBox = (page: Page) =>
      page.evaluate<{ x: number; y: number; w: number; h: number } | null>(`(() => {
        const el = document.querySelector('[data-screen="play"] .crosshair'); if (!el) return null;
        const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
      })()`);

    /** 中心の周りの、色 c に近い画素の上下左右と斜めへの広がり。 */
    const extent = (img: Image, c: RGB) => ({
      center: distance(img.pixel(cx, cy), c) < 40,
      right: run(img, cx, cy, 1, 0, c, 40),
      left: run(img, cx, cy, -1, 0, c, 40),
      up: run(img, cx, cy, 0, -1, c, 40),
      diag: distance(img.pixel(cx + 6, cy + 6), c) < 40,
      // 中心から右へ 40 px までに、この色の画素があるか（輪の確認用）。
      ringRight: Array.from({ length: 40 }, (_, i) => img.pixel(cx + i + 1, cy)).some((p) => distance(p, c) < 40),
      ringUp: Array.from({ length: 40 }, (_, i) => img.pixel(cx, cy - i - 1)).some((p) => distance(p, c) < 40),
    });

    it('既定では画面の中心に、#77ccff の小さな点が表示される', async () => {
      const page = await browser!.newPage();
      await enterPlay(page, staticOrigin);
      const box = await crosshairBox(page);
      expect(box).not.toBeNull();
      expect(Math.abs(box!.x - cx)).toBeLessThanOrEqual(1);
      expect(Math.abs(box!.y - cy)).toBeLessThanOrEqual(1);
      const img = await screenshot(page);
      const e = extent(img, hex('#77ccff'));
      expect(e.center, `中心の色 ${img.pixel(cx, cy)}`).toBe(true);
      // 点: 小さく、上下左右に同じだけ広がる。
      expect(e.right).toBeLessThanOrEqual(6);
      expect(Math.abs(e.right - e.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(e.right - e.up)).toBeLessThanOrEqual(1);
      expect(e.ringRight && e.right >= 39).toBe(false);
      // 中心から 10 px 以上離れた所には、クロスヘアの色がない。
      for (const [dx, dy] of [[10, 0], [-10, 0], [0, 10], [0, -10], [8, 8]] as const) {
        expect(distance(img.pixel(cx + dx, cy + dy), hex('#77ccff'))).toBeGreaterThan(40);
      }
    }, 60_000);

    it('色と形を指定し直すと、その色と形で表示される（十字・輪、別の色）', async () => {
      const page = await browser!.newPage();
      await enterPlay(page, devOrigin);
      const apply = (shape: string, color: string) =>
        page.evaluate(`import('${BASE}src/ui/crosshair.ts').then((m) => {
          m.applyCrosshair(document.querySelector('[data-screen="play"] .crosshair'), { shape: ${JSON.stringify(shape)}, color: ${JSON.stringify(color)} });
        })`);

      // 既定の確認（開発サーバーでも同じ）。
      let img = await screenshot(page);
      expect(distance(img.pixel(cx, cy), hex('#77ccff'))).toBeLessThan(40);

      // 赤の十字: 中心と上下左右の腕が赤く、斜めは赤くない。点より長い。
      await apply('cross', '#ff2020');
      await pause(300);
      img = await screenshot(page);
      const red = hex('#ff2020');
      let e = extent(img, red);
      expect(e.center, `中心の色 ${img.pixel(cx, cy)}`).toBe(true);
      expect(e.right).toBeGreaterThanOrEqual(6);
      expect(e.left).toBeGreaterThanOrEqual(6);
      expect(e.up).toBeGreaterThanOrEqual(6);
      expect(e.diag).toBe(false);
      // 前の色は残っていない。
      expect(distance(img.pixel(cx, cy), hex('#77ccff'))).toBeGreaterThan(40);
      let box = await crosshairBox(page);
      expect(Math.abs(box!.x - cx)).toBeLessThanOrEqual(1);
      expect(Math.abs(box!.y - cy)).toBeLessThanOrEqual(1);

      // 緑の輪: 中心は緑でなく、中心から離れた所に緑の輪がある。
      await apply('circle', '#20ff40');
      await pause(300);
      img = await screenshot(page);
      const green = hex('#20ff40');
      e = extent(img, green);
      expect(e.center, `中心の色 ${img.pixel(cx, cy)}`).toBe(false);
      expect(e.ringRight).toBe(true);
      expect(e.ringUp).toBe(true);
      box = await crosshairBox(page);
      expect(Math.abs(box!.x - cx)).toBeLessThanOrEqual(1);
      expect(Math.abs(box!.y - cy)).toBeLessThanOrEqual(1);

      // 点に戻し、色も変える。
      await apply('dot', '#ffff00');
      await pause(300);
      img = await screenshot(page);
      e = extent(img, hex('#ffff00'));
      expect(e.center).toBe(true);
      expect(e.right).toBeLessThanOrEqual(6);
      expect(page.errors.filter((x) => x.startsWith('exception:')), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });
});
