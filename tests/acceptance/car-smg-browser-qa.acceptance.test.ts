// docs/spec/modes.md の MODE-1（MVP の 7 つの武器それぞれで 3 つのモードを最後まで練習でき、リザルト画面が表示される）の
// QA の受け入れテスト（#49。7 つ目の武器 C.A.R. SMG を足した）。
// 公開された入口だけを使う: ビルドの結果を /apex-training/ で配信した画面（トップ・プレイ・リザルト）。
// 画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、パッドは Gamepad API の形で与えて R2 で撃つ。
// サーバーと DevTools のポートは OS に選ばせ（ARC-18）、待ちは画面の状態の条件で待つ（ARC-22）。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const chromium = findChromium();

const MVP_WEAPONS = ['R-301', 'R-99', 'フラットライン', 'ボルト', 'スピットファイア', 'L-STAR', 'C.A.R. SMG'];
const MODES = ['パターン観察', 'ゴースト追従', 'センター維持'];

/** Gamepad API の形の、標準配置のパッド 1 台。R2 はボタン 7。 */
const FAKE_PAD = `
  window.__pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) };
  navigator.getGamepads = () => [{ id: 'acceptance pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard',
    timestamp: performance.now(), axes: window.__pad.axes.slice(), buttons: window.__pad.buttons.map((b) => ({ ...b })), vibrationActuator: null }];
  window.__setR2 = (v) => { window.__pad.buttons[7] = { value: v, pressed: v >= 0.5, touched: v > 0 }; };
  window.__ammo = () => { const m = (document.querySelector('[data-hud="ammo"]')?.textContent ?? '').match(/\\d+/); return m ? Number(m[0]) : NaN; };
  window.__time = () => { const m = (document.querySelector('[data-hud="time"]')?.textContent ?? '').match(/[\\d.]+/); return m ? Number(m[0]) : NaN; };
`;

const resultText = (page: Page) => page.evaluate<string>(`document.querySelector('[data-screen="result"]')?.innerText ?? ''`);
const waitResult = (page: Page) =>
  page.waitFor(`location.hash === '#/result' && !document.querySelector('[data-screen="result"]').hidden && document.querySelector('[data-screen="result"]').innerText.trim().length > 0`);
const closePage = (page: Page) => page.send('Page.close').catch(() => undefined);

async function choose(page: Page, selector: string, label: string) {
  const ok = await page.evaluate<boolean>(`(() => {
    const s = document.querySelector(${JSON.stringify(selector)});
    const o = [...s.options].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  if (!ok) throw new Error(`${selector} に ${label} の選択肢がない`);
}

describe.skipIf(NESTED || !chromium)('QA MODE-1: MVP の 7 つの武器（C.A.R. SMG を含む）', () => {
  let work = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  let opened: Page[] = [];

  const newPage = async () => {
    const page = await browser!.newPage();
    await page.addInitScript(FAKE_PAD);
    opened.push(page);
    return page;
  };
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'car-qa-'));
    const dist = join(work, 'dist');
    const build = spawnSync(`npm run build -- --outDir "${dist}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`ビルドが失敗した:\n${build.stdout}${build.stderr}`);
    server = await serveStatic(dist, BASE);
    origin = originOf(server);
    browser = await launchBrowser(chromium!);
  }, 180_000);

  afterEach(async () => {
    for (const p of opened) await closePage(p);
    opened = [];
  });

  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise((ok) => server!.close(ok));
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('トップ画面の武器の選択肢に 7 つの武器がすべて出て、C.A.R. SMG は SMG の分類にある', async () => {
    const page = await newPage();
    await page.goto(`${origin}${BASE}#/`);
    await page.waitFor(`document.querySelector('#weapon').options.length > 0 && document.querySelector('#mode').options.length > 0`);
    const weapons = await page.evaluate<string[]>(`[...document.querySelector('#weapon').options].map((o) => o.textContent.trim())`);
    expect([...weapons].sort()).toEqual([...MVP_WEAPONS].sort());
    const group = await page.evaluate<string | null>(
      `([...document.querySelector('#weapon').options].find((o) => o.textContent.trim() === 'C.A.R. SMG')?.closest('optgroup')?.label ?? null)`,
    );
    if (group !== null) expect(group).toMatch(/SMG/);
    const modes = await page.evaluate<string[]>(`[...document.querySelector('#mode').options].map((o) => o.textContent.trim())`);
    expect(modes).toEqual(expect.arrayContaining(MODES));
  });

  it.each(MVP_WEAPONS.flatMap((w) => MODES.map((m) => [w, m] as const)))('%s / %s を最後まで練習でき、リザルト画面が表示される', async (name, mode) => {
    const page = await newPage();
    await page.goto(`${origin}${BASE}#/`);
    await page.evaluate('localStorage.clear()');
    await page.goto(`${origin}${BASE}#/`);
    await page.waitFor(`!document.querySelector('[data-screen="top"]').hidden && document.querySelector('#weapon').options.length > 0 && document.querySelector('#mode').options.length > 0`);
    await choose(page, '#weapon', name);
    await choose(page, '#mode', mode);
    await page.clickSelector('[data-screen="top"] a[href="#/play"]');
    await page.waitFor(`location.hash === '#/play' && !document.querySelector('[data-screen="play"]').hidden && window.__ammo() > 0`);
    // C.A.R. SMG の装弾数 30（WPN-20）が HUD の残弾に出る。
    if (name === 'C.A.R. SMG') expect(await page.evaluate<number>('window.__ammo()')).toBe(30);
    await page.waitFor('window.__time() >= 0.5', 15_000);
    await page.frames(2);

    // 撃ち切るまで R2 を押し続け、撃ち切ったら離す（撃たない時間でリザルトに移る）。
    await page.evaluate(`window.__setR2(1)`);
    await page.waitFor(`window.__ammo() === 0 || location.hash === '#/result'`, 20_000);
    await page.evaluate(`window.__setR2(0)`);
    await waitResult(page);

    expect(await page.evaluate<boolean>(`!document.querySelector('[data-screen="result"]').hidden`)).toBe(true);
    const text = await resultText(page);
    expect(text).toContain(name);
    expect(text).toContain(mode);
    if (mode !== 'パターン観察') expect(text, text).toMatch(/平均ズレ/);
    expect(exceptions(page), page.errors.join('\n')).toEqual([]);
  }, 60_000);
});
