// docs/spec/architecture.md「テストのための描画の省略と時計の差し替え」（ARC-23〜ARC-25）の受け入れテスト（QA）。
// 公開された入口（ビルドの結果を /apex-training/ で配信した画面、URL のクエリ render=off・clock=manual、
// tests/helpers/browser.ts の appUrl・Page.advanceClock、index.html の要素）だけを使う。
// 入力は Gamepad API（navigator.getGamepads）の形で与える（標準配置の R2 = ボタン 7 が fire、右スティック = 軸 2・3）。
// 練習の乱数の種は crypto.getRandomValues を決まった列にして、2 つのページで同じ入力の記録（種と操作）になるようにする。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type AppUrlOptions, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const chromium = findChromium();

/** canvas の getContext に求められた種類と、WebGL の描画の呼び出しの回数を記録する（ページのスクリプトより先に入れる）。 */
const SPY_WEBGL = `
  window.__spy = { kinds: [], draws: 0 };
  for (const C of [window.HTMLCanvasElement, window.OffscreenCanvas]) {
    if (!C) continue;
    const original = C.prototype.getContext;
    C.prototype.getContext = function (kind, ...rest) { window.__spy.kinds.push(String(kind)); return original.call(this, kind, ...rest); };
  }
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements', 'clear', 'clearBufferfv']) {
      const original = C.prototype[name];
      if (typeof original !== 'function') continue;
      C.prototype[name] = function (...args) { window.__spy.draws += 1; return original.apply(this, args); };
    }
  }
`;

/** パッド 1 台と、決まった乱数の列と、画面を調べる小さな関数。 */
const PAGE_INIT = `
  window.__pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) };
  navigator.getGamepads = () => [{ id: 'qa pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
    axes: window.__pad.axes.slice(), buttons: window.__pad.buttons.map((b) => ({ ...b })), vibrationActuator: null }];
  window.__fire = (on) => { window.__pad.buttons[7] = { value: on ? 1 : 0, pressed: on, touched: on }; };
  window.__look = (x, y) => { window.__pad.axes[2] = x; window.__pad.axes[3] = y; };
  let seed = 987654321;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  crypto.getRandomValues = (array) => { for (let i = 0; i < array.length; i += 1) array[i] = next(); return array; };
  window.__shown = (sel) => { const el = document.querySelector(sel);
    return !!el && !el.closest('[hidden]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0; };
  window.__ammo = () => { const m = (document.querySelector('[data-hud="ammo"]')?.textContent ?? '').match(/\\d+/); return m ? Number(m[0]) : NaN; };
  window.__onResult = () => location.hash === '#/result' && window.__shown('[data-screen="result"]');
`;

/** HUD の文字（data-hud の要素ごと）。 */
const hud = (page: Page) =>
  page.evaluate<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll('[data-hud]')].map((el) => [el.getAttribute('data-hud'), el.textContent.trim()]))`);

/** リザルト画面に見えている文字（採点結果）。 */
const resultScreen = (page: Page) => page.evaluate<string>(`document.querySelector('[data-screen="result"]').innerText.trim()`);

describe.skipIf(NESTED || !chromium)('render=off と clock=manual（QA）', () => {
  let work = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'render-clock-qa-'));
    const dist = join(work, 'dist');
    const r = spawnSync(`npm run build -- --outDir "${dist}" --emptyOutDir`, {
      cwd: ROOT,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, APEX_ACCEPTANCE_NESTED: '1', FORCE_COLOR: '0' },
    });
    if (r.status !== 0) throw new Error(`ビルドが失敗した:\n${r.stdout ?? ''}${r.stderr ?? ''}`);
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

  /** 新しいページで、保存のない状態のトップ画面を options のクエリを付けて開く。 */
  async function openTop(options: AppUrlOptions, extra: string[] = []): Promise<Page> {
    const page = await browser!.newPage();
    for (const script of [PAGE_INIT, ...extra]) await page.addInitScript(script);
    await page.addInitScript(`if (!sessionStorage.getItem('__qa')) { localStorage.clear(); sessionStorage.setItem('__qa', '1'); }`);
    await page.goto(appUrl(origin, BASE, '#/', options));
    await page.waitFor(`window.__shown('[data-screen="top"]') && document.querySelector('#weapon').options.length > 0`, 15_000);
    return page;
  }

  /** トップ画面で採点するモード（反復練習）を選び、「開始」でプレイ画面に入って練習が始まるまで待つ。 */
  async function start(page: Page) {
    await page.evaluate(`(() => { const s = document.querySelector('#mode'); s.value = 'ghost'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    expect(await page.evaluate<string>(`document.querySelector('#mode').value`)).toBe('ghost');
    await page.clickSelector('[data-screen="top"] a[href="#/play"]');
    await page.waitFor(`location.hash === '#/play' && window.__shown('[data-screen="play"]') && window.__ammo() > 0`);
    await page.frames(2);
  }

  /** パッドの状態を変え、ページがそれを読む（実際の描画が進む）まで待つ。 */
  async function pad(page: Page, script: string) {
    await page.evaluate(script);
    await page.frames(2);
  }

  it('ARC-23: render=off でトップを開いて 1 セット練習しリザルト画面まで進めても、WebGL の文脈が求められず描画の呼び出しが 1 回もない', async () => {
    // 時計は差し替えず、実時間で練習する（render=off だけを付ける）。
    const page = await openTop({ render: false }, [SPY_WEBGL]);
    await start(page);
    const full = await page.evaluate<number>('window.__ammo()');
    await page.evaluate('window.__fire(true)');
    await page.waitFor(`window.__ammo() < ${full}`, 10_000);
    await pad(page, 'window.__fire(false)');
    await page.waitFor('window.__onResult()', 15_000);
    await page.frames(5);
    const spy = await page.evaluate<{ kinds: string[]; draws: number }>('window.__spy');
    expect(spy.kinds.filter((k) => /webgl/i.test(k)), JSON.stringify(spy.kinds)).toEqual([]);
    expect(spy.draws).toBe(0);
    expect(await resultScreen(page)).not.toBe('');
    expect(exceptions(page), page.errors.join('\n')).toEqual([]);

    // 記録のしかたの確認: render=off を付けないページでは WebGL の文脈が求められ、描画が呼ばれる。
    const drawn = await openTop({}, [SPY_WEBGL]);
    await drawn.frames(5);
    const control = await drawn.evaluate<{ kinds: string[]; draws: number }>('window.__spy');
    expect(control.kinds.some((k) => /webgl/i.test(k)), JSON.stringify(control.kinds)).toBe(true);
    expect(control.draws).toBeGreaterThan(0);
  }, 90_000);

  /** clock=manual のページで決まった入力の記録（時計の時刻ごとのパッドの操作）を流し、HUD の文字の推移とリザルトの文字を返す。 */
  async function replay(page: Page) {
    const huds: Record<string, string>[] = [];
    await start(page);
    huds.push(await hud(page));
    const script: [number, string][] = [
      [0.2, 'window.__fire(true); window.__look(0.25, 0.5)'],
      [0.3, 'window.__look(-0.3, 0.7)'],
      [0.3, 'window.__look(0.1, 0.2)'],
      [0.2, 'window.__look(0, 0)'],
      [0.25, 'window.__fire(false)'],
    ];
    for (const [seconds, input] of script) {
      await pad(page, input);
      await page.advanceClock(seconds);
      await page.frames(1);
      huds.push(await hud(page));
    }
    await page.advanceClock(2.2);
    await page.waitFor('window.__onResult()');
    return { huds, result: await resultScreen(page) };
  }

  it('ARC-24: 同じ入力の記録を render=off のページと付けないページで流すと、HUD の文字と採点結果が一致する', async () => {
    const off = await replay(await openTop({ render: false, manualClock: true }));
    const on = await replay(await openTop({ manualClock: true }));
    expect(off.huds).toEqual(on.huds);
    expect(off.result).toEqual(on.result);
    // 比べた練習が意味のあるものになっている（撃って残弾が減り、リザルトに数字が出ている）。
    expect(off.huds.at(-1)!.ammo).not.toEqual(off.huds[0]!.ammo);
    expect(off.result).toMatch(/\d/);
  }, 120_000);

  /** clock=manual のページで練習を始め、1 発以上撃って fire を離す。 */
  async function fireAndRelease(page: Page) {
    await start(page);
    const full = await page.evaluate<number>('window.__ammo()');
    await pad(page, 'window.__fire(true)');
    await page.advanceClock(0.25);
    await pad(page, 'window.__fire(false)');
    const left = await page.evaluate<number>('window.__ammo()');
    expect(left).toBeLessThan(full);
    expect(left).toBeGreaterThan(0);
  }

  it('ARC-25: clock=manual で撃って fire を離したあと、時計を 2 秒進めると実時間で 2 秒たつ前にリザルト画面に移り、1.9 秒だけ進めるとプレイ画面のまま', async () => {
    const two = await openTop({ render: false, manualClock: true });
    await fireAndRelease(two);
    const started = Date.now();
    await two.advanceClock(2);
    await two.waitFor('window.__onResult()', 2_000);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(exceptions(two), two.errors.join('\n')).toEqual([]);

    const short = await openTop({ render: false, manualClock: true });
    await fireAndRelease(short);
    await short.advanceClock(1.9);
    // 実時間で 2 秒を超えて描画が進んでも、時計を進めない限りプレイ画面のまま。
    const t0 = await short.evaluate<number>('performance.now()');
    await short.waitFor(`performance.now() > ${t0 + 2_500}`, 10_000);
    await short.frames(3);
    expect(await short.evaluate<string>('location.hash')).toBe('#/play');
    expect(await short.evaluate<boolean>(`window.__shown('[data-screen="play"]')`)).toBe(true);
    expect(exceptions(short), short.errors.join('\n')).toEqual([]);
  }, 90_000);
});
