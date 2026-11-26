// docs/spec/modes.md・screens.md の人形の的の表示の受け入れ条件（MODE-58・UI-135・UI-137）を、ビルドの結果をヘッドレスの Chromium で開いて確かめる（#90）。
// QA が SPEC だけから書いたもの。公開された入口（/apex-training/ で配信した画面: トップ・設定・プレイ、キャンバスの画面写し）と、
// FOV からの視野角の換算 fieldOfView（screens.md「FOV と画面への投影」）だけを使う。ブラウザを使わない部分は humanoid-dummy-qa.acceptance.test.ts にある。
//
// 人形の見つけ方: 人形の色は SPEC では「マゼンタ」（追いエイムで照準が乗っているときは水色）としか決まっていないので、画面写しで人形の胴が
// あるはずの所（反復練習と追いエイムの開始直後は画面の中心、フリックは的が出る前後の差）の色を人形の色とし、その色に近い画素を人形の画素とする。
// 人形の画素の外接の長方形（人形の幅 0.82・高さ 1.8 の縮尺倍）から、SPEC の表の部分の箱の高さの行を求め、その行で人形の画素のまとまりを数える
// （頭の行は 1 つ、胴と腕の行は腕・胴・腕の 3 つ以上、脚の行は 2 つ）。1 つの箱の的なら、どの行もまとまりは 1 つになる。
// 時計は clock=manual で進め（ARC-22）、ページは固定の種で開く（ARC-49）。Chromium がなければ飛ばす。入れ子の実行（ARC-13）でも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fieldOfView } from '../../src/render/fov';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';
import { decodePng, type Image } from '../helpers/png';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
/** ページを開く練習の乱数の種。テストが失敗したときのメッセージにも出る。 */
const SEED = 9058;
const WIDTH = 1920;
const HEIGHT = 1200;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;
const chromium = findChromium();
const rad = (d: number) => (d * Math.PI) / 180;

/** SPEC の値。 */
const FOV = 90; // 既定の FOV（screens.md「設定」）
const RING_ANGLES = [0.5, 1, 1.5, 2, 2.5, 3]; // 的のリング（screens.md「3D の表示」）
const DOT_ANGLE = 0.1; // 中心点の半径（度）
const IMPACT: RGB = [0xff, 0xd8, 0x4a]; // 弾痕の色
const DUMMY_WIDTH = 0.82;
const DUMMY_HEIGHT = 1.8;
const HEAD_TOP = 0.525; // 人形の中心から頭の上端まで（縮尺 1）
const DUMMY_FRONT = 9.6; // 反復練習の人形の正面（目から約 9.7 m の中心 − 奥行きの半分 0.125）

const REPEAT = '反復練習';
const TRACK = '追いエイム';
const TRACK_RECOIL = '追いエイム＋リコイル';
const FLICK = 'フリック';

type RGB = [number, number, number];
const l1 = (a: readonly number[], b: readonly number[]) => Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!);
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const lum = (c: readonly number[]) => c[0]! + c[1]! + c[2]!;

/** 画面の中心から tan = 1 だけずれた方向が何 px 離れて描かれるか（screens.md「FOV と画面への投影」）。 */
const K = HEIGHT / 2 / Math.tan(rad(fieldOfView(FOV, WIDTH / HEIGHT).vertical / 2));
/** 照準からの角度（度）の画面上の距離（px）。 */
const px = (deg: number) => K * Math.tan(rad(deg));

function median(colors: RGB[]): RGB {
  const m = (i: 0 | 1 | 2) => {
    const v = colors.map((c) => c[i]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)]!;
  };
  return [m(0), m(1), m(2)];
}

const PAGE_INIT = `
  window.__vis = (sel) => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    return !!el && !el.closest('[hidden]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0; };
`;
const TOP_READY = `window.__vis('[data-screen="top"]') && document.querySelector('#mode').options.length > 0`;

async function choose(page: Page, selector: string, label: string) {
  const ok = await page.evaluate<boolean>(`(() => {
    const s = document.querySelector(${JSON.stringify(selector)}); if (!s) return false;
    const o = [...s.options].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  if (!ok) throw new Error(`${selector} に ${label} の選択肢がない`);
}

async function chooseSetting(page: Page, label: string, value: string) {
  const ok = await page.evaluate<boolean>(`(() => {
    const s = [...document.querySelectorAll('[data-screen="top"] select')].find((s) => window.__vis(s) && (s.closest('label')?.textContent ?? '').includes(${JSON.stringify(label)}));
    if (!s) return false; const o = [...s.options].find((x) => x.textContent.trim() === ${JSON.stringify(value)}); if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  if (!ok) throw new Error(`「${label}」で ${value} を選べない`);
}

/** HTML の画面（HUD・クロスヘア・補正のパネル）を隠し、時計を少し進めて描画してから、キャンバスだけを写す。 */
async function canvas(page: Page): Promise<Image> {
  await page.evaluate(`document.getElementById('ui').style.visibility = 'hidden'`);
  await page.advanceClock(1 / 60);
  await page.frames(2);
  const img = decodePng(await page.screenshot());
  await page.evaluate(`document.getElementById('ui').style.visibility = ''`);
  return img;
}

/** 点 (x, y) のまわり 3×3 の画素の中央値。 */
const around = (img: Image, x: number, y: number): RGB => {
  const out: RGB[] = [];
  for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) out.push(img.pixel(Math.floor(x) + dx, Math.floor(y) + dy));
  return median(out);
};

interface Silhouette {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** 人形の縮尺 1 の 1 メートルの画素数（外接の長方形の幅 ÷ 0.82）。 */
  unit: number;
  /** 人形の中心からの高さ y（メートル、縮尺 1）の行の、人形の画素のまとまり（[始まり, 終わり) の px）。 */
  runs(y: number): [number, number][];
}

/** 人形の色 color に近い画素の外接の長方形と、行ごとのまとまり。 */
/**
 * centerY を渡すと、行の高さを外接の長方形の上端からではなく、その画面の高さ（人形の中心）から求める（反復練習では頭の上端に 3 度のリングが重なり、
 * 人形の色の画素の上端が頭の上端より下になるため）。
 */
function silhouette(img: Image, color: RGB, centerY?: number): Silhouette {
  const region = { x0: 0, y0: 0, x1: img.width, y1: img.height };
  const isFill = (x: number, y: number) => l1(img.pixel(x, y), color) < 60;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  let n = 0;
  for (let y = region.y0; y < region.y1; y += 1) {
    for (let x = region.x0; x < region.x1; x += 1) {
      if (!isFill(x, y)) continue;
      n += 1;
      left = Math.min(left, x);
      right = Math.max(right, x + 1);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y + 1);
    }
  }
  if (n < 50) throw new Error(`人形の色 ${color} の画素が見つからない（${n}）`);
  const unit = (right - left) / DUMMY_WIDTH;
  return {
    left,
    right,
    top,
    bottom,
    unit,
    runs(y: number) {
      const row = Math.floor(centerY === undefined ? top + (HEAD_TOP - y) * unit : centerY - y * unit);
      const out: [number, number][] = [];
      let start: number | undefined;
      for (let x = left - 2; x <= right + 2; x += 1) {
        const f = x >= 0 && x < img.width && isFill(x, row);
        if (f && start === undefined) start = x;
        if (!f && start !== undefined) {
          out.push([start, x]);
          start = undefined;
        }
      }
      return out;
    },
  };
}

/**
 * 人形の画素が、頭・胴・左右の腕・左右の脚の部分が分かる人の形か。頭の行（中心から +0.455 m）は頭だけで、端から端までの幅が頭の幅（0.25 m）ほどで
 * 人形の左右の真ん中にある（斜めから見ると頭の側面が縁の線で分かれて見えるので、まとまりの数は数えない）。
 * 胴の行（−0.15 m）は腕・胴・腕の 3 つ以上のまとまりで端から端までが人形の幅ほど、脚の行（−0.6 m）は左右の脚の 2 つ以上のまとまり。
 */
function expectHumanShape(s: Silhouette, label: string, { fullHeight = true } = {}) {
  const head = s.runs(0.455);
  const torso = s.runs(-0.15);
  const legs = s.runs(-0.6);
  const info = `${label}: 外接 ${JSON.stringify([s.left, s.top, s.right, s.bottom])}・1 m ${s.unit.toFixed(1)} px・頭 ${JSON.stringify(head)}・胴 ${JSON.stringify(torso)}・脚 ${JSON.stringify(legs)}`;
  expect(head.length, `頭の行のまとまり（${info}）`).toBeGreaterThanOrEqual(1);
  const headWidth = (head.at(-1)![1] - head[0]![0]) / s.unit;
  expect(headWidth, `頭の幅（${info}）`).toBeGreaterThan(0.25 * 0.6);
  expect(headWidth, `頭の幅（${info}）`).toBeLessThan(0.25 * 1.5);
  // 頭は人形の左右の真ん中にある。
  const headMid = (head[0]![0] + head.at(-1)![1]) / 2;
  expect(Math.abs(headMid - (s.left + s.right) / 2) / s.unit, `頭の位置（${info}）`).toBeLessThan(0.08);
  expect(torso.length, `胴と腕の行のまとまり（${info}）`).toBeGreaterThanOrEqual(3);
  expect((torso.at(-1)![1] - torso[0]![0]) / s.unit, `胴と腕の行の幅（${info}）`).toBeGreaterThan(DUMMY_WIDTH * 0.9);
  expect(legs.length, `脚の行のまとまり（${info}）`).toBeGreaterThanOrEqual(2);
  // 左右の脚のあいだ（人形の左右の真ん中）は人形の画素でない。
  const mid = (s.left + s.right) / 2;
  expect(legs.some(([a, b]) => a <= mid - 1 && b >= mid + 1), `脚のあいだ（${info}）`).toBe(false);
  if (fullHeight) {
    const aspect = (s.bottom - s.top) / (s.right - s.left);
    expect(aspect, `高さ ÷ 幅（${info}）`).toBeGreaterThan((DUMMY_HEIGHT / DUMMY_WIDTH) * 0.9);
    expect(aspect, `高さ ÷ 幅（${info}）`).toBeLessThan((DUMMY_HEIGHT / DUMMY_WIDTH) * 1.1);
  }
}

describe.skipIf(NESTED || !chromium)('QA: 人形の的の表示（MODE-58・UI-135・UI-137）', () => {
  let work = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  const noExceptions = (page: Page) => expect(page.errors.filter((e) => e.startsWith('exception:')), page.errors.join('\n')).toEqual([]);

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'humanoid-browser-qa-'));
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

  /** 新しいタブで localStorage を空にし、必要なら設定でゴースト表示を ON にして、トップ画面を開く（3D を描画し、時計は手で進める）。 */
  async function openTop(opts: { ghost?: boolean } = {}): Promise<Page> {
    const page = await browser!.newPage();
    await page.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await page.addInitScript(PAGE_INIT);
    await page.goto(appUrl(origin, BASE, '#/', { manualClock: true, seed: SEED }));
    await page.evaluate('localStorage.clear()');
    await page.evaluate(`window.__beforeReload = true; location.hash = '#/settings'; location.reload()`);
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && !!document.getElementById('setting-ghost')`, 15_000);
    if (opts.ghost) {
      await page.clickSelector('#setting-ghost');
      await page.waitFor(`document.getElementById('setting-ghost').checked`);
    }
    await page.evaluate(`location.hash = '#/'`);
    await page.waitFor(TOP_READY, 15_000);
    return page;
  }

  /** モード（と練習の設定）を選んで「開始」を押し、プレイ画面に入って時計を after 秒進める。 */
  async function start(page: Page, mode: string, settings: Record<string, string> = {}, after = 0.05) {
    await choose(page, '#mode', mode);
    for (const [label, value] of Object.entries(settings)) await chooseSetting(page, label, value);
    await page.clickSelector('[data-screen="top"] a[href="#/play"]');
    await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]')`);
    await page.advanceClock(after);
  }

  describe('MODE-58: どのモードを始めても、頭・胴・腕・脚が分かる人形の的が表示される', () => {
    it('反復練習: 画面の中心の人形が人の形で表示され、1 つの箱だけの的はない', async () => {
      const page = await openTop();
      await start(page, REPEAT);
      const img = await canvas(page);
      // 人形の胴（中心から 0.3 度、中心点とリングのあいだ）の色を人形の色とする。
      const r = px(0.3);
      const color = median([0, 90, 180, 270].map((a) => around(img, CX + r * Math.cos(rad(a)), CY + r * Math.sin(rad(a)))));
      // 反復練習の人形の中心は画面の中心（開始時の照準は人形の中心を向く）。頭の上端に 3 度のリングが重なるので、高さ ÷ 幅は確かめない。
      expectHumanShape(silhouette(img, color, CY), REPEAT, { fullHeight: false });
      noExceptions(page);
    });

    for (const mode of [TRACK, TRACK_RECOIL]) {
      it(`${mode}: 開始直後（的は画面の中心）の人形が人の形で表示され、1 つの箱だけの的はない`, async () => {
        const page = await openTop();
        await start(page, mode);
        const img = await canvas(page);
        // 開始時の照準は的の中心（人形の胴の中心）を向く。中心のまわりの色を人形の色とする。
        const r = 6;
        const color = median([0, 90, 180, 270].map((a) => around(img, CX + r * Math.cos(rad(a)), CY + r * Math.sin(rad(a)))));
        expectHumanShape(silhouette(img, color), mode);
        noExceptions(page);
      });
    }

    it('フリック（的の大きさ「大」）: 1 個目の的が出たあと、出た人形が人の形で表示され、1 つの箱だけの的はない', async () => {
      const page = await openTop();
      await start(page, FLICK, { 的の大きさ: '大' }, 0.9);
      const before = await canvas(page);
      await page.advanceClock(0.2);
      const after = await canvas(page);
      // 的が出る前後で変わった画素の、いちばん多い色を人形の色とする。
      const counts = new Map<string, number>();
      for (let y = 0; y < HEIGHT; y += 1) {
        for (let x = 0; x < WIDTH; x += 1) {
          const q = after.pixel(x, y);
          if (l1(before.pixel(x, y), q) > 60) counts.set(q.join(','), (counts.get(q.join(',')) ?? 0) + 1);
        }
      }
      const top = [...counts].sort((a, b) => b[1] - a[1])[0];
      expect(top, '1 個目の的が出たあとに画面が変わる').toBeDefined();
      const color = top![0].split(',').map(Number) as RGB;
      // 人形の脚の下端は床に隠れることがある（modes.md「フリック」）ので、高さ ÷ 幅は確かめない。
      expectHumanShape(silhouette(after, color), FLICK, { fullHeight: false });
      noExceptions(page);
    });
  });

  describe('UI-135: 反復練習の人形の胴・リング・中心点', () => {
    it('画面の中心に人形の胴が見え、中心点が胴の中心にあり、リングが人形の正面と後ろの壁の両方に、人形の縁で途切れずにつながって描かれる', async () => {
      const page = await openTop();
      await start(page, REPEAT);
      const img = await canvas(page);
      const r03 = px(0.3);
      const torso = [0, 45, 90, 135, 180, 225, 270, 315].map((a) => around(img, CX + r03 * Math.cos(rad(a)), CY + r03 * Math.sin(rad(a))));
      const color = median(torso);
      const isFill = (c: readonly number[]) => l1(c, color) < 60;
      // 画面の中心のまわり（中心点とリングのあいだ）は人形の胴の色。
      expect(torso.filter(isFill).length, `中心のまわりの色 ${JSON.stringify(torso)}`).toBe(8);

      // 中心点: 画面の中心（半径 0.1 度の内）は人形の色でなく暗い。
      const dot = around(img, CX, CY);
      expect(isFill(dot), `中心の色 ${dot}`).toBe(false);
      expect(lum(dot), `中心点の明るさ ${dot}`).toBeLessThan(lum(color));
      expect(px(DOT_ANGLE)).toBeGreaterThan(1);

      // 中心点は胴の中心にある: 人形の画素の外接の長方形から求めた胴の中心（左右の真ん中、上端から 0.525 m）が画面の中心。
      // 左右は人形の画素の外接の長方形の真ん中、上下は脚の下端（頭の上端は 3 度のリングと重なる）から 1.275 m 上が胴の中心。
      const s = silhouette(img, color, CY);
      expectHumanShape(s, REPEAT, { fullHeight: false });
      const box = JSON.stringify([s.left, s.top, s.right, s.bottom]);
      expect(Math.abs((s.left + s.right) / 2 - CX), `外接 ${box}`).toBeLessThanOrEqual(2);
      expect(Math.abs(s.bottom - (DUMMY_HEIGHT - HEAD_TOP) * s.unit - CY), `外接 ${box}`).toBeLessThanOrEqual(2.5);
      // 人形の正面の距離（約 9.6 m）: 人形の幅 0.82 m の画素数から（縮尺 1）。
      expect(K / s.unit).toBeGreaterThan(DUMMY_FRONT * 0.95);
      expect(K / s.unit).toBeLessThan(DUMMY_FRONT * 1.05);

      // リング: 各リングの円の上の点を 2 度ごとに見て、半径 K·tanθ の ±1.5 px に前後より暗い所があるか。
      // 点が人形の上か壁（と的の箱）の上かは、その点から半径の向きに ±0.2 度の所の色がどちらも人形の色か、どちらも明るい壁の色（人形の色でなく、
      // 部分の箱の縁の暗い線でもない）かで決める。縁にかかる点と、脚のあいだのような細い空き（縁の線で埋まる）の点は除く。
      // 壁と的の箱の地は灰色〜白（色みのない明るい色）。人形の色や縁の線と混ざった画素は色みがある。
      const isWall = (c: RGB) => lum(c) > 300 && Math.max(...c) - Math.min(...c) < 40;
      const missing: string[] = [];
      const counted = { dummy: 0, wall: 0 };
      for (const theta of RING_ANGLES) {
        const R = px(theta);
        const off = px(0.2);
        for (let phi = 0; phi < 360; phi += 2) {
          const ux = Math.cos(rad(phi));
          const uy = Math.sin(rad(phi));
          const at = (rr: number) => img.pixel(Math.floor(CX + ux * rr), Math.floor(CY + uy * rr));
          const inner = around(img, CX + ux * (R - off), CY + uy * (R - off));
          const outer = around(img, CX + ux * (R + off), CY + uy * (R + off));
          const where = isFill(inner) && isFill(outer) ? 'dummy' : isWall(inner) && isWall(outer) ? 'wall' : undefined;
          if (!where) continue;
          let darkest = Infinity;
          for (let d = -1.5; d <= 1.5; d += 0.25) darkest = Math.min(darkest, lum(at(R + d)));
          const ok = Math.min(lum(inner), lum(outer)) - darkest >= 80;
          counted[where] += 1;
          if (!ok) missing.push(`${theta}°@${phi}°(${where}: 内 ${inner} 外 ${outer} 最暗 ${darkest})`);
        }
      }
      expect(counted.dummy, '人形の上で確かめたリングの点').toBeGreaterThan(200);
      expect(counted.wall, '壁の上で確かめたリングの点').toBeGreaterThan(100);
      expect(missing.join(" "), `リングの線が見つからない点（人形 ${counted.dummy}・壁 ${counted.wall} 点のうち）`).toBe("");
      noExceptions(page);
    });
  });

  describe('UI-137: 人形の胴・頭の色', () => {
    it('反復練習の人形の胴・頭の画素の色が、壁・床・空・リング・弾痕（#ffd84a）・ゴーストのどの色とも違う', async () => {
      const page = await openTop();
      await start(page, REPEAT);
      const img = await canvas(page);
      // 胴: 中心から 0.3 度（中心点とリングのあいだ）。頭: 中心から上へ 2.2 度（頭の中心 0.4 m の少し下、2.0 度と 2.5 度のリングのあいだ）。
      const r03 = px(0.3);
      const torso = [0, 90, 180, 270].map((a) => around(img, CX + r03 * Math.cos(rad(a)), CY + r03 * Math.sin(rad(a))));
      const headY = CY - px(2.2);
      const head = [-0.04, 0, 0.04].map((dx) => around(img, CX + (dx / DUMMY_FRONT) * K, headY));
      // 壁: 照準の中心から左右 8 度・上下 ±2 度（リングと人形の外）。床: 画面の下の端の近く。空: 画面の上の端の近く。
      const wall = [-8, 8].flatMap((yaw) => [-2, 0, 2].map((pitch) => around(img, CX + px(yaw), CY - px(pitch))));
      const floor = [-0.3, 0, 0.3].map((f) => around(img, CX + f * WIDTH, HEIGHT - 8));
      const sky = [-0.3, 0, 0.3].map((f) => around(img, CX + f * WIDTH, 8));
      // リング: 3 度のリングの壁の上の右側。暗い線と白に近い縁取りの画素を、その近くのいちばん暗い・明るい画素とする。
      const ring: RGB[] = [];
      for (let d = -3; d <= 3; d += 1) ring.push(img.pixel(Math.floor(CX + px(3) + d), CY));
      const ringDark = ring.reduce((a, b) => (lum(b) < lum(a) ? b : a));
      const ringLight = ring.reduce((a, b) => (lum(b) > lum(a) ? b : a));

      // ゴースト: ゴースト表示を ON にした同じ時点の画面写しとの差の色（modes.md「反復練習」、ゴーストは緑）。
      const ghostPage = await openTop({ ghost: true });
      await start(ghostPage, REPEAT);
      const withGhost = await canvas(ghostPage);
      const diff: RGB[] = [];
      for (let y = CY - 200; y < CY + 200; y += 1) {
        for (let x = CX - 200; x < CX + 200; x += 1) {
          const q = withGhost.pixel(x, y);
          if (l1(img.pixel(x, y), q) > 60) diff.push(q);
        }
      }
      expect(diff.length, 'ゴースト表示を ON にした画面にゴーストが見える').toBeGreaterThan(5);
      const ghost = median(diff);

      const others: Record<string, RGB[]> = { 壁: wall, 床: floor, 空: sky, リングの線: [ringDark], リングの縁取り: [ringLight], 弾痕: [IMPACT], ゴースト: [ghost] };
      const report = JSON.stringify({ torso, head, ...others });
      for (const [name, part] of [['胴', torso], ['頭', head]] as const) {
        for (const c of part) {
          for (const [other, list] of Object.entries(others)) {
            for (const o of list) expect(dist(c, o), `${name} ${c} と${other} ${o}（${report}）`).toBeGreaterThan(60);
          }
        }
      }
      // 胴と頭は同じ人形の色。
      expect(dist(median(torso), median(head)), report).toBeLessThan(40);
      noExceptions(page);
      noExceptions(ghostPage);
    });
  });
});
