// トップ画面の武器とモードのカード（docs/spec/screens.md「トップ画面」）を、ビルドした画面で確かめる。
// カードは隠した select の値に合わせて表示し、クリック・矢印キー・パッドの左右で select の値を変える（src/ui/card-choices.ts）。
// 画面は render=off で開く。パッドは navigator.getGamepads を差し替えて与え、window.__pad のボタンをテストが変える。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const chromium = findChromium();
const APP = { render: false, manualClock: true };
const SHOTS = process.env.APEX_TOP_CARDS_SHOTS;

const PAD_INIT = `
  window.__pad = { buttons: [] };
  const makePad = () => ({ id: 'top-cards-pad', index: 0, connected: true, mapping: 'standard', timestamp: performance.now(), axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, i) => { const p = window.__pad.buttons.includes(i); return { value: p ? 1 : 0, pressed: p, touched: p }; }) });
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: function () { return [makePad(), null, null, null]; } });
`;
const DPAD_DOWN = 13;
const DPAD_RIGHT = 15;

/** カードの並びの今の様子。 */
interface CardsView {
  readonly names: string[];
  readonly selected: string[];
  readonly select: string;
}

const readCards = (page: Page, root: string, select: string) =>
  page.evaluate<CardsView>(`(() => {
    const cards = [...document.querySelectorAll('${root} .card')];
    return { names: cards.map((c) => c.querySelector('.card-name').textContent),
      selected: cards.filter((c) => c.classList.contains('selected')).map((c) => c.querySelector('.card-name').textContent),
      select: document.getElementById('${select}').value };
  })()`);

describe.skipIf(NESTED || !chromium)('トップ画面のカード', () => {
  let work = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';

  async function open(setup = ''): Promise<Page> {
    const page = await browser!.newPage();
    await page.addInitScript(PAD_INIT);
    await page.goto(appUrl(origin, BASE, '#/', APP));
    await page.evaluate(`(() => { localStorage.clear(); ${setup}; location.reload(); })()`);
    await page.waitFor(`document.readyState === 'complete' && document.querySelectorAll('#mode-cards .card').length > 0`, 15_000);
    return page;
  }

  /** パッドのボタンを押して離す（押した描画と離した描画を 1 回ずつ進める）。 */
  async function press(page: Page, button: number): Promise<void> {
    await page.evaluate(`window.__pad.buttons = [${button}]`);
    await page.advanceClock(2 / 60);
    await page.evaluate(`window.__pad.buttons = []`);
    await page.advanceClock(2 / 60);
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'top-cards-'));
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

  it('モードのカードが登録の順に並び、名前・説明・アイコンを持ち、クリックで選び直せる', async () => {
    const page = await open();
    const view = await readCards(page, '#mode-cards', 'mode');
    expect(view).toEqual({ names: ['反復練習', '追いエイム', '追いエイム＋リコイル', 'フリック'], selected: ['反復練習'], select: 'ghost' });
    const parts = await page.evaluate<{ description: string; icon: string | null }[]>(`[...document.querySelectorAll('#mode-cards .card')].map((c) => ({
      description: c.querySelector('.card-description').textContent, icon: c.querySelector('svg.card-icon')?.dataset.icon ?? null }))`);
    expect(parts.map((p) => p.description)).toEqual([
      '同じ武器のリコイルを繰り返し撃って、パターンを手に覚えさせる',
      '左右に動く的に照準を乗せ続ける',
      'リコイルを抑えながら、動く的に照準を乗せ続ける',
      'ランダムに出る的へ素早く照準を合わせて撃つ',
    ]);
    expect(new Set(parts.map((p) => p.icon)).size).toBe(4);
    await page.clickSelector('#mode-cards .card[data-value="flick"]');
    expect(await readCards(page, '#mode-cards', 'mode')).toMatchObject({ selected: ['フリック'], select: 'flick' });
    // 武器を使わないモードでは武器の並び（見出しを含む）を隠す。
    expect(await page.evaluate<boolean>(`document.getElementById('weapon-choice').hidden`)).toBe(true);
  });

  it('武器のカードは分類の見出しの下に並び、クリックした武器で練習が始まる', async () => {
    const page = await open();
    const headings = await page.evaluate<string[]>(`[...document.querySelectorAll('#weapon-cards .card-heading')].map((h) => h.textContent)`);
    expect(headings.length).toBeGreaterThan(0);
    const before = await readCards(page, '#weapon-cards', 'weapon');
    expect(before.names.slice().sort()).toEqual(['C.A.R. SMG', 'L-STAR']);
    expect(before.selected).toEqual(['C.A.R. SMG']);
    await page.clickSelector('#weapon-cards .card[data-value="lstar"]');
    expect(await readCards(page, '#weapon-cards', 'weapon')).toMatchObject({ selected: ['L-STAR'], select: 'lstar' });
    await page.clickSelector('#start');
    await page.waitFor(`location.hash === '#/play'`);
    // 練習は「開始」のあとに非同期で始まるので、ページの時計を 1 描画ずつ進めながら HUD を待つ。
    await page.waitFor(`(window.__apexTestClock.advance(1 / 60, 1 / 60), document.querySelector('[data-hud="weapon"]').textContent.includes('L-STAR'))`);
  });

  it('武器の並びにフォーカスがあるとき、右の矢印キーで並びの次の武器を選ぶ', async () => {
    const page = await open();
    const first = await readCards(page, '#weapon-cards', 'weapon');
    await page.evaluate(`document.getElementById('weapon-cards').focus()`);
    for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    const after = await readCards(page, '#weapon-cards', 'weapon');
    expect(after.selected).toEqual([first.names[1]]);
  });

  it('自己ベストの要約は、選んでいる武器と入力方式の組の自己ベストを出し、ないときは「まだ記録なし」', async () => {
    const best = JSON.stringify({ version: 1, meanError: 0.85, groupingRadius: 1, hitRate: 50, shots: 10, achievedAt: '2026-11-26T00:00:00.000Z' });
    const page = await open(`localStorage.setItem('apex-training:best:mouse:lstar:ghost', ${JSON.stringify(best)})`);
    const summaries = () => page.evaluate<string[]>(`[...document.querySelectorAll('#mode-cards .card-best')].map((b) => b.textContent)`);
    expect(await summaries()).toEqual(Array(4).fill('自己ベスト: まだ記録なし'));
    await page.clickSelector('#weapon-cards .card[data-value="lstar"]');
    expect((await summaries())[0]).toBe('自己ベスト: 0.85°');
    await page.clickSelector('#weapon-cards .card[data-value="car"]');
    expect((await summaries())[0]).toBe('自己ベスト: まだ記録なし');
  });

  it('パッドでモードの並びにフォーカスを移すと並び全体に枠が付き、右で 1 枚ずつ進んで最後で止まり、下で次の項目へ移る', async () => {
    const page = await open();
    const focused = () => page.evaluate<string[]>(`[...document.querySelectorAll('.pad-focus')].map((e) => e.id || e.tagName)`);
    await page.advanceClock(4 / 60);
    // 武器の並び → 試聴 → モードの並び。
    for (let i = 0; i < 3; i += 1) await press(page, DPAD_DOWN);
    expect(await focused()).toEqual(['mode-cards']);
    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      await press(page, DPAD_RIGHT);
      seen.push((await readCards(page, '#mode-cards', 'mode')).selected[0] ?? '');
    }
    expect(seen).toEqual(['追いエイム', '追いエイム＋リコイル', 'フリック', 'フリック']);
    await press(page, DPAD_DOWN);
    expect(await focused()).not.toEqual(['mode-cards']);
  });

  it.each([
    ['反復練習', 'ghost'],
    ['フリック', 'flick'],
  ])('幅 375px で %s を選んでも横にはみ出さない', async (_name, mode) => {
    const page = await open();
    await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 740, deviceScaleFactor: 1, mobile: true });
    await page.clickSelector(`#mode-cards .card[data-value="${mode}"]`);
    await page.advanceClock(2 / 60);
    const overflow = await page.evaluate<{ doc: number; widest: number }>(`(() => ({
      doc: document.documentElement.scrollWidth,
      widest: Math.max(...[...document.querySelectorAll('[data-screen="top"] *, .footer *')].filter((e) => e.getClientRects().length > 0).map((e) => e.getBoundingClientRect().right)) }))()`);
    expect(overflow.doc).toBeLessThanOrEqual(375);
    expect(overflow.widest).toBeLessThanOrEqual(375);
    if (SHOTS) writeFileSync(join(SHOTS, `top-375-${mode}.png`), await page.screenshot());
  });

  it('「開始」は「設定」「履歴」より大きく、文字も大きい', async () => {
    const page = await open();
    const sizes = await page.evaluate<{ w: number; h: number; f: number }[]>(`['#start', '#open-settings', '#open-history'].map((s) => {
      const e = document.querySelector(s); const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, f: parseFloat(getComputedStyle(e).fontSize) }; })`);
    const [start, ...links] = sizes;
    for (const link of links) {
      expect(start!.w).toBeGreaterThan(link.w);
      expect(start!.h).toBeGreaterThan(link.h);
      expect(start!.f).toBeGreaterThan(link.f);
    }
    if (SHOTS) writeFileSync(join(SHOTS, 'top-1280.png'), await page.screenshot());
  });
});
