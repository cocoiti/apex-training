// docs/spec/input.md「入力方式の切替」「入力方式ごとの保存」の QA の受け入れテスト（INP-9〜INP-14）。
// 公開された入口（ビルドの結果を /apex-training/ で配信した画面、index.html の要素、武器の JSON、
// scoring.md の自己ベストの localStorage のキー）だけを使い、実装の内部には依存しない。
// 画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、パッドは Gamepad API（navigator.getGamepads）の形で与える。
// HUD の入力方式の表示は index.html の [data-hud="input"] の文字で読む。照準の反応は、センター維持の中心の的の色が
// 画面の中心から外れるか（画面写しの中心の画素）で読む。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findChromium, launchBrowser, originOf, serveStatic, waitUntil, type Browser, type Page } from '../helpers/browser';
import { decodePng, type Image } from '../helpers/png';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const WIDTH = 1280;
const HEIGHT = 800;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;
const chromium = findChromium();
/**
 * ページが描画を frames 回進めるまで待つ（決まった時間の sleep で待たない。architecture.md ARC-20, ARC-22）。
 * パッドの読み取りと練習のステップは描画ごとに進むので、変わらないことを確かめるときもこれで待つ。
 */
const settle = (page: Page, frames: number) => page.frames(frames);

/** SPEC の文言と値（実装の定数には依存しない）。 */
const MOUSE = 'マウス';
const PAD = 'パッド';
const UPDATED = '自己ベスト更新';
const BEST_PREFIX = 'apex-training:best:';
const bestKey = (input: string, weapon: string, mode: string) => `${BEST_PREFIX}${input}:${weapon}:${mode}`;
const CENTER_MODE = 'センター維持';
const CENTER_MODE_ID = 'center';

interface WeaponJson {
  id: string;
  name: string;
  rpm: number;
  magSize: number;
}
const WEAPONS: WeaponJson[] = readdirSync(join(ROOT, 'src/data/weapons'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(ROOT, 'src/data/weapons', f), 'utf8')) as WeaponJson);
const byId = (id: string) => {
  const w = WEAPONS.find((x) => x.id === id);
  if (!w) throw new Error(`武器がない: ${id}`);
  return w;
};

type RGB = [number, number, number];
const distance = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Gamepad API の形の、標準配置のパッド 1 台（ページを開いたときから接続していて、何も操作していない）。
 * 右スティックは軸 2・3、L2 はボタン 6、R2 はボタン 7、ボタン 0 は ×（DualSense）/ A（Xbox）。
 */
const PAGE_INIT = `
  window.__pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) };
  navigator.getGamepads = () => [{ id: 'acceptance pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard',
    timestamp: performance.now(), axes: window.__pad.axes.slice(), buttons: window.__pad.buttons.map((b) => ({ ...b })), vibrationActuator: null }];
  window.__button = (i, v) => { window.__pad.buttons[i] = { value: v, pressed: v >= 0.5, touched: v > 0 }; };
  window.__ammo = () => { const m = (document.querySelector('[data-hud="ammo"]')?.textContent ?? '').match(/\\d+/); return m ? Number(m[0]) : NaN; };
  window.__inputShown = () => (document.querySelector('[data-hud="input"]')?.textContent ?? '').trim();
`;

const ammo = (page: Page) => page.evaluate<number>('window.__ammo()');
const shown = (page: Page) => page.evaluate<string>('window.__inputShown()');
const hash = (page: Page) => page.evaluate<string>('location.hash');

/** HUD の入力方式の表示が「マウス」「パッド」のどちらか（両方の語を含むときは区別できないので null）。 */
const shownMethod = async (page: Page): Promise<string | null> => {
  const text = await shown(page);
  const m = text.includes(MOUSE);
  const p = text.includes(PAD);
  if (m === p) return null;
  return m ? MOUSE : PAD;
};
const waitShown = (page: Page, method: string, timeout = 2000) =>
  page.waitFor(`(() => { const t = window.__inputShown(); return t.includes(${JSON.stringify(method)}) && !t.includes(${JSON.stringify(method === MOUSE ? PAD : MOUSE)}); })()`, timeout);

/** 選択肢の表示名から値を選ぶ（キーボードで選んだときと同じく change を出す。マウスの操作にならない）。 */
async function choose(page: Page, selector: string, label: string) {
  const ok = await page.evaluate<boolean>(`(() => {
    const s = document.querySelector(${JSON.stringify(selector)});
    const o = [...s.options].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  if (!ok) throw new Error(`${selector} に ${label} の選択肢がない`);
}

/** 設定画面で入力方式を選び、トップ画面に戻る（マウスでもパッドでも操作しない）。 */
async function setInputMethod(page: Page, label: string) {
  await page.evaluate(`location.hash = '#/settings'`);
  await page.waitFor(`!document.querySelector('[data-screen="settings"]').hidden`);
  await choose(page, '#setting-input-method', label);
  await settle(page, 6);
  await page.evaluate(`location.hash = '#/'`);
  await page.waitFor(`!document.querySelector('[data-screen="top"]').hidden`);
}

/**
 * トップ画面で武器とモードを選び、「開始」をキーボード（フォーカスして Enter）で押してプレイ画面に入る
 * （マウスでもパッドでも操作しないため。screens.md「武器とモードはマウスのクリック（またはキーボード）で選ぶ」）。
 */
async function start(page: Page, weapon: WeaponJson, mode = CENTER_MODE) {
  await page.evaluate(`location.hash = '#/'`);
  await page.waitFor(`!document.querySelector('[data-screen="top"]').hidden && document.querySelector('#weapon').options.length > 0 && document.querySelector('#mode').options.length > 0`);
  await choose(page, '#weapon', weapon.name);
  await choose(page, '#mode', mode);
  await page.evaluate(`document.querySelector('[data-screen="top"] a[href="#/play"]').focus()`);
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
  }
  try {
    await page.waitFor(`location.hash === '#/play' && !document.querySelector('[data-screen="play"]').hidden && window.__ammo() === ${weapon.magSize} && window.__inputShown() !== ''`, 10_000);
  } catch (e) {
    const state = await page.evaluate<unknown>(`({ hash: location.hash, hidden: document.querySelector('[data-screen="play"]').hidden, ammo: document.querySelector('[data-hud="ammo"]')?.textContent, input: document.querySelector('[data-hud="input"]')?.textContent, status: document.querySelector('#status')?.textContent, w: document.querySelector('#weapon').value })`);
    throw new Error(`${String(e)} ${JSON.stringify(state)} ${page.errors.join(' / ')}`, { cause: e });
  }
  await settle(page, 31);
}

const mouseButton = (page: Page, type: 'mousePressed' | 'mouseReleased', x = CX, y = CY) =>
  page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });

/** マウスを中心から右へ dx ピクセルまで steps 回に分けて動かす（buttons は押しているボタン）。 */
async function moveMouse(page: Page, dx: number, steps = 10, buttons = 0) {
  for (let i = 1; i <= steps; i += 1) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: CX + (dx * i) / steps, y: CY + (dx * i) / steps / 4, button: buttons ? 'left' : 'none', buttons });
    await settle(page, 2);
  }
}

/** キャンバスの中心をクリックしてポインターロックを掛ける。掛かったかを返す。 */
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

async function screenshot(page: Page): Promise<Image> {
  const { data } = await page.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  return decodePng(Buffer.from(data, 'base64'));
}

/** HTML の画面を見えなくし、キャンバスだけを写す（HUD の文字は textContent で読める。隠した要素はクリックを受けない）。 */
async function hideHtml(page: Page) {
  await page.evaluate(`for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.visibility = 'hidden'`);
  await settle(page, 19);
}

const storedBests = (page: Page) =>
  page.evaluate<Record<string, string>>(`(() => { const out = {}; try { for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i);
    if (k.startsWith(${JSON.stringify(BEST_PREFIX)})) out[k] = localStorage.getItem(k); } } catch {} return out; })()`);

const resultText = (page: Page) =>
  page.evaluate<string>(`(() => { const s = document.querySelector('[data-screen="result"]'); return s && !s.hidden ? s.innerText : ''; })()`);

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('QA: 入力方式の切替（INP-9〜INP-14）', () => {
  let work = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  const pages: Page[] = [];
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));

  /** 新しいタブで localStorage を空にし（seed を入れ）、読み込み直したトップ画面を開く（ページを開いた直後の状態）。 */
  async function openFresh(seed: Record<string, string> = {}): Promise<Page> {
    for (const p of pages.splice(0)) await p.send('Page.close').catch(() => {});
    const page = await browser!.newPage();
    pages.push(page);
    await page.addInitScript(PAGE_INIT);
    await page.goto(`${origin}${BASE}#/`);
    await page.evaluate(`(() => { localStorage.clear(); const seed = ${JSON.stringify(seed)}; for (const k in seed) localStorage.setItem(k, seed[k]); })()`);
    await page.evaluate('window.__beforeReload = true');
    await page.send('Page.reload', { ignoreCache: false });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && !!document.querySelector('[data-screen="top"]') && !document.querySelector('[data-screen="top"]').hidden`, 15_000);
    return page;
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'input-switch-qa-'));
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

  // -------------------------------------------------------------------------
  it('INP-11: 自動で、ページを開いてからどちらのデバイスも操作せずに練習を始めると、HUD の入力方式の表示がマウスになる', async () => {
    const page = await openFresh();
    // 前提: 入力方式の既定は「自動」。
    expect(await page.evaluate<string>(`document.querySelector('#setting-input-method').selectedOptions[0].textContent.trim()`)).toBe('自動');
    await start(page, byId('r301'));
    expect(await shownMethod(page)).toBe(MOUSE);
    // 何も操作せずにしばらく置いても、マウスのまま（パッドは接続しているが操作していない）。
    await settle(page, 50);
    expect(await shownMethod(page)).toBe(MOUSE);
    expect(exceptions(page), page.errors.join('\n')).toEqual([]);
  }, 60_000);

  // -------------------------------------------------------------------------
  it('INP-9: 自動で、パッドで撃ったあとにマウスを動かすと、入力方式の表示がマウスに変わる', async () => {
    const page = await openFresh();
    const w = byId('r301');
    await start(page, w);
    expect(await shownMethod(page)).toBe(MOUSE);
    // 練習の始めにキャンバスをクリックしてポインターロックを掛ける（mouse.md: ロックしていない間はマウスで照準が動かない）。
    expect(await lock(page)).toBe(true);
    // パッドの R2 で撃つ。
    await page.evaluate('window.__button(7, 1)');
    await page.waitFor(`window.__ammo() <= ${w.magSize - 2}`, 5000);
    await waitShown(page, PAD);
    await page.evaluate('window.__button(7, 0)');
    await settle(page, 6);
    expect(await shownMethod(page)).toBe(PAD);
    expect(await hash(page)).toBe('#/play');
    // ポインターロックのまま、マウスを動かす（ボタンは押さない）。
    expect(await page.evaluate<boolean>('!!document.pointerLockElement')).toBe(true);
    await moveMouse(page, 120);
    await waitShown(page, MOUSE, 1000);
    expect(await shownMethod(page)).toBe(MOUSE);
    expect(await hash(page)).toBe('#/play');
    expect(exceptions(page), page.errors.join('\n')).toEqual([]);
  }, 60_000);

  // -------------------------------------------------------------------------
  it('INP-10: パッドに固定しているとき、マウスを動かしたりクリックしたりしても照準と射撃は反応せず、表示はパッドのまま', async () => {
    const page = await openFresh();
    await setInputMethod(page, 'パッド');
    const w = byId('r301');
    await start(page, w);
    expect(await shownMethod(page)).toBe(PAD);
    await hideHtml(page);
    const base = await screenshot(page);
    const target = base.pixel(CX, CY);

    // マウスでクリックする（ポインターロックが掛かれば、掛かった状態でも確かめる）。
    const locked = await lock(page);
    await settle(page, 19);
    expect(await ammo(page), 'クリックで撃たない').toBe(w.magSize);
    expect(await shownMethod(page)).toBe(PAD);
    // 左ボタンを押したまま 0.6 秒保ち、押したまま動かしてから離す。
    await mouseButton(page, 'mousePressed');
    await settle(page, 38);
    await moveMouse(page, 200, 10, 1);
    await mouseButton(page, 'mouseReleased', CX + 200, CY + 50);
    await settle(page, 12);
    // ボタンを押さずに大きく動かす。
    await moveMouse(page, -300, 15);
    await settle(page, 25);
    expect(await ammo(page), `左ボタンを押しても撃たない（ポインターロック: ${locked}）`).toBe(w.magSize);
    expect(await hash(page)).toBe('#/play');
    expect(await shownMethod(page)).toBe(PAD);
    const afterMouse = await screenshot(page);
    expect(distance(afterMouse.pixel(CX, CY), target), `マウスで照準が動かない（ポインターロック: ${locked}）`).toBeLessThan(20);

    // 対照: パッドの右スティックでは照準が動き、R2 では撃てる（画面の中心の色の変化で照準の動きを読める）。
    // ポインターロックは外さない（外すと一時停止になる。mouse.md「一時停止と再開」）。
    // 中心の色が的の色から外れるまで、スティックを倒したまま待つ（描画の速さによって 1 回の倒しで動く量が変わるため）。
    await page.evaluate('window.__pad.axes[2] = 0.4');
    await waitUntil(
      async () => distance((await screenshot(page)).pixel(CX, CY), target) > 30,
      'パッドの右スティックで照準が動き、画面の中心の色が的の色から外れる',
      { timeout: 5000 },
    );
    await page.evaluate('window.__pad.axes[2] = 0');
    await page.evaluate('window.__button(7, 1)');
    await page.waitFor(`window.__ammo() < ${w.magSize}`, 3000);
    await page.evaluate('window.__button(7, 0)');
    expect(await shownMethod(page)).toBe(PAD);
    expect(exceptions(page), page.errors.join('\n')).toEqual([]);
  }, 60_000);

  // -------------------------------------------------------------------------
  describe('INP-12: 自動で、右スティックをデッドゾーンの内側でだけ動かしても、入力方式の表示は変わらない', () => {
    /** 既定のデッドゾーン 10% の内側（傾き 8% 以下）で、いろいろな向きに揺らす（約 1.2 秒）。 */
    async function wiggleInsideDeadzone(page: Page) {
      const tilts: [number, number][] = [
        [0.08, 0], [0, -0.08], [-0.07, 0.03], [0.05, 0.05], [-0.05, -0.05], [0.02, 0.07], [0.08, 0], [-0.08, 0],
        [0.0566, -0.0566], [0, 0.08], [0.03, -0.02], [0, 0],
      ];
      for (const [x, y] of tilts) {
        await page.evaluate(`(() => { window.__pad.axes[2] = ${x}; window.__pad.axes[3] = ${y}; })()`);
        await settle(page, 6);
      }
    }

    it('ページを開いてから操作していない状態（マウス）で揺らしても、マウスのまま', async () => {
      const page = await openFresh();
      await start(page, byId('r301'));
      expect(await shownMethod(page)).toBe(MOUSE);
      await wiggleInsideDeadzone(page);
      await settle(page, 12);
      expect(await shownMethod(page)).toBe(MOUSE);
      // 対照: デッドゾーンより大きく倒すとパッドになる（このパッドの入力が読まれている）。
      await page.evaluate('window.__pad.axes[2] = 0.5');
      await waitShown(page, PAD, 1000);
      await page.evaluate('window.__pad.axes[2] = 0');
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('パッドからマウスに切り替えたあとに揺らしても、マウスのまま', async () => {
      const page = await openFresh();
      await start(page, byId('r301'));
      expect(await lock(page)).toBe(true);
      // パッドのボタン（× / A）を押して離し、パッドにする。
      await page.evaluate('window.__button(0, 1)');
      await waitShown(page, PAD);
      await page.evaluate('window.__button(0, 0)');
      // マウスを動かしてマウスにする。
      await moveMouse(page, 100);
      await waitShown(page, MOUSE, 1000);
      await wiggleInsideDeadzone(page);
      await settle(page, 12);
      expect(await shownMethod(page)).toBe(MOUSE);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  it('INP-13: 自動で、マウスの左ボタンで撃っている間にパッドのボタンを押すと、表示がパッドに変わり、左ボタンを押したままでも射撃が止まる', async () => {
    const page = await openFresh();
    // 撃ち切るまでの時間が長い武器（スピットファイア: 55 発・540 rpm、約 6 秒）。
    const w = byId('spitfire');
    await start(page, w);
    expect(await lock(page)).toBe(true);
    const beforeFire = await ammo(page);
    await mouseButton(page, 'mousePressed');
    await page.waitFor(`window.__ammo() <= ${beforeFire - 3}`, 5000);
    expect(await shownMethod(page)).toBe(MOUSE);
    // 左ボタンを押したまま、パッドのボタン（× / A）を押す（射撃のボタンではない）。
    await page.evaluate('window.__button(0, 1)');
    await waitShown(page, PAD, 1000);
    await page.evaluate('window.__button(0, 0)');
    await settle(page, 12);
    const stoppedAt = await ammo(page);
    // 左ボタンは押したまま 0.8 秒待つ（発射間隔は約 0.11 秒。撃ち続けていれば 7 発ほど減る）。
    await settle(page, 50);
    const later = await ammo(page);
    expect(stoppedAt).toBeGreaterThan(0);
    expect(later, '左ボタンを押したままでも射撃が止まる').toBe(stoppedAt);
    expect(await shownMethod(page)).toBe(PAD);
    await mouseButton(page, 'mouseReleased');
    await page.evaluate('document.exitPointerLock()');
    expect(exceptions(page), page.errors.join('\n')).toEqual([]);
  }, 60_000);

  // -------------------------------------------------------------------------
  describe('INP-14: 自動で、マウスで 1 発目を撃ち、パッドに切り替えて撃ち終えると、自己ベストはマウスの記録として比べて保存する', () => {
    const w = byId('r301');
    const mouseKey = bestKey('mouse', w.id, CENTER_MODE_ID);
    const padKey = bestKey('pad', w.id, CENTER_MODE_ID);
    const unbeatable = JSON.stringify({ version: 1, meanError: 0.0001, groupingRadius: 0.0001, hitRate: 100, shots: 28, achievedAt: '2026-01-01T00:00:00.000Z' });

    /** マウスで 1 発目を撃ってから、パッドに切り替えて R2 で撃ち切る。リザルト画面の文字を返す。 */
    async function mouseThenPad(page: Page): Promise<string> {
      await start(page, w);
      expect(await lock(page)).toBe(true);
      await mouseButton(page, 'mousePressed');
      await page.waitFor(`window.__ammo() <= ${w.magSize - 1}`, 5000);
      expect(await shownMethod(page)).toBe(MOUSE);
      // パッドのボタン（× / A）を押してパッドに切り替え、マウスの左ボタンを離す。
      await page.evaluate('window.__button(0, 1)');
      await waitShown(page, PAD, 1000);
      await page.evaluate('window.__button(0, 0)');
      await mouseButton(page, 'mouseReleased');
      const left = await ammo(page);
      expect(left, 'パッドに切り替えた時点ではまだ撃ち切っていない').toBeGreaterThan(0);
      expect(left).toBeLessThan(w.magSize);
      // パッドの R2 で撃ち切る。
      await page.evaluate('window.__button(7, 1)');
      await page.waitFor(`location.hash === '#/result' && !document.querySelector('[data-screen="result"]').hidden`, 20_000);
      await page.evaluate('window.__button(7, 0)');
      await settle(page, 19);
      return resultText(page);
    }

    it('自己ベストがないとき: マウスのキーに保存され、パッドのキーには何も保存されない', async () => {
      const page = await openFresh();
      const text = await mouseThenPad(page);
      expect(text).toContain(UPDATED);
      const stored = await storedBests(page);
      expect(Object.keys(stored)).toEqual([mouseKey]);
      const best = JSON.parse(stored[mouseKey]!) as { shots: number };
      expect(best.shots).toBe(w.magSize);
      expect(Object.keys(stored).some((k) => k.startsWith(`${BEST_PREFIX}pad:`))).toBe(false);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('パッドの自己ベストだけがあるとき: パッドの記録とは比べず、マウスの最初の記録として更新・保存し、パッドのキーは変わらない', async () => {
      const page = await openFresh({ [padKey]: unbeatable });
      const text = await mouseThenPad(page);
      // パッドの記録（平均ズレ 0.0001）と比べたなら更新にならない。マウスの記録はまだないので更新になる。
      expect(text).toContain(UPDATED);
      const stored = await storedBests(page);
      expect(Object.keys(stored).sort()).toEqual([mouseKey, padKey].sort());
      expect(stored[padKey]).toBe(unbeatable);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('マウスの自己ベストがあるとき: マウスの記録と比べて更新にならず、マウスのキーは変わらず、パッドのキーには何も保存されない', async () => {
      const page = await openFresh({ [mouseKey]: unbeatable });
      const text = await mouseThenPad(page);
      expect(text).not.toContain(UPDATED);
      const stored = await storedBests(page);
      expect(Object.keys(stored)).toEqual([mouseKey]);
      expect(stored[mouseKey]).toBe(unbeatable);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });
});
