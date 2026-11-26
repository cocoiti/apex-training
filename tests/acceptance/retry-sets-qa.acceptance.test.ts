// docs/spec/modes.md「やり直し」「連続練習（セット）」（MODE-16〜MODE-23）と
// docs/spec/screens.md「トップ画面」「画面の操作」「セットのまとめ」（UI-31〜UI-39）の受け入れテスト。
// 公開された入口（ビルドの結果を /apex-training/ で配信した画面、index.html の要素、武器の JSON、localStorage の自己ベストのキー）だけを使い、
// 実装の内部には依存しない。画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、パッドは Gamepad API（navigator.getGamepads）の形で与える。
// 射撃は、照準を細かく決めたい MODE-23・UI-34・UI-38 はマウス（ポインターロック + 左ボタン）、それ以外はパッドの R2 で行う。
// ポインターロック中の DevTools の mouseMoved は、座標の差がそのまま movementX / movementY（カウント）になる。
// 決まった平均ズレを作るため、リポジトリの写しに受け入れ用の武器（ブレ 0）を足してビルドした画面で確かめる。
// 弾痕は、HTML の画面を見えなくしたキャンバスの画面写しの差として読む（tests/helpers/png.ts）。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';
import { decodePng, type Image } from '../helpers/png';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const CX = 640;
const CY = 400;
const chromium = findChromium();
/**
 * ページの時計（clock=manual）を ms 進める。実時間では待たない。SPEC が時間で決めている振る舞い
 * （2 秒たってもリザルトに移らない、押し続けても繰り返さない、3 秒後に次の回）を確かめるときと、マウスの動きの間隔を空けるときに使う。
 */
const elapse = (page: Page, ms: number) => page.advanceClock(ms / 1000);

/** SPEC の値（実装の定数には依存しない）。 */
const INTERLUDE_SECONDS = 3;
const COMMENTS = ['下げすぎ', '下げ不足', '横の補正不足', 'よくまとまっている'];
const COUNT_CHOICES = [1, 5, 10, 20];
const DEG_PER_COUNT = (sensitivity: number) => sensitivity * 0.022;

interface WeaponJson {
  id: string;
  name: string;
  category: string;
  version: string;
  source: string;
  rpm: number;
  magSize: number;
  randomness: number;
  pattern: { dx: number; dy: number }[];
  measured?: boolean;
}
const WEAPONS: WeaponJson[] = readdirSync(join(ROOT, 'src/data/weapons'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(ROOT, 'src/data/weapons', f), 'utf8')) as WeaponJson);

const accWeapon = (id: string, name: string, pattern: { dx: number; dy: number }[]): WeaponJson => ({
  id,
  name,
  category: 'ACC',
  version: 'S31-Cipher',
  source: '仮データ（受け入れテスト）',
  rpm: 600,
  magSize: pattern.length,
  randomness: 0,
  pattern,
  measured: true,
});
const zeros = (n: number) => Array.from({ length: n }, () => ({ dx: 0, dy: 0 }));
const ZERO = accWeapon('acc-zero', '受け入れ-跳ねなし', zeros(6));
const LONG = accWeapon('acc-long', '受け入れ-長い弾倉', zeros(30));
// 1 発目で 2 度下がり、照準を動かさなければ全弾が中心より下に 2 度外れる（平均ズレ 2、「下げすぎ」）。
const LOW = accWeapon('acc-low', '受け入れ-下外れ', [{ dx: 0, dy: -2 }, ...zeros(5)]);
const EXTRA_WEAPONS = [ZERO, LONG, LOW];
const LSTAR = WEAPONS.find((w) => w.id === 'lstar')!;

// ---------------------------------------------------------------------------
// ページに入れるスクリプト
// ---------------------------------------------------------------------------

/** 標準配置のパッド 1 台（A はボタン 0、B はボタン 1、R2 はボタン 7）。 */
const FAKE_PAD = `
  window.__pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) };
  navigator.getGamepads = () => [{ id: 'acceptance pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard',
    timestamp: performance.now(), axes: window.__pad.axes.slice(), buttons: window.__pad.buttons.map((b) => ({ ...b })), vibrationActuator: null }];
  window.__btn = (i, on) => { window.__pad.buttons[i] = { value: on ? 1 : 0, pressed: on, touched: on }; };
`;

const PAGE_INIT = `
  window.__num = (sel) => { const m = (document.querySelector(sel)?.textContent ?? '').match(/-?\\d+(?:\\.\\d+)?/); return m ? Number(m[0]) : NaN; };
  window.__ammo = () => window.__num('[data-hud="ammo"]');
  window.__time = () => window.__num('[data-hud="time"]');
  window.__vis = (sel) => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    return !!el && !el.closest('[hidden]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0; };
  window.__round = () => { const el = document.querySelector('[data-hud="round"]'); return el && window.__vis(el) ? el.textContent.trim() : ''; };
  window.__interlude = () => window.__vis('#interlude');
  window.__screens = () => [...document.querySelectorAll('[data-screen]')].filter((s) => window.__vis(s)).map((s) => s.getAttribute('data-screen'));
  window.__hashes = [];
  addEventListener('hashchange', () => window.__hashes.push(location.hash));
`;

// ---------------------------------------------------------------------------
// 画面の操作
// ---------------------------------------------------------------------------

const KEYS = {
  r: { key: 'r', code: 'KeyR', vk: 82, text: 'r' },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  q: { key: 'q', code: 'KeyQ', vk: 81, text: 'q' },
} as const;

async function key(page: Page, name: keyof typeof KEYS) {
  const k = KEYS[name];
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, text: k.text });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
}

/** パッドのボタンを押して、パッドが何回か読まれるまで待ってから離す。 */
async function padTap(page: Page, button: 0 | 1) {
  await page.evaluate(`window.__btn(${button}, true)`);
  await page.frames(6);
  await page.evaluate(`window.__btn(${button}, false)`);
  await page.frames(3);
}

/** 選択肢の表示名（または表示の中の数）から値を選ぶ（キーボードで選んだときと同じく change を出す）。 */
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

const selectedText = (page: Page, selector: string) =>
  page.evaluate<string>(`(() => { const s = document.querySelector(${JSON.stringify(selector)}); return s.options[s.selectedIndex]?.textContent.trim() ?? ''; })()`);

const hash = (page: Page) => page.evaluate<string>('location.hash');
const ammo = (page: Page) => page.evaluate<number>('window.__ammo()');
const round = (page: Page) => page.evaluate<string>('window.__round()');
const screens = (page: Page) => page.evaluate<string[]>('window.__screens()');
const hudWeapon = (page: Page) => page.evaluate<string>(`document.querySelector('[data-hud="weapon"]')?.textContent ?? ''`);

/** トップ画面を開き、武器・モード・回数を選んで「開始」を押し、プレイ画面で練習が始まるまで待つ。 */
async function start(page: Page, weapon: WeaponJson, mode: string, count: number) {
  await page.evaluate(`location.hash = '#/'`);
  await page.waitFor(`window.__vis('[data-screen="top"]') && document.querySelector('#weapon').options.length > 0 && document.querySelector('#mode').options.length > 0 && document.querySelector('#count').options.length > 0`);
  await choose(page, '#weapon', weapon.name);
  await choose(page, '#mode', mode);
  await choose(page, '#count', count);
  await page.clickSelector('[data-screen="top"] a[href="#/play"]');
  await waitRoundStart(page, weapon, count > 1 ? 1 : 0, count);
}

/** 新しい回（または練習）が始まった状態（プレイ画面、短いリザルトなし、残弾が装弾数、回の表示）になるまで待つ。 */
async function waitRoundStart(page: Page, weapon: WeaponJson, n: number, count: number, timeout = 10_000) {
  const roundCheck = n > 0 ? `window.__round().includes('${n} / ${count}')` : 'true';
  await page.waitFor(
    `location.hash === '#/play' && window.__vis('[data-screen="play"]') && !window.__interlude() && window.__ammo() === ${weapon.magSize} && ${roundCheck}`,
    timeout,
  );
  await page.frames(2);
}

/** パッドの R2 を押し続けて撃ち切る（残弾が 0 になるか、プレイ画面の練習中でなくなったら離す）。 */
async function padFireAll(page: Page) {
  await page.evaluate('window.__btn(7, true)');
  await page.advanceClockUntil(`window.__ammo() === 0 || location.hash !== '#/play' || window.__interlude()`);
  await page.evaluate('window.__btn(7, false)');
  await page.frames(2);
}

/** パッドの R2 で n 発だけ撃つ（残弾が n 減ったら離す）。 */
async function padFire(page: Page, n: number) {
  await page.evaluate(`window.__goal = window.__ammo() - ${n}; window.__btn(7, true)`);
  await page.advanceClockUntil('window.__ammo() <= window.__goal');
  await page.evaluate('window.__btn(7, false)');
  await page.frames(2);
}

/** 1 回分を撃ち切り、短いリザルトが出るまで待つ。 */
async function padRoundToInterlude(page: Page) {
  await padFireAll(page);
  await page.waitFor('window.__interlude()', 5000);
}

/** マウスの位置を覚えておき、ポインターロック中の移動量（カウント）を決める。 */
class Mouse {
  x = CX;
  y = CY;
  constructor(private readonly page: Page) {}
  private button(type: 'mousePressed' | 'mouseReleased') {
    return this.page.send('Input.dispatchMouseEvent', { type, x: this.x, y: this.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
  /** ポインターロックしていなければ、キャンバスをクリックしてロックする。 */
  async lock() {
    if (await this.page.evaluate<boolean>('!!document.pointerLockElement')) return;
    await this.button('mousePressed');
    await this.button('mouseReleased');
    await this.page.waitFor('!!document.pointerLockElement', 5000);
    await this.page.frames(2);
  }
  /** 水平に dx カウント動かす（1 回 10 カウントまで）。 */
  async moveX(dx: number, buttons = 0) {
    const sign = Math.sign(dx);
    let left = Math.abs(dx);
    while (left > 0) {
      const step = Math.min(10, left);
      this.x += sign * step;
      left -= step;
      await this.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: this.x, y: this.y, buttons, button: buttons ? 'left' : 'none' });
    }
    await this.page.frames(2);
  }
  async moveY(dy: number, buttons = 1) {
    this.y += dy;
    await this.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: this.x, y: this.y, buttons, button: buttons ? 'left' : 'none' });
  }
  /** 左ボタンを押し続けて撃ち切る。during は押しているあいだに呼ぶ（ページの時計を進めながら）。 */
  async fireAll(during?: () => Promise<void>) {
    await this.button('mousePressed');
    if (during) await during();
    await this.page.advanceClockUntil(`window.__ammo() === 0 || location.hash !== '#/play' || window.__interlude()`);
    await this.button('mouseReleased');
  }
}

/** ボタン（リンク）を、利用者と同じくスクロールして見える所に出してからクリックする。 */
async function clickButton(page: Page, selector: string) {
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`);
  await page.frames(1);
  await page.clickSelector(selector);
}

/** HTML の画面を見えなくして、キャンバスだけを写す。 */
async function canvasShot(page: Page): Promise<Image> {
  await page.evaluate(`for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.visibility = 'hidden'`);
  await page.frames(2);
  const { data } = await page.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  await page.evaluate(`for (const el of document.body.children) el.style.visibility = ''`);
  return decodePng(Buffer.from(data, 'base64'));
}

/** 2 枚の画面写しで色が変わった画素の数（画面の中心の 200 ピクセル四方）。 */
function changedNearCenter(a: Image, b: Image, tol = 40): number {
  let n = 0;
  for (let y = CY - 100; y < CY + 100; y += 1) {
    for (let x = CX - 100; x < CX + 100; x += 1) {
      const p = a.pixel(x, y);
      const q = b.pixel(x, y);
      if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > tol) n += 1;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// 短いリザルトとセットのまとめの読み取り
// ---------------------------------------------------------------------------

const decimals = (s: string) => (s.match(/\d+\.\d+/g) ?? []).map(Number);
const numbers = (s: string) => (s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);

const interludeText = (page: Page) => page.evaluate<string>(`document.querySelector('#interlude')?.innerText ?? ''`);

interface SetState {
  hash: string;
  screens: string[];
  summary: string;
  rounds: string[];
  points: { x: number; y: number }[];
  average: string;
  best: string;
}
const setState = (page: Page) =>
  page.evaluate<SetState>(`(() => {
    const plot = document.querySelector('#set-plot');
    const points = [...(plot?.querySelectorAll('svg circle') ?? [])].filter((c) => window.__vis(c)).map((c) => {
      const p = new DOMPoint(c.cx.baseVal.value, c.cy.baseVal.value).matrixTransform(c.getScreenCTM()); return { x: p.x, y: p.y }; });
    return {
      hash: location.hash,
      screens: window.__screens(),
      summary: document.querySelector('#set-summary')?.innerText.trim() ?? '',
      rounds: [...document.querySelectorAll('#set-rounds li')].filter((li) => window.__vis(li)).map((li) => li.innerText.trim()),
      points,
      average: document.querySelector('#set-average')?.innerText.trim() ?? '',
      best: document.querySelector('#set-best')?.innerText.trim() ?? '',
    }; })()`);

/** セットのまとめが表示されるまで待って読む。 */
async function waitSetResult(page: Page): Promise<SetState> {
  await page.waitFor(`location.hash === '#/set-result' && window.__vis('[data-screen="set-result"]')`, 10_000);
  await page.frames(2);
  return setState(page);
}

/** 一覧の各回の平均ズレ（小数第 2 位までの数。「なし」は null）。 */
const roundValues = (s: SetState) =>
  s.rounds.map((r) => {
    if (r.includes('なし')) return null;
    const d = r.match(/\d+\.\d{2}/g);
    if (!d) throw new Error(`平均ズレがない: ${r}`);
    return Number(d.at(-1));
  });

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('すぐにやり直す操作と連続練習（セット）', () => {
  const temps: string[] = [];
  let dist = '';
  let build = { status: null as number | null, output: '' };
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));

  /**
   * 新しいタブで localStorage を空にし、読み込み直したトップ画面を開く。pad が true なら標準配置のパッドをつなぐ。
   * ページの時計はテストから進める（clock=manual）。弾痕の画面写しを撮るテスト（render: true）だけが 3D を描画する。
   */
  async function openFresh(opts: { pad?: boolean; render?: boolean } = {}): Promise<Page> {
    const page = await browser!.newPage();
    await page.goto(appUrl(origin, BASE, '#/', { render: opts.render ?? false, manualClock: true }));
    await page.evaluate('localStorage.clear()');
    await page.addInitScript(PAGE_INIT);
    if (opts.pad) await page.addInitScript(FAKE_PAD);
    await page.evaluate('window.__beforeReload = true');
    await page.send('Page.reload', { ignoreCache: false });
    // 武器とモードの欄は、武器のデータを読み込んだあとに埋まる（遅いマシンでは読み込み終わる前に欄を読まないよう待つ）。
    await page.waitFor(
      `!window.__beforeReload && document.readyState === 'complete' && window.__vis('[data-screen="top"]') && document.querySelector('#weapon').options.length > 0 && document.querySelector('#mode').options.length > 0`,
      15_000,
    );
    return page;
  }

  /** 設定画面で欄に値を打って Enter で確定する。 */
  async function setSetting(page: Page, id: string, text: string) {
    await page.evaluate(`location.hash = '#/settings'`);
    await page.waitFor(`window.__vis('[data-screen="settings"]')`);
    await page.clickSelector(`#${id}`);
    await page.evaluate(`document.getElementById(${JSON.stringify(id)}).select()`);
    await page.send('Input.insertText', { text });
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await page.waitFor(`document.getElementById(${JSON.stringify(id)}).value === ${JSON.stringify(text)}`);
    expect(await page.evaluate<string>(`document.getElementById(${JSON.stringify(id)}).value`)).toBe(text);
  }

  beforeAll(async () => {
    const work = mkdtempSync(join(tmpdir(), 'retry-sets-qa-'));
    temps.push(work);
    const copy = join(work, 'copy');
    for (const entry of ['src', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'eslint.config.js', 'scripts']) {
      if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
    }
    symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), 'dir');
    for (const w of EXTRA_WEAPONS) writeFileSync(join(copy, `src/data/weapons/${w.id}.json`), JSON.stringify(w, null, 2));
    dist = join(work, 'dist');
    const r = spawnSync(`npm run build -- --outDir "${dist}" --emptyOutDir`, {
      cwd: copy,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, APEX_ACCEPTANCE_NESTED: '1', FORCE_COLOR: '0' },
    });
    build = { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    if (r.status !== 0) throw new Error(`ビルドが失敗した:\n${build.output}`);
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
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it('受け入れ用の武器を足した写しのビルドが通る', () => {
    expect(build.status, build.output).toBe(0);
  });

  // -------------------------------------------------------------------------
  describe('トップ画面', () => {
    it('UI-31: トップ画面を開いたとき、回数の選択肢 1・5・10・20 が表示され、1 が選ばれている', async () => {
      const page = await openFresh();
      const options = await page.evaluate<string[]>(`[...document.querySelector('#count').options].map((o) => o.textContent.trim())`);
      expect(options.map((o) => Number((o.match(/\d+/) ?? [NaN])[0]))).toEqual(COUNT_CHOICES);
      expect(await page.evaluate<boolean>(`window.__vis('#count')`)).toBe(true);
      expect(numbers(await selectedText(page, '#count'))).toEqual([1]);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 30_000);

    it('UI-36: 終えたセットがない状態で #/set-result を直接開いたとき、トップ画面が表示される', async () => {
      const page = await openFresh();
      await page.goto(`${origin}${BASE}#/set-result`);
      await page.waitFor(`window.__screens().length > 0`);
      await page.frames(5);
      expect(await screens(page)).toEqual(['top']);
      // 再読み込みしたときも同じ。
      await page.send('Page.reload', { ignoreCache: false });
      await page.waitFor(`document.readyState === 'complete' && window.__screens().length > 0`);
      await page.frames(5);
      expect(await screens(page)).toEqual(['top']);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  describe('やり直し', () => {
    for (const via of ['キーボードの R', 'パッドの A'] as const) {
      it(`MODE-16: 練習中に 1 発以上撃ったあと、${via}を押すと、プレイ画面のまま同じ武器・モードで練習が始め直され、弾痕が消え、残弾が装弾数に、経過時間が 0.0 に戻る`, async () => {
        const page = await openFresh({ pad: true, render: true });
        await start(page, LONG, '反復練習', 1);
        const clean = await canvasShot(page);
        await padFire(page, 4);
        await elapse(page, 700);
        const fired = await ammo(page);
        expect(fired).toBeLessThan(LONG.magSize);
        expect(fired).toBeGreaterThan(0);
        const before = await page.evaluate<number>('window.__time()');
        expect(before).toBeGreaterThanOrEqual(0.5);
        const holes = await canvasShot(page);
        expect(changedNearCenter(clean, holes), '撃ったあとに弾痕が見えない').toBeGreaterThan(10);

        // 撃つのをやめてから 2 秒たつ前にやり直す。残弾が装弾数に戻った最初の描画の経過時間を、ページの中で読む。
        await page.evaluate(`(() => { window.__afterReset = undefined; const t0 = performance.now();
          const tick = () => { if (window.__ammo() === ${LONG.magSize}) { window.__afterReset = window.__time(); return; }
            if (performance.now() - t0 < 5000) requestAnimationFrame(tick); };
          requestAnimationFrame(tick); })()`);
        if (via === 'キーボードの R') await key(page, 'r');
        else await padTap(page, 0);
        await page.waitFor(`window.__afterReset !== undefined`, 3000);
        const after = await page.evaluate<number>('window.__afterReset');
        expect(after, `経過時間 ${before} → ${after}`).toBeLessThanOrEqual(0.1);
        expect(await hash(page)).toBe('#/play');
        expect(await hudWeapon(page)).toContain(LONG.name);
        const reset = await canvasShot(page);
        expect(changedNearCenter(clean, reset), 'やり直したあとも弾痕が残っている').toBeLessThanOrEqual(10);

        // 2 秒以上たってもリザルト画面に移らない（打ち切った回の結果は残らない）。
        await elapse(page, 2500);
        expect(await hash(page)).toBe('#/play');
        expect(await page.evaluate<string[]>('window.__hashes')).not.toContain('#/result');
        expect(await ammo(page)).toBe(LONG.magSize);

        // 撃ち切ると、同じ武器・同じモードのリザルトになる。
        await padFireAll(page);
        await page.waitFor(`location.hash === '#/result' && window.__vis('[data-screen="result"]')`, 10_000);
        const summary = await page.evaluate<string>(`document.querySelector('#result-summary')?.textContent ?? ''`);
        expect(summary).toContain(LONG.name);
        expect(summary).toContain('反復練習');
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 90_000);
    }
  });

  // -------------------------------------------------------------------------
  describe('連続練習（セット）', () => {
    it('MODE-17: 回数 5 で 1 回目を撃ち切ると、プレイ画面の上に 1 回目の平均ズレとコメントの短いリザルトが表示され、3 秒後に操作なしで 2 回目が始まり、HUD に「2 / 5」と表示される', async () => {
      const page = await openFresh({ pad: true });
      await start(page, LOW, '反復練習', 5);
      expect(await round(page)).toContain('1 / 5');
      await padFireAll(page);
      await page.waitFor('window.__interlude()', 5000);
      await page.frames(2);
      const text = await interludeText(page);
      const screensDuring = await screens(page);
      // プレイ画面の上に表示される（リザルト画面には移らない）。
      expect(screensDuring).toEqual(['play']);
      expect(await page.evaluate<string[]>('window.__hashes')).not.toContain('#/result');
      // 回の番号と回数、平均ズレ（2 度）、コメント（下げすぎ）、残り秒数。
      expect(text).toContain('1 / 5');
      expect(text).toContain('平均ズレ');
      expect(decimals(text).some((v) => Math.abs(v - 2) < 0.01), text).toBe(true);
      expect(COMMENTS.filter((c) => text.includes(c))).toEqual(['下げすぎ']);
      // 時計を進めない間は、実際の描画が進んでも次の回は始まらない。
      await page.frames(30);
      expect(await page.evaluate<boolean>('window.__interlude()')).toBe(true);
      // 3 秒たつ少し前はまだ短いリザルトで、3 秒たつと操作なしで 2 回目が始まる。
      await elapse(page, (INTERLUDE_SECONDS - 0.1) * 1000);
      await page.frames(2);
      expect(await page.evaluate<boolean>('window.__interlude()')).toBe(true);
      expect(await round(page)).toContain('1 / 5');
      await elapse(page, 150);
      await waitRoundStart(page, LOW, 2, 5, 3000);
      expect(await hash(page)).toBe('#/play');
      expect(await round(page)).toContain('2 / 5');
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('MODE-18: 回数 5 で 5 回とも撃ち切ると、5 回目のあとにセットのまとめが表示され、5 回分の平均ズレが並ぶ', async () => {
      const page = await openFresh({ pad: true });
      await start(page, LOW, '反復練習', 5);
      for (let n = 1; n <= 5; n += 1) {
        expect(await round(page)).toContain(`${n} / 5`);
        await padFireAll(page);
        if (n < 5) {
          await page.waitFor('window.__interlude()', 5000);
          // 操作しないまま、短いリザルトの 3 秒がたつ。
          await elapse(page, (INTERLUDE_SECONDS + 0.1) * 1000);
          await waitRoundStart(page, LOW, n + 1, 5, 8000);
        }
      }
      const s = await waitSetResult(page);
      expect(s.screens).toEqual(['set-result']);
      expect(s.rounds).toHaveLength(5);
      expect(roundValues(s)).toEqual([2, 2, 2, 2, 2]);
      expect(s.summary).toContain(LOW.name);
      expect(s.summary).toContain('反復練習');
      expect(s.summary).toMatch(/5\s*\/\s*5/);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 90_000);

    it('MODE-19: 短いリザルトの表示中にキーボードの R・Space、パッドの A を押すと、3 秒を待たずに次の回が始まる', async () => {
      const page = await openFresh({ pad: true });
      await start(page, ZERO, '反復練習', 5);
      const vias = [
        ['R', () => key(page, 'r')],
        ['Space', () => key(page, 'space')],
        ['パッドの A', () => padTap(page, 0)],
      ] as const;
      let n = 1;
      for (const [label, press] of vias) {
        await padRoundToInterlude(page);
        await page.frames(2);
        // ページの時計を止めたまま押す。3 秒たって始まったのではなく、押したことで次の回が始まる。
        const t0 = await page.evaluate<number>('window.__apexTestClock.now()');
        await press();
        await waitRoundStart(page, ZERO, n + 1, 5, 2500);
        const waited = (await page.evaluate<number>('window.__apexTestClock.now()')) - t0;
        expect(waited, `${label}: ${waited} 秒`).toBeLessThan(INTERLUDE_SECONDS - 1);
        n += 1;
      }
      expect(await round(page)).toContain('4 / 5');
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 90_000);

    it('MODE-20: 回数 5 で 2 回を終え、3 回目の練習中にキーボードの Q を押すと、終えた 2 回分だけが並ぶセットのまとめが表示される', async () => {
      const page = await openFresh({ pad: true });
      await start(page, LOW, '反復練習', 5);
      for (let n = 1; n <= 2; n += 1) {
        await padRoundToInterlude(page);
        await key(page, 'space');
        await waitRoundStart(page, LOW, n + 1, 5);
      }
      await padFire(page, 2);
      await key(page, 'q');
      const s = await waitSetResult(page);
      expect(s.screens).toEqual(['set-result']);
      expect(roundValues(s)).toEqual([2, 2]);
      expect(s.summary).toMatch(/2\s*\/\s*5/);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 90_000);

    it('MODE-20: 回数 5 で 2 回目のあとの短いリザルトの表示中にパッドの B を押すと、終えた 2 回分だけが並ぶセットのまとめが表示される', async () => {
      const page = await openFresh({ pad: true });
      await start(page, LOW, '反復練習', 5);
      await padRoundToInterlude(page);
      await key(page, 'space');
      await waitRoundStart(page, LOW, 2, 5);
      await padRoundToInterlude(page);
      await page.frames(2);
      await padTap(page, 1);
      const s = await waitSetResult(page);
      expect(roundValues(s)).toEqual([2, 2]);
      expect(s.summary).toMatch(/2\s*\/\s*5/);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 90_000);

    it('MODE-21: 回数 5 のセットの 1 回目の練習中にキーボードの Q を押すと、セットのまとめは表示されず、トップ画面に戻る', async () => {
      const page = await openFresh({ pad: true });
      await start(page, ZERO, '反復練習', 5);
      await padFire(page, 2);
      await key(page, 'q');
      await page.waitFor(`window.__vis('[data-screen="top"]')`, 5000);
      await page.frames(5);
      expect(['#/', '']).toContain(await hash(page));
      expect(await screens(page)).toEqual(['top']);
      expect(await page.evaluate<string[]>('window.__hashes')).not.toContain('#/set-result');
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('MODE-22: 回数 5 の 3 回目の練習中に R でやり直すと、回の表示は「3 / 5」のままで、撃ち切ると短いリザルトのあとに 4 回目が始まり、まとめに並ぶ回は 5 回のまま', async () => {
      const page = await openFresh({ pad: true });
      await start(page, LONG, '反復練習', 5);
      for (let n = 1; n <= 2; n += 1) {
        await padRoundToInterlude(page);
        await key(page, 'space');
        await waitRoundStart(page, LONG, n + 1, 5);
      }
      await padFire(page, 3);
      expect(await ammo(page)).toBeLessThan(LONG.magSize);
      expect(await ammo(page)).toBeGreaterThan(0);
      await key(page, 'r');
      await page.waitFor(`window.__ammo() === ${LONG.magSize}`, 3000);
      await page.frames(2);
      expect(await round(page)).toContain('3 / 5');
      expect(await page.evaluate<boolean>('window.__interlude()')).toBe(false);
      // やり直した 3 回目を撃ち切ると、短いリザルト（3 / 5）のあとに 4 回目が始まる。
      await padRoundToInterlude(page);
      expect(await interludeText(page)).toContain('3 / 5');
      await elapse(page, (INTERLUDE_SECONDS + 0.1) * 1000);
      await waitRoundStart(page, LONG, 4, 5, 8000);
      await padRoundToInterlude(page);
      await key(page, 'space');
      await waitRoundStart(page, LONG, 5, 5);
      await padFireAll(page);
      const s = await waitSetResult(page);
      expect(s.rounds).toHaveLength(5);
      expect(s.summary).toMatch(/5\s*\/\s*5/);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 120_000);

    /** 自己ベストがない状態から、マウスで L-STAR と反復練習の回数 count のセットを最後まで練習し、保存された自己ベストを確かめる。 */
    async function bestOfSet(count: number) {
      const page = await openFresh();
      const KEY = 'apex-training:best:mouse:lstar:ghost';
      expect(await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(KEY)})`)).toBeNull();
      await start(page, LSTAR, '反復練習', count);
      const mouse = new Mouse(page);
      // 回ごとに補正の量を変え、平均ズレが回で違うようにする（補正なし、手前に強く引く、少しだけ引く、…）。
      const pulls = [0, 8, 3, 5, 1];
      const shown: number[] = [];
      for (let n = 1; n <= count; n += 1) {
        await mouse.lock();
        expect(await ammo(page)).toBe(LSTAR.magSize);
        const pull = pulls[(n - 1) % pulls.length]!;
        await mouse.fireAll(
          pull
            ? async () => {
                for (let i = 0; i < 20; i += 1) {
                  await elapse(page, 90);
                  await mouse.moveY(pull);
                }
              }
            : undefined,
        );
        if (n < count) {
          await page.waitFor('window.__interlude()', 5000);
          await page.frames(2);
          const text = await page.evaluate<string>(`document.querySelector('#interlude-score')?.innerText ?? ''`);
          const v = decimals(text);
          expect(v.length, text).toBeGreaterThan(0);
          shown.push(v[0]!);
          await key(page, 'space');
          await waitRoundStart(page, LSTAR, n + 1, count, 8000);
        }
      }
      const s = await waitSetResult(page);
      const values = roundValues(s) as number[];
      expect(values).toHaveLength(count);
      // 短いリザルトの平均ズレとまとめの一覧が回の順に一致する。
      shown.forEach((v, i) => expect(values[i]).toBeCloseTo(v, 2));
      const raw = await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(KEY)})`);
      expect(raw, '自己ベストが保存されていない').not.toBeNull();
      const best = JSON.parse(raw!) as { meanError: number };
      const min = Math.min(...values);
      expect(Math.abs(best.meanError - min), `保存 ${best.meanError}、一覧 ${values.join(', ')}`).toBeLessThanOrEqual(0.0051);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }

    it('MODE-23: 自己ベストがない状態で、マウスで L-STAR と反復練習の回数 5 のセットを最後まで練習すると、5 回のうち平均ズレが最も小さい回の平均ズレが自己ベストに保存される', async () => {
      await bestOfSet(5);
    }, 150_000);
  });

  // -------------------------------------------------------------------------
  describe('リザルト画面の操作', () => {
    it('UI-32: 回数 1 で練習を終えたリザルト画面で、キーボードの R・Space、パッドの A を押すと、同じ武器・同じモードで新しい練習が始まり、前の練習の弾痕は消えている', async () => {
      const page = await openFresh({ pad: true, render: true });
      await start(page, ZERO, '反復練習', 1);
      const clean = await canvasShot(page);
      const vias = [
        ['R', () => key(page, 'r')],
        ['Space', () => key(page, 'space')],
        ['パッドの A', () => padTap(page, 0)],
      ] as const;
      for (const [label, press] of vias) {
        await padFireAll(page);
        await page.waitFor(`location.hash === '#/result' && window.__vis('[data-screen="result"]')`, 10_000);
        await page.frames(5);
        const summary = await page.evaluate<string>(`document.querySelector('#result-summary')?.textContent ?? ''`);
        expect(summary, label).toContain(ZERO.name);
        expect(summary, label).toContain('反復練習');
        await press();
        await waitRoundStart(page, ZERO, 0, 1, 5000);
        expect(await screens(page), label).toEqual(['play']);
        expect(await hudWeapon(page), label).toContain(ZERO.name);
        const shot = await canvasShot(page);
        expect(changedNearCenter(clean, shot), `${label}: 前の練習の弾痕が残っている`).toBeLessThanOrEqual(10);
      }
      // 最後に始まった練習も、撃ち切ると同じ武器・同じモードのリザルトになる。
      await padFireAll(page);
      await page.waitFor(`location.hash === '#/result'`, 10_000);
      const summary = await page.evaluate<string>(`document.querySelector('#result-summary')?.textContent ?? ''`);
      expect(summary).toContain(ZERO.name);
      expect(summary).toContain('反復練習');
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 120_000);

    it('UI-33: リザルト画面でパッドの B を押すと、トップ画面に戻る', async () => {
      const page = await openFresh({ pad: true });
      await start(page, ZERO, '反復練習', 1);
      await padFireAll(page);
      await page.waitFor(`location.hash === '#/result' && window.__vis('[data-screen="result"]')`, 10_000);
      await page.frames(5);
      await padTap(page, 1);
      await page.waitFor(`window.__vis('[data-screen="top"]')`, 5000);
      await page.frames(2);
      expect(['#/', '']).toContain(await hash(page));
      expect(await screens(page)).toEqual(['top']);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('UI-37: リザルト画面でパッドの A を押して新しい練習が始まったあと、押し続けてもやり直されず、一度離して押し直すとやり直される', async () => {
      const page = await openFresh({ pad: true });
      await start(page, LONG, '反復練習', 1);
      await padFireAll(page);
      await page.waitFor(`location.hash === '#/result' && window.__vis('[data-screen="result"]')`, 15_000);
      await page.frames(5);
      // A を押したまま。
      await page.evaluate('window.__btn(0, true)');
      await waitRoundStart(page, LONG, 0, 1, 5000);
      await padFire(page, 3);
      await page.frames(2);
      const fired = await ammo(page);
      expect(fired).toBeLessThan(LONG.magSize);
      await elapse(page, 800);
      expect(await ammo(page), 'A を押し続けているあいだにやり直された').toBe(fired);
      expect(await hash(page)).toBe('#/play');
      // 離して押し直すとやり直される。
      await page.evaluate('window.__btn(0, false)');
      await page.frames(6);
      await page.evaluate('window.__btn(0, true)');
      await page.waitFor(`window.__ammo() === ${LONG.magSize}`, 3000);
      await page.evaluate('window.__btn(0, false)');
      expect(await hash(page)).toBe('#/play');
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('UI-38: 入力方式を「マウス」に固定しているときも、リザルト画面でパッドの A を押すと新しい練習が始まる', async () => {
      const page = await openFresh({ pad: true });
      await page.evaluate(`location.hash = '#/settings'`);
      await page.waitFor(`window.__vis('[data-screen="settings"]')`);
      await page.evaluate(`(() => { const s = document.querySelector('#setting-input-method'); s.value = 'mouse';
        s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await page.frames(2);
      await start(page, ZERO, '反復練習', 1);
      const mouse = new Mouse(page);
      await mouse.lock();
      await mouse.fireAll();
      await page.waitFor(`location.hash === '#/result' && window.__vis('[data-screen="result"]')`, 10_000);
      await page.evaluate('document.exitPointerLock()');
      await page.frames(5);
      await padTap(page, 0);
      await waitRoundStart(page, ZERO, 0, 1, 5000);
      expect(await screens(page)).toEqual(['play']);
      expect(await hudWeapon(page)).toContain(ZERO.name);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('UI-39: リザルト画面で武器変更を選んでトップ画面に戻ったとき、直前の練習の武器・モード・回数が選ばれている', async () => {
      const page = await openFresh({ pad: true });
      // 開いたときに選ばれているのと違う武器（一覧の最初でないもの）を選ぶ。モードは反復練習だけ。
      const initialWeapon = await selectedText(page, '#weapon');
      const weapon = WEAPONS.find((w) => w.measured !== false && w.name !== initialWeapon)!;
      expect(weapon, '一覧の最初でない武器がない').toBeDefined();
      const MODE = '反復練習';
      expect(await selectedText(page, '#mode')).toBe(MODE);
      for (const [label, back] of [
        ['「武器変更」のボタン', () => clickButton(page, '#change-weapon')],
        ['パッドの B', () => padTap(page, 1)],
      ] as const) {
        await start(page, weapon, MODE, 1);
        await padFireAll(page);
        await page.waitFor(`location.hash === '#/result' && window.__vis('[data-screen="result"]')`, 10_000);
        await page.frames(5);
        await back();
        await page.waitFor(`window.__vis('[data-screen="top"]')`, 5000).catch(async (e: Error) => {
          throw new Error(`${label}: ${e.message}（${await hash(page)}、${(await screens(page)).join(', ')}）`);
        });
        await page.frames(2);
        expect(await selectedText(page, '#weapon'), label).toBe(weapon.name);
        expect(await selectedText(page, '#mode'), label).toBe(MODE);
        expect(numbers(await selectedText(page, '#count')), label).toEqual([1]);
      }
      // セットのまとめから戻ったときも、回数を含めて選ばれたまま（screens.md「トップ画面」）。
      await start(page, weapon, MODE, 5);
      await padFire(page, 1);
      await padFireAll(page);
      await page.waitFor('window.__interlude()', 5000);
      await key(page, 'q');
      await waitSetResult(page);
      await clickButton(page, '#set-change-weapon');
      await page.waitFor(`window.__vis('[data-screen="top"]')`, 5000);
      await page.frames(2);
      expect(await selectedText(page, '#weapon')).toBe(weapon.name);
      expect(await selectedText(page, '#mode')).toBe(MODE);
      expect(numbers(await selectedText(page, '#count'))).toEqual([5]);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  describe('セットのまとめ', () => {
    it('UI-34: 各回の平均ズレが 1.0・0.8・1.2・0.6・0.9 度のとき、5 回分が回の順に並び、推移の図に 5 つの点、セットの平均 0.90 度、いちばん良かった回が 4 回目（0.60 度）と表示される', async () => {
      const page = await openFresh();
      // 感度 0.2 では 1 カウントが 0.0044 度。ブレもパターンもない武器で、照準を水平にずらしてから撃てば、平均ズレはずらした角度になる。
      const SENS = 0.2;
      await setSetting(page, 'setting-sensitivity', String(SENS));
      const targets = [1.0, 0.8, 1.2, 0.6, 0.9];
      await start(page, ZERO, '反復練習', 5);
      const mouse = new Mouse(page);
      for (let n = 1; n <= 5; n += 1) {
        await mouse.lock();
        expect(await ammo(page), `${n} 回目`).toBe(ZERO.magSize);
        const counts = Math.round(targets[n - 1]! / DEG_PER_COUNT(SENS));
        // 画面の外に出ないよう、回ごとに右と左に交互にずらす（平均ズレは向きによらない）。
        await mouse.moveX(n % 2 === 1 ? counts : -counts);
        await page.frames(2);
        await mouse.fireAll();
        if (n < 5) {
          await page.waitFor('window.__interlude()', 5000);
          await page.frames(2);
          await key(page, 'space');
          await waitRoundStart(page, ZERO, n + 1, 5, 5000);
        }
      }
      const s = await waitSetResult(page);
      expect(roundValues(s)).toEqual([1.0, 0.8, 1.2, 0.6, 0.9]);
      // 推移の図: 5 つの点が回の順に左から右へ並び、平均ズレが大きい回ほど上に描かれる。
      expect(s.points).toHaveLength(5);
      const byX = [...s.points].sort((a, b) => a.x - b.x);
      for (let i = 0; i < 5; i += 1) {
        for (let j = 0; j < 5; j += 1) {
          if (targets[i]! > targets[j]!) expect(byX[i]!.y, `${i + 1} 回目と ${j + 1} 回目`).toBeLessThan(byX[j]!.y);
        }
      }
      expect(decimals(s.average)).toContain(0.9);
      expect(s.average).toContain('0.90');
      expect(s.best).toContain('0.60');
      expect(numbers(s.best.replace('0.60', ''))).toContain(4);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 120_000);

    for (const via of ['キーボードの R', 'パッドの A'] as const) {
      it(`UI-35: セットのまとめで${via}を押すと、同じ武器・モード・回数の新しいセットが 1 回目から始まり、HUD に「1 / 5」と表示される`, async () => {
        const page = await openFresh({ pad: true });
        await start(page, LOW, '反復練習', 5);
        for (let n = 1; n <= 5; n += 1) {
          await padFireAll(page);
          if (n < 5) {
            await page.waitFor('window.__interlude()', 5000);
            await key(page, 'space');
            await waitRoundStart(page, LOW, n + 1, 5);
          }
        }
        await waitSetResult(page);
        if (via === 'キーボードの R') await key(page, 'r');
        else await padTap(page, 0);
        await waitRoundStart(page, LOW, 1, 5, 5000);
        expect(await screens(page)).toEqual(['play']);
        expect(await round(page)).toContain('1 / 5');
        expect(await hudWeapon(page)).toContain(LOW.name);
        // 同じモード・回数: 1 回目を撃ち切ると、採点された短いリザルト（1 / 5）が出て、2 回目（2 / 5）に進む。
        await padRoundToInterlude(page);
        const text = await interludeText(page);
        expect(text).toContain('1 / 5');
        expect(text).not.toContain('採点なし');
        await key(page, 'space');
        await waitRoundStart(page, LOW, 2, 5);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 120_000);
    }
  });
});
