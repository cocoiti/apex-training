// docs/spec/pad.md「練習中のガイド」「リザルトの入力推移のグラフ」の QA の受け入れテスト（PAD-17〜PAD-19）。
// 公開された入口（ビルドの結果を /apex-training/ で配信した画面、index.html の要素、武器の JSON）だけを使い、実装の内部には依存しない。
// 画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、パッドは Gamepad API（navigator.getGamepads）の形で与える。
// ガイドは index.html の .pad-guide（点は [data-guide="ideal"]・[data-guide="current"]、位置は data-x・data-y の右と上が正の %）、
// 名前は .pad-guide-name、リザルトの入力推移のグラフは #result-pad で読む。
// 理想の位置の期待値は、SPEC の式（「理想の補正速度」「カーブの逆」）と SPEC のパッドの設定の既定値からこのファイルで求める。
// 画面は render=off・clock=manual で開き、練習の時間はページの時計を進めて決める。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';

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
/** ページの時計（clock=manual）を 60Hz の描画 frames 回分進める。実時間では待たない。 */
const settle = (page: Page, frames: number) => page.advanceClock(frames / 60);
/** 3D は描画せず（render=off）、ページの時計はテストから進める（clock=manual）。 */
const APP = { render: false, manualClock: true, seed: SEED };

const PAD_NAME = 'acceptance pad (STANDARD GAMEPAD)';
const GHOST = '反復練習';

/** SPEC のパッドの詳細設定の既定値（pad.md の表）。 */
const DEFAULT = { deadzone: 0.1, outer: 0.02, curve: 2, yaw: 300, pitch: 260, adsYaw: 90, adsPitch: 78 };

interface WeaponJson {
  id: string;
  name: string;
  rpm: number;
  magSize: number;
  pattern: { dx: number; dy: number }[];
}
const WEAPONS: WeaponJson[] = readdirSync(join(ROOT, 'src/data/weapons'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(ROOT, 'src/data/weapons', f), 'utf8')) as WeaponJson);
const byId = (id: string) => {
  const w = WEAPONS.find((x) => x.id === id);
  if (!w) throw new Error(`武器がない: ${id}`);
  return w;
};

/** SPEC「理想の補正速度」: fire を押していて次に撃つ弾が k 発目（k ≥ 2）なら（k 発目 − (k−1) 発目の理想の補正軌道）÷ 発射間隔。 */
function idealRate(w: WeaponJson, nextShot: number) {
  if (nextShot < 2 || nextShot > w.magSize) return { yaw: 0, pitch: 0 };
  const p = w.pattern[nextShot - 1]!;
  return { yaw: (-p.dx * w.rpm) / 60, pitch: (-p.dy * w.rpm) / 60 };
}

/** SPEC「カーブの逆」（腰撃ち）。右と上が正の %。 */
function idealPercent(rate: { yaw: number; pitch: number }) {
  const u = rate.yaw / DEFAULT.yaw;
  const v = rate.pitch / DEFAULT.pitch;
  const len = Math.hypot(u, v);
  const q = Math.min(1, len);
  if (q === 0) return { x: 0, y: 0 };
  const t = q ** (1 / (1 + DEFAULT.curve / 8));
  const m = DEFAULT.deadzone + t * (1 - DEFAULT.outer - DEFAULT.deadzone);
  return { x: (u / len) * m * 100, y: (v / len) * m * 100 };
}

const PAGE_INIT = `
  window.__pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) };
  navigator.getGamepads = () => [{ id: ${JSON.stringify(PAD_NAME)}, index: 0, connected: true, mapping: 'standard',
    timestamp: performance.now(), axes: window.__pad.axes.slice(), buttons: window.__pad.buttons.map((b) => ({ ...b })), vibrationActuator: null }];
  window.__button = (i, v) => { window.__pad.buttons[i] = { value: v, pressed: v >= 0.5, touched: v > 0 }; };
  window.__ammo = () => { const m = (document.querySelector('[data-hud="ammo"]')?.textContent ?? '').match(/\\d+/); return m ? Number(m[0]) : NaN; };
  window.__inputShown = () => (document.querySelector('[data-hud="input"]')?.textContent ?? '').trim();
  window.__guideVisible = () => {
    const g = document.querySelector('.pad-guide');
    if (!g || g.hidden) return false;
    const st = getComputedStyle(g);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    const r = g.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  window.__guide = () => {
    const ideal = document.querySelector('[data-guide="ideal"]');
    const name = document.querySelector('.pad-guide-name');
    return { visible: window.__guideVisible(), ammo: window.__ammo(),
      x: parseFloat(ideal?.getAttribute('data-x') ?? 'NaN'), y: parseFloat(ideal?.getAttribute('data-y') ?? 'NaN'),
      name: (name?.textContent ?? '').trim() };
  };
`;

interface GuideSample {
  visible: boolean;
  ammo: number;
  x: number;
  y: number;
  name: string;
}
const guide = (page: Page) => page.evaluate<GuideSample>('window.__guide()');
const guideVisible = (page: Page) => page.evaluate<boolean>('window.__guideVisible()');
const ammo = (page: Page) => page.evaluate<number>('window.__ammo()');

async function choose(page: Page, selector: string, label: string) {
  const ok = await page.evaluate<boolean>(`(() => {
    const s = document.querySelector(${JSON.stringify(selector)});
    const o = [...s.options].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  if (!ok) throw new Error(`${selector} に ${label} の選択肢がない`);
}

/** 設定画面で入力方式とゴースト表示を選び、トップ画面に戻る（マウスでもパッドでも操作しない）。 */
async function configure(page: Page, opts: { input?: string; ghost?: boolean }) {
  await page.evaluate(`location.hash = '#/settings'`);
  await page.waitFor(`!document.querySelector('[data-screen="settings"]').hidden`);
  if (opts.input) await choose(page, '#setting-input-method', opts.input);
  if (opts.ghost !== undefined) {
    await page.evaluate(`(() => { const c = document.getElementById('setting-ghost'); if (c.checked !== ${opts.ghost}) c.click(); })()`);
    await page.waitFor(`document.getElementById('setting-ghost').checked === ${opts.ghost}`);
  }
  await settle(page, 6);
  await page.evaluate(`location.hash = '#/'`);
  await page.waitFor(`!document.querySelector('[data-screen="top"]').hidden`);
}

/** トップ画面で武器とモードを選び、「開始」をキーボードで押してプレイ画面に入る。 */
async function start(page: Page, weapon: WeaponJson, mode: string) {
  await page.evaluate(`location.hash = '#/'`);
  await page.waitFor(`!document.querySelector('[data-screen="top"]').hidden && document.querySelector('#weapon').options.length > 0 && document.querySelector('#mode').options.length > 0`);
  await choose(page, '#weapon', weapon.name);
  await choose(page, '#mode', mode);
  await page.evaluate(`document.querySelector('[data-screen="top"] a[href="#/play"]').focus()`);
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
  }
  await page.waitFor(`location.hash === '#/play' && !document.querySelector('[data-screen="play"]').hidden && window.__ammo() === ${weapon.magSize} && window.__inputShown() !== ''`, 10_000);
  await settle(page, 31);
}

async function lock(page: Page): Promise<boolean> {
  await page.click(CX, CY);
  try {
    await page.waitFor('!!document.pointerLockElement', 3000);
  } catch {
    return false;
  }
  await settle(page, 12);
  return true;
}

async function moveMouse(page: Page, dx: number, steps = 10) {
  for (let i = 1; i <= steps; i += 1) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: CX + (dx * i) / steps, y: CY + (dx * i) / steps / 4, button: 'none', buttons: 0 });
    await settle(page, 2);
  }
}

const mouseButton = (page: Page, type: 'mousePressed' | 'mouseReleased') =>
  page.send('Input.dispatchMouseEvent', { type, x: CX, y: CY, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });

const waitResult = async (page: Page) => {
  await page.advanceClockUntil(`location.hash === '#/result'`, { step: 1 / 60 });
  await page.waitFor(`location.hash === '#/result' && !document.querySelector('[data-screen="result"]').hidden`, 30_000);
};

/** リザルト画面の右スティックの入力推移のグラフの様子。 */
interface PadTraceDom {
  visible: boolean;
  text: string;
  figures: { caption: string; series: number }[];
}
const padTraceDom = (page: Page) =>
  page.evaluate<PadTraceDom>(`(() => {
    const el = document.getElementById('result-pad');
    const visible = !!el && !el.hidden && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
    const svgs = el ? [...el.querySelectorAll('svg')] : [];
    const figures = svgs.map((svg) => {
      const fig = svg.closest('figure');
      const marks = new Set([...svg.querySelectorAll('[data-series]'), ...svg.querySelectorAll('polyline, path')]
        .filter((m) => m.matches('[data-series]') || !m.closest('[data-series]')));
      return { caption: ((fig?.querySelector('figcaption')?.textContent) ?? svg.getAttribute('aria-label') ?? '').trim(), series: marks.size };
    });
    return { visible, text: el ? el.innerText ?? el.textContent ?? '' : '', figures };
  })()`);

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('QA: パッド向けのガイドとリザルトの入力推移のグラフ（PAD-17〜PAD-19）', () => {
  let work = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));

  async function openFresh(): Promise<Page> {
    const page = await browser!.newPage();
    await page.addInitScript(PAGE_INIT);
    await page.goto(appUrl(origin, BASE, '#/', APP));
    await page.evaluate(`localStorage.clear()`);
    await page.evaluate('window.__beforeReload = true');
    await page.send('Page.reload', { ignoreCache: false });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && !!document.querySelector('[data-screen="top"]') && !document.querySelector('[data-screen="top"]').hidden`, 15_000);
    return page;
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'pad-guide-qa-'));
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
  // ゴースト表示（3D の中のゴースト）の設定によらず出る。既定は OFF。
  for (const ghost of [true, false]) {
    it(`PAD-17: 反復練習・ゴースト表示 ${ghost ? 'ON' : 'OFF'}・入力方式パッドで、ガイドとパッドの名前が表示され、2 発目以降の理想の位置が理想の補正速度をカーブの逆で直した位置になる`, async () => {
      const page = await openFresh();
      await configure(page, { input: 'パッド', ghost });
      const w = byId('lstar');
      await start(page, w, GHOST);

      // 撃つ前: ガイドとパッドの名前が出て、理想の位置は中心（fire を押していない）。
      await page.waitFor('window.__guideVisible()', 3000);
      const before = await guide(page);
      expect(before.visible).toBe(true);
      expect(before.name).toContain(PAD_NAME);
      expect(Math.abs(before.x)).toBeLessThan(0.5);
      expect(Math.abs(before.y)).toBeLessThan(0.5);

      // R2 を押し続け、撃っているあいだの理想の位置を描画のたびに読む。
      await page.evaluate('window.__button(7, 1)');
      await page.advanceClockUntil(`window.__ammo() <= ${w.magSize - 2}`);
      const samples: GuideSample[] = [];
      for (;;) {
        const s = await guide(page);
        if (!(s.ammo > 2)) break;
        samples.push(s);
        await settle(page, 1);
      }
      await page.evaluate('window.__button(7, 0)');

      expect(samples.length).toBeGreaterThan(20);
      const matchedShots = new Set<number>();
      const mismatches: string[] = [];
      for (const s of samples) {
        expect(s.visible, '撃っているあいだはガイドが出ている').toBe(true);
        expect(s.name).toContain(PAD_NAME);
        // HUD の残弾から次に撃つ弾を数える（描画の前のステップの状態でガイドを置くこともあるので、1 発前も許す）。
        const next = w.magSize - s.ammo + 1;
        const hit = [next, next - 1].find((k) => {
          const e = idealPercent(idealRate(w, k));
          return Math.abs(e.x - s.x) < 0.5 && Math.abs(e.y - s.y) < 0.5;
        });
        if (hit === undefined) {
          const e = idealPercent(idealRate(w, next));
          mismatches.push(`残弾 ${s.ammo}（次 ${next} 発目）: 表示 (${s.x}, ${s.y}) 期待 (${e.x.toFixed(2)}, ${e.y.toFixed(2)})`);
        } else if (hit >= 2) {
          matchedShots.add(hit);
        }
      }
      expect(mismatches, mismatches.join('\n')).toEqual([]);
      expect(matchedShots.size, '多くの弾で理想の位置を確かめた').toBeGreaterThan(10);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 90_000);
  }

  // -------------------------------------------------------------------------
  describe('PAD-18: ガイドが表示されないとき', () => {
    /** R2 を押して何発か撃つあいだ、ガイドが一度も出ないことを確かめる。 */
    async function neverShownWhileFiring(page: Page, w: WeaponJson) {
      const seen: boolean[] = [];
      for (let i = 0; i < 10; i += 1) {
        seen.push(await guideVisible(page));
        await settle(page, 2);
      }
      await page.evaluate('window.__button(7, 1)');
      for (let i = 0; i < 30; i += 1) {
        seen.push(await guideVisible(page));
        await settle(page, 2);
      }
      await page.evaluate('window.__button(7, 0)');
      return { seen, ammo: await ammo(page), magSize: w.magSize };
    }

    for (const ghost of [true, false]) {
      it(`入力方式がマウスのとき（反復練習・ゴースト表示 ${ghost ? 'ON' : 'OFF'}）`, async () => {
        const page = await openFresh();
        await configure(page, { input: 'マウス', ghost });
        const w = byId('lstar');
        await start(page, w, GHOST);
        const { seen } = await neverShownWhileFiring(page, w);
        // マウスで撃っているあいだも出ない。
        if (await lock(page)) {
          await mouseButton(page, 'mousePressed');
          for (let i = 0; i < 20; i += 1) {
            seen.push(await guideVisible(page));
            await settle(page, 2);
          }
          await mouseButton(page, 'mouseReleased');
          expect(await ammo(page), 'マウスで撃てている').toBeLessThan(w.magSize);
        }
        expect(seen.some(Boolean)).toBe(false);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 60_000);
    }

    it('入力方式が「自動」でパッドで練習中にマウスを操作したとき、ガイドが消える（ゴースト表示は既定の OFF）', async () => {
      const page = await openFresh();
      await configure(page, { input: '自動' });
      const w = byId('lstar');
      await start(page, w, GHOST);
      expect(await lock(page)).toBe(true);
      // パッドの R2 で何発か撃ち、パッドにする。ガイドが出る。
      await page.evaluate('window.__button(7, 1)');
      await page.advanceClockUntil(`window.__ammo() <= ${w.magSize - 3}`);
      await page.waitFor('window.__guideVisible()', 3000);
      await page.evaluate('window.__button(7, 0)');
      await settle(page, 6);
      expect(await guideVisible(page), 'パッドで練習中はガイドが出ている').toBe(true);
      expect(await ammo(page)).toBeGreaterThan(0);
      // マウスを動かす。
      await moveMouse(page, 120);
      await page.waitFor('!window.__guideVisible()', 1000);
      expect(await guideVisible(page)).toBe(false);
      expect(await page.evaluate<string>(`location.hash`)).toBe('#/play');
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('PAD-19: リザルト画面の右スティックの入力推移のグラフ', () => {
    for (const mode of [GHOST]) {
      it(`パッドで${mode}を練習して終えたとき、左右と上下のグラフ（自分と理想）と、使ったパッドの名前が表示される`, async () => {
        const page = await openFresh();
        await configure(page, { input: 'パッド', ghost: true });
        const w = byId('lstar');
        await start(page, w, mode);
        // 右スティックを少し倒しながら R2 で撃ち切る。
        await page.evaluate('window.__pad.axes[2] = 0.3; window.__pad.axes[3] = 0.2');
        await page.evaluate('window.__button(7, 1)');
        await waitResult(page);
        await page.evaluate('window.__button(7, 0); window.__pad.axes[2] = 0; window.__pad.axes[3] = 0');
        await settle(page, 12);
        const dom = await padTraceDom(page);
        expect(dom.visible, 'グラフが表示される').toBe(true);
        expect(dom.text).toContain(PAD_NAME);
        expect(dom.figures, JSON.stringify(dom.figures)).toHaveLength(2);
        expect(dom.text).toContain('左右');
        expect(dom.text).toContain('上下');
        for (const f of dom.figures) expect(f.series, `${f.caption} に自分と理想の 2 つの推移`).toBeGreaterThanOrEqual(2);
        expect(dom.text).toContain('自分');
        expect(dom.text).toContain('理想');
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 60_000);
    }

    it('マウスで練習して終えたときは表示されない（反復練習）', async () => {
      const page = await openFresh();
      await configure(page, { input: 'マウス', ghost: true });
      const w = byId('lstar');
      await start(page, w, GHOST);
      expect(await lock(page)).toBe(true);
      await mouseButton(page, 'mousePressed');
      await waitResult(page);
      await mouseButton(page, 'mouseReleased');
      await settle(page, 12);
      const dom = await padTraceDom(page);
      expect(dom.visible).toBe(false);
      expect(await page.evaluate<string>(`document.querySelector('[data-screen="result"]').innerText`)).not.toContain(PAD_NAME);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });
});
