// docs/spec/screens.md「補正のパネル」のパターンの表示（詳細 / 簡易）と設定（UI-11・UI-13・UI-69〜UI-73）、
// docs/spec/weapons.md の WPN-29 の QA の受け入れテスト。
// 公開された入口だけを使う: ビルドの結果を /apex-training/ で配信した画面（トップ・設定・プレイ・リザルト）、index.html の要素、
// 武器の JSON。画面はヘッドレスの Chromium で開く（tests/helpers/browser.ts）。
//
// パネルは index.html の .correction-panel（svg の [data-series="ideal"] の polyline、[data-panel="current"] の次の発の点、
// 凡例の .plot-legend、区切りの言葉の一覧 .correction-panel-segments の li）で読む。強調された言葉は aria-current の付いた li とし、
// その li がほかの li と見た目（計算されたスタイル）で見分けられることも確かめる。
// パネルの座標の縮尺は SPEC にないので、理想の線の点を期待する点（度）に「原点 + 同じ縮尺 s × (ヨー, −ピッチ)」で合わせて読む。
// 簡易版のパターンの期待値は SPEC の定義から tests/helpers/simple-pattern-oracle.ts で求める（実装には依存しない）。
//
// リポジトリの写しに受け入れテスト用の武器（measured が true）を足してビルドした画面で確かめる（WPN-29 もこの写しで確かめる）。
// - QA-ジグザグ: randomness 0・rpm 60・装弾数 10。簡易版での位置が理想の補正軌道と目に見えて違うよう、細かい揺れを入れる。
// - QA-ジグザグ遅: QA-ジグザグの rpm 30 版（マウスの記録用）。
// - QA-新しい計測: WPN-29 の「足した新しい武器」。
// パッドは Gamepad API（navigator.getGamepads）の形で与え、R2 で撃つ。マウスはポインターロック中の移動（DevTools の mouseMoved）。
// 画面は clock=manual で開き、練習の時間（撃つ・撃ち切る・撃たない 2 秒）はページの時計を進めて決める。
// 3D は、キャンバスの画面写しでゴーストを比べるテスト（UI-73）のほかは描画しない（render=off）。
// サーバーと DevTools のポートは OS に選ばせる。待ちは sleep にせず、画面の状態の条件で待つ。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';
import { decodePng, type Image } from '../helpers/png';
import { idealPoints, oracleSimplePattern, type Deg } from '../helpers/simple-pattern-oracle';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const WIDTH = 1280;
const HEIGHT = 800;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;
const chromium = findChromium();
/** ページの時計（clock=manual）を 60Hz の描画 frames 回分進める。実時間では待たない。 */
const settle = (page: Page, frames: number) => page.advanceClock(frames / 60);

const GHOST = '反復練習';
const DETAILED = '詳細';
const SIMPLE = '簡易';
type Display = typeof DETAILED | typeof SIMPLE;

interface WeaponJson {
  id: string;
  name: string;
  category: string;
  version: string;
  source: string;
  measured: boolean;
  rpm: number;
  magSize: number;
  randomness: number;
  pattern: { dx: number; dy: number }[];
}
const load = (id: string) => JSON.parse(readFileSync(join(ROOT, 'src/data/weapons', `${id}.json`), 'utf8')) as WeaponJson;
const LSTAR = load('lstar');
const CAR = load('car');

const qa = (id: string, name: string, rpm: number, pattern: { dx: number; dy: number }[]): WeaponJson => ({
  id,
  name,
  category: 'QA',
  version: 'S31-Cipher',
  source: '仮データ（受け入れテスト）',
  measured: true,
  rpm,
  magSize: pattern.length,
  randomness: 0,
  pattern,
});
/** 1〜5 発目は上へ（左右に揺れながら）、6〜10 発目は右へ（上下に揺れながら）跳ねる。 */
const ZIG = qa('qa-simple-zig', 'QA-ジグザグ', 60, [
  ...[0, 1, 2, 3, 4].map((k) => ({ dx: k % 2 === 0 ? 0.6 : -0.6, dy: 1 })),
  ...[0, 1, 2, 3, 4].map((k) => ({ dx: 1, dy: k % 2 === 0 ? 0.6 : -0.6 })),
]);
/** QA-ジグザグと同じ pattern で rpm 30（発の間に照準を動かすマウスの記録に使う）。 */
const ZIG_SLOW: WeaponJson = { ...ZIG, id: 'qa-simple-zig-slow', name: 'QA-ジグザグ遅', rpm: 30 };
/** WPN-29 の新しい武器。 */
const NEW = qa('qa-new-measured', 'QA-新しい計測', 600, [
  ...Array.from({ length: 6 }, () => ({ dx: 0.2, dy: 0.8 })),
  ...Array.from({ length: 6 }, () => ({ dx: -0.7, dy: 0.3 })),
]);

type Pt = [number, number];
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

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
  window.__pts = (s) => { const n = String(s ?? '').trim().split(/[\\s,]+/).filter(Boolean).map(Number); const out = [];
    for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]); return out; };
  window.__style = (el) => { const s = getComputedStyle(el);
    return [s.color, s.backgroundColor, s.fontWeight, s.outlineStyle, s.outlineColor, s.borderTopColor, s.borderLeftColor, s.textDecorationLine, s.opacity].join('|'); };
  window.__panel = () => {
    const fig = document.querySelector('.correction-panel');
    const svg = fig?.querySelector('svg');
    const cur = svg?.querySelector('[data-panel="current"]');
    const vb = svg?.viewBox?.baseVal;
    const items = [...(fig?.querySelectorAll('.correction-panel-segments li') ?? [])].filter((li) => window.__vis(li));
    return {
      visible: window.__vis(fig),
      ammo: window.__ammo(),
      hash: location.hash,
      viewBox: vb ? [vb.x, vb.y, vb.width, vb.height] : [0, 0, 0, 0],
      ideal: window.__pts(svg?.querySelector('[data-series="ideal"]')?.getAttribute('points')),
      current: cur ? { x: cur.cx.baseVal.value, y: cur.cy.baseVal.value, r: cur.r.baseVal.value, visible: window.__vis(cur) && cur.r.baseVal.value > 0 } : null,
      legend: [...(fig?.querySelectorAll('.plot-legend') ?? [])].filter((el) => window.__vis(el)).map((el) => (el.textContent ?? '').trim()),
      words: items.map((li) => (li.textContent ?? '').trim()),
      highlighted: items.map((li, i) => (li.hasAttribute('aria-current') && li.getAttribute('aria-current') !== 'false' ? i : -1)).filter((i) => i >= 0),
      styles: items.map((li) => window.__style(li)),
    };
  };
  // 描画ごとにパネルの状態を残す（撃ち切った直後の短い時間を読むため）。実際の描画のたびと、
  // ページの時計を進める途中で __recNow() を呼んだときに残す（時計を進める途中の描画では requestAnimationFrame が呼ばれないため）。
  window.__rec = [];
  window.__recNow = () => { if (!window.__recOn) return true; const p = window.__panel();
    window.__rec.push({ ammo: p.ammo, hash: p.hash, visible: p.visible, current: !!p.current?.visible, highlighted: p.highlighted.length });
    return true; };
  window.__startRec = () => { window.__rec = []; window.__recOn = true;
    const tick = () => { if (!window.__recOn) return; window.__recNow(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick); };
  window.__stopRec = () => { window.__recOn = false; return window.__rec; };
`;

interface PanelDom {
  visible: boolean;
  ammo: number;
  hash: string;
  viewBox: [number, number, number, number];
  ideal: Pt[];
  current: { x: number; y: number; r: number; visible: boolean } | null;
  legend: string[];
  words: string[];
  highlighted: number[];
  styles: string[];
}
const panel = (page: Page) => page.evaluate<PanelDom>('window.__panel()');
const tolOf = (p: PanelDom) => p.viewBox[2] * 0.01;

/** パネルの点の列を、期待する点（度）に「原点 o + s × (ヨー, −ピッチ)」で合わせる。 */
function fit(points: Pt[], expected: Deg[]) {
  const o = points[0] ?? [NaN, NaN];
  let num = 0;
  let den = 0;
  expected.forEach(([yaw, pitch], k) => {
    const q = points[k];
    if (!q || k === 0) return;
    num += (q[0] - o[0]) * yaw + (q[1] - o[1]) * -pitch;
    den += yaw * yaw + pitch * pitch;
  });
  const s = num / den;
  const toPanel = (d: Deg): Pt => [o[0] + s * d[0], o[1] - s * d[1]];
  let resid = points.length === expected.length ? 0 : Infinity;
  expected.forEach((d, k) => {
    const q = points[k];
    resid = Math.max(resid, q ? dist(q, toPanel(d)) : Infinity);
  });
  return { o, s, toPanel, resid };
}

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

async function setCheck(page: Page, id: string, on: boolean) {
  if ((await page.evaluate<boolean>(`document.getElementById(${JSON.stringify(id)}).checked`)) !== on) await page.clickSelector(`#${id}`);
  await page.waitFor(`document.getElementById(${JSON.stringify(id)}).checked === ${on}`);
}

interface Opts {
  input?: '自動' | 'マウス' | 'パッド';
  ghost?: boolean;
  display?: Display;
}
async function configure(page: Page, opts: Opts) {
  await page.evaluate(`location.hash = '#/settings'`);
  await page.waitFor(`window.__vis('[data-screen="settings"]')`);
  if (opts.input) await choose(page, '#setting-input-method', opts.input);
  if (opts.ghost !== undefined) await setCheck(page, 'setting-ghost', opts.ghost);
  if (opts.display) await choose(page, '#setting-pattern-display', opts.display);
  await settle(page, 3);
  await page.evaluate(`location.hash = '#/'`);
  await page.waitFor(`window.__vis('[data-screen="top"]')`);
}

async function start(page: Page, w: WeaponJson, mode: string) {
  await page.evaluate(`location.hash = '#/'`);
  await page.waitFor(`window.__vis('[data-screen="top"]') && document.querySelector('#weapon').options.length > 0 && document.querySelector('#mode').options.length > 0`);
  await choose(page, '#weapon', w.name);
  await choose(page, '#mode', mode);
  await choose(page, '#count', 1);
  await page.clickSelector('[data-screen="top"] a[href="#/play"]');
  await page.waitFor(
    `location.hash === '#/play' && window.__vis('[data-screen="play"]') && !window.__interlude() && window.__ammo() === ${w.magSize} && window.__inputShown() !== ''`,
  );
  await page.advanceClockUntil('window.__time() >= 0.3', { limit: 10 });
  await settle(page, 3);
}

/** パッドの R2 で撃ち切る（ページの時計を進める）。 */
async function padFireAll(page: Page) {
  await page.evaluate('window.__btn(7, true)');
  await page.advanceClockUntil(`window.__ammo() === 0 || location.hash !== '#/play' || window.__interlude()`, { limit: 20 });
  await page.evaluate('window.__btn(7, false)');
}

class Mouse {
  x = CX;
  y = CY;
  held = 0;
  constructor(private readonly page: Page) {}
  async lock() {
    if (await this.page.evaluate<boolean>('!!document.pointerLockElement')) return;
    await this.page.click(this.x, this.y);
    await this.page.waitFor('!!document.pointerLockElement', 5000);
    await settle(this.page, 6);
  }
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

/** HTML の画面を隠し、キャンバスだけを写す。 */
async function canvasOnly(page: Page): Promise<Image> {
  await page.evaluate(`document.getElementById('ui').style.visibility = 'hidden'`);
  await page.frames(2);
  const img = decodePng(await page.stableScreenshot());
  await page.evaluate(`document.getElementById('ui').style.visibility = ''`);
  return img;
}
function changedPixels(a: Image, b: Image, tol = 40): number {
  let n = 0;
  for (let y = 0; y < a.height; y += 1)
    for (let x = 0; x < a.width; x += 1) {
      const p = a.pixel(x, y);
      const q = b.pixel(x, y);
      if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > tol) n += 1;
    }
  return n;
}

const resultOf = (page: Page) =>
  page.evaluate<{ summary: string; metrics: string; comments: string; plots: string }>(`(() => ({
    summary: document.getElementById('result-summary')?.innerText ?? '',
    metrics: document.getElementById('result-metrics')?.innerText ?? '',
    comments: document.getElementById('result-comments')?.innerText ?? '',
    plots: document.getElementById('result-plots')?.innerHTML ?? '' }))()`);

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('QA: 補正のパネルのパターンの表示', () => {
  const temps: string[] = [];
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  let opened: Page[] = [];
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));

  /**
   * 新しいタブで localStorage を空にして読み込み直し、トップ画面を開く。ページの時計はテストから進める（clock=manual）。
   * 3D はキャンバスを写すテスト（render: true）だけが描画する。
   */
  async function openFresh(init = '', { render = false }: { render?: boolean } = {}): Promise<Page> {
    const page = await browser!.newPage();
    opened.push(page);
    await page.addInitScript(PAGE_INIT + init);
    await page.goto(appUrl(origin, BASE, '#/', { render, manualClock: true }));
    await page.evaluate('localStorage.clear()');
    await page.evaluate('window.__beforeReload = true');
    await page.send('Page.reload', { ignoreCache: false });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && window.__vis('[data-screen="top"]')`, 15_000);
    return page;
  }
  async function close(page: Page) {
    await page.send('Page.close').catch(() => undefined);
    opened = opened.filter((x) => x !== page);
  }
  async function reloadSettings(page: Page) {
    await page.evaluate('window.__beforeReload = true');
    await page.send('Page.reload', { ignoreCache: true });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete'`, 15_000);
    await page.evaluate(`location.hash = '#/settings'`);
    await page.waitFor(`window.__vis('[data-screen="settings"]') && document.getElementById('setting-fov').value !== ''`);
  }

  beforeAll(async () => {
    const work = mkdtempSync(join(tmpdir(), 'simple-pattern-qa-'));
    temps.push(work);
    const repo = join(work, 'copy');
    for (const entry of ['src', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'eslint.config.js', 'scripts', 'public']) {
      if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(repo, entry), { recursive: true });
    }
    symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'), 'dir');
    // JSON を足すだけで、コードは変えない（WPN-29）。
    for (const w of [ZIG, ZIG_SLOW, NEW]) writeFileSync(join(repo, `src/data/weapons/${w.id}.json`), JSON.stringify(w, null, 2));
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

  /** 簡易のパネルが、期待する簡易版のパターンを描いているか確かめ、合わせた座標を返す。 */
  function expectSimplePanel(p: PanelDom, w: WeaponJson) {
    const o = oracleSimplePattern(w);
    expect(p.visible).toBe(true);
    expect(p.ideal.length, `理想の線の点の数（区切り ${o.segments.length} 本 + 1）`).toBe(o.segments.length + 1);
    const f = fit(p.ideal, o.points);
    expect(f.s, '縮尺が正').toBeGreaterThan(0);
    expect(f.resid, `理想の線が簡易版の頂点を結んでいない（ずれ ${f.resid}）`).toBeLessThanOrEqual(tolOf(p));
    expect(p.legend, p.legend.join(',')).toContain('理想（簡易）');
    expect(p.words, '区切りの言葉').toEqual(o.segments.map((s) => s.label));
    return { o, f };
  }

  // -------------------------------------------------------------------------
  describe('パターンの表示の設定の保存と既定値（設定画面の受け入れ条件は settings-qa が確かめる）', () => {
    it('設定を一度も変えずに設定画面を開くと、パターンの表示は詳細（ほかの既定値も SPEC のとおり）', async () => {
      const page = await openFresh();
      await page.evaluate(`location.hash = '#/settings'`);
      await page.waitFor(`window.__vis('[data-screen="settings"]') && document.getElementById('setting-fov').value !== ''`);
      const s = await page.evaluate<Record<string, string | boolean>>(`(() => {
        const v = (id) => document.getElementById(id).value;
        const c = (id) => document.getElementById(id).checked;
        const t = (id) => document.getElementById(id).selectedOptions[0].textContent.trim();
        return { input: t('setting-input-method'), fov: v('setting-fov'), color: v('setting-crosshair-color').toLowerCase(), shape: t('setting-crosshair-shape'),
          ghost: c('setting-ghost'), display: t('setting-pattern-display'), sound: c('setting-sound'),
          dpi: v('setting-dpi'), sens: v('setting-sensitivity'), ads: v('setting-ads-multiplier'),
          displayLabel: document.getElementById('setting-pattern-display').closest('label')?.textContent.trim() ?? '' }; })()`);
      expect(s.display).toBe('詳細');
      expect(s.displayLabel).toContain('パターンの表示（補正のパネル）');
      expect(s.input).toBe('自動');
      expect(s.fov).toBe('90');
      expect(s.color).toBe('#77ccff');
      expect(s.shape).toBe('点');
      expect(s.ghost).toBe(false);
      expect(s.sound).toBe(true);
      expect(s.dpi).toBe('800');
      expect(Number(s.sens)).toBe(1.5);
      expect(Number(s.ads)).toBe(1);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('FOV・クロスヘアの色と形・ゴースト表示・パターンの表示を変えて再読み込みすると、変えた値が残る', async () => {
      const page = await openFresh();
      await page.evaluate(`location.hash = '#/settings'`);
      await page.waitFor(`window.__vis('[data-screen="settings"]') && document.getElementById('setting-fov').value !== ''`);
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
      await setCheck(page, 'setting-ghost', true);
      await choose(page, '#setting-pattern-display', SIMPLE);
      await settle(page, 3);

      await reloadSettings(page);
      const read = () =>
        page.evaluate<Record<string, string | boolean>>(`(() => ({
        fov: document.getElementById('setting-fov').value, color: document.getElementById('setting-crosshair-color').value.toLowerCase(),
        shape: document.getElementById('setting-crosshair-shape').value, ghost: document.getElementById('setting-ghost').checked,
        display: document.getElementById('setting-pattern-display').selectedOptions[0].textContent.trim() }))()`);
      expect(await read()).toEqual({ fov: '104', color: '#33cc66', shape: 'circle', ghost: true, display: '簡易' });

      // パターンの表示を詳細に戻して再読み込みしても、その値が残る（ほかの変えた値もそのまま）。
      await choose(page, '#setting-pattern-display', DETAILED);
      await settle(page, 3);
      await reloadSettings(page);
      expect(await read()).toEqual({ fov: '104', color: '#33cc66', shape: 'circle', ghost: true, display: '詳細' });
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('UI-69: 簡易では理想の線が簡易版の頂点を結んだ折れ線で、凡例「理想（簡易）」と区切りの言葉が出る。詳細では出ない', () => {
    for (const input of ['パッド', 'マウス'] as const) {
      it(`L-STAR・反復練習・${input}: 簡易`, async () => {
        const page = await openFresh();
        await configure(page, { input, display: SIMPLE });
        await start(page, LSTAR, GHOST);
        const p = await panel(page);
        const { o } = expectSimplePanel(p, LSTAR);
        expect(p.words.length).toBe(o.segments.length);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 60_000);
    }

    it('L-STAR・反復練習: 詳細（既定）では、理想の線が 1〜装弾数発目の理想の補正軌道を結んだ線で、区切りの言葉は出ない', async () => {
      const page = await openFresh();
      await configure(page, { input: 'パッド' });
      await start(page, LSTAR, GHOST);
      const p = await panel(page);
      expect(p.visible).toBe(true);
      expect(p.ideal.length).toBe(LSTAR.magSize + 1);
      const f = fit(p.ideal, idealPoints(LSTAR));
      expect(f.resid).toBeLessThanOrEqual(tolOf(p));
      expect(p.words, '詳細なのに区切りの言葉が出ている').toEqual([]);
      expect(p.legend).toContain('理想');
      expect(p.legend.join(',')).not.toContain('簡易');
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('簡易にしてから詳細に戻して始めると、区切りの言葉が出ない', async () => {
      const page = await openFresh();
      await configure(page, { input: 'パッド', display: SIMPLE });
      await start(page, LSTAR, GHOST);
      expect((await panel(page)).words.length).toBeGreaterThan(0);
      await configure(page, { display: DETAILED });
      await start(page, LSTAR, GHOST);
      const p = await panel(page);
      expect(p.ideal.length).toBe(LSTAR.magSize + 1);
      expect(p.words).toEqual([]);
      expect(p.legend.join(',')).not.toContain('簡易');
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('UI-70: 簡易では次の発の点が簡易版での位置にあり、次の発を受け持つ区切りの言葉が強調される', () => {
    for (const mode of [GHOST]) {
      it(`${ZIG.name}（rpm 60）・${mode}・パッド: 撃つ前・i 発撃つごと・撃ち切ったあと`, async () => {
        const w = ZIG;
        const page = await openFresh();
        await configure(page, { input: 'パッド', display: SIMPLE });
        await start(page, w, mode);
        const p0 = await panel(page);
        const { o, f } = expectSimplePanel(p0, w);
        expect(o.segments.length, '前提: 区切りが 2 本以上').toBeGreaterThanOrEqual(2);
        const ideal = idealPoints(w);
        const segOf = (shot: number) => o.segments.findIndex((s) => s.from < shot && shot <= s.to);
        // 前提: 簡易版での位置が理想の補正軌道と見分けられる発がある。
        const distinct = [...Array(w.magSize).keys()].map((k) => k + 1).filter((k) => dist(f.toPanel(o.positions[k]!), f.toPanel(ideal[k]!)) > 3 * tolOf(p0));
        expect(distinct.length, '前提: 簡易と詳細で位置が違う発').toBeGreaterThan(0);

        const check = (p: PanelDom, next: number, when: string) => {
          expect(p.current?.visible, `${when}: 次の発の点が見える`).toBe(true);
          const at: Pt = [p.current!.x, p.current!.y];
          expect(dist(at, f.toPanel(o.positions[next]!)), `${when}: 次の発の点が簡易版での ${next} 発目の位置にない`).toBeLessThanOrEqual(tolOf(p));
          expect(p.highlighted, `${when}: 強調される言葉`).toEqual([segOf(next)]);
          // 強調された言葉はほかの言葉と見た目で見分けられる。
          const hs = p.styles[segOf(next)];
          p.styles.forEach((s, k) => {
            if (k !== segOf(next)) expect(s, `${when}: 強調された言葉とほかの言葉の見た目が同じ`).not.toBe(hs);
          });
        };
        check(p0, 1, '撃つ前');

        await page.evaluate('window.__startRec()');
        await page.evaluate('window.__btn(7, true)');
        for (let i = 1; i < w.magSize; i += 1) {
          await page.advanceClockUntil(`window.__recNow() && window.__ammo() === ${w.magSize - i}`, { limit: 10 });
          await settle(page, 3);
          const p = await panel(page);
          expect(p.ammo, `${i} 発目のあと、次の発の前に読めていない`).toBe(w.magSize - i);
          check(p, i + 1, `${i} 発撃ったあと`);
        }
        // 時計を進める途中の描画ごとにも状態を残す。
        await page.advanceClockUntil(`window.__recNow() && (window.__ammo() === 0 || location.hash !== '#/play')`, { limit: 10 });
        for (let k = 0; k < 6; k += 1) {
          await settle(page, 1);
          await page.evaluate('window.__recNow()');
        }
        await page.evaluate('window.__btn(7, false)');
        const rec = await page.evaluate<{ ammo: number; hash: string; visible: boolean; current: boolean; highlighted: number }[]>('window.__stopRec()');
        // 撃ち切ったあと（残弾 0）にパネルが見えている描画では、次の発の点が描かれず、どの言葉も強調されない。
        const bad = rec.filter((r) => r.ammo === 0 && r.visible && (r.current || r.highlighted > 0));
        expect(bad, JSON.stringify(bad.slice(0, 3))).toEqual([]);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 90_000);
    }
  });

  // -------------------------------------------------------------------------
  describe('UI-71: 同じ入力を詳細と簡易で与えると、弾痕の位置・採点結果・リザルトの理想の軌道の重ね描きが一致する', () => {
    it(`${ZIG_SLOW.name}（rpm 30）・反復練習・マウス: 同じ照準の動かし方と撃ち方`, async () => {
      const w = ZIG_SLOW;
      const moves: Pt[] = [
        [4, 12],
        [-7, 20],
        [11, 15],
        [-3, 25],
        [6, 9],
        [10, -4],
        [-5, 8],
        [2, 2],
        [15, 0],
        [-9, 6],
      ];
      const run = async (display: Display) => {
        const page = await openFresh();
        await configure(page, { input: 'マウス', display: display });
        await start(page, w, GHOST);
        expect((await panel(page)).words.length > 0).toBe(display === SIMPLE);
        const mouse = new Mouse(page);
        await mouse.lock();
        await mouse.move(...moves[0]!);
        await settle(page, 4);
        await mouse.press();
        for (let i = 1; i < w.magSize; i += 1) {
          await page.advanceClockUntil(`window.__ammo() === ${w.magSize - i}`, { limit: 10 });
          await mouse.move(...moves[i]!);
          await settle(page, 4);
          expect(await page.evaluate<number>('window.__ammo()')).toBe(w.magSize - i);
        }
        await page.advanceClockUntil(`location.hash === '#/result'`, { limit: 10 });
        await mouse.release();
        await page.waitFor(`document.getElementById('result-metrics').innerText.trim().length > 0`);
        await settle(page, 3);
        const r = await resultOf(page);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
        await close(page);
        return r;
      };
      const detailed = await run(DETAILED);
      const simple = await run(SIMPLE);
      expect(detailed.metrics.length).toBeGreaterThan(0);
      expect(detailed.plots.length).toBeGreaterThan(0);
      expect(simple).toEqual(detailed);
    }, 120_000);

    it('L-STAR・反復練習・パッド（乱数の元を決まった値にして同じ種で始める）: 撃ち切ったときの弾痕と採点', async () => {
      const fixedRandom = `
        (() => { let s = 12345; const next = () => { s = (s * 1103515245 + 12345) >>> 0; return s; };
          Math.random = () => next() / 4294967296;
          const orig = crypto.getRandomValues.bind(crypto);
          crypto.getRandomValues = (a) => { if (a && typeof a.length === 'number') { for (let i = 0; i < a.length; i += 1) a[i] = next() & 0xffffffff; return a; } return orig(a); };
        })();`;
      const run = async (display: Display) => {
        const page = await openFresh(fixedRandom);
        await configure(page, { input: 'パッド', display: display });
        await start(page, LSTAR, GHOST);
        expect((await panel(page)).visible).toBe(true);
        await padFireAll(page);
        await page.advanceClockUntil(`location.hash === '#/result'`, { limit: 15 });
        await page.waitFor(`location.hash === '#/result' && document.getElementById('result-metrics').innerText.trim().length > 0`, 15_000);
        await settle(page, 3);
        const r = await resultOf(page);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
        await close(page);
        return r;
      };
      const detailed = await run(DETAILED);
      const simple = await run(SIMPLE);
      expect(detailed.metrics.length).toBeGreaterThan(0);
      expect(simple).toEqual(detailed);
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  describe('UI-72: 同じ武器で詳細と簡易のパネルの表示の範囲が同じ', () => {
    for (const w of [LSTAR, CAR, ZIG, NEW]) {
      for (const mode of [GHOST]) {
        it(`${w.name}・${mode}`, async () => {
          const page = await openFresh();
          await configure(page, { input: 'パッド', display: DETAILED });
          await start(page, w, mode);
          const d = await panel(page);
          await configure(page, { display: SIMPLE });
          await start(page, w, mode);
          const s = await panel(page);
          expect(d.visible && s.visible).toBe(true);
          expect(s.words.length, '簡易になっていない').toBeGreaterThan(0);
          expect(d.words.length, '詳細になっていない').toBe(0);
          s.viewBox.forEach((v, k) => expect(v, `viewBox ${k}`).toBeCloseTo(d.viewBox[k]!, 6));
          // 範囲は詳細版の理想の補正軌道がすべて収まる範囲（詳細の理想の線の点が範囲の中）。
          const [vx, vy, vw, vh] = s.viewBox;
          for (const q of d.ideal) {
            expect(q[0] > vx && q[0] < vx + vw && q[1] > vy && q[1] < vy + vh, `点 ${q} が範囲の外`).toBe(true);
          }
          expect(exceptions(page), page.errors.join('\n')).toEqual([]);
        }, 60_000);
      }
    }
  });

  // -------------------------------------------------------------------------
  describe('UI-73: 簡易でゴースト表示 ON の反復練習で撃つと、ゴーストの向きとスティック型のガイドの理想の位置が詳細と同じ', () => {
    it(`${ZIG.name}（randomness 0・rpm 60）・パッド: 撃つ前と各発のあとのキャンバスとガイド`, async () => {
      const w = ZIG;
      const shots = [0, 1, 2, 4, 6, 8];
      const run = async (display: Display) => {
        const page = await openFresh('', { render: true });
        await configure(page, { input: 'パッド', ghost: true, display: display });
        await start(page, w, GHOST);
        await page.waitFor(`window.__vis('.pad-guide')`, 3000);
        expect((await panel(page)).words.length > 0).toBe(display === SIMPLE);
        const out: { shot: number; img: Image; guide: { x: number; y: number } }[] = [];
        const readGuide = () =>
          page.evaluate<{ x: number; y: number }>(`(() => { const e = document.querySelector('[data-guide="ideal"]');
            return { x: parseFloat(e?.getAttribute('data-x') ?? 'NaN'), y: parseFloat(e?.getAttribute('data-y') ?? 'NaN') }; })()`);
        for (const n of shots) {
          if (n > 0) {
            if (n === 1) await page.evaluate('window.__btn(7, true)');
            await page.advanceClockUntil(`window.__ammo() === ${w.magSize - n}`, { limit: 10 });
          }
          await settle(page, 3);
          const guide = await readGuide();
          const img = await canvasOnly(page);
          expect(await page.evaluate<number>('window.__ammo()'), `${n} 発目のあと、次の発の前に読めていない`).toBe(w.magSize - n);
          out.push({ shot: n, img, guide });
        }
        await page.evaluate('window.__btn(7, false)');
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
        await close(page);
        return out;
      };
      const detailed = await run(DETAILED);
      const simple = await run(SIMPLE);
      for (let k = 0; k < shots.length; k += 1) {
        const a = detailed[k]!;
        const b = simple[k]!;
        expect(Number.isFinite(a.guide.x) && Number.isFinite(a.guide.y), 'ガイドの理想の位置が読めない').toBe(true);
        expect(b.guide.x, `${a.shot} 発撃ったあとのガイドの理想の位置（横）`).toBeCloseTo(a.guide.x, 3);
        expect(b.guide.y, `${a.shot} 発撃ったあとのガイドの理想の位置（縦）`).toBeCloseTo(a.guide.y, 3);
        // キャンバス（ゴーストと弾痕を含む 3D）が詳細のときと同じ。
        expect(changedPixels(a.img, b.img), `${a.shot} 発撃ったあとのキャンバスが詳細と違う（ゴーストの向きが違う）`).toBe(0);
      }
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  describe('WPN-29: measured が true の新しい武器の JSON を足してビルドすると、コードを変えずに補正のパネルにその武器の簡易版が表示される', () => {
    for (const mode of [GHOST]) {
      it(`${NEW.name}・${mode}・簡易`, async () => {
        const page = await openFresh();
        await configure(page, { input: 'パッド', display: SIMPLE });
        const names = await page.evaluate<string[]>(`[...document.querySelector('#weapon').options].map((o) => o.textContent.trim())`);
        expect(names).toContain(NEW.name);
        await start(page, NEW, mode);
        const p = await panel(page);
        const { o } = expectSimplePanel(p, NEW);
        expect(o.segments.length, '前提: 区切りが 2 本').toBe(2);
        expect(p.highlighted).toEqual([0]);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 60_000);
    }
  });
});
