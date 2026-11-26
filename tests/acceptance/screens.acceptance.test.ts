// docs/spec/screens.md の受け入れ条件のうち、画面で確かめるもの（UI-6・UI-8・UI-9）の受け入れテスト。
// 壁・的の見た目は #33 の SPEC（パネルの壁、リングの的、床と空）に合わせて確かめる。
// 公開された入口（ビルドの結果を /apex-training/ で配信した画面、開発サーバーの画面と公開関数）だけを使い、実装の内部には依存しない。
// 画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、画面写しの画素を読んで確かめる（tests/helpers/png.ts）。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';
import { decodePng, type Image } from '../helpers/png';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
/** ページを開く練習の乱数の種（docs/spec/architecture.md「テストのための乱数の種の固定」）。テストが失敗したときのメッセージにも出る。 */
const SEED = 12345;
const WIDTH = 1280;
const HEIGHT = 800;
const chromium = findChromium();

type RGB = [number, number, number];
const distance = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const hex = (s: string): RGB => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

async function screenshot(page: Page): Promise<Image> {
  return decodePng(await page.screenshot());
}

/** トップ画面から「開始」でプレイ画面に入る。 */
async function enterPlay(page: Page, origin: string) {
  await page.goto(appUrl(origin, BASE, '', { seed: SEED }));
  await page.waitFor(`document.querySelector('[data-screen="top"]') && !document.querySelector('[data-screen="top"]').hidden`);
  await page.clickSelector('[data-screen="top"] a[href="#/play"]');
  await page.waitFor(`!document.querySelector('[data-screen="play"]').hidden`);
  // 何度か描画されるまで待つ。ポインターロックはかけない（照準を動かさない）。
  await page.frames(10);
}

/** HTML の画面を見えなくし、キャンバスだけを写す。 */
async function hideHtml(page: Page) {
  await page.evaluate(`for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.visibility = 'hidden'`);
  // 隠した状態で描画し直されるまで待つ。
  await page.frames(2);
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
  let staticOrigin = '';
  let devOrigin = '';
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;

  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), 'ui-dist-'));
    temps.push(out);
    const build = spawnSync(`npm run build -- --outDir "${out}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`ビルドが失敗した:\n${build.stdout}${build.stderr}`);
    server = await serveStatic(out, BASE);
    staticOrigin = originOf(server);
    // 開発サーバーもポート 0 で待ち受け、OS が選んだポートを読む（ARC-18）。
    // 依存の事前バンドルの置き場（cacheDir）はファイルごとの一時ディレクトリにし、並行に流すほかのファイルと node_modules/.vite を取り合わない。
    const cache = mkdtempSync(join(tmpdir(), 'ui-vite-cache-'));
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
    await new Promise((ok) => (server ? server.close(ok) : ok(undefined)));
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  describe('UI-6: HTML の画面の後ろにウィンドウ全体を覆うキャンバスが描画され、プレイ画面では壁と中心の的が見える', () => {
    it('トップ画面を開くと、ウィンドウ全体を覆うキャンバスが HTML の画面の後ろにあり、3D のシーンが描画されている', async () => {
      const page = await browser!.newPage();
      await page.goto(appUrl(staticOrigin, BASE, '', { seed: SEED }));
      await page.waitFor(`!document.querySelector('[data-screen="top"]').hidden && document.querySelector('#weapon').options.length > 0`);
      await page.frames(5);
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
      // 的の周り（中心から 80 px ほど離れた所）は壁で、パネルごとの明るさの違いはわずか。目地（1 m ごと、約 53 px ごと）は避ける。
      const wall = img.pixel(cx + 80, cy);
      for (const [x, y] of [[cx - 80, cy], [cx + 25, cy - 100], [cx - 25, cy + 60], [cx + 150, cy - 100]] as [number, number][]) {
        expect(distance(img.pixel(x, y), wall), `(${x}, ${y})`).toBeLessThan(25);
      }
      // 壁は有限の大きさ（画面の隅は壁ではない）。
      expect(distance(img.pixel(5, 5), wall)).toBeGreaterThan(10);
      // 的（リングの暗い線と、白に近い板）は中心の近くにあり、どちらも壁とは違う色。
      const near: RGB[] = [];
      for (let dy = -6; dy <= 6; dy += 1) for (let dx = -6; dx <= 6; dx += 1) near.push(img.pixel(cx + dx, cy + dy));
      const lum = (c: RGB) => c[0] + c[1] + c[2];
      const darkest = near.reduce((a, b) => (lum(b) < lum(a) ? b : a));
      const lightest = near.reduce((a, b) => (lum(b) > lum(a) ? b : a));
      expect(distance(darkest, wall), `暗い線 ${darkest} と壁 ${wall}`).toBeGreaterThan(40);
      expect(distance(lightest, wall), `板 ${lightest} と壁 ${wall}`).toBeGreaterThan(40);
      // 的は画面の中心にある（中心から上下左右に、最初の暗いリングまでの距離が同じ）。
      const firstDark = (dx: number, dy: number) => {
        for (let n = 3; n < 30; n += 1) if (lum(img.pixel(cx + dx * n, cy + dy * n)) < lum(wall) - 60) return n;
        return -1;
      };
      const [left, right, up, down] = [firstDark(-1, 0), firstDark(1, 0), firstDark(0, -1), firstDark(0, 1)];
      expect(left).toBeGreaterThan(0);
      expect(Math.abs(left - right), `${left} ${right}`).toBeLessThanOrEqual(1);
      expect(Math.abs(up - down), `${up} ${down}`).toBeLessThanOrEqual(1);
      expect(Math.abs(left - up), `${left} ${up}`).toBeLessThanOrEqual(1);
      expect(page.errors.filter((e) => e.startsWith('exception:')), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  describe('UI-8: FOV を指定しないで始めた画面は FOV 90 から求めた視野角で描画される', () => {
    it('壁（幅 12 m・高さ 5 m、正面まで 10 m）の画面上の大きさが、FOV 90 の視野角での投影と一致する', async () => {
      const page = await browser!.newPage();
      await enterPlay(page, staticOrigin);
      await hideHtml(page);
      const img = await screenshot(page);
      // 目地（暗い線）を避けた位置で、壁の色が続く所までを数える。
      const y = cy - 120;
      const x = cx + 80;
      const wall = img.pixel(x, y);
      const edge = (x0: number, y0: number, dx: number, dy: number) => {
        let n = 0;
        for (;;) {
          const px = x0 + dx * (n + 1);
          const py = y0 + dy * (n + 1);
          if (px < 0 || py < 0 || px >= img.width || py >= img.height) return n;
          // 目地は 1〜2 px なので、3 px 続けて壁と違う色になった所を縁とする。
          const off = [1, 2, 3].every((k) => distance(img.pixel(x0 + dx * (n + k), y0 + dy * (n + k)), wall) > 30);
          if (off) return n;
          n += 1;
        }
      };
      const right = cx + 80 + edge(x, y, 1, 0);
      const top = y - edge(x, y, 0, -1);
      // 縦の視野角 = 2 atan(tan(45°) × 3/4)。1 m あたりの画素は 高さの半分 ÷ tan(縦の視野角 / 2) ÷ 距離。
      const pxPerTan = HEIGHT / 2 / 0.75;
      const expectedRight = cx + pxPerTan * (6 / 10);
      const expectedTop = cy - pxPerTan * ((5 - 1.6) / 10);
      // 別の FOV（たとえば縦 90 度）なら右の縁は約 880 px、FOV 90 の換算なら約 960 px。
      expect(right, `右の縁 ${right} 期待 ${expectedRight}`).toBeGreaterThanOrEqual(expectedRight - 3);
      expect(right).toBeLessThanOrEqual(expectedRight + 3);
      expect(top, `上の縁 ${top} 期待 ${expectedTop}`).toBeGreaterThanOrEqual(expectedTop - 3);
      expect(top).toBeLessThanOrEqual(expectedTop + 3);
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
      await page.frames(2);
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
      await page.frames(2);
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
      await page.frames(2);
      img = await screenshot(page);
      e = extent(img, hex('#ffff00'));
      expect(e.center).toBe(true);
      expect(e.right).toBeLessThanOrEqual(6);
      expect(page.errors.filter((x) => x.startsWith('exception:')), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });
});
