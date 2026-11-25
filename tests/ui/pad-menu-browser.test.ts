// パッドでの項目の移動と変更（docs/spec/screens.md「パッドでの項目の移動と変更」）を、ビルドした画面で確かめる。
// パッドは navigator.getGamepads を差し替えて与え、window.__pad のボタンと軸をテストが変える。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const chromium = findChromium();

const A = 0;
const B = 1;
const UP = 12;
const DOWN = 13;
const LEFT = 14;
const RIGHT = 15;

/** window.__pad（押しているボタンの番号と軸）から、標準配置のパッドを 1 つ返す。 */
const PAD_INIT = `
  window.__pad = { buttons: [], axes: [0, 0, 0, 0], mapping: 'standard' };
  const makePad = () => ({ id: 'menu-pad', index: 0, connected: true, mapping: window.__pad.mapping, timestamp: performance.now(),
    axes: window.__pad.axes.slice(),
    buttons: Array.from({ length: 17 }, (_, i) => { const p = window.__pad.buttons.includes(i); return { value: p ? 1 : 0, pressed: p, touched: p }; }) });
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: function () { return [makePad(), null, null, null]; } });
`;

const screenVisible = (name: string) => `!document.querySelector('[data-screen="${name}"]').hidden`;
/** フォーカスの枠が付いている要素の id か文字。ないときは null。 */
const focusedName = (page: Page) =>
  page.evaluate<string | null>(`(() => { const el = document.querySelector('.pad-focus'); return el ? (el.id || el.textContent.trim()) : null; })()`);

async function press(page: Page, button: number, times = 1) {
  for (let i = 0; i < times; i += 1) {
    await page.evaluate(`window.__pad.buttons = [${button}]`);
    await page.frames(2);
    await page.evaluate(`window.__pad.buttons = []`);
    await page.frames(2);
  }
}

/** 下を押して、id の要素にフォーカスを移す。 */
async function focusDown(page: Page, id: string) {
  for (let i = 0; i < 60 && (await focusedName(page)) !== id; i += 1) await press(page, DOWN);
  expect(await focusedName(page)).toBe(id);
}

describe.skipIf(NESTED || !chromium)('パッドでの項目の移動と変更', () => {
  let work = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';

  async function open(hash: string, seed: Record<string, string> = {}): Promise<Page> {
    const page = await browser!.newPage();
    await page.addInitScript(PAD_INIT);
    await page.goto(`${origin}${BASE}#/`);
    await page.evaluate(`(() => { localStorage.clear(); const seed = ${JSON.stringify(seed)}; for (const k in seed) localStorage.setItem(k, seed[k]); })()`);
    await page.evaluate(`location.hash = ${JSON.stringify(hash)}; location.reload()`);
    await page.waitFor(`document.readyState === 'complete' && document.querySelector('#weapon').options.length > 0`, 15_000);
    await page.frames(3);
    return page;
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'pad-menu-'));
    const dist = join(work, 'dist');
    const build = spawnSync(`npm run build -- --outDir "${dist}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`ビルドが失敗した:\n${build.stdout}${build.stderr}`);
    server = await serveStatic(dist, BASE);
    origin = originOf(server);
    browser = await launchBrowser(chromium!);
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((ok) => (server ? server.close(ok) : ok(undefined)));
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('UI-47・UI-49: トップ画面で下を押すと武器にフォーカスが出て選択は変わらず、最後の項目で止まり、B / ○ では何もしない', async () => {
    const page = await open('#/');
    expect(await focusedName(page)).toBeNull();
    const weapon = await page.evaluate<string>(`document.querySelector('#weapon').value`);
    await press(page, DOWN);
    expect(await focusedName(page)).toBe('weapon');
    expect(await page.evaluate<string>(`document.querySelector('#weapon').value`)).toBe(weapon);
    await press(page, DOWN);
    expect(await focusedName(page)).toBe('mode');
    await press(page, DOWN, 10);
    expect(await focusedName(page)).toBe('open-history');
    await press(page, B);
    expect(await page.evaluate<boolean>(screenVisible('top'))).toBe(true);
    await page.send('Page.close');
  });

  it('UI-43・INP-15: 十字キーと A / × だけで L-STAR・センター維持を選んで始めると HUD は L-STAR でマウスのまま、R2 / RT でパッドに変わる', async () => {
    const page = await open('#/');
    const index = (select: string, value: string) =>
      page.evaluate<number>(`[...document.querySelector('${select}').options].findIndex((o) => o.value === '${value}')`);
    await press(page, DOWN);
    await press(page, RIGHT, await index('#weapon', 'lstar'));
    expect(await page.evaluate<string>(`document.querySelector('#weapon').value`)).toBe('lstar');
    await press(page, DOWN);
    await press(page, RIGHT, await index('#mode', 'center'));
    expect(await page.evaluate<string>(`document.querySelector('#mode').value`)).toBe('center');
    await focusDown(page, 'start');
    await press(page, A);
    await page.waitFor(screenVisible('play'));
    await page.frames(3);
    expect(await focusedName(page)).toBeNull();
    expect(await page.evaluate<string>(`document.querySelector('[data-hud="weapon"]').textContent`)).toContain('L-STAR');
    expect(await page.evaluate<string>(`document.querySelector('[data-hud="input"]').textContent`)).toContain('マウス');
    await press(page, 7);
    expect(await page.evaluate<string>(`document.querySelector('[data-hud="input"]').textContent`)).toContain('パッド');
    // UI-46: 練習中の十字キーと左スティックは何の操作にもならない。
    await press(page, DOWN, 3);
    await press(page, RIGHT, 3);
    expect(await focusedName(page)).toBeNull();
    expect(await page.evaluate<boolean>(screenVisible('play'))).toBe(true);
    await page.send('Page.close');
  });

  it('UI-44・UI-45: 設定画面で FOV の欄で右を 5 回押すと 95 になって保存され、上限では変わらない。感度は 0.1 ずつ', async () => {
    const page = await open('#/settings');
    await focusDown(page, 'setting-fov');
    await press(page, RIGHT, 5);
    expect(await page.evaluate<string>(`document.querySelector('#setting-fov').value`)).toBe('95');
    expect(JSON.parse(await page.evaluate<string>(`localStorage.getItem('apex-training:settings:common')`))).toMatchObject({ fov: 95 });
    await page.send('Page.close');

    const top = await open('#/settings', {
      'apex-training:settings:common': JSON.stringify({ fov: 110 }),
      'apex-training:settings:mouse': JSON.stringify({ sensitivity: 1.5 }),
    });
    await focusDown(top, 'setting-fov');
    await press(top, RIGHT);
    expect(await top.evaluate<string>(`document.querySelector('#setting-fov').value`)).toBe('110');
    await focusDown(top, 'setting-sensitivity');
    await press(top, LEFT);
    expect(JSON.parse(await top.evaluate<string>(`localStorage.getItem('apex-training:settings:mouse')`))).toMatchObject({ sensitivity: 1.4 });
    await top.send('Page.close');
  });

  it('UI-50・UI-51: ゴースト表示は A / × で切り替わり、色は右で次の色、簡易設定の間は詳細設定の欄にフォーカスが移らない', async () => {
    const page = await open('#/settings', { 'apex-training:settings:pad': JSON.stringify({ mode: 'simple' }) });
    await focusDown(page, 'setting-crosshair-color');
    await press(page, RIGHT);
    expect(await page.evaluate<string>(`document.querySelector('#setting-crosshair-color').value`)).toBe('#ffffff');
    await focusDown(page, 'setting-ghost');
    await press(page, A);
    const common = () => page.evaluate<string>(`localStorage.getItem('apex-training:settings:common')`);
    expect(JSON.parse(await common())).toMatchObject({ ghost: false, crosshairColor: '#ffffff' });
    await press(page, A);
    expect(JSON.parse(await common())).toMatchObject({ ghost: true });
    const visited = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      await press(page, DOWN);
      visited.add((await focusedName(page)) ?? '');
    }
    expect([...visited].filter((id) => id.startsWith('setting-pad-') && !/mode|simple|vibration/.test(id))).toEqual([]);
    expect(visited.has('setting-pad-vibration')).toBe(true);
    await press(page, B);
    await page.waitFor(screenVisible('top'));
    await page.send('Page.close');
  });

  it('UI-52: 履歴の画面で「この履歴を消す」を A / × で押すと確認が出て「取りやめる」にフォーカスがあり、B / ○ で閉じ、「消す」で消える', async () => {
    // 開いたときに選ばれる組（一覧の最初の武器・ゴースト追従・マウス）に履歴を入れる。
    const entry = { at: '2026-11-25T05:00:00.000Z', meanError: 1, hitRate: 1, groupingRadius: 1 };
    const page = await open('#/');
    const key = `apex-training:history:mouse:${await page.evaluate<string>(`document.querySelector('#history-weapon').options[0].value`)}:ghost`;
    await page.evaluate(`localStorage.setItem('${key}', ${JSON.stringify(JSON.stringify({ version: 1, entries: [entry] }))}); location.hash = '#/history'`);
    await page.waitFor(`!document.querySelector('#history-clear').disabled`);
    await focusDown(page, 'history-clear');
    await press(page, A);
    expect(await page.evaluate<boolean>(`document.querySelector('#history-confirm').hidden`)).toBe(false);
    expect(await focusedName(page)).toBe('history-confirm-cancel');
    await press(page, B);
    expect(await page.evaluate<boolean>(`document.querySelector('#history-confirm').hidden`)).toBe(true);
    expect(await page.evaluate<boolean>(screenVisible('history'))).toBe(true);
    expect(await page.evaluate<string | null>(`localStorage.getItem('${key}')`)).not.toBeNull();
    expect(await focusedName(page)).toBe('history-clear');
    await press(page, A);
    await press(page, LEFT);
    await press(page, UP);
    expect(await focusedName(page)).toBe('history-confirm-ok');
    await press(page, A);
    expect(await page.evaluate<string | null>(`localStorage.getItem('${key}')`)).toBeNull();
    await press(page, B);
    await page.waitFor(screenVisible('top'));
    await page.send('Page.close');
  });

  it('UI-54: 標準配置でないパッドのボタンではフォーカスも選択も変わらない', async () => {
    const page = await open('#/', {
      'apex-training:pad-mapping': JSON.stringify({ 'menu-pad': { fire: 7, ads: 6, lookX: { axis: 2, invert: false }, lookY: { axis: 3, invert: false } } }),
    });
    await page.evaluate(`window.__pad.mapping = ''`);
    await page.frames(3);
    const weapon = await page.evaluate<string>(`document.querySelector('#weapon').value`);
    for (const button of [A, B, UP, DOWN, LEFT, RIGHT]) await press(page, button);
    expect(await focusedName(page)).toBeNull();
    expect(await page.evaluate<string>(`document.querySelector('#weapon').value`)).toBe(weapon);
    await page.send('Page.close');
  });
});
