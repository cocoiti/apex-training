// docs/spec/screens.md の受け入れ条件 UI-76（リコイルは視点が跳ねる表示）の QA の受け入れテスト（#65）。
// 公開された入口だけを使う: ビルドの結果を /apex-training/ で配信した画面（キャンバス・.crosshair・HUD の残弾・設定画面）と武器の JSON。
// 「randomness 0 で pattern が上向き（dy が正）の武器」は、ビルドの結果の武器の JSON を、randomness 0・各発 dx 0・dy 1.5 度・
// 遅い rpm に書き換えた配信物で再現する（撃っている途中の画面を確実に写せるように）。
// 画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、マウスは DevTools プロトコルで実際の入力として送る。
// 照準は動かさない（マウスを動かさない）。ポートは OS に選ばせ、決まった時間ではなく画面の状態を待つ。Chromium がなければ飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

/** 書き換えた武器の 1 発ごとの跳ね（上向き、度）と発射の速さ。 */
const KICK_DY = 1.5;
const SLOW_RPM = 120;

type RGB = [number, number, number];
const distance = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** HUD の残弾。 */
const AMMO = `Number((document.querySelector('[data-hud="ammo"]').textContent.match(/(\\d+)/) || [])[1])`;

const noExceptions = (page: Page) => expect(page.errors.filter((e) => e.startsWith('exception:')), page.errors.join('\n')).toEqual([]);

/** キャンバス以外の HTML を見えなくする / 戻す。 */
const hideHtml = (page: Page, hide: boolean) =>
  page.evaluate(`for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.visibility = ${hide ? "'hidden'" : "''"}`);

/**
 * 色 c に近い画素のまとまりの中心。列 x を縦に見る。的はリングの暗い線で区切られるので、12 px 以内の切れ目はつなげ、
 * 画素がいちばん多いまとまりの両端の中点を返す。
 */
function blobCenterOnColumn(img: Image, x: number, c: RGB): number | undefined {
  let best: [number, number, number] | undefined;
  let group: [number, number, number] | undefined;
  for (let y = 0; y < HEIGHT; y += 1) {
    if (distance(img.pixel(x, y), c) >= 30) continue;
    if (group && y - group[1] <= 12) group = [group[0], y, group[2] + 1];
    else group = [y, y, 1];
    if (!best || group[2] > best[2]) best = group;
  }
  return best && (best[0] + best[1]) / 2;
}

/** 的の板の色。中心の近くで、壁（中心から 150 px 右）と違う色のうち、いちばん多い色。 */
function boardColor(img: Image): RGB {
  const wall = img.pixel(CX + 150, CY);
  const counts = new Map<string, [RGB, number]>();
  for (let dy = -12; dy <= 12; dy += 1) {
    for (let dx = -12; dx <= 12; dx += 1) {
      const c = img.pixel(CX + dx, CY + dy);
      if (distance(c, wall) <= 40) continue;
      const key = c.join(',');
      counts.set(key, [c, (counts.get(key)?.[1] ?? 0) + 1]);
    }
  }
  const [best] = [...counts.values()].sort((a, b) => b[1] - a[1]);
  return best ? best[0] : img.pixel(CX, CY);
}

const mouseButton = (page: Page, type: 'mousePressed' | 'mouseReleased') =>
  page.send('Input.dispatchMouseEvent', { type, x: CX, y: CY, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });

/** プレイ画面のクロスヘアの中心と、キャンバスの中心（ビューポートの座標）。 */
const crosshairState = (page: Page) =>
  page.evaluate<{ crosshair: { x: number; y: number; shown: boolean } | null; canvas: { x: number; y: number } | null }>(`(() => {
    const el = document.querySelector('[data-screen="play"] .crosshair');
    const canvas = document.querySelector('canvas');
    const center = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    let shown = !!el;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (e.hidden || s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) shown = false;
    }
    return { crosshair: el ? { ...center(el), shown } : null, canvas: canvas ? center(canvas) : null };
  })()`);

describe.skipIf(NESTED || !chromium)('QA: UI-76 リコイルは視点が跳ねる表示で、表示の方式を切り替える設定はない', () => {
  const temps: string[] = [];
  const servers: Server[] = [];
  let browser: Browser | undefined;
  let staticOrigin = '';
  let upOrigin = '';
  let upWeaponFiles = 0;

  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), 'ui75-dist-'));
    temps.push(out);
    const build = spawnSync(`npm run build -- --outDir "${out}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`ビルドが失敗した:\n${build.stdout}${build.stderr}`);
    // 同じ配信物を写し、武器の JSON（pattern と randomness を持つもの）を randomness 0・上向きの pattern・遅い rpm にする。
    const up = mkdtempSync(join(tmpdir(), 'ui75-up-dist-'));
    temps.push(up);
    cpSync(out, up, { recursive: true });
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
    for (const file of walk(up).filter((f) => f.endsWith('.json'))) {
      let json: unknown;
      try {
        json = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      if (!json || typeof json !== 'object' || !Array.isArray((json as { pattern?: unknown }).pattern)) continue;
      const w = json as { pattern: { dx: number; dy: number }[]; randomness: number; rpm: number };
      w.randomness = 0;
      w.rpm = SLOW_RPM;
      w.pattern = w.pattern.map(() => ({ dx: 0, dy: KICK_DY }));
      writeFileSync(file, JSON.stringify(w));
      upWeaponFiles += 1;
    }
    const staticServer = await serveStatic(out, BASE);
    servers.push(staticServer);
    staticOrigin = originOf(staticServer);
    const upServer = await serveStatic(up, BASE);
    servers.push(upServer);
    upOrigin = originOf(upServer);
    browser = await launchBrowser(chromium!);
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    for (const s of servers) await new Promise((ok) => s.close(ok));
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it('画面: 照準を動かさずに数発撃つと、クロスヘアは画面の中心のままで、的の中心は撃つ前より画面上で下に表示される', async () => {
    expect(upWeaponFiles, '書き換える武器の JSON が配信物にない').toBeGreaterThan(0);
    const page = await browser!.newPage();
    await page.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await page.goto(`${upOrigin}${BASE}`);
    await page.evaluate('localStorage.clear()');
    // 読み込み直す前のページで開始を押さないように、印を付けてから読み込み直し、印がなく武器の選択肢がそろうまで待つ。
    await page.evaluate('window.__beforeReload = true; location.reload()');
    await page.waitFor(
      `!window.__beforeReload && document.querySelector('[data-screen="top"]') && !document.querySelector('[data-screen="top"]').hidden && document.querySelector('#weapon').options.length > 0`,
    );
    await page.clickSelector('[data-screen="top"] a[href="#/play"]');
    await page.waitFor(`!document.querySelector('[data-screen="play"]').hidden && ${AMMO} > 0`);
    await page.frames(5);

    // ポインターロックを掛ける（マウスは中心から動かさない）。
    await page.click(CX, CY);
    await page.waitFor('!!document.pointerLockElement', 5000);

    // 撃つ前: 画面の動きが止まってからキャンバスだけを写し、的の中心の高さを読む。
    await hideHtml(page, true);
    await page.frames(2);
    const before = decodePng(await page.stableScreenshot());
    await hideHtml(page, false);
    const board = boardColor(before);
    expect(distance(board, before.pixel(CX + 150, CY)), '撃つ前に画面の中心に的が見えない').toBeGreaterThan(40);
    const beforeY = blobCenterOnColumn(before, CX, board);
    expect(beforeY, '撃つ前に的の中心が見つからない').toBeDefined();
    expect(Math.abs(beforeY! - CY), `撃つ前の的の中心 ${beforeY} が画面の中心にない`).toBeLessThanOrEqual(3);
    const crosshairBefore = await crosshairState(page);
    expect(crosshairBefore.crosshair, 'プレイ画面にクロスヘアがない').not.toBeNull();

    const ammo0 = await page.evaluate<number>(AMMO);
    expect(ammo0).toBeGreaterThan(4);

    // 撃つ: 左ボタンを押したまま、3 発撃ったところで（撃ち切る前に）画面を写す。
    await mouseButton(page, 'mousePressed');
    let during: Image;
    let crosshairDuring: Awaited<ReturnType<typeof crosshairState>>;
    let ammoAtShot: number;
    try {
      await page.waitFor(`${AMMO} <= ${ammo0 - 3}`, 15_000);
      crosshairDuring = await crosshairState(page);
      const full = decodePng(await page.screenshot());
      // クロスヘアの見た目も画面の中心に残っている（既定の色 #77ccff の点が中心の近くにある）。
      let nearCrosshair = Infinity;
      for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) nearCrosshair = Math.min(nearCrosshair, distance(full.pixel(CX + dx, CY + dy), [0x77, 0xcc, 0xff]));
      expect(nearCrosshair, '撃っている途中の画面の中心にクロスヘアの色の点がない').toBeLessThan(40);
      await hideHtml(page, true);
      during = decodePng(await page.screenshot());
      ammoAtShot = await page.evaluate<number>(AMMO);
    } finally {
      await mouseButton(page, 'mouseReleased');
      await hideHtml(page, false);
    }
    expect(ammoAtShot!, '写す前に撃ち切った').toBeGreaterThan(0);

    // クロスヘアは撃つ前も撃っている途中も、キャンバス（画面）の中心にある。
    for (const s of [crosshairBefore, crosshairDuring!]) {
      expect(s.crosshair!.shown, 'クロスヘアが見えない').toBe(true);
      expect(Math.abs(s.crosshair!.x - s.canvas!.x), `クロスヘアの x ${s.crosshair!.x} が中心 ${s.canvas!.x} にない`).toBeLessThanOrEqual(1);
      expect(Math.abs(s.crosshair!.y - s.canvas!.y), `クロスヘアの y ${s.crosshair!.y} が中心 ${s.canvas!.y} にない`).toBeLessThanOrEqual(1);
      expect(Math.abs(s.canvas!.x - CX)).toBeLessThanOrEqual(1);
      expect(Math.abs(s.canvas!.y - CY)).toBeLessThanOrEqual(1);
    }

    // 的の中心は撃つ前より画面上で下（y が大きい）に表示される。3 発ぶん（2 発目以降の跳ねが 1.5 度ずつ）なら、
    // FOV 90 の縦 800 px で少なくとも 1.5 度 ≒ 十数 px は下がる。
    const duringY = blobCenterOnColumn(during!, CX, board);
    expect(duringY, '撃っている途中に的が見つからない').toBeDefined();
    expect(duringY! - beforeY!, `的の中心 撃つ前 ${beforeY} → 撃っている途中 ${duringY}`).toBeGreaterThan(10);
    noExceptions(page);
  }, 120_000);

  it('設定画面: 視点の跳ねとカメラの固定（リコイルの表示の方式）を切り替える項目はない', async () => {
    const page = await browser!.newPage();
    await page.goto(`${staticOrigin}${BASE}#/settings`);
    await page.waitFor(`document.querySelector('[data-screen="settings"]') && !document.querySelector('[data-screen="settings"]').hidden && document.getElementById('setting-fov')`);
    const found = await page.evaluate<{ controls: { id: string; name: string; label: string; options: string }[]; text: string }>(`(() => {
      const root = document.querySelector('[data-screen="settings"]');
      const labelOf = (el) => {
        const parts = [];
        if (el.labels) for (const l of el.labels) parts.push(l.textContent);
        const fs = el.closest('fieldset'); if (fs && fs.querySelector('legend')) parts.push(fs.querySelector('legend').textContent);
        parts.push(el.getAttribute('aria-label') || '', el.title || '');
        return parts.join(' ').trim();
      };
      const controls = [...root.querySelectorAll('input, select, button, textarea, [role="switch"], [role="checkbox"]')].map((el) => ({
        id: el.id || '', name: el.getAttribute('name') || '', label: labelOf(el) + ' ' + (el.tagName === 'BUTTON' ? el.textContent : ''),
        options: el.tagName === 'SELECT' ? [...el.options].map((o) => o.value + ':' + o.textContent).join(',') : '',
      }));
      return { controls, text: root.textContent };
    })()`);
    expect(found.controls.length, '設定画面に入力欄がない').toBeGreaterThan(0);
    const VIEW_MODE = /視点の跳ね|跳ね|カメラ|固定|リコイルの表示|表示の方式/;
    const VIEW_MODE_ID = /recoil|camera|kick|view-?mode|fixed|lock-?view/i;
    const offending = found.controls.filter(
      (c) => VIEW_MODE.test(c.label) || VIEW_MODE.test(c.options) || VIEW_MODE_ID.test(c.id) || VIEW_MODE_ID.test(c.name) || VIEW_MODE_ID.test(c.options),
    );
    expect(offending, JSON.stringify(offending)).toEqual([]);
    expect(found.text).not.toMatch(/視点の跳ね|カメラの固定|カメラを固定/);
    noExceptions(page);
  }, 60_000);
});
