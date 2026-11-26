// docs/spec/screens.md「結果のシェア」（UI-87〜UI-95）と docs/spec/overview.md「練習の範囲」（OVR-5・OVR-20）の QA の受け入れテスト。
// 公開された入口（ビルドの結果を /apex-training/ で配信した画面、index.html の要素、武器の JSON、SPEC の localStorage のキー）だけを使い、
// 実装の内部には依存しない。画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、3D は描画せず（render=off）、
// ページの時計はテストから進める（clock=manual）。
//
// ブラウザのシェアの機能とクリップボードは、ページのスクリプトより先に差し替える（navigator.share・navigator.clipboard.writeText）。
// 差し替えた関数は呼ばれた引数を記録し、テストはそれを読む（ほんとうのシェアの画面やシステムのクリップボードには触れない）。
//
// 決まった平均ズレと命中率を作るため、リポジトリの写しの L-STAR をブレ 0 の 25 発のパターンに差し替え、受け入れ用の武器（ブレ 0）を足してビルドする。
// 差し替えた L-STAR は照準を動かさなければ、18 発が中心から 0.5 度、7 発が 1.75 度に当たる（平均ズレ 0.85 度、的の半径が 0.5〜1.75 度なら命中率 72%）。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const CX = 640;
const CY = 400;
const chromium = findChromium();

/** SPEC の文言と値（実装の定数には依存しない）。 */
const MODE = '反復練習';
const PUBLIC_URL = 'https://cocoiti.github.io/apex-training/';
const COPIED = 'コピーしました';
const COPY_FAILED = 'コピーできませんでした。下の文を選んでコピーしてください。';
const BEST_LINE = '自己ベスト更新！';
const POST_PREFIX = 'https://x.com/intent/post?text=';
const BEST_PREFIX = 'apex-training:best:';
const HISTORY_PREFIX = 'apex-training:history:';
const DEG_PER_COUNT = (sensitivity: number) => sensitivity * 0.022;

/** 標準配置のボタンの番号（pad.md・screens.md）。 */
const A = 0;
const B = 1;
const Y = 3;
const R2 = 7;
const DOWN = 13;
const LEFT = 14;
const RIGHT = 15;

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
const zeros = (n: number) => Array.from({ length: n }, () => ({ dx: 0, dy: 0 }));
const accWeapon = (id: string, name: string, category: string, pattern: { dx: number; dy: number }[]): WeaponJson => ({
  id,
  name,
  category,
  version: 'S31-Cipher',
  source: '仮データ（受け入れテスト）',
  rpm: 600,
  magSize: pattern.length,
  randomness: 0,
  pattern,
  measured: true,
});
/** 写しの L-STAR: 1〜18 発目は上に 0.5 度、19〜25 発目は上に 1.75 度。 */
const LSTAR = accWeapon('lstar', 'L-STAR', 'LMG', [{ dx: 0, dy: 0.5 }, ...zeros(17), { dx: 0, dy: 1.25 }, ...zeros(6)]);
/** 跳ねもブレもない。照準をずらしてから撃てば、平均ズレはずらした角度になる。 */
const ZERO = accWeapon('acc-zero', '受け入れ-跳ねなし', 'ACC', zeros(6));
/** 1 発目で 2 度下がり、全弾が中心より下に 2 度外れる。 */
const LOW = accWeapon('acc-low', '受け入れ-下外れ', 'ACC', [{ dx: 0, dy: -2 }, ...zeros(5)]);

/** SPEC の「シェアの文」（リザルト画面）。 */
const resultText = (weapon: string, mean: string, hit: string, best: boolean) =>
  [`リコイル練習（非公式ファンツール）の結果`, `武器: ${weapon} / モード: ${MODE}`, `平均ズレ: ${mean} / 命中率: ${hit}`, ...(best ? [BEST_LINE] : []), PUBLIC_URL].join('\n');
/** SPEC の「シェアの文」（セットのまとめ）。 */
const setText = (weapon: string, done: number, count: number, average: string, best: boolean) =>
  [
    `リコイル練習（非公式ファンツール）のセットの結果`,
    `武器: ${weapon} / モード: ${MODE}`,
    `回数: ${done} / ${count} 回 / セットの平均ズレ: ${average}`,
    ...(best ? [BEST_LINE] : []),
    PUBLIC_URL,
  ].join('\n');

/** SPEC の文の例（L-STAR を反復練習で 1 回、平均ズレ 0.85 度・命中率 72%、自己ベストを更新）。 */
const SPEC_EXAMPLE = [
  'リコイル練習（非公式ファンツール）の結果',
  '武器: L-STAR / モード: 反復練習',
  '平均ズレ: 0.85° / 命中率: 72.0%',
  '自己ベスト更新！',
  'https://cocoiti.github.io/apex-training/',
].join('\n');

// ---------------------------------------------------------------------------
// ページに入れるスクリプト
// ---------------------------------------------------------------------------

type ShareEnv = 'ok' | 'none' | 'notallowed' | 'abort';
type ClipEnv = 'ok' | 'fail';

/** シェアの機能とクリップボードを差し替える。呼ばれた引数は __shareCalls・__clip に記録する。 */
const envScript = (share: ShareEnv, clip: ClipEnv) => `
(() => {
  window.__shareCalls = [];
  window.__clip = [];
  window.__clipAttempts = 0;
  const shareMode = ${JSON.stringify(share)};
  if (shareMode === 'none') {
    delete Navigator.prototype.share;
    delete Navigator.prototype.canShare;
    delete navigator.share;
  } else {
    const share = function (data) {
      const keys = data && typeof data === 'object' ? Object.keys(data) : [];
      window.__shareCalls.push({ argc: arguments.length, keys, text: data?.text, hasFiles: !!data && 'files' in data });
      let result = Promise.resolve();
      if (shareMode === 'notallowed') result = Promise.reject(new DOMException('not allowed', 'NotAllowedError'));
      if (shareMode === 'abort') result = Promise.reject(new DOMException('aborted', 'AbortError'));
      // 返した Promise が決まったこと（失敗の知らせを渡し終えたこと）をテストが待てるようにする。
      window.__shareSettled = result.then(() => undefined, () => undefined);
      return result;
    };
    Object.defineProperty(Navigator.prototype, 'share', { value: share, configurable: true, writable: true });
    Object.defineProperty(Navigator.prototype, 'canShare', { value: () => true, configurable: true, writable: true });
  }
  const clipMode = ${JSON.stringify(clip)};
  const clipboard = {
    writeText: (t) => { window.__clipAttempts += 1;
      if (clipMode === 'fail') return Promise.reject(new DOMException('denied', 'NotAllowedError'));
      window.__clip.push(String(t)); return Promise.resolve(); },
    write: () => { window.__clipAttempts += 1; return Promise.reject(new DOMException('denied', 'NotAllowedError')); },
    readText: () => Promise.resolve(window.__clip.at(-1) ?? ''),
  };
  Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => clipboard, configurable: true });
  if (clipMode === 'fail') {
    // クリップボードへの書き込みが失敗する環境では、古い方法（execCommand('copy')）も失敗する。
    document.execCommand = () => { window.__clipAttempts += 1; return false; };
  } else {
    const original = document.execCommand.bind(document);
    document.execCommand = (cmd, ...rest) => {
      if (String(cmd).toLowerCase() === 'copy') { window.__clipAttempts += 1; window.__clip.push(String(getSelection() ?? '')); return true; }
      return original(cmd, ...rest);
    };
  }
})();
`;

/** 標準配置のパッド 1 台。__btn(番号, 押す) で操作する。 */
const FAKE_PAD = `
  window.__pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) };
  navigator.getGamepads = () => [{ id: 'acceptance pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard',
    timestamp: performance.now(), axes: window.__pad.axes.slice(), buttons: window.__pad.buttons.map((b) => ({ ...b })), vibrationActuator: null }];
  window.__btn = (i, on) => { window.__pad.buttons[i] = { value: on ? 1 : 0, pressed: on, touched: on }; };
`;

const PAGE_INIT = `
  window.__num = (sel) => { const m = (document.querySelector(sel)?.textContent ?? '').match(/-?\\d+(?:\\.\\d+)?/); return m ? Number(m[0]) : NaN; };
  window.__ammo = () => window.__num('[data-hud="ammo"]');
  window.__vis = (sel) => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    return !!el && !el.closest('[hidden]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0; };
  window.__interlude = () => window.__vis('#interlude');
  window.__screens = () => [...document.querySelectorAll('[data-screen]')].filter((s) => window.__vis(s)).map((s) => s.getAttribute('data-screen'));
  window.__focused = () => { const els = [...document.querySelectorAll('.pad-focus')]; return els.length === 1 ? (els[0].id || els[0].textContent.trim()) : ''; };
  window.__hashes = [];
  addEventListener('hashchange', () => window.__hashes.push(location.hash));
`;

// ---------------------------------------------------------------------------
// 画面の操作と読み取り
// ---------------------------------------------------------------------------

type ScreenName = 'result' | 'set-result';

/** 画面の見えている「結果をシェア」のボタン（表示名で探す）。 */
const shareButtonExpr = (screen: ScreenName) =>
  `[...document.querySelectorAll('[data-screen="${screen}"] button')].find((b) => b.textContent.trim() === '結果をシェア' && window.__vis(b))`;
/** 画面の見えている「X に投稿」のリンク。 */
const postLinkExpr = (screen: ScreenName) =>
  `[...document.querySelectorAll('[data-screen="${screen}"] a')].find((a) => a.textContent.trim() === 'X に投稿' && window.__vis(a))`;

/** 「結果をシェア」を、利用者と同じくスクロールして見える所に出してからクリックする（ほかの要素に隠れていないことも確かめる）。 */
async function clickShare(page: Page, screen: ScreenName) {
  const box = await page.evaluate<{ x: number; y: number; hit: boolean } | null>(`(() => {
    const el = ${shareButtonExpr(screen)};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, hit: !!top && (top === el || el.contains(top)) }; })()`);
  if (!box) throw new Error(`${screen} に「結果をシェア」のボタンが見えない`);
  expect(box.hit, '「結果をシェア」がクリックできる位置にない').toBe(true);
  await page.click(box.x, box.y);
}

interface ShareCall {
  argc: number;
  keys: string[];
  text: unknown;
  hasFiles: boolean;
}
const shareCalls = (page: Page) => page.evaluate<ShareCall[]>('window.__shareCalls');
const clip = (page: Page) => page.evaluate<string[]>('window.__clip');

/**
 * 画面のシェアの近くに見えている文（メッセージと読み取り専用の欄を含む、シェアのボタン・リンクを含む区画の見えている文字）。
 * 区画は「結果をシェア」のボタンの親をたどり、「X に投稿」のリンクも含む最も内側の要素とする。
 */
const shareAreaExpr = (screen: ScreenName) => `(() => {
  const btn = ${shareButtonExpr(screen)}; const link = ${postLinkExpr(screen)};
  let el = btn; while (el && !(el.contains(link) && el.parentElement)) el = el.parentElement;
  while (el && el.parentElement && el.parentElement.getAttribute('data-screen') === null && !el.querySelector('p, [role="status"], textarea')) el = el.parentElement;
  return el; })()`;
const shareMessage = (page: Page, screen: ScreenName) =>
  page.evaluate<string>(`(() => {
    const scope = document.querySelector('[data-screen="${screen}"]');
    return [...scope.querySelectorAll('p, [role="status"], output, span, div')].filter((e) => window.__vis(e) && e.children.length === 0)
      .map((e) => e.textContent.trim()).filter((t) => t === ${JSON.stringify(COPIED)} || t === ${JSON.stringify(COPY_FAILED)} || t.includes('コピー')).join('|'); })()`);
/** 画面の見えている読み取り専用の欄（textarea・input）の値。 */
const readonlyFields = (page: Page, screen: ScreenName) =>
  page.evaluate<{ value: string; readOnly: boolean }[]>(`[...document.querySelectorAll('[data-screen="${screen}"] textarea, [data-screen="${screen}"] input')]
    .filter((e) => window.__vis(e)).map((e) => ({ value: e.value, readOnly: e.readOnly }))`);

/** 選択肢の表示名（または表示の中の数）から値を選ぶ（キーボードで選んだときと同じく change を出す）。欄がなければ何もしない。 */
async function choose(page: Page, selector: string, label: string | number) {
  const ok = await page.evaluate<boolean | null>(`(() => {
    const s = document.querySelector(${JSON.stringify(selector)});
    if (!s) return null;
    const want = ${JSON.stringify(label)};
    const o = [...s.options].find((x) => typeof want === 'number'
      ? Number((x.textContent.match(/\\d+/) ?? [NaN])[0]) === want
      : x.textContent.trim() === want);
    if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  if (ok === false) throw new Error(`${selector} に ${label} の選択肢がない`);
}

/** トップ画面を開き、武器・回数を選んで（モードの欄があれば反復練習を選んで）「開始」をクリックし、練習が始まるまで待つ。 */
async function start(page: Page, weapon: WeaponJson, count: number) {
  await page.evaluate(`location.hash = '#/'`);
  await page.waitFor(`window.__vis('[data-screen="top"]') && document.querySelector('#weapon').options.length > 0 && document.querySelector('#count').options.length > 0`);
  await choose(page, '#weapon', weapon.name);
  await choose(page, '#mode', MODE);
  await choose(page, '#count', count);
  await page.clickSelector('[data-screen="top"] a[href="#/play"]');
  await waitRoundStart(page, weapon);
}

async function waitRoundStart(page: Page, weapon: WeaponJson, timeout = 10_000) {
  await page.waitFor(
    `location.hash === '#/play' && window.__vis('[data-screen="play"]') && !window.__interlude() && window.__ammo() === ${weapon.magSize}`,
    timeout,
  );
  await page.frames(2);
}

/** マウスの位置を覚えておき、ポインターロック中の移動量（カウント）を決める。 */
class Mouse {
  x = CX;
  y = CY;
  constructor(private readonly page: Page) {}
  private button(type: 'mousePressed' | 'mouseReleased') {
    return this.page.send('Input.dispatchMouseEvent', { type, x: this.x, y: this.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
  async lock() {
    if (await this.page.evaluate<boolean>('!!document.pointerLockElement')) return;
    await this.page.frames(5);
    await this.button('mousePressed');
    await this.button('mouseReleased');
    await this.page.waitFor('!!document.pointerLockElement', 5000);
    await this.page.frames(2);
  }
  /** 水平に dx カウント動かす（1 回 10 カウントまで）。 */
  async moveX(dx: number) {
    const sign = Math.sign(dx);
    let left = Math.abs(dx);
    while (left > 0) {
      const step = Math.min(10, left);
      this.x += sign * step;
      left -= step;
      await this.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: this.x, y: this.y, buttons: 0, button: 'none' });
    }
    await this.page.frames(2);
  }
  /** 左ボタンを押し続けて撃ち切る（残弾が 0 か、短いリザルトか、プレイ画面でなくなるまで）。 */
  async fireAll() {
    await this.button('mousePressed');
    await this.page.advanceClockUntil(`window.__ammo() === 0 || location.hash !== '#/play' || window.__interlude()`);
    await this.button('mouseReleased');
  }
}

const KEYS = {
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  q: { key: 'q', code: 'KeyQ', vk: 81, text: 'q' },
} as const;
async function key(page: Page, name: keyof typeof KEYS) {
  const k = KEYS[name];
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, text: k.text });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
}

/** マウスで 1 回練習し（照準を動かさずに撃ち切る）、リザルト画面が表示されるまで待つ。 */
async function practiceOnce(page: Page, weapon: WeaponJson) {
  await start(page, weapon, 1);
  const mouse = new Mouse(page);
  await mouse.lock();
  await mouse.fireAll();
  await page.advanceClockUntil(`location.hash === '#/result'`, { step: 1 / 60 });
  await page.evaluate('document.exitPointerLock()');
  await page.waitFor(`window.__vis('[data-screen="result"]') && !document.pointerLockElement`);
  await page.frames(2);
}

/** リザルト画面の指標（見えている dt / dd の組）。 */
const metrics = (page: Page) =>
  page.evaluate<Record<string, string>>(`(() => { const out = {}; for (const dt of document.querySelectorAll('[data-screen="result"] dt')) {
    if (!window.__vis(dt)) continue; const dd = dt.nextElementSibling; if (dd && dd.tagName === 'DD') out[dt.textContent.trim()] = dd.textContent.trim(); } return out; })()`);
const metric = (m: Record<string, string>, label: string) => {
  const k = Object.keys(m).find((x) => x.includes(label));
  if (!k) throw new Error(`指標 ${label} がない: ${JSON.stringify(m)}`);
  return m[k]!;
};

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
}

/** セットのまとめが表示されるまで待つ。 */
async function waitSetResult(page: Page) {
  await page.waitFor(`location.hash === '#/set-result' && window.__vis('[data-screen="set-result"]')`, 10_000);
  await page.frames(2);
}

/**
 * 感度 0.2 で、ZERO の回数 5 のセットを、各回の平均ズレが targets（度）になるよう照準を水平にずらして撃ち、
 * 最後の回の短いリザルトで Q を押してやめ、セットのまとめを表示する。
 */
async function setStoppedAfter(page: Page, targets: number[]) {
  const SENS = 0.2;
  await setSetting(page, 'setting-sensitivity', String(SENS));
  await start(page, ZERO, 5);
  const mouse = new Mouse(page);
  for (let n = 1; n <= targets.length; n += 1) {
    await mouse.lock();
    const counts = Math.round(targets[n - 1]! / DEG_PER_COUNT(SENS));
    await mouse.moveX(n % 2 === 1 ? counts : -counts);
    await mouse.fireAll();
    await page.waitFor('window.__interlude()', 5000);
    await page.frames(2);
    if (n < targets.length) {
      await key(page, 'space');
      await waitRoundStart(page, ZERO, 5000);
    }
  }
  await key(page, 'q');
  await page.evaluate('document.exitPointerLock()');
  await waitSetResult(page);
}

/** 画面の、シェアの区画を除いた見えている文字と図（svg）。押す前と押したあとを比べる。 */
const screenSnapshot = (page: Page, screen: ScreenName) =>
  page.evaluate<{ hash: string; text: string; svgs: string[]; screens: string[] }>(`(() => {
    const scope = document.querySelector('[data-screen="${screen}"]');
    const area = ${shareAreaExpr(screen)};
    const clone = scope.cloneNode(true);
    const mark = (root) => [...root.querySelectorAll('*')];
    // シェアの区画（メッセージ・欄を含む）を除く。clone では同じ位置の要素を消す。
    const all = mark(scope); const idx = area ? all.indexOf(area) : -1;
    if (idx >= 0) mark(clone)[idx].remove();
    document.body.appendChild(clone); clone.hidden = false; clone.style.position = 'absolute'; clone.style.left = '-99999px';
    const text = clone.innerText; clone.remove();
    return { hash: location.hash, text, svgs: [...scope.querySelectorAll('svg')].map((s) => s.outerHTML), screens: window.__screens() }; })()`);
const storage = (page: Page) =>
  page.evaluate<Record<string, string>>(`(() => { const out = {}; for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i);
    if (k.startsWith(${JSON.stringify(BEST_PREFIX)}) || k.startsWith(${JSON.stringify(HISTORY_PREFIX)})) out[k] = localStorage.getItem(k); } return out; })()`);

// パッドの操作 ------------------------------------------------------------

const btn = (page: Page, b: number, on: boolean) => page.evaluate(`window.__btn(${b}, ${on})`);
async function tap(page: Page, b: number) {
  await btn(page, b, true);
  await page.frames(3);
  await btn(page, b, false);
  await page.frames(3);
}
async function focusDownTo(page: Page, target: string, limit = 40) {
  const seen: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    await tap(page, DOWN);
    const f = await page.evaluate<string>('window.__focused()');
    seen.push(f);
    if (f === target) return;
  }
  throw new Error(`十字キーの下で ${target} にフォーカスが来ない。移った順: ${seen.join(' → ')}`);
}
async function chooseByPad(page: Page, selector: string, match: string) {
  const target = await page.evaluate<number>(`(() => { const want = ${match}; return [...document.querySelector(${JSON.stringify(selector)}).options].findIndex((o) => want(o.textContent.trim())); })()`);
  if (target < 0) throw new Error(`${selector} に選択肢がない`);
  for (let i = 0; i < 30; i += 1) {
    const now = await page.evaluate<number>(`document.querySelector(${JSON.stringify(selector)}).selectedIndex`);
    if (now === target) return;
    await tap(page, now < target ? RIGHT : LEFT);
  }
  throw new Error(`十字キーの左右で ${selector} を選べない`);
}
/** トップ画面でパッドだけで武器と回数を選び、「開始」で A を押してプレイ画面に入る。 */
async function padStart(page: Page, weapon: WeaponJson, count: number) {
  await page.waitFor(`window.__vis('[data-screen="top"]') && document.querySelector('#weapon').options.length > 0 && document.querySelector('#count').options.length > 0`);
  await tap(page, DOWN);
  expect(await page.evaluate<string>('window.__focused()')).toBe('weapon');
  await chooseByPad(page, '#weapon', `(t) => t === ${JSON.stringify(weapon.name)}`);
  await focusDownTo(page, 'count');
  await chooseByPad(page, '#count', `(t) => Number((t.match(/\\d+/) ?? [NaN])[0]) === ${count}`);
  await focusDownTo(page, 'start');
  await btn(page, A, true);
  await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]') && window.__ammo() === ${weapon.magSize}`, 10_000);
  await btn(page, A, false);
  await page.frames(5);
}
/** R2 を押し続けて撃ち切る（残弾が 0 か、短いリザルトか、プレイ画面でなくなったら離す）。 */
async function padFireAll(page: Page) {
  await btn(page, R2, true);
  await page.advanceClockUntil(`window.__ammo() === 0 || location.hash !== '#/play' || window.__interlude()`, { step: 0.05 });
  await btn(page, R2, false);
  await page.frames(3);
}

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('QA: 結果のシェア', () => {
  const temps: string[] = [];
  let build = { status: null as number | null, output: '' };
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));
  const noExceptions = (page: Page) => expect(exceptions(page), page.errors.join('\n')).toEqual([]);

  async function openFresh(opts: { share?: ShareEnv; clip?: ClipEnv; pad?: boolean; seed?: Record<string, string> } = {}): Promise<Page> {
    const page = await browser!.newPage();
    await page.goto(appUrl(origin, BASE, '#/', { render: false, manualClock: true }));
    await page.evaluate(`(() => { localStorage.clear(); const seed = ${JSON.stringify(opts.seed ?? {})}; for (const k in seed) localStorage.setItem(k, seed[k]); })()`);
    await page.addInitScript(PAGE_INIT);
    await page.addInitScript(envScript(opts.share ?? 'ok', opts.clip ?? 'ok'));
    if (opts.pad) await page.addInitScript(FAKE_PAD);
    await page.evaluate('window.__beforeReload = true');
    await page.send('Page.reload', { ignoreCache: false });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && window.__vis('[data-screen="top"]')`, 15_000);
    await page.frames(3);
    return page;
  }

  beforeAll(async () => {
    const work = mkdtempSync(join(tmpdir(), 'share-results-qa-'));
    temps.push(work);
    const copy = join(work, 'copy');
    for (const entry of ['src', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'eslint.config.js', 'scripts']) {
      if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
    }
    symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), 'dir');
    for (const w of [LSTAR, ZERO, LOW]) writeFileSync(join(copy, `src/data/weapons/${w.id}.json`), JSON.stringify(w, null, 2));
    const dist = join(work, 'dist');
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

  it('L-STAR を差し替えた写しのビルドが通る', () => {
    expect(build.status, build.output).toBe(0);
  });

  /** L-STAR を 1 回練習したリザルト画面で、平均ズレ 0.85°・命中率 72.0% と表示されていることを確かめる。 */
  async function lstarResult(page: Page) {
    await practiceOnce(page, LSTAR);
    const m = await metrics(page);
    expect(metric(m, '平均ズレ')).toContain('0.85°');
    expect(metric(m, '命中率')).toContain('72.0%');
  }

  // -------------------------------------------------------------------------
  describe('リザルト画面', () => {
    it('UI-87, OVR-20: navigator.share がある環境で、自己ベストを更新したリザルト画面の「結果をシェア」をクリックすると、text だけを持つ引数で 1 回だけ呼ばれ、文が SPEC の例と一致する', async () => {
      const page = await openFresh({ share: 'ok' });
      await lstarResult(page);
      expect(await page.evaluate<string>(`document.querySelector('[data-screen="result"]').innerText`)).toContain('自己ベスト更新');
      await clickShare(page, 'result');
      await page.waitFor('window.__shareCalls.length > 0', 5000);
      await page.frames(10);
      const calls = await shareCalls(page);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.argc).toBe(1);
      expect(calls[0]!.keys).toEqual(['text']);
      expect(calls[0]!.hasFiles).toBe(false);
      expect(calls[0]!.text).toBe(SPEC_EXAMPLE);
      // シェアできたときはクリップボードにコピーしない。
      expect(await clip(page)).toEqual([]);
      noExceptions(page);
    }, 90_000);

    it('UI-88: 自己ベストを更新しなかった練習のリザルト画面で「結果をシェア」を押すと、「自己ベスト更新！」の行がなく、ほかの行は同じ形になる', async () => {
      const seed = {
        [`${BEST_PREFIX}mouse:lstar:ghost`]: JSON.stringify({ version: 1, meanError: 0.5, groupingRadius: 0.5, hitRate: 90, shots: 25, achievedAt: '2026-11-01T00:00:00.000Z' }),
      };
      const page = await openFresh({ share: 'ok', seed });
      await lstarResult(page);
      expect(await page.evaluate<string>(`document.querySelector('[data-screen="result"]').innerText`)).not.toContain('自己ベスト更新');
      await clickShare(page, 'result');
      await page.waitFor('window.__shareCalls.length > 0', 5000);
      const calls = await shareCalls(page);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.text).toBe(resultText('L-STAR', '0.85°', '72.0%', false));
      expect(String(calls[0]!.text)).not.toContain(BEST_LINE);
      noExceptions(page);
    }, 90_000);

    it('UI-89, OVR-20: navigator.share がない環境で「結果をシェア」を押すと、同じ形の文がクリップボードに入り、「コピーしました」と表示される', async () => {
      const page = await openFresh({ share: 'none' });
      expect(await page.evaluate<boolean>(`'share' in navigator`)).toBe(false);
      await lstarResult(page);
      await clickShare(page, 'result');
      await page.waitFor('window.__clip.length > 0', 5000);
      await page.frames(5);
      expect(await clip(page)).toEqual([SPEC_EXAMPLE]);
      expect(await shareMessage(page, 'result')).toBe(COPIED);
      noExceptions(page);
    }, 90_000);

    it('UI-90: navigator.share が NotAllowedError で失敗すると同じ文がクリップボードに入り「コピーしました」と表示される', async () => {
      const page = await openFresh({ share: 'notallowed' });
      await lstarResult(page);
      await clickShare(page, 'result');
      await page.waitFor('window.__clip.length > 0', 5000);
      await page.frames(5);
      expect(await shareCalls(page)).toHaveLength(1);
      expect(await clip(page)).toEqual([SPEC_EXAMPLE]);
      expect(await shareMessage(page, 'result')).toBe(COPIED);
      noExceptions(page);
    }, 90_000);

    it('UI-90: navigator.share が AbortError で失敗すると、クリップボードは変わらず、メッセージも出ない', async () => {
      const page = await openFresh({ share: 'abort' });
      await lstarResult(page);
      await clickShare(page, 'result');
      await page.waitFor('window.__shareCalls.length > 0', 5000);
      // 失敗の知らせが届いてから、処理し終わるまで描画を進める。
      await page.evaluate('window.__shareSettled');
      await page.frames(10);
      expect(await shareCalls(page)).toHaveLength(1);
      expect(await page.evaluate<number>('window.__clipAttempts')).toBe(0);
      expect(await clip(page)).toEqual([]);
      expect(await shareMessage(page, 'result')).toBe('');
      expect(await readonlyFields(page, 'result')).toEqual([]);
      noExceptions(page);
    }, 90_000);

    it('UI-91: navigator.share がなく、クリップボードへの書き込みも失敗すると、エラーで止まらず、メッセージとシェアの文の読み取り専用の欄が表示される', async () => {
      const page = await openFresh({ share: 'none', clip: 'fail' });
      await lstarResult(page);
      await clickShare(page, 'result');
      await page.waitFor(`window.__clipAttempts > 0`, 5000);
      await page.waitFor(`[...document.querySelectorAll('[data-screen="result"] textarea, [data-screen="result"] input')].some((e) => window.__vis(e))`, 5000);
      await page.frames(5);
      expect(await shareMessage(page, 'result')).toBe(COPY_FAILED);
      const fields = await readonlyFields(page, 'result');
      expect(fields).toEqual([{ value: SPEC_EXAMPLE, readOnly: true }]);
      // 画面は止まらず、リザルト画面のまま操作できる（「武器変更」でトップ画面に戻れる）。
      expect(await page.evaluate<string[]>('window.__screens()')).toEqual(['result']);
      noExceptions(page);
      await page.evaluate(`[...document.querySelectorAll('[data-screen="result"] button, [data-screen="result"] a')].find((e) => e.textContent.trim() === '武器変更').scrollIntoView({ block: 'center' })`);
      const box = await page.evaluate<{ x: number; y: number }>(`(() => { const r = [...document.querySelectorAll('[data-screen="result"] button, [data-screen="result"] a')].find((e) => e.textContent.trim() === '武器変更').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await page.click(box.x, box.y);
      await page.waitFor(`window.__vis('[data-screen="top"]')`, 5000);
    }, 90_000);

    it('UI-94: リザルト画面の「X に投稿」のリンクの行き先は、https://x.com/intent/post?text= にシェアの文を URL エンコードしたもので、新しいタブで開く', async () => {
      const page = await openFresh({ share: 'ok' });
      await lstarResult(page);
      const link = await page.evaluate<{ href: string; target: string } | null>(`(() => { const a = ${postLinkExpr('result')}; return a ? { href: a.getAttribute('href'), target: a.target } : null; })()`);
      expect(link).not.toBeNull();
      expect(link!.target).toBe('_blank');
      expect(link!.href.startsWith(POST_PREFIX), link!.href).toBe(true);
      const encoded = link!.href.slice(POST_PREFIX.length);
      expect(encoded).not.toMatch(/[\s&#]/);
      expect(new URL(link!.href).searchParams.get('text')).toBe(SPEC_EXAMPLE);
      expect([encodeURIComponent(SPEC_EXAMPLE), new URLSearchParams({ text: SPEC_EXAMPLE }).toString().slice('text='.length)]).toContain(encoded);
      noExceptions(page);
    }, 90_000);

    it('UI-95: リザルト画面で「結果をシェア」を押したあと、ハッシュ・指標・図・localStorage の自己ベストと履歴は押す前と変わらない', async () => {
      const page = await openFresh({ share: 'none' });
      await lstarResult(page);
      const before = await screenSnapshot(page, 'result');
      const storedBefore = await storage(page);
      expect(Object.keys(storedBefore).some((k) => k.startsWith(BEST_PREFIX))).toBe(true);
      expect(Object.keys(storedBefore).some((k) => k.startsWith(HISTORY_PREFIX))).toBe(true);
      const hashesBefore = await page.evaluate<string[]>('window.__hashes.slice()');
      await clickShare(page, 'result');
      await page.waitFor('window.__clip.length > 0', 5000);
      // もう一度押しても同じ。
      await clickShare(page, 'result');
      await page.waitFor('window.__clip.length > 1', 5000);
      await page.frames(5);
      const after = await screenSnapshot(page, 'result');
      expect(after.hash).toBe('#/result');
      expect(after).toEqual(before);
      expect(await page.evaluate<string[]>('window.__hashes')).toEqual(hashesBefore);
      expect(await storage(page)).toEqual(storedBefore);
      expect(await metrics(page).then((m) => metric(m, '平均ズレ'))).toContain('0.85°');
      noExceptions(page);
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  describe('セットのまとめ', () => {
    const SET_EXPECTED = setText(ZERO.name, 3, 5, '1.00°', true);

    it('UI-92, OVR-20: 回数 5 のセットを 3 回目まで終えてやめ、各回の平均ズレが 1.0・0.8・1.2 度のセットのまとめで「結果をシェア」を押すと、セットの見出し・回数とセットの平均ズレ・公開 URL を含む文が渡る', async () => {
      const page = await openFresh({ share: 'ok' });
      await setStoppedAfter(page, [1.0, 0.8, 1.2]);
      const shown = await page.evaluate<string>(`document.querySelector('[data-screen="set-result"]').innerText`);
      expect(shown).toMatch(/3\s*\/\s*5/);
      expect(shown).toContain('1.00');
      await clickShare(page, 'set-result');
      await page.waitFor('window.__shareCalls.length > 0', 5000);
      await page.frames(5);
      const calls = await shareCalls(page);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.keys).toEqual(['text']);
      expect(calls[0]!.hasFiles).toBe(false);
      const text = String(calls[0]!.text);
      const lines = text.split('\n');
      expect(lines[0]).toBe('リコイル練習（非公式ファンツール）のセットの結果');
      expect(lines).toContain('回数: 3 / 5 回 / セットの平均ズレ: 1.00°');
      expect(lines).toContain(PUBLIC_URL);
      // 文は「シェアの文」の行だけからなる（各回の値は入らない）。
      expect(text).toBe(SET_EXPECTED);
      for (const v of ['0.80', '1.20', '0.8°', '1.2°']) expect(text).not.toContain(v);
      noExceptions(page);
    }, 150_000);

    it('UI-94: セットのまとめの「X に投稿」のリンクの行き先は、https://x.com/intent/post?text= にシェアの文を URL エンコードしたもので、新しいタブで開く', async () => {
      const page = await openFresh({ share: 'ok' });
      await setStoppedAfter(page, [1.0, 0.8, 1.2]);
      const link = await page.evaluate<{ href: string; target: string } | null>(`(() => { const a = ${postLinkExpr('set-result')}; return a ? { href: a.getAttribute('href'), target: a.target } : null; })()`);
      expect(link).not.toBeNull();
      expect(link!.target).toBe('_blank');
      expect(link!.href.startsWith(POST_PREFIX), link!.href).toBe(true);
      expect(new URL(link!.href).searchParams.get('text')).toBe(SET_EXPECTED);
      const encoded = link!.href.slice(POST_PREFIX.length);
      expect([encodeURIComponent(SET_EXPECTED), new URLSearchParams({ text: SET_EXPECTED }).toString().slice('text='.length)]).toContain(encoded);
      noExceptions(page);
    }, 150_000);

    it('UI-95: セットのまとめで「結果をシェア」を押したあと、ハッシュ・表示・図・localStorage の自己ベストと履歴は押す前と変わらない', async () => {
      const page = await openFresh({ share: 'none' });
      await setStoppedAfter(page, [1.0, 0.8, 1.2]);
      const before = await screenSnapshot(page, 'set-result');
      const storedBefore = await storage(page);
      expect(Object.keys(storedBefore).length).toBeGreaterThan(0);
      const hashesBefore = await page.evaluate<string[]>('window.__hashes.slice()');
      await clickShare(page, 'set-result');
      await page.waitFor('window.__clip.length > 0', 5000);
      await page.frames(5);
      expect(await clip(page)).toEqual([SET_EXPECTED]);
      expect(await shareMessage(page, 'set-result')).toBe(COPIED);
      const after = await screenSnapshot(page, 'set-result');
      expect(after.hash).toBe('#/set-result');
      expect(after).toEqual(before);
      expect(await page.evaluate<string[]>('window.__hashes')).toEqual(hashesBefore);
      expect(await storage(page)).toEqual(storedBefore);
      noExceptions(page);
    }, 150_000);
  });

  // -------------------------------------------------------------------------
  describe('パッドの Y / △', () => {
    it('UI-93: パッドだけで練習を終えたリザルト画面とセットのまとめで Y / △ を押すと、「結果をシェア」と同じ処理が 1 回だけ行われ、押し続けても繰り返さない', async () => {
      const page = await openFresh({ share: 'none', pad: true });
      // マウスとキーボードの操作は送らない。
      await page.evaluate(`window.__kbm = 0; for (const t of ['keydown', 'mousedown', 'mousemove', 'click']) addEventListener(t, (e) => { if (e.isTrusted) window.__kbm += 1; }, true)`);

      // リザルト画面（回数 1）。
      await padStart(page, LOW, 1);
      await padFireAll(page);
      await page.advanceClockUntil(`location.hash === '#/result'`, { step: 0.05 });
      await page.waitFor(`window.__vis('[data-screen="result"]')`, 10_000);
      await page.frames(5);
      expect(await clip(page)).toEqual([]);
      await btn(page, Y, true);
      await page.waitFor('window.__clip.length > 0', 5000);
      // 押し続けても繰り返さない。
      await page.frames(40);
      await page.advanceClock(2);
      await page.frames(10);
      expect(await clip(page)).toHaveLength(1);
      expect((await clip(page))[0]!.split('\n')[0]).toBe('リコイル練習（非公式ファンツール）の結果');
      expect((await clip(page))[0]).toContain(`武器: ${LOW.name} / モード: ${MODE}`);
      expect((await clip(page))[0]).toContain(PUBLIC_URL);
      expect(await shareMessage(page, 'result')).toBe(COPIED);
      expect(await page.evaluate<string>('location.hash')).toBe('#/result');
      await btn(page, Y, false);
      await page.frames(5);
      expect(await clip(page)).toHaveLength(1);

      // セットのまとめ（回数 5 の 1 回目を終えて、短いリザルトで B でやめる）。
      await tap(page, B);
      await page.waitFor(`window.__vis('[data-screen="top"]')`, 5000);
      await page.frames(5);
      await padStart(page, LOW, 5);
      await padFireAll(page);
      await page.waitFor('window.__interlude()', 5000);
      await page.frames(3);
      await tap(page, B);
      await waitSetResult(page);
      await page.frames(5);
      await btn(page, Y, true);
      await page.waitFor('window.__clip.length > 1', 5000);
      await page.frames(40);
      await page.advanceClock(2);
      await page.frames(10);
      const copied = await clip(page);
      expect(copied).toHaveLength(2);
      expect(copied[1]!.split('\n')[0]).toBe('リコイル練習（非公式ファンツール）のセットの結果');
      expect(copied[1]).toContain('回数: 1 / 5 回 / セットの平均ズレ: 2.00°');
      expect(await shareMessage(page, 'set-result')).toBe(COPIED);
      expect(await page.evaluate<string>('location.hash')).toBe('#/set-result');
      await btn(page, Y, false);
      await page.frames(5);
      expect(await clip(page)).toHaveLength(2);
      expect(await page.evaluate<number>('window.__kbm')).toBe(0);
      noExceptions(page);
    }, 150_000);
  });

  // -------------------------------------------------------------------------
  describe('外へ渡す操作', () => {
    it('OVR-5: どの画面にも、ファイルや外部へ出力する操作がなく、外へ渡す操作は「結果をシェア」と「X に投稿」だけで、渡すのは成績の要約の文だけ', async () => {
      const page = await openFresh({ share: 'ok' });
      // ページの外（テストのサーバーの origin でないもの）へのリクエストを記録する。
      const external: string[] = [];
      const own = new URL(origin).origin;
      // リクエストはページの Performance の記録（resource）から読む。
      const controls = async (screen: string) =>
        page.evaluate<{ tag: string; label: string; href: string | null; download: boolean; target: string }[]>(`(() => {
          const scope = document.querySelector('[data-screen="${screen}"]');
          return [...scope.querySelectorAll('a, button, input[type="button"], input[type="submit"], form, [download]')].filter((e) => window.__vis(e))
            .map((e) => ({ tag: e.tagName.toLowerCase(), label: e.tagName === 'FORM' ? '' : (e.textContent || e.value || '').trim(), href: e.getAttribute(e.tagName === 'FORM' ? 'action' : 'href'), download: e.hasAttribute('download'), target: e.getAttribute('target') ?? '' })); })()`);
      const seen: Record<string, Awaited<ReturnType<typeof controls>>> = {};
      for (const [hash, screen] of [
        ['#/', 'top'],
        ['#/settings', 'settings'],
        ['#/settings/pad', 'settings-pad'],
        ['#/settings/pad/mapping', 'settings-pad-mapping'],
        ['#/history', 'history'],
      ] as const) {
        await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
        await page.waitFor(`window.__vis('[data-screen="${screen}"]')`, 5000);
        await page.frames(3);
        seen[screen] = await controls(screen);
      }
      await practiceOnce(page, LSTAR);
      seen.result = await controls('result');
      await clickShare(page, 'result');
      await page.waitFor('window.__shareCalls.length > 0', 5000);
      await page.frames(5);
      await page.evaluate(`location.hash = '#/history'`);
      await page.waitFor(`window.__vis('[data-screen="history"]')`, 5000);
      await page.frames(3);
      seen['history-after'] = await controls('history');

      const exportWords = /保存|書き出|エクスポート|ダウンロード|送信|出力|export|download|upload|save|copy|コピー/i;
      for (const [screen, list] of Object.entries(seen)) {
        for (const c of list) {
          expect(c.download, `${screen}: ${c.label}`).toBe(false);
          // フォームは外へ送らない（送り先がページの外でない）。
          if (c.tag === 'form') expect(c.href ?? '', screen).not.toMatch(/^[a-z]+:/i);
          expect(c.label, `${screen}: ${c.label}`).not.toMatch(exportWords);
          if (c.href && /^[a-z]+:/i.test(c.href)) {
            // 外部へのリンクは「X に投稿」だけ。
            expect(c.label, `${screen}: ${c.href}`).toBe('X に投稿');
            expect(c.href.startsWith(POST_PREFIX), c.href).toBe(true);
          }
          if (/シェア|共有|share|投稿|post/i.test(c.label)) expect(['結果をシェア', 'X に投稿'], screen).toContain(c.label);
        }
      }
      // 外へ渡す操作は、リザルト画面の「結果をシェア」と「X に投稿」だけ。
      expect(seen.result!.filter((c) => /シェア|投稿/.test(c.label)).map((c) => c.label).sort()).toEqual(['X に投稿', '結果をシェア'].sort());
      for (const s of ['top', 'settings', 'settings-pad', 'settings-pad-mapping', 'history', 'history-after']) {
        expect(seen[s]!.filter((c) => /シェア|投稿/.test(c.label)), s).toEqual([]);
      }
      // 渡したのは成績の要約の文だけ（ほかの引数・ファイルなし）。
      const calls = await shareCalls(page);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.keys).toEqual(['text']);
      expect(calls[0]!.text).toBe(SPEC_EXAMPLE);
      // 練習とシェアのあいだ、テストのサーバーの外へのリクエストはない。
      const urls = await page.evaluate<string[]>(`performance.getEntriesByType('resource').map((e) => e.name)`);
      for (const u of urls) if (!u.startsWith('data:') && !u.startsWith('blob:') && new URL(u).origin !== own) external.push(u);
      expect(external).toEqual([]);
      noExceptions(page);
    }, 120_000);

    it('OVR-20: クリップボードに渡る文も「シェアの文」の行だけからなり、補正値・照準の軌道・パターンの数値・入力の記録・各弾のズレを含まない', async () => {
      const page = await openFresh({ share: 'notallowed' });
      await practiceOnce(page, LSTAR);
      await clickShare(page, 'result');
      await page.waitFor('window.__clip.length > 0', 5000);
      const calls = await shareCalls(page);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.keys).toEqual(['text']);
      expect(calls[0]!.hasFiles).toBe(false);
      const [text] = await clip(page);
      expect(text).toBe(SPEC_EXAMPLE);
      // 行は「シェアの文」の行だけ。数は平均ズレと命中率だけ（各弾のズレ 0.5・1.75、パターンの 1.25、グルーピング半径などは入らない）。
      const numbersInText = (text!.replace(PUBLIC_URL, '').match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
      expect(numbersInText).toEqual([0.85, 72.0]);
      expect(text).not.toMatch(/マウス|パッド|pad|mouse|グルーピング|横ブレ|縦ブレ|yaw|pitch|dx|dy|\[|\{/i);
      noExceptions(page);
    }, 90_000);
  });
});
