// docs/spec/screens.md「表示の言語」（UI-125〜UI-134）、docs/spec/overview.md「権利と表記」「保存」（OVR-28・OVR-29）、
// docs/spec/modes.md「モードの登録」（MODE-57）のブラウザで確かめる QA の受け入れテスト。QA が SPEC だけから書いたもの。
// 公開された入口（ビルドの結果を /apex-training/ で配信した画面、index.html の要素、SPEC の localStorage のキーと値の形、
// navigator.language、ビルドのコンテナ ID を置き換える環境変数 APEX_GTM_CONTAINER_ID）だけを使い、実装の内部には依存しない。
//
// ブラウザで確かめる受け入れ条件の持ち主は tests/acceptance/README.md の表のとおり tests/ui/language-browser.test.ts なので（ARC-29）、
// このファイルのテストの名前には、表で持ち主が決まっている ID を書かない。各テストが確かめる受け入れ条件は、テストの前のコメントに書く。
// 表に持ち主のない UI-132 だけは、このファイルが持ち主になる。
//
// 決まった平均ズレと命中率を作るため、リポジトリの写しの L-STAR をブレ 0 の 25 発のパターンに差し替えてビルドする
// （18 発が中心から 0.5 度、7 発が 1.75 度に当たり、平均ズレ 0.85 度・命中率 72%。share-results-qa と同じ作り）。
// 計測の同意の案内を出すため、コンテナ ID を受け入れ用の ID にしてビルドする。googletagmanager.com への要求は止めて空のスクリプトを返す。
// フリックの的を狙う練習では 3D を描画し、画面写しで的の画素を探してマウスで照準を合わせる（flick-browser-qa と同じ作り）。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';
import { decodePng } from '../helpers/png';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const CX = 640;
const CY = 400;
const chromium = findChromium();
/** 固定ステップ（architecture.md、既定 1/120 秒）。 */
const DT = 1 / 120;
/** 既定の感度 1.5 の 1 カウントの角度（mouse.md）。 */
const DEG_PER_COUNT = 1.5 * 0.022;

/** SPEC の値と文言（実装の定数には依存しない）。 */
const SEED = 12345;
const LANGUAGE_KEY = 'apex-training:language';
const CONSENT_KEY = 'apex-training:analytics-consent';
const CONTAINER_ID = 'GTM-QA0081';
const TITLE_EN = 'Hyper Aim Training (Unofficial)';
const TITLE_JA = 'Hyper Aim Training（非公式）';
const FOOTER_EN = 'Unofficial fan tool. Not affiliated with EA or Respawn.';
const STORAGE_NOTICE_EN = "Settings and records can't be saved in this environment. You can keep practicing.";
const LANGUAGE_LABEL = '言語 / Language';
const MODES_EN = [
  ['Recoil Drill', "Fire the same weapon's recoil again and again until the pattern is in your hands"],
  ['Tracking', 'Keep your crosshair on a target moving left and right'],
  ['Tracking + Recoil', 'Keep your crosshair on a moving target while controlling recoil'],
  ['Flick', 'Snap to targets that appear at random spots and shoot fast'],
] as const;
const SHARE_EXAMPLE_EN = [
  'Hyper Aim Training (unofficial fan tool) result',
  'Weapon: L-STAR / Mode: Recoil Drill',
  'Avg. error: 0.85° / Hit rate: 72.0%',
  'New personal best!',
  'https://cocoiti.github.io/apex-training/',
].join('\n');
const GHOST_HISTORY = 'apex-training:history:mouse:lstar:ghost';
const FLICK_KEY = (kind: 'best' | 'history', range: string, size: string) => `apex-training:${kind}:mouse:-:flick:${range}:${size}`;

/** ひらがな・カタカナ・漢字（UI-127）。 */
const JAPANESE = String.raw`[぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]`;

/** パッドの標準配置のボタン番号。 */
const A = 0;
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
/** 写しの L-STAR: 1〜18 発目は上に 0.5 度、19〜25 発目は上に 1.75 度。 */
const LSTAR: WeaponJson = {
  id: 'lstar',
  name: 'L-STAR',
  category: 'LMG',
  version: 'S31-Cipher',
  source: '仮データ（受け入れテスト）',
  rpm: 600,
  magSize: 25,
  randomness: 0,
  pattern: [{ dx: 0, dy: 0.5 }, ...zeros(17), { dx: 0, dy: 1.25 }, ...zeros(6)],
  measured: true,
};

// ---------------------------------------------------------------------------
// ページに入れるスクリプト
// ---------------------------------------------------------------------------

const PAGE_INIT = `
  window.__vis = (sel) => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    return !!el && !el.closest('[hidden]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0; };
  window.__num = (sel) => { const m = (document.querySelector(sel)?.textContent ?? '').match(/-?\\d+(?:\\.\\d+)?/); return m ? Number(m[0]) : NaN; };
  window.__ammo = () => window.__num('[data-hud="ammo"]');
  window.__interlude = () => window.__vis('#interlude');
  window.__clockNow = () => window.__apexTestClock.now();
  window.__focused = () => { const els = [...document.querySelectorAll('.pad-focus')]; return els.length === 1 ? (els[0].getAttribute('data-card-choice') || els[0].id || els[0].textContent.trim()) : els.length > 1 ? 'MULTIPLE' : ''; };
  window.__shareCalls = [];
  Object.defineProperty(Navigator.prototype, 'share', { value: function (data) { window.__shareCalls.push(data?.text); return Promise.resolve(); }, configurable: true, writable: true });
  Object.defineProperty(Navigator.prototype, 'canShare', { value: () => true, configurable: true, writable: true });
  // 表示している文字と、表示している要素の aria-label・title・placeholder・ページのタイトルのうち、ひらがな・カタカナ・漢字を含むもの。
  // 言語の欄の名前（言語 / Language）と選択肢の「日本語」は除く（UI-127）。見えている select は、すべての選択肢の文字を調べる。
  window.__japanese = () => {
    const re = new RegExp(${JSON.stringify(JAPANESE)});
    const allowed = (t) => t === '日本語' || t === ${JSON.stringify(LANGUAGE_LABEL)};
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent.trim();
      const el = n.parentElement;
      if (!t || !el || !re.test(t) || allowed(t) || el.closest('script, style, template')) continue;
      const select = el.closest('select');
      const host = select ?? (el.namespaceURI?.includes('svg') && el.tagName.toLowerCase() === 'title' ? el.parentElement : el);
      if (!window.__vis(host)) continue;
      out.push((el.id ? '#' + el.id + ': ' : el.tagName.toLowerCase() + ': ') + t);
    }
    for (const el of document.querySelectorAll('[aria-label], [title], [placeholder]')) {
      if (!window.__vis(el)) continue;
      for (const a of ['aria-label', 'title', 'placeholder']) {
        const v = el.getAttribute(a);
        if (v && re.test(v) && !allowed(v)) out.push(a + '=' + v);
      }
    }
    if (re.test(document.title)) out.push('document.title=' + document.title);
    return out;
  };
`;

/** localStorage への書き込みが例外になる環境。 */
const STORAGE_FAILS = `Storage.prototype.setItem = function () { throw new DOMException('quota', 'QuotaExceededError'); };`;

/** 標準配置のパッド 1 台。__btn(番号, 押す) で操作する。 */
const FAKE_PAD = `
  window.__pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) };
  navigator.getGamepads = () => [{ id: 'acceptance pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard',
    timestamp: performance.now(), axes: window.__pad.axes.slice(), buttons: window.__pad.buttons.map((b) => ({ ...b })), vibrationActuator: null }];
  window.__btn = (i, on) => { window.__pad.buttons[i] = { value: on ? 1 : 0, pressed: on, touched: on }; };
`;

// ---------------------------------------------------------------------------
// 画面の操作と読み取り
// ---------------------------------------------------------------------------

/** 選択肢の表示名（または表示の中の数）から値を選ぶ（キーボードで選んだときと同じく input と change を出す）。 */
async function choose(page: Page, selector: string, label: string | number) {
  const ok = await page.evaluate<boolean>(`(() => {
    const s = document.querySelector(${JSON.stringify(selector)});
    if (!s) return false;
    const want = ${JSON.stringify(label)};
    const o = [...s.options].find((x) => typeof want === 'number' ? Number((x.textContent.match(/\\d+/) ?? [NaN])[0]) === want : x.textContent.trim() === want);
    if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  if (!ok) throw new Error(`${selector} に ${label} の選択肢がない`);
}

/** ラベルの文字を含む label の中の、見えている select。 */
const settingSelect = (screen: string, label: string) =>
  `[...document.querySelectorAll('[data-screen="${screen}"] select')].find((s) => window.__vis(s) && (s.closest('label')?.textContent ?? '').includes(${JSON.stringify(label)}))`;

async function chooseSetting(page: Page, screen: string, label: string, value: string) {
  const ok = await page.evaluate<boolean>(`(() => { const s = ${settingSelect(screen, label)}; if (!s) return false;
    const o = [...s.options].find((x) => x.textContent.trim() === ${JSON.stringify(value)}); if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  if (!ok) throw new Error(`${screen} の「${label}」で ${value} を選べない`);
}

const TOP_READY = `window.__vis('[data-screen="top"]') && document.querySelector('#mode').options.length > 0 && document.querySelector('#count').options.length > 0`;

const visibleText = (page: Page, selector: string) =>
  page.evaluate<string>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el && window.__vis(el) ? el.innerText.trim() : ''; })()`);
const screenText = (page: Page, screen: string) => visibleText(page, `[data-screen="${screen}"]`);
const japanese = (page: Page) => page.evaluate<string[]>('window.__japanese()');
const lang = (page: Page) => page.evaluate<string>('document.documentElement.lang');
const title = (page: Page) => page.evaluate<string>('document.title');
const hash = (page: Page) => page.evaluate<string>('location.hash');
const now = (page: Page) => page.evaluate<number>('window.__clockNow()');
const footer = (page: Page) =>
  page.evaluate<string[]>(`[...document.querySelectorAll('footer *')].filter((e) => window.__vis(e) && e.children.length === 0).map((e) => e.textContent.trim())`);

/** hash の画面に移り、表示されるまで待つ。 */
async function go(page: Page, to: string, screen: string) {
  await page.evaluate(`location.hash = ${JSON.stringify(to)}`);
  await page.waitFor(`window.__vis('[data-screen="${screen}"]')`);
  await page.frames(2);
}

/** 言語の欄の名前（区分の見出しと欄の名前）と選択肢。 */
const languageField = (page: Page) =>
  page.evaluate<{ legend: string; label: string; options: string[]; value: string; visible: boolean }>(`(() => {
    const s = document.querySelector('#setting-language');
    const label = s.closest('label');
    const own = label ? [...label.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE || (n.nodeType === Node.ELEMENT_NODE && !n.contains(s) && n !== s))
      .map((n) => n.textContent).join('').trim() : '';
    return { legend: s.closest('fieldset')?.querySelector('legend')?.textContent.trim() ?? '', label: own,
      options: [...s.options].map((o) => o.textContent.trim()), value: s.selectedOptions[0]?.textContent.trim() ?? '', visible: window.__vis(s) }; })()`);

// マウス -------------------------------------------------------------------

/** ポインターロック中のマウスの位置（mouseMoved の座標）と、練習の開始から動かしたカウントの合計。 */
interface Mouse {
  x: number;
  y: number;
  cx: number;
  cy: number;
}
const newMouse = (): Mouse => ({ x: CX, y: CY, cx: 0, cy: 0 });
const mouseButton = (page: Page, m: Mouse, type: 'mousePressed' | 'mouseReleased') =>
  page.send('Input.dispatchMouseEvent', { type, x: m.x, y: m.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });

async function moveBy(page: Page, m: Mouse, dx: number, dy: number) {
  if (dx === 0 && dy === 0) return;
  m.x += dx;
  m.y += dy;
  m.cx += dx;
  m.cy += dy;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: m.x, y: m.y, button: 'none', buttons: 0 });
}

/** プレイ画面でクリックしてポインターロックを掛ける（掛かっていれば何もしない）。 */
async function lock(page: Page, m: Mouse) {
  await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]') && !window.__interlude()`);
  if (await page.evaluate<boolean>('!!document.pointerLockElement')) return;
  await page.frames(3);
  await mouseButton(page, m, 'mousePressed');
  await mouseButton(page, m, 'mouseReleased');
  await page.waitFor('!!document.pointerLockElement', 5000);
  await page.frames(2);
}

/** 押して 3 ステップ後に離す。 */
async function click(page: Page, m: Mouse) {
  await mouseButton(page, m, 'mousePressed');
  await page.advanceClock(3 * DT);
  await mouseButton(page, m, 'mouseReleased');
}

/** 左ボタンを押し続けて撃ち切る（残弾が 0 か、短いリザルトか、プレイ画面でなくなるまで）。 */
async function fireAll(page: Page, m: Mouse) {
  await mouseButton(page, m, 'mousePressed');
  await page.advanceClockUntil(`window.__ammo() === 0 || location.hash !== '#/play' || window.__interlude()`);
  await mouseButton(page, m, 'mouseReleased');
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

// フリックの的の画素 ---------------------------------------------------------

let targetColor: [number, number, number] | undefined;
const CLIP = { x: CX - 480, y: CY - 160, width: 960, height: 320 };

async function findTarget(page: Page): Promise<{ n: number; x: number; y: number }> {
  if (!targetColor) throw new Error('的の色がまだ分からない');
  const { data } = await page.send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    optimizeForSpeed: true,
    clip: { ...CLIP, scale: 1 },
  });
  const img = decodePng(Buffer.from(data, 'base64'));
  // 的は人型の板で、画素の重心は胴の中心より上（頭の側）に寄るので、胴を狙う。
  const color = targetColor;
  const isTarget = ([r, g, b]: readonly number[]) => Math.abs(r! - color[0]) + Math.abs(g! - color[1]) + Math.abs(b! - color[2]) < 60;
  let n = 0;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      if (isTarget(img.pixel(x, y))) {
        n += 1;
        left = Math.min(left, CLIP.x + x);
        right = Math.max(right, CLIP.x + x + 1);
        top = Math.min(top, CLIP.y + y);
        bottom = Math.max(bottom, CLIP.y + y + 1);
      }
    }
  }
  if (n === 0) return { n, x: NaN, y: NaN };
  // 縦は胴の中心（板の上端から高さの 0.45 ÷ 0.75）。横は胴の高さの帯（上端から 0.35 ÷ 0.75〜下端）の的の色の画素の重心
  // （胴が多くを占める。頭は細く、縁の線で見えたり消えたりするので、頭の行は使わない）。
  const height = bottom - top;
  const y = top + height * (0.45 / 0.75);
  const [bandTop, bandBottom] = [top + height * (0.35 / 0.75), bottom];
  let m = 0;
  let sx = 0;
  for (let row = Math.max(0, Math.floor(bandTop) - CLIP.y); row < Math.min(img.height, Math.ceil(bandBottom) - CLIP.y); row += 1) {
    for (let x = 0; x < img.width; x += 1) {
      if (isTarget(img.pixel(x, row))) {
        m += 1;
        sx += CLIP.x + x + 0.5;
      }
    }
  }
  return m === 0 ? { n, x: (left + right) / 2, y } : { n, x: sx / m, y };
}

async function learnTargetColor(before: Buffer, after: Buffer) {
  const a = decodePng(before);
  const b = decodePng(after);
  const counts = new Map<string, number>();
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const p = a.pixel(x, y);
      const q = b.pixel(x, y);
      if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 60) counts.set(q.join(','), (counts.get(q.join(',')) ?? 0) + 1);
    }
  }
  const top = [...counts].sort((x, y) => y[1] - x[1])[0];
  if (!top || top[1] < 20) throw new Error(`的が出たあとの画面写しの差が見つからない: ${JSON.stringify([...counts].slice(0, 5))}`);
  targetColor = top[0].split(',').map(Number) as [number, number, number];
}

const FOCAL_GUESS = 530;
const countsFor = (px: number) => Math.round((Math.atan(px / FOCAL_GUESS) * 180) / Math.PI / DEG_PER_COUNT);

async function aimAtTarget(page: Page, m: Mouse, limit = 10) {
  const trail: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    const t = await findTarget(page);
    if (t.n === 0) throw new Error(`画面に練習の的が見えない（${trail.join(' → ')}）`);
    trail.push(`${(t.x - CX).toFixed(1)},${(t.y - CY).toFixed(1)}`);
    // 板の頭・縁は細く、画素の端で 1〜3 px 跳ぶので、2 px 以内で合ったとする（小さい板でも胴の幅は約 9 px）。
    if (Math.hypot(t.x - CX, t.y - CY) <= 2) return;
    // 近くでは板の画素が縁の線で 1〜2 px 跳ぶので、半分ずつ詰めて行き過ぎを繰り返さないようにする。
    const gain = Math.hypot(t.x - CX, t.y - CY) < 6 ? 0.5 : 1;
    await moveBy(page, m, countsFor((t.x - CX) * gain), countsFor((t.y - CY) * gain));
    await page.advanceClock(1 / 30);
  }
  throw new Error(`${limit} 回動かしても的の中心に合わない: ${trail.join(' → ')}`);
}

async function advanceTo(page: Page, t: number) {
  const d = t - (await now(page));
  if (d < -1e-9) throw new Error(`時計がすでに ${t} を過ぎている（今 ${await now(page)}）`);
  if (d > 1e-9) await page.advanceClock(d);
}

// 保存・リザルト ---------------------------------------------------------------

const storage = (page: Page) =>
  page.evaluate<Record<string, string>>(`(() => { const out = {}; for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i);
    if (k.startsWith('apex-training:best:') || k.startsWith('apex-training:history:')) out[k] = localStorage.getItem(k); } return out; })()`);

/** 画面の見えている dt / dd の組。 */
const metrics = (page: Page, screen: string) =>
  page.evaluate<Record<string, string>>(`(() => { const out = {}; for (const dt of document.querySelectorAll('[data-screen="${screen}"] dt')) {
    if (!window.__vis(dt)) continue; const dd = dt.nextElementSibling; if (dd && dd.tagName === 'DD') out[dt.textContent.trim()] = dd.textContent.trim(); } return out; })()`);
const metric = (m: Record<string, string>, label: string) => {
  const k = Object.keys(m).find((x) => x.includes(label));
  if (k === undefined) throw new Error(`指標 ${label} がない: ${JSON.stringify(m)}`);
  return m[k]!;
};

/** リザルト画面の「結果をシェア」（表示名で探す）を押し、渡ったシェアの文を返す。 */
async function share(page: Page, label: string) {
  const before = await page.evaluate<number>('window.__shareCalls.length');
  const ok = await page.evaluate<boolean>(`(() => { const b = [...document.querySelectorAll('[data-screen="result"] button')]
    .find((x) => x.textContent.trim() === ${JSON.stringify(label)} && window.__vis(x)); if (!b) return false; b.scrollIntoView({ block: 'center' }); return true; })()`);
  if (!ok) throw new Error(`リザルト画面に「${label}」のボタンが見えない`);
  const box = await page.evaluate<{ x: number; y: number }>(`(() => { const b = [...document.querySelectorAll('[data-screen="result"] button')]
    .find((x) => x.textContent.trim() === ${JSON.stringify(label)} && window.__vis(x)); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.click(box.x, box.y);
  await page.waitFor(`window.__shareCalls.length > ${before}`);
  return page.evaluate<string>('String(window.__shareCalls.at(-1))');
}

// パッド -------------------------------------------------------------------

const btn = (page: Page, b: number, on: boolean) => page.evaluate(`window.__btn(${b}, ${on})`);
async function padTap(page: Page, b: number) {
  await btn(page, b, true);
  await page.frames(3);
  await btn(page, b, false);
  await page.frames(3);
}
const focused = (page: Page) => page.evaluate<string>('window.__focused()');
async function padFocus(page: Page, target: string, limit = 30) {
  const seen: string[] = [await focused(page)];
  for (let i = 0; i < limit; i += 1) {
    if ((await focused(page)) === target) return;
    await padTap(page, DOWN);
    seen.push(await focused(page));
  }
  throw new Error(`十字キーの下で ${target} にフォーカスが来ない: ${seen.join(' → ')}`);
}
async function padChoose(page: Page, selector: string, label: string) {
  for (let i = 0; i < 8; i += 1) {
    const st = await page.evaluate<{ now: number; want: number }>(`(() => { const s = document.querySelector(${JSON.stringify(selector)});
      return { now: s.selectedIndex, want: [...s.options].findIndex((o) => o.textContent.trim() === ${JSON.stringify(label)}) }; })()`);
    if (st.want < 0) throw new Error(`${selector} に ${label} がない`);
    if (st.now === st.want) return;
    await padTap(page, st.now < st.want ? RIGHT : LEFT);
  }
  throw new Error(`十字キーの左右で ${selector} に ${label} を選べない`);
}

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('QA: 表示の言語（ブラウザ）', () => {
  let work = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));
  const noExceptions = (page: Page) => expect(exceptions(page), page.errors.join('\n')).toEqual([]);

  interface OpenOptions {
    /** ブラウザの言語（navigator.language）。 */
    language: string;
    hash?: string;
    screen?: string;
    seed?: Record<string, string>;
    /** 計測の同意の状態。既定は「許可しない」を保存しておく（案内を出さない）。null なら何も保存しない。 */
    consent?: 'granted' | 'denied' | null;
    init?: string[];
    pad?: boolean;
    render?: boolean;
  }

  /** 新しいタブで、同じ origin のアプリを動かさない文書から localStorage を空にし（seed を入れ）、アプリの hash を開く。 */
  async function open(opts: OpenOptions): Promise<Page> {
    const page = await browser!.newPage({ language: opts.language });
    page.on('Fetch.requestPaused', (p) => {
      void page.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }],
        body: '',
      });
    });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*googletagmanager.com*' }] });
    await page.goto(`${origin}${BASE}qa-blank.html`);
    const seed = { ...(opts.consent === null ? {} : { [CONSENT_KEY]: opts.consent ?? 'denied' }), ...(opts.seed ?? {}) };
    await page.evaluate(`(() => { localStorage.clear(); const seed = ${JSON.stringify(seed)}; for (const k in seed) localStorage.setItem(k, seed[k]); })()`);
    await page.addInitScript(PAGE_INIT);
    if (opts.pad) await page.addInitScript(FAKE_PAD);
    for (const s of opts.init ?? []) await page.addInitScript(s);
    await page.goto(appUrl(origin, BASE, opts.hash ?? '#/', { render: opts.render ?? false, manualClock: true, seed: SEED }));
    const screen = opts.screen ?? 'top';
    await page.waitFor(screen === 'top' ? TOP_READY : `window.__vis('[data-screen="${screen}"]')`, 15_000);
    await page.frames(3);
    return page;
  }

  /** 読み込み直し、画面が表示されるまで待つ。 */
  async function reload(page: Page, screen = 'top') {
    await page.evaluate('window.__beforeReload = true');
    await page.reload({ ignoreCache: false });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && window.__vis('[data-screen="${screen}"]')`, 15_000);
    await page.frames(3);
  }

  /** トップ画面でモード・武器・回数を選んで「開始」を押し、プレイ画面に入るまで待つ。 */
  async function start(page: Page, opts: { mode: string; weapon?: string; count?: number; options?: [string, string][] }) {
    await go(page, '#/', 'top');
    await page.waitFor(TOP_READY);
    await choose(page, '#mode', opts.mode);
    if (opts.weapon) await choose(page, '#weapon', opts.weapon);
    for (const [label, value] of opts.options ?? []) await chooseSetting(page, 'top', label, value);
    await choose(page, '#count', opts.count ?? 1);
    await page.clickSelector('[data-screen="top"] a[href="#/play"]');
    await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]')`);
  }

  /** L-STAR の反復練習の 1 回を照準を動かさずに撃ち切る（プレイ画面に入ってから呼ぶ）。 */
  async function ghostRound(page: Page, m: Mouse) {
    await page.waitFor(`window.__vis('[data-screen="play"]') && !window.__interlude() && window.__ammo() === ${LSTAR.magSize}`);
    await page.frames(2);
    await lock(page, m);
    await fireAll(page, m);
  }

  async function untilResult(page: Page) {
    await page.advanceClockUntil(`location.hash === '#/result'`, { step: 1 / 60, limit: 15 });
    await page.evaluate('document.pointerLockElement && document.exitPointerLock()');
    await page.waitFor(`window.__vis('[data-screen="result"]') && !document.pointerLockElement`);
    await page.frames(2);
  }

  /** L-STAR を反復練習で 1 回練習し、リザルト画面を表示する。 */
  async function ghostOnce(page: Page, mode: string) {
    await start(page, { mode, weapon: LSTAR.name, count: 1 });
    await ghostRound(page, newMouse());
    await untilResult(page);
  }

  /** 設定画面の言語の欄を選び直す（キーボードで選んだときと同じく change を出す）。 */
  async function chooseLanguage(page: Page, label: '日本語' | 'English') {
    await choose(page, '#setting-language', label);
    await page.frames(2);
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'language-qa-'));
    const copy = join(work, 'copy');
    for (const entry of ['src', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'eslint.config.js', 'scripts']) {
      if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
    }
    symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), 'dir');
    writeFileSync(join(copy, 'src/data/weapons/lstar.json'), JSON.stringify(LSTAR, null, 2));
    const dist = join(work, 'dist');
    const r = spawnSync(`npm run build -- --outDir "${dist}" --emptyOutDir`, {
      cwd: copy,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, APEX_GTM_CONTAINER_ID: CONTAINER_ID, APEX_ACCEPTANCE_NESTED: '1', FORCE_COLOR: '0' },
    });
    if (r.status !== 0) throw new Error(`ビルドが失敗した:\n${r.stdout}${r.stderr}`);
    // 保存を整えるための、アプリを動かさない同じ origin の文書。
    writeFileSync(join(dist, 'qa-blank.html'), '<!doctype html><meta charset="utf-8"><title>blank</title>');
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

  // UI-125
  it('最初の言語: ブラウザの言語が en-US で言語を保存していないと英語で、lang と タイトルが英語。ja-JP なら日本語', async () => {
    const en = await open({ language: 'en-US' });
    expect(await visibleText(en, '[data-screen="top"] a[href="#/play"]')).toBe('Start');
    expect(await visibleText(en, '#open-settings')).toBe('Settings');
    expect(await lang(en)).toBe('en');
    expect(await title(en)).toBe(TITLE_EN);
    expect(await japanese(en)).toEqual([]);
    noExceptions(en);

    const ja = await open({ language: 'ja-JP' });
    expect(await visibleText(ja, '[data-screen="top"] a[href="#/play"]')).toBe('開始');
    expect(await visibleText(ja, '#open-settings')).toBe('設定');
    expect(await lang(ja)).toBe('ja');
    expect(await title(ja)).toBe(TITLE_JA);
    noExceptions(ja);
  });

  // UI-126・UI-131
  it('言語の設定: 日本語の設定画面で English に変えると読み込み直さずに英語になり、ほかの画面も英語で、再読み込みしても英語のまま。欄の名前と選択肢は両方の言語で同じ', async () => {
    const page = await open({ language: 'ja-JP', hash: '#/settings', screen: 'settings' });
    expect(await lang(page)).toBe('ja');
    const jaField = await languageField(page);
    expect(jaField).toMatchObject({ legend: LANGUAGE_LABEL, label: LANGUAGE_LABEL, options: ['日本語', 'English'], value: '日本語', visible: true });
    expect(await screenText(page, 'settings')).toMatch(new RegExp(JAPANESE));

    await page.evaluate('window.__sameDocument = true');
    await chooseLanguage(page, 'English');
    expect(await page.evaluate<boolean>('window.__sameDocument === true'), 'ページを読み込み直していない').toBe(true);
    expect(await hash(page)).toBe('#/settings');
    expect(await lang(page)).toBe('en');
    expect(await title(page)).toBe(TITLE_EN);
    expect(await japanese(page)).toEqual([]);
    const enField = await languageField(page);
    expect(enField).toMatchObject({ legend: LANGUAGE_LABEL, label: LANGUAGE_LABEL, options: ['日本語', 'English'], value: 'English' });
    expect(await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(LANGUAGE_KEY)})`)).toBe('en');

    await go(page, '#/', 'top');
    expect(await visibleText(page, '[data-screen="top"] a[href="#/play"]')).toBe('Start');
    expect(await japanese(page)).toEqual([]);
    await go(page, '#/history', 'history');
    expect(await japanese(page)).toEqual([]);
    expect(await page.evaluate<boolean>('window.__sameDocument === true')).toBe(true);

    await reload(page, 'history');
    expect(await lang(page)).toBe('en');
    expect(await japanese(page)).toEqual([]);
    await go(page, '#/', 'top');
    expect(await visibleText(page, '#open-settings')).toBe('Settings');
    await go(page, '#/settings', 'settings');
    expect((await languageField(page)).value).toBe('English');

    // 日本語に戻すと、すぐ日本語に戻る。
    await chooseLanguage(page, '日本語');
    expect(await lang(page)).toBe('ja');
    expect(await title(page)).toBe(TITLE_JA);
    expect(await languageField(page)).toMatchObject({ legend: LANGUAGE_LABEL, label: LANGUAGE_LABEL, options: ['日本語', 'English'] });
    noExceptions(page);
  });

  // UI-130
  it('パッドだけで、日本語のトップ画面から設定画面を開き言語の欄を English に変えると英語になり、再読み込みしても英語のまま', async () => {
    const page = await open({ language: 'ja-JP', pad: true });
    await padFocus(page, 'open-settings');
    await padTap(page, A);
    await page.waitFor(`location.hash === '#/settings' && window.__vis('[data-screen="settings"]')`);
    await page.frames(3);
    await padFocus(page, 'setting-language');
    await padChoose(page, '#setting-language', 'English');
    await page.frames(3);
    expect(await lang(page)).toBe('en');
    expect(await japanese(page)).toEqual([]);
    expect(await hash(page)).toBe('#/settings');

    await reload(page, 'settings');
    expect(await lang(page)).toBe('en');
    expect((await languageField(page)).value).toBe('English');
    expect(await japanese(page)).toEqual([]);
    noExceptions(page);
  });

  // OVR-29
  it('保存できない環境で en-US のとき、フッターの非公式の表記のすぐ上に保存できない旨が英語で出る', async () => {
    const page = await open({ language: 'en-US', init: [STORAGE_FAILS] });
    const notice = await page.evaluate<{ text: string; next: string; visible: boolean } | null>(`(() => {
      const el = [...document.querySelectorAll('body *')].find((e) => window.__vis(e) && e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(STORAGE_NOTICE_EN)});
      if (!el) return null;
      let next = el.nextElementSibling; while (next && !window.__vis(next)) next = next.nextElementSibling;
      return { text: el.textContent.trim(), next: next?.textContent.trim() ?? '', visible: true }; })()`);
    expect(notice, await page.evaluate<string>('document.body.innerText')).not.toBeNull();
    expect(notice!.next).toBe(FOOTER_EN);
    expect(await japanese(page)).toEqual([]);
    await go(page, '#/history', 'history');
    expect(await japanese(page), '保存できない環境の履歴の画面').toEqual([]);
    noExceptions(page);
  });

  // UI-134
  it('保存できない環境で、設定画面の言語の欄を English に変えるとエラーで止まらずにすぐ英語になり、ほかの画面でも英語のまま', async () => {
    const page = await open({ language: 'ja-JP', hash: '#/settings', screen: 'settings', init: [STORAGE_FAILS] });
    expect(await lang(page)).toBe('ja');
    await chooseLanguage(page, 'English');
    expect(await lang(page)).toBe('en');
    expect(await japanese(page)).toEqual([]);
    await go(page, '#/', 'top');
    expect(await visibleText(page, '[data-screen="top"] a[href="#/play"]')).toBe('Start');
    expect(await japanese(page)).toEqual([]);
    await go(page, '#/history', 'history');
    expect(await japanese(page)).toEqual([]);
    await go(page, '#/settings', 'settings');
    expect((await languageField(page)).value).toBe('English');
    expect(await japanese(page)).toEqual([]);
    noExceptions(page);
  });

  // MODE-57（カードと練習の選択肢）
  it('英語のトップ画面のモードのカードが表の順と英語の説明で並び、フリックの練習の選択肢が英語で出る', async () => {
    const page = await open({ language: 'en-US' });
    const cards = await visibleText(page, '#mode-cards');
    let at = -1;
    for (const [name, description] of MODES_EN) {
      const n = cards.indexOf(name, at + 1);
      expect(n, `${name} が前のカードのあとにない:\n${cards}`).toBeGreaterThan(at);
      const d = cards.indexOf(description, n);
      expect(d, `${name} のカードに ${description} がない:\n${cards}`).toBeGreaterThan(n);
      at = d;
    }
    // 名前の順（Tracking は Tracking + Recoil の先頭にも当たるので、行で比べる）。
    const lines = cards.split('\n').map((l) => l.trim());
    expect(lines.filter((l) => MODES_EN.some(([name]) => name === l))).toEqual(MODES_EN.map(([name]) => name));
    expect(await page.evaluate<string[]>(`[...document.querySelector('#mode').options].map((o) => o.textContent.trim())`)).toEqual(MODES_EN.map(([n]) => n));

    await choose(page, '#mode', 'Flick');
    await page.frames(2);
    const options = await page.evaluate<Record<string, string[]>>(`(() => { const out = {};
      for (const s of document.querySelectorAll('[data-screen="top"] select')) {
        if (!window.__vis(s) || s.id === 'count') continue;
        const label = (s.closest('label')?.textContent ?? '').replace(s.textContent, '').trim();
        out[label] = [...s.options].map((o) => o.textContent.trim()); }
      return out; })()`);
    expect(options).toEqual({ 'Spawn range': ['Near', 'Normal', 'Far'], 'Target size': ['Large', 'Medium', 'Small'] });
    expect(await japanese(page)).toEqual([]);
    noExceptions(page);
  });

  // UI-128・UI-132（リザルト画面の英語の数の書き方）
  it('英語で L-STAR を反復練習で 1 回練習して自己ベストを更新したリザルト画面のシェアの文が、英語のシェアの文の例と一致する', { timeout: 120_000 }, async () => {
    const page = await open({ language: 'en-US' });
    await ghostOnce(page, 'Recoil Drill');
    const m = await metrics(page, 'result');
    expect(metric(m, 'Avg. error')).toBe('0.85°');
    expect(metric(m, 'Hit rate')).toBe('72.0%');
    expect(await screenText(page, 'result')).toContain('New personal best');
    expect(await share(page, 'Share result')).toBe(SHARE_EXAMPLE_EN);
    noExceptions(page);
  });

  // UI-133・UI-132（リザルト画面の日本語の数の書き方）
  it('日本語で反復練習を 1 回終えて保存した履歴が、英語に変えたあとの履歴の画面にそのまま出て、モードの名前が Recoil Drill、指標の名前が英語', { timeout: 120_000 }, async () => {
    const page = await open({ language: 'ja-JP' });
    await ghostOnce(page, '反復練習');
    const m = await metrics(page, 'result');
    expect(metric(m, '平均ズレ')).toBe('0.85°');
    expect(metric(m, '命中率')).toBe('72.0%');
    const saved = await storage(page);
    expect(Object.keys(saved)).toContain(GHOST_HISTORY);

    await go(page, '#/history', 'history');
    const jaList = await visibleText(page, '#history-list');
    expect(jaList).toContain('0.85°');

    await go(page, '#/settings', 'settings');
    await chooseLanguage(page, 'English');
    await go(page, '#/history', 'history');
    expect(await storage(page), '言語を変えても保存は変わらない').toEqual(saved);
    expect(await page.evaluate<string>(`document.querySelector('#history-mode').selectedOptions[0].textContent.trim()`)).toBe('Recoil Drill');
    expect(await page.evaluate<string>(`document.querySelector('#history-weapon').selectedOptions[0].textContent.trim()`)).toBe('L-STAR');
    const enText = await screenText(page, 'history');
    expect(enText).toContain('Recoil Drill');
    const enList = await visibleText(page, '#history-list');
    for (const name of ['Avg. error', 'Hit rate', 'Grouping radius']) expect(enText, `指標の名前 ${name}`).toContain(name);
    expect(enList).toContain('0.85°');
    expect(enList).toContain('72.0%');
    expect(await japanese(page)).toEqual([]);
    noExceptions(page);
  });

  it('UI-132: 同じ履歴を日本語と英語で表示すると、度と割合の書き方は同じで、命中 1 回あたりの時間は日本語が 0.523 秒、英語が 0.523 s', async () => {
    const at = '2026-11-20T03:00:00.000Z';
    const seed = {
      [GHOST_HISTORY]: JSON.stringify({ version: 1, entries: [{ at, meanError: 0.85, hitRate: 72, groupingRadius: 1.2, shots: 25 }] }),
      [FLICK_KEY('history', 'normal', 'medium')]: JSON.stringify({
        version: 1,
        entries: [{ at, timePerHit: 0.523, meanTime: 0.5, hitRate: 72, hits: 18, targets: 20, meanError: 0.85 }],
      }),
    };
    const views: Record<string, { ghost: string; flick: string }> = {};
    for (const [language, flick] of [
      ['ja-JP', 'フリック'],
      ['en-US', 'Flick'],
    ] as const) {
      const page = await open({ language, hash: '#/history', screen: 'history', seed });
      await choose(page, '#history-weapon', LSTAR.name);
      await page.frames(2);
      const ghost = await visibleText(page, '#history-list');
      await choose(page, '#history-mode', flick);
      await page.frames(2);
      views[language] = { ghost, flick: await visibleText(page, '#history-list') };
      noExceptions(page);
    }
    for (const v of Object.values(views)) {
      expect(v.ghost).toContain('0.85°');
      expect(v.ghost).toContain('72.0%');
      expect(v.flick).toContain('72.0%');
      expect(v.flick).toContain('0.85°');
    }
    expect(views['ja-JP']!.flick).toContain('0.523 秒');
    expect(views['en-US']!.flick).toContain('0.523 s');
    expect(views['en-US']!.flick).not.toContain('秒');
  });

  // UI-129・UI-132（英語の秒）・MODE-57（英語で選んだ値で保存される）
  it('英語で出る範囲 Far・的の大きさ Small のフリックを 1 回練習したシェアの文の 2・3 行目が英語の形で、自己ベストと履歴は flick:far:small に保存される', { timeout: 240_000 }, async () => {
    const page = await open({ language: 'en-US', render: true });
    await start(page, { mode: 'Flick', options: [['Spawn range', 'Far'], ['Target size', 'Small']] });
    const startedAt = await now(page);
    const m = newMouse();
    await lock(page, m);
    // 1 個目の的が出る前後の画面写しから的の色を求める。
    await advanceTo(page, startedAt + 1 - 0.03);
    const before = await page.screenshot();
    await advanceTo(page, startedAt + 1 + 0.05);
    if (!targetColor) await learnTargetColor(before, await page.screenshot());
    // 20 個の的に合わせて、出てから 0.5 秒で撃つ。
    let appear = startedAt + 1;
    for (let i = 0; i < 20; i += 1) {
      if ((await now(page)) < appear + 1 / 60) await advanceTo(page, appear + 1 / 60);
      await aimAtTarget(page, m);
      const fireAt = appear + 0.5 - DT / 2;
      if ((await now(page)) > fireAt) throw new Error(`${i + 1} 個目の的に合わせ終える前に撃つ時刻を過ぎた`);
      await advanceTo(page, fireAt);
      await click(page, m);
      appear += 0.5;
    }
    await untilResult(page);
    const r = await metrics(page, 'result');
    expect(metric(r, 'Time per hit')).toMatch(/^\d+\.\d{3} s$/);
    expect(metric(r, 'Hit rate')).toMatch(/^\d+\.\d%$/);
    expect(await japanese(page)).toEqual([]);
    expect(await footer(page)).toContain(FOOTER_EN);

    const lines = (await share(page, 'Share result')).split('\n');
    expect(lines[0]).toBe('Hyper Aim Training (unofficial fan tool) result');
    expect(lines[1]).toBe('Mode: Flick / Spawn range: Far / Target size: Small');
    expect(lines[2]).toMatch(/^Time per hit: \d+\.\d{3} s \/ Hit rate: \d+\.\d%$/);
    expect(lines[2]).toContain(`Time per hit: ${metric(r, 'Time per hit')}`);

    const s = await storage(page);
    expect(Object.keys(s).sort()).toEqual([FLICK_KEY('best', 'far', 'small'), FLICK_KEY('history', 'far', 'small')].sort());
    noExceptions(page);
  });

  // UI-127・OVR-28
  describe('英語のとき、どの画面にもひらがな・カタカナ・漢字がなく、フッターが英語の非公式の表記', () => {
    it('計測の同意の案内・トップ（フリックの選択肢を含む）・設定・パッドのキャリブレーション・パッドのボタン割り当て', async () => {
      const page = await open({ language: 'en-US', consent: null, pad: true });
      expect(await page.evaluate<boolean>(`window.__vis('#consent-banner')`), '計測の同意の案内が出る').toBe(true);
      expect(await japanese(page)).toEqual([]);
      expect(await footer(page)).toContain(FOOTER_EN);
      await page.clickSelector('#consent-deny');
      await page.waitFor(`!window.__vis('#consent-banner')`);
      for (const mode of ['Tracking', 'Tracking + Recoil', 'Flick', 'Recoil Drill']) {
        await choose(page, '#mode', mode);
        await page.frames(2);
        expect(await japanese(page), `トップ画面（${mode}）`).toEqual([]);
      }
      await go(page, '#/settings', 'settings');
      expect(await japanese(page), '設定').toEqual([]);
      expect(await footer(page)).toContain(FOOTER_EN);
      await go(page, '#/settings/pad', 'settings-pad');
      expect(await japanese(page), 'パッドのキャリブレーション').toEqual([]);
      await go(page, '#/settings/pad/mapping', 'settings-pad-mapping');
      expect(await japanese(page), 'パッドのボタン割り当て').toEqual([]);
      noExceptions(page);
    });

    it('履歴（反復練習・フリック・消す確認・履歴がない組）', async () => {
      const at = '2026-11-20T03:00:00.000Z';
      const entries = Array.from({ length: 3 }, () => ({ at, meanError: 0.85, hitRate: 72, groupingRadius: 1.2, shots: 25 }));
      const page = await open({
        language: 'en-US',
        hash: '#/history',
        screen: 'history',
        seed: {
          [GHOST_HISTORY]: JSON.stringify({ version: 1, entries }),
          [FLICK_KEY('history', 'normal', 'medium')]: JSON.stringify({
            version: 1,
            entries: [{ at, timePerHit: 0.523, meanTime: 0.5, hitRate: 72, hits: 18, targets: 20, meanError: 0.85 }],
          }),
        },
      });
      await choose(page, '#history-weapon', LSTAR.name);
      await page.frames(2);
      expect(await visibleText(page, '#history-list')).toContain('0.85°');
      expect(await japanese(page), '履歴（反復練習）').toEqual([]);
      expect(await footer(page)).toContain(FOOTER_EN);
      await page.clickSelector('#history-clear');
      await page.waitFor(`window.__vis('#history-confirm')`);
      expect(await japanese(page), '消す確認').toEqual([]);
      await page.clickSelector('#history-confirm-cancel');
      await page.waitFor(`!window.__vis('#history-confirm')`);
      for (const mode of ['Flick', 'Tracking', 'Tracking + Recoil']) {
        await choose(page, '#history-mode', mode);
        await page.frames(2);
        expect(await japanese(page), `履歴（${mode}）`).toEqual([]);
      }
      noExceptions(page);
    });

    it('プレイ（反復練習）・回数 5 の短いリザルト・セットのまとめ・リザルト', { timeout: 180_000 }, async () => {
      const page = await open({ language: 'en-US' });
      await start(page, { mode: 'Recoil Drill', weapon: LSTAR.name, count: 5 });
      expect(await japanese(page), 'プレイ（ポインターロック前）').toEqual([]);
      const m = newMouse();
      await ghostRound(page, m);
      await page.waitFor('window.__interlude()', 5000);
      await page.frames(2);
      expect(await japanese(page), '短いリザルト').toEqual([]);
      await key(page, 'space');
      await ghostRound(page, m);
      await page.waitFor('window.__interlude()', 5000);
      await page.frames(2);
      expect(await japanese(page), '2 回目の短いリザルト').toEqual([]);
      // 短いリザルトで Q を押してセットをやめ、セットのまとめを表示する。
      await key(page, 'q');
      await page.evaluate('document.pointerLockElement && document.exitPointerLock()');
      await page.waitFor(`location.hash === '#/set-result' && window.__vis('[data-screen="set-result"]')`);
      await page.frames(2);
      expect(await japanese(page), 'セットのまとめ').toEqual([]);
      expect(await footer(page)).toContain(FOOTER_EN);

      await ghostOnce(page, 'Recoil Drill');
      expect(await japanese(page), 'リザルト').toEqual([]);
      expect(await footer(page)).toContain(FOOTER_EN);
      noExceptions(page);
    });

    it('プレイ（追いエイム・追いエイム＋リコイル・フリック）', { timeout: 120_000 }, async () => {
      for (const mode of ['Tracking', 'Tracking + Recoil', 'Flick']) {
        const page = await open({ language: 'en-US' });
        await start(page, mode === 'Tracking + Recoil' ? { mode, weapon: LSTAR.name } : { mode });
        expect(await japanese(page), `プレイ（${mode}、ポインターロック前）`).toEqual([]);
        const m = newMouse();
        await lock(page, m);
        await page.advanceClock(1.2);
        await page.frames(2);
        expect(await japanese(page), `プレイ（${mode}）`).toEqual([]);
        if (mode === 'Flick') expect(await screenText(page, 'play')).toContain('Targets: 0 / 20');
        noExceptions(page);
      }
    });
  });
});
