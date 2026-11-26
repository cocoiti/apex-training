// docs/spec/screens.md「トップ画面」（UI-10・UI-117〜UI-124）と docs/spec/modes.md「モードの登録」（MODE-56）の
// ブラウザで確かめる受け入れテスト。QA が SPEC だけから書いたもの。
// 公開された入口（ビルドの結果を /apex-training/ で配信した画面、武器の JSON、SPEC に書かれた localStorage のキーと値の形、
// モードの共通の型 TrainingMode）だけを使い、実装の内部には依存しない。
//
// カードは画面で観察できる形で読む。画面を開いて確かめたところ、武器とモードのカードの並びはそれぞれ
// role="radiogroup"（aria-label が「武器」「モード」）で、カード 1 枚は role="radio"（選ばれているものは aria-checked="true"）。
// 「選ばれた表示」は aria-checked に加えて、カードの計算済みのスタイル（枠の色・太さと背景の色）が、ほかのカードと違うかで読む。
// パッドのフォーカスを置いた項目には pad-focus のクラスが付く（pad-navigation-qa と同じ読み方）。並び全体を囲む枠は、
// 並びの要素の計算済みのスタイル（outline・box-shadow・枠）が、フォーカスのないときから変わり、並びの矩形がすべてのカードを囲むかで読む。
// MODE-56 はリポジトリの写しにモードのファイルを 1 つ足してビルドし、その画面で確かめる。
// 3D は描画せずに開く（render=off）。Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
/** ページを開く練習の乱数の種（docs/spec/architecture.md「テストのための乱数の種の固定」）。テストが失敗したときのメッセージにも出る。 */
const SEED = 12345;
const chromium = findChromium();

interface WeaponJson {
  id: string;
  name: string;
  category: string;
  measured: boolean;
}
const WEAPON_FILES: WeaponJson[] = readdirSync(join(ROOT, 'src/data/weapons'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(ROOT, 'src/data/weapons', f), 'utf8')) as WeaponJson);
/** 武器の一覧（weapons.md）: 計測した武器データだけ。仮データ（measured が true でない）は入らない。 */
const WEAPONS = WEAPON_FILES.filter((w) => w.measured === true);
const PROVISIONAL = WEAPON_FILES.filter((w) => w.measured !== true);

/** SPEC の値と文言（modes.md「モードの登録」の表）。 */
const MODES = [
  { name: '反復練習', description: '同じ武器のリコイルを繰り返し撃って、パターンを手に覚えさせる' },
  { name: '追いエイム', description: '左右に動く的に照準を乗せ続ける' },
  { name: '追いエイム＋リコイル', description: 'リコイルを抑えながら、動く的に照準を乗せ続ける' },
  { name: 'フリック', description: 'ランダムに出る的へ素早く照準を合わせて撃つ' },
];
const REPEAT = '反復練習';
const FLICK = 'フリック';
const LSTAR = 'L-STAR';
const CAR = 'C.A.R. SMG';
const NO_RECORD = '自己ベスト: まだ記録なし';
const LSTAR_GHOST_BEST = 'apex-training:best:mouse:lstar:ghost';

/** MODE-56: 足すモード（共通の型 TrainingMode を default で export する）。並び順はいちばん後ろ。 */
const EXTRA_NAME = '受け入れのカードのモード';
const EXTRA_DESCRIPTION = '受け入れテストで足したカードのひとこと説明';
const EXTRA_MODE = `import type { TrainingMode } from '../types';

const mode: TrainingMode = {
  id: 'acceptance-card',
  name: '${EXTRA_NAME}',
  description: '${EXTRA_DESCRIPTION}',
  icon: 'flick',
  category: 'recoil',
  order: 100000,
  setup() {},
  step() {
    return true;
  },
  result() {
    return {};
  },
  teardown() {},
};

export default mode;
`;

/** パッドの標準配置のボタン番号。 */
const DOWN = 13;
const RIGHT = 15;

// ---------------------------------------------------------------------------
// ページに入れるスクリプト
// ---------------------------------------------------------------------------

const PAGE_INIT = `
  window.__vis = (el) => !!el && !el.closest('[hidden]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0;
  window.__top = () => document.querySelector('[data-screen="top"]');
  window.__group = (label) => window.__top().querySelector('[role="radiogroup"][aria-label="' + label + '"]');
  window.__cards = (label) => { const g = window.__group(label); return g ? [...g.querySelectorAll('[role="radio"]')] : []; };
  window.__look = (el) => { const s = getComputedStyle(el);
    return { border: s.borderTopStyle + ' ' + s.borderTopWidth + ' ' + s.borderTopColor, background: s.backgroundColor + ' ' + s.backgroundImage,
      outline: s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineColor, shadow: s.boxShadow }; };
  /** モードのカードの名前: 表の名前のうち、カードの文字に含まれるいちばん長いもの（「追いエイム」は「追いエイム＋リコイル」に含まれるため）。 */
  window.__cardName = (card, names) => names.filter((n) => card.textContent.includes(n)).sort((a, b) => b.length - a.length)[0] ?? '';
  window.__focused = () => { const els = [...document.querySelectorAll('.pad-focus')]; return els.length === 1 ? els[0] : null; };
`;

/** 標準配置のパッド 1 台。__btn(番号, 押す) で操作する。 */
const FAKE_PAD = `
  window.__pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) };
  navigator.getGamepads = () => [{ id: 'acceptance pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard',
    timestamp: performance.now(), axes: window.__pad.axes.slice(), buttons: window.__pad.buttons.map((b) => ({ ...b })), vibrationActuator: null }];
  window.__btn = (i, on) => { window.__pad.buttons[i] = { value: on ? 1 : 0, pressed: on, touched: on }; };
`;

const TOP_READY = `window.__vis(window.__top()) && window.__cards('モード').length > 0 && (window.__cards('武器').length > 0 || !window.__vis(window.__group('武器')))`;

// ---------------------------------------------------------------------------
// 画面の読み取りと操作
// ---------------------------------------------------------------------------

/**
 * 見た目を読む前に、マウスを並びの外へ動かし（ホバーの見た目を除く）、色の移り変わり（CSS の transition）が終わるまで待つ。
 * 選んだ直後は枠や背景の色が移り変わる途中のことがあるため。
 */
async function settle(page: Page, { mouse = true } = {}) {
  if (mouse) await page.moveMouse(0, 0);
  await page.waitFor(`document.getAnimations().every((a) => a.playState !== 'running')`);
  await page.frames(2);
}

interface CardView {
  text: string;
  checked: boolean;
  border: string;
  background: string;
  visible: boolean;
}
/** カードの見た目を読む。padOnly ならマウスに触れずに読む（パッドだけで操作するテスト）。 */
const cards = async (page: Page, label: '武器' | 'モード', { padOnly = false } = {}) => {
  await settle(page, { mouse: !padOnly });
  return readCards(page, label);
};
const readCards = (page: Page, label: '武器' | 'モード') =>
  page.evaluate<CardView[]>(`window.__cards(${JSON.stringify(label)}).map((c) => { const l = window.__look(c);
    return { text: c.textContent.replace(/\\s+/g, ' ').trim(), checked: c.getAttribute('aria-checked') === 'true', border: l.border, background: l.background, visible: window.__vis(c) }; })`);

const modeNames = (page: Page, names = MODES.map((m) => m.name)) =>
  page.evaluate<string[]>(`window.__cards('モード').map((c) => window.__cardName(c, ${JSON.stringify(names)}))`);

/** 名前を含むカード（モードは名前が一致するもの）をマウスでクリックする。 */
async function clickCard(page: Page, label: '武器' | 'モード', name: string) {
  const box = await page.evaluate<{ x: number; y: number } | null>(`(() => {
    const names = ${JSON.stringify([...MODES.map((m) => m.name), EXTRA_NAME])};
    const c = window.__cards(${JSON.stringify(label)}).find((x) => ${JSON.stringify(label)} === 'モード' ? window.__cardName(x, names) === ${JSON.stringify(name)} : x.textContent.trim() === ${JSON.stringify(name)});
    if (!c) return null; c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!box) throw new Error(`${label} のカードがない: ${name}`);
  await page.click(box.x, box.y);
}

/**
 * 選ばれた表示: 選ばれたカードがちょうど 1 枚で aria-checked が付き、その枠と背景がほかのどのカードとも違い、
 * ほかのカードどうしは同じ見た目（選ばれていない表示）であること。選ばれたカードの文字を返す。
 */
function expectOneSelected(list: CardView[], context: string): CardView {
  const selected = list.filter((c) => c.checked);
  expect(selected.length, `${context}: ${JSON.stringify(list)}`).toBe(1);
  const s = selected[0]!;
  const others = list.filter((c) => !c.checked);
  for (const o of others) {
    expect(o.border, `${context}: 選ばれたカードと「${o.text}」の枠が同じ`).not.toBe(s.border);
    expect(o.background, `${context}: 選ばれたカードと「${o.text}」の背景が同じ`).not.toBe(s.background);
  }
  if (others.length > 1) {
    for (const o of others) {
      expect(o.border, `${context}: 選ばれていないカードの枠`).toBe(others[0]!.border);
      expect(o.background, `${context}: 選ばれていないカードの背景`).toBe(others[0]!.background);
    }
  }
  return s;
}

const hud = (page: Page, k: string) =>
  page.evaluate<string>(`(() => { const el = document.querySelector('[data-hud="${k}"]'); return el && window.__vis(el) ? el.textContent.trim() : ''; })()`);

async function key(page: Page, name: 'Tab' | 'ArrowRight') {
  const code = { Tab: 9, ArrowRight: 39 }[name];
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  }
}

async function padTap(page: Page, b: number) {
  await page.evaluate(`window.__btn(${b}, true)`);
  await page.frames(3);
  await page.evaluate(`window.__btn(${b}, false)`);
  await page.frames(3);
}

// ---------------------------------------------------------------------------

describe.skipIf(!chromium || NESTED)('トップ画面のカード（UI-10・UI-117〜UI-124・MODE-56）', () => {
  let work = '';
  let server: Server | undefined;
  let extraServer: Server | undefined;
  let origin = '';
  let extraOrigin = '';
  let browser: Browser | undefined;
  /** 配信したサーバーが受けた要求のパス（UI-124）。 */
  let requests: string[] = [];

  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));
  const noExceptions = (page: Page) => expect(exceptions(page), page.errors.join('\n')).toEqual([]);

  /** 新しいタブで localStorage を空にし（seed を入れ）、読み込み直したトップ画面を開く。 */
  async function openFresh(opts: { seed?: Record<string, string>; pad?: boolean; width?: number; at?: string; render?: boolean; init?: string } = {}): Promise<Page> {
    const page = await browser!.newPage();
    if (opts.width) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: opts.width, height: 800, deviceScaleFactor: 1, mobile: false });
    }
    const url = appUrl(opts.at ?? origin, BASE, '#/', { render: opts.render ?? false, seed: SEED });
    await page.goto(url);
    await page.evaluate(`(() => { localStorage.clear(); const seed = ${JSON.stringify(opts.seed ?? {})}; for (const k in seed) localStorage.setItem(k, seed[k]); })()`);
    await page.addInitScript(PAGE_INIT);
    if (opts.pad) await page.addInitScript(FAKE_PAD);
    if (opts.init) await page.addInitScript(opts.init);
    await page.evaluate(`window.__beforeReload = true`);
    await page.send('Page.reload', { ignoreCache: false });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && ${TOP_READY}`, 15_000);
    return page;
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'top-cards-qa-'));
    const env = { ...process.env, APEX_ACCEPTANCE_NESTED: '1', FORCE_COLOR: '0' };
    const dist = join(work, 'dist');
    const build = spawnSync(`npm run build -- --outDir "${dist}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8', env });
    if (build.status !== 0) throw new Error(`ビルドが失敗した:\n${build.stdout}${build.stderr}`);

    // MODE-56: リポジトリの写しにモードのファイルを 1 つだけ足してビルドする（ほかのファイルは変えない）。
    const copy = join(work, 'copy');
    for (const entry of ['src', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'eslint.config.js', 'scripts']) {
      if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
    }
    symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), 'dir');
    writeFileSync(join(copy, 'src/modes/recoil/acceptance-card.ts'), EXTRA_MODE);
    const extraDist = join(work, 'extra-dist');
    const r = spawnSync(`npm run build -- --outDir "${extraDist}" --emptyOutDir`, { cwd: copy, shell: true, encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(`モードを足した写しのビルドが失敗した:\n${r.stdout}${r.stderr}`);

    server = await serveStatic(dist, BASE);
    server.prependListener('request', (req: IncomingMessage) => requests.push(req.url ?? ''));
    origin = originOf(server);
    extraServer = await serveStatic(extraDist, BASE);
    extraOrigin = originOf(extraServer);
    browser = await launchBrowser(chromium!);
  }, 300_000);

  afterEach(async () => {
    await browser?.closePages();
  });

  afterAll(async () => {
    await browser?.close();
    for (const s of [server, extraServer]) await new Promise((ok) => (s ? s.close(ok) : ok(undefined)));
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('UI-10: 武器のカードが category ごとの見出しの下にまとまり、一覧のすべての武器がカードに出て、仮データの武器のカードは出ない', async () => {
    const page = await openFresh();
    // 並びの中の見出しとカードを文書の順に読み、各カードを直前の見出しに割り当てる。
    const groups = await page.evaluate<{ heading: string; names: string[] }[]>(`(() => {
      const g = window.__group('武器'); const out = []; let cur = null; const loose = [];
      for (const el of g.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"], [role="radio"]')) {
        if (el.getAttribute('role') === 'radio') { if (!window.__vis(el)) continue; if (cur) cur.names.push(el.textContent.trim()); else loose.push(el.textContent.trim()); }
        else if (window.__vis(el)) { cur = { heading: el.textContent.trim(), names: [] }; out.push(cur); }
      }
      if (loose.length) out.unshift({ heading: '', names: loose });
      return out; })()`);
    // すべてのカードが見出しの下にある。見出しは category ごとに 1 つ。
    expect(groups.every((g) => g.heading !== ''), JSON.stringify(groups)).toBe(true);
    const categories = [...new Set(WEAPONS.map((w) => w.category))];
    expect(groups.map((g) => g.heading).sort()).toEqual(categories.slice().sort());
    for (const g of groups) {
      expect(g.names.slice().sort(), g.heading).toEqual(WEAPONS.filter((w) => w.category === g.heading).map((w) => w.name).sort());
    }
    // 一覧のすべての武器が 1 枚ずつ出て、仮データの武器は出ない。
    const all = groups.flatMap((g) => g.names);
    expect(all.slice().sort()).toEqual(WEAPONS.map((w) => w.name).sort());
    expect(PROVISIONAL.length).toBeGreaterThan(0);
    for (const w of PROVISIONAL) expect(all).not.toContain(w.name);
    // 選べる武器は 1 つ（選ばれたカードが 1 枚）。
    expectOneSelected(await cards(page, '武器'), '開いたとき');
    noExceptions(page);
  });

  it('UI-117: モードのカードが登録の順に並び、名前・説明・アイコンを持ち、反復練習が選ばれ、フリックをクリックすると選び直される', async () => {
    const page = await openFresh();
    expect(await modeNames(page)).toEqual(MODES.map((m) => m.name));
    const list = await cards(page, 'モード');
    for (const [i, m] of MODES.entries()) {
      expect(list[i]!.visible, m.name).toBe(true);
      expect(list[i]!.text, m.name).toContain(m.description);
    }
    // アイコン: 各カードに、見えている大きさのある自作の図（SVG）があり、モードごとに形が違う。
    const icons = await page.evaluate<{ size: number; shape: string }[]>(`window.__cards('モード').map((c) => {
      const svg = [...c.querySelectorAll('svg')].find((s) => window.__vis(s));
      if (!svg) return { size: 0, shape: '' };
      const r = svg.getBoundingClientRect();
      return { size: Math.min(r.width, r.height), shape: [...svg.querySelectorAll('*')].map((e) => e.tagName + JSON.stringify([...e.attributes].filter((a) => !/^(class|data-|aria-)/.test(a.name)).map((a) => a.name + '=' + a.value))).join('|') };
    })`);
    for (const [i, icon] of icons.entries()) {
      expect(icon.size, `${MODES[i]!.name} のアイコンの大きさ`).toBeGreaterThan(8);
      expect(icon.shape, `${MODES[i]!.name} のアイコンの形`).not.toBe('');
    }
    expect(new Set(icons.map((x) => x.shape)).size, 'モードごとに違う形').toBe(MODES.length);

    // 開いたときは反復練習が選ばれた表示。
    const first = expectOneSelected(list, '開いたとき');
    expect(first.text).toContain(REPEAT);
    expect(first.text).not.toContain('追いエイム');
    const unselectedLook = list.find((c) => !c.checked)!;

    // フリックをクリックすると、フリックが選ばれた表示になり、反復練習は選ばれていない表示に戻る。
    await clickCard(page, 'モード', FLICK);
    await page.waitFor(`window.__cards('モード')[3]?.getAttribute('aria-checked') === 'true'`);
    const after = await cards(page, 'モード');
    const s = expectOneSelected(after, 'フリックをクリックしたあと');
    expect(s.text).toContain(FLICK);
    expect(s.border).toBe(first.border);
    expect(s.background).toBe(first.background);
    expect(after[0]!.checked).toBe(false);
    expect(after[0]!.border).toBe(unselectedLook.border);
    expect(after[0]!.background).toBe(unselectedLook.background);
    noExceptions(page);
  });

  it('UI-118: L-STAR のカードをクリックすると選ばれた表示になり（C.A.R. SMG は戻り）、「開始」で HUD に L-STAR と出て練習が始まる', async () => {
    const page = await openFresh();
    const before = await cards(page, '武器');
    expect(expectOneSelected(before, '開いたとき').text).toBe(CAR);
    await clickCard(page, '武器', LSTAR);
    await page.waitFor(`window.__cards('武器').find((c) => c.textContent.trim() === ${JSON.stringify(LSTAR)})?.getAttribute('aria-checked') === 'true'`);
    const after = await cards(page, '武器');
    expect(expectOneSelected(after, 'L-STAR をクリックしたあと').text).toBe(LSTAR);
    const car = after.find((c) => c.text === CAR)!;
    expect(car.checked).toBe(false);
    const carBefore = before.find((c) => c.text === CAR)!;
    const lstarBefore = before.find((c) => c.text === LSTAR)!;
    // C.A.R. SMG は、開いたときの L-STAR（選ばれていない表示）と同じ見た目に戻る。
    expect(car.border).toBe(lstarBefore.border);
    expect(car.background).toBe(lstarBefore.background);
    expect(after.find((c) => c.text === LSTAR)!.border).toBe(carBefore.border);

    await page.clickSelector('[data-screen="top"] a[href="#/play"]');
    await page.waitFor(`location.hash === '#/play'`);
    await page.waitFor(`(document.querySelector('[data-hud="weapon"]')?.textContent ?? '').includes(${JSON.stringify(LSTAR)})`);
    expect(await hud(page, 'weapon')).toContain(LSTAR);
    expect(await hud(page, 'weapon')).not.toContain(CAR);
    noExceptions(page);
  });

  it('UI-119: L-STAR の反復練習の自己ベスト 0.85 度があるとき反復練習のカードに「自己ベスト: 0.85°」、ない武器では「まだ記録なし」。記録がないときはすべて「まだ記録なし」', async () => {
    // 自己ベストを 1 つも保存していないとき。
    const empty = await openFresh();
    const emptyCards = await cards(empty, 'モード');
    expect(emptyCards.length).toBe(MODES.length);
    for (const c of emptyCards) expect(c.text, c.text).toContain(NO_RECORD);
    noExceptions(empty);

    // マウスの L-STAR と反復練習の自己ベスト（scoring.md「保存の形」）。
    const best = JSON.stringify({ version: 1, meanError: 0.85, groupingRadius: 1.2, hitRate: 80, shots: 40, achievedAt: '2026-11-26T00:00:00.000Z' });
    const page = await openFresh({ seed: { [LSTAR_GHOST_BEST]: best } });
    // 最初の武器（C.A.R. SMG）では記録なし。
    expect((await cards(page, 'モード'))[0]!.text).toContain(NO_RECORD);
    await clickCard(page, '武器', LSTAR);
    await page.waitFor(`window.__cards('モード')[0].textContent.includes('自己ベスト: 0.85°')`);
    const withBest = await cards(page, 'モード');
    expect(withBest[0]!.text).toContain('自己ベスト: 0.85°');
    expect(withBest[0]!.text).not.toContain(NO_RECORD);
    for (const c of withBest.slice(1)) {
      if (c.text.includes('追いエイム') || c.text.includes(FLICK)) expect(c.text, c.text).toContain(NO_RECORD);
    }
    // 自己ベストのない武器に変えると「まだ記録なし」に変わる。
    await clickCard(page, '武器', CAR);
    await page.waitFor(`window.__cards('モード')[0].textContent.includes(${JSON.stringify(NO_RECORD)})`);
    expect((await cards(page, 'モード'))[0]!.text).not.toContain('0.85');
    noExceptions(page);
  });

  it('UI-119: 3D の描画（WebGL）が使えない環境でも、モードのカードに自己ベストの要約が出る', async () => {
    // GPU のないヘッドレスの Chromium のように、WebGL のコンテキストが作れない状態にする。
    const noWebGL = `(() => { const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) { return /webgl/.test(String(type)) ? null : get.call(this, type, ...rest); }; })()`;
    const page = await openFresh({ render: true, init: noWebGL });
    await page.waitFor(`window.__cards('モード').every((c) => c.textContent.includes(${JSON.stringify(NO_RECORD)}))`);
    for (const c of await cards(page, 'モード')) expect(c.text, c.text).toContain(NO_RECORD);
  });

  it('UI-120: パッドだけでモードの並びにフォーカスを移すと並び全体を囲む枠が出て、右で 1 枚ずつ移って最後で止まり、下で次の項目に移る', async () => {
    const page = await openFresh({ pad: true });
    const unfocusedGroup = await page.evaluate<Record<string, string>>(`window.__look(window.__group('モード'))`);
    const seen: string[] = [];
    let reached = false;
    for (let i = 0; i < 12 && !reached; i += 1) {
      await padTap(page, DOWN);
      reached = await page.evaluate<boolean>(`window.__focused() === window.__group('モード')`);
      seen.push(await page.evaluate<string>(`(() => { const f = window.__focused(); return f ? (f.getAttribute('aria-label') || f.id || f.textContent.trim().slice(0, 20)) : ''; })()`));
    }
    expect(reached, `十字キーの下でモードの並びにフォーカスが来ない: ${seen.join(' → ')}`).toBe(true);
    // フォーカスで選んでいるモードは変わらない。
    expect(expectOneSelected(await cards(page, 'モード', { padOnly: true }), 'フォーカスを移したとき').text).toContain(REPEAT);

    // 並び全体を囲む枠: 並びの要素の見た目がフォーカスのないときから変わり、並びの矩形がすべてのカードを囲む。
    await settle(page, { mouse: false });
    const frame = await page.evaluate<{ look: Record<string, string>; encloses: boolean; selectedLook: Record<string, string> }>(`(() => {
      const g = window.__group('モード'); const r = g.getBoundingClientRect();
      const encloses = window.__cards('モード').every((c) => { const b = c.getBoundingClientRect();
        return b.left >= r.left - 0.5 && b.right <= r.right + 0.5 && b.top >= r.top - 0.5 && b.bottom <= r.bottom + 0.5; });
      const sel = window.__cards('モード').find((c) => c.getAttribute('aria-checked') === 'true');
      return { look: window.__look(g), encloses, selectedLook: window.__look(sel) }; })()`);
    const visibleFrame = (l: Record<string, string>) =>
      (!l.outline!.startsWith('none') && !/ 0px /.test(l.outline!)) || l.shadow !== 'none' || (!l.border!.startsWith('none') && !/ 0px /.test(l.border!));
    expect(frame.look, JSON.stringify({ unfocusedGroup, focused: frame.look })).not.toEqual(unfocusedGroup);
    expect(visibleFrame(frame.look), JSON.stringify(frame.look)).toBe(true);
    expect(frame.encloses).toBe(true);
    // 選んでいるカードの表示と見分けられる（枠の形が選ばれたカードの枠と同じではない）。
    expect(`${frame.look.outline} / ${frame.look.shadow} / ${frame.look.border}`).not.toBe(
      `${frame.selectedLook.outline} / ${frame.selectedLook.shadow} / ${frame.selectedLook.border}`,
    );

    // 十字キーの右で 1 枚ずつ移り、最後のカード（フリック）で止まる。
    const order: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      await padTap(page, RIGHT);
      const s = (await cards(page, 'モード', { padOnly: true })).filter((c) => c.checked);
      expect(s.length).toBe(1);
      order.push((await page.evaluate<string>(`window.__cardName(window.__cards('モード').find((c) => c.getAttribute('aria-checked') === 'true'), ${JSON.stringify(MODES.map((m) => m.name))})`)));
      expect(await page.evaluate<boolean>(`window.__focused() === window.__group('モード')`), `右 ${i + 1} 回目のあともモードの並びにフォーカス`).toBe(true);
    }
    expect(order).toEqual(['追いエイム', '追いエイム＋リコイル', FLICK, FLICK]);

    // 十字キーの下で、フォーカスがモードの並びのあとの次の項目に移る。
    await padTap(page, DOWN);
    const next = await page.evaluate<{ isMode: boolean; after: boolean; visible: boolean; text: string }>(`(() => {
      const f = window.__focused(); const g = window.__group('モード');
      if (!f) return { isMode: false, after: false, visible: false, text: '' };
      return { isMode: f === g, after: !!(g.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING) && !g.contains(f), visible: window.__vis(f),
        text: (f.closest('label')?.textContent ?? f.textContent).replace(/\\s+/g, ' ').trim().slice(0, 40) }; })()`);
    expect(next.isMode).toBe(false);
    expect(next.after, JSON.stringify(next)).toBe(true);
    expect(next.visible).toBe(true);
    // フリックでは、モードの並びの次の項目は「出る範囲」の欄（screens.md「並びと見た目」の順）。
    expect(next.text, JSON.stringify(next)).toContain('出る範囲');
    // フォーカスが離れた並びは、フォーカスのないときの見た目に戻る。
    await settle(page, { mouse: false });
    expect(await page.evaluate<Record<string, string>>(`window.__look(window.__group('モード'))`)).toEqual(unfocusedGroup);
    noExceptions(page);
  });

  it('UI-121: 武器のカードの並びにフォーカスがあるとき、キーボードの右の矢印キーで並びの順の次の武器が選ばれる', async () => {
    const page = await openFresh();
    let focused = false;
    for (let i = 0; i < 20 && !focused; i += 1) {
      await key(page, 'Tab');
      focused = await page.evaluate<boolean>(`(() => { const g = window.__group('武器'); return !!document.activeElement && (document.activeElement === g || g.contains(document.activeElement)); })()`);
    }
    expect(focused, 'Tab で武器のカードの並びにフォーカスが移らない').toBe(true);
    const before = await cards(page, '武器');
    const order = before.map((c) => c.text);
    const i = order.indexOf(expectOneSelected(before, 'フォーカスしたとき').text);
    expect(i).toBeLessThan(order.length - 1);
    await key(page, 'ArrowRight');
    await page.waitFor(`window.__cards('武器')[${i + 1}]?.getAttribute('aria-checked') === 'true'`);
    expect(expectOneSelected(await cards(page, '武器'), '右の矢印キーのあと').text).toBe(order[i + 1]);
    noExceptions(page);
  });

  it('UI-122: 幅 375px で反復練習とフリックのどちらでも横のスクロールが出ず、どの要素も画面の幅からはみ出さず、フッターに非公式の表記が出る', async () => {
    const page = await openFresh({ width: 375 });
    const check = async (context: string) => {
      await page.frames(2);
      const r = await page.evaluate<{ inner: number; docWidth: number; bodyWidth: number; over: string[]; footer: string }>(`(() => {
        const inner = window.innerWidth;
        const over = [];
        for (const el of document.querySelectorAll('[data-screen="top"] *, footer, footer *')) {
          if (!window.__vis(el)) continue;
          const b = el.getBoundingClientRect();
          if (b.width === 0 && b.height === 0) continue;
          if (b.right > inner + 0.5 || b.left < -0.5) over.push((el.id || el.className || el.tagName) + ' ' + Math.round(b.left) + '..' + Math.round(b.right));
        }
        const footer = [...document.querySelectorAll('footer')].filter((f) => window.__vis(f)).map((f) => f.textContent).join(' ');
        return { inner, docWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, over, footer }; })()`);
      expect(r.inner, context).toBe(375);
      expect(r.docWidth, `${context}: 文書の幅`).toBeLessThanOrEqual(r.inner);
      expect(r.bodyWidth, `${context}: body の幅`).toBeLessThanOrEqual(r.inner);
      expect(r.over, `${context}: はみ出す要素`).toEqual([]);
      expect(r.footer, context).toContain('非公式ファンツール');
    };
    await check('反復練習');
    expect(expectOneSelected(await cards(page, 'モード'), '幅 375px').text).toContain(REPEAT);
    await clickCard(page, 'モード', FLICK);
    await page.waitFor(`window.__cards('モード')[3]?.getAttribute('aria-checked') === 'true'`);
    await page.evaluate(`window.scrollTo(0, 0)`);
    await check('フリック');
    noExceptions(page);
  });

  it('UI-123: 「開始」のボタンの幅・高さ・文字の大きさが「設定」「履歴」のリンクより大きい', async () => {
    const page = await openFresh();
    const sizes = await page.evaluate<Record<string, { w: number; h: number; font: number } | null>>(`(() => {
      const els = [...window.__top().querySelectorAll('a, button')].filter((e) => window.__vis(e));
      const pick = (t) => { const e = els.find((x) => x.textContent.trim() === t); if (!e) return null; const r = e.getBoundingClientRect();
        return { w: r.width, h: r.height, font: parseFloat(getComputedStyle(e).fontSize) }; };
      return { start: pick('開始'), settings: pick('設定'), history: pick('履歴') }; })()`);
    expect(sizes.start, JSON.stringify(sizes)).not.toBeNull();
    for (const k of ['settings', 'history']) {
      const o = sizes[k];
      expect(o, k).not.toBeNull();
      expect(sizes.start!.w, `${k} の幅`).toBeGreaterThan(o!.w);
      expect(sizes.start!.h, `${k} の高さ`).toBeGreaterThan(o!.h);
      expect(sizes.start!.font, `${k} の文字の大きさ`).toBeGreaterThan(o!.font);
    }
    noExceptions(page);
  });

  it('UI-124: トップ画面を表示し終えるまでに、ほかのオリジンからの読み込みも、フォントとラスタ画像のファイルの読み込みもない', async () => {
    const page = await browser!.newPage();
    requests = [];
    await page.addInitScript(PAGE_INIT);
    await page.goto(appUrl(origin, BASE, '#/', { render: false, seed: SEED }));
    await page.waitFor(TOP_READY, 15_000);
    await page.evaluate(`document.fonts.ready.then(() => true)`);
    await page.frames(5);
    const loaded = await page.evaluate<{ origin: string; resources: { name: string; type: string }[]; fonts: string[]; images: string[] }>(`(() => ({
      origin: location.origin,
      resources: performance.getEntriesByType('resource').map((e) => ({ name: e.name, type: e.initiatorType })),
      fonts: [...document.fonts].filter((f) => f.status !== 'unloaded').map((f) => f.family),
      images: [...document.querySelectorAll('img, image, picture source')].map((e) => e.currentSrc || e.getAttribute('src') || e.getAttribute('href') || e.getAttribute('srcset') || ''),
    }))()`);
    const font = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i;
    const raster = /\.(png|jpe?g|webp|gif|avif|bmp|ico|tiff?)(\?|#|$)/i;
    // ほかのオリジンへの読み込みがない（ページが行った読み込みのすべてがページと同じオリジン）。
    const foreign = loaded.resources.filter((r) => !r.name.startsWith(`${loaded.origin}/`) && !r.name.startsWith('data:'));
    expect(foreign, JSON.stringify(loaded.resources)).toEqual([]);
    // フォントとラスタ画像のファイルを読み込まない。ブラウザが自分で取りに行く /favicon.ico はページの読み込みではないので除く。
    const paths = [...requests.filter((p) => !/^\/favicon\.ico(\?|$)/.test(p)), ...loaded.resources.map((r) => new URL(r.name).pathname)];
    expect(paths.filter((p) => font.test(p)), JSON.stringify(paths)).toEqual([]);
    expect(paths.filter((p) => raster.test(p)), JSON.stringify(paths)).toEqual([]);
    expect(loaded.resources.filter((r) => r.type === 'img' || r.type === 'image'), JSON.stringify(loaded.resources)).toEqual([]);
    expect(loaded.images.filter((s) => raster.test(s) || /^data:image\/(png|jpe?g|webp|gif|avif)/.test(s))).toEqual([]);
    // Web フォントを読み込まない（読み込まれた・読み込み中の FontFace がない）。
    expect(loaded.fonts).toEqual([]);
    expect(requests.length, '配信したサーバーが要求を受けている').toBeGreaterThan(0);
    noExceptions(page);
  });

  it('MODE-56: 各モードのカードに表のひとこと説明が出て、モードのファイルを 1 つ足したビルドでは、そのモードの名前と説明のカードが出る', async () => {
    // 今のビルド: 各モードのカードに、そのモードの表のひとこと説明が出る。
    const page = await openFresh();
    const list = await cards(page, 'モード');
    expect(await modeNames(page)).toEqual(MODES.map((m) => m.name));
    for (const [i, m] of MODES.entries()) {
      expect(list[i]!.text, m.name).toContain(m.description);
      for (const other of MODES.filter((x) => x !== m)) expect(list[i]!.text, `${m.name} に ${other.name} の説明`).not.toContain(other.description);
    }
    expect(list.some((c) => c.text.includes(EXTRA_NAME))).toBe(false);
    noExceptions(page);

    // モードのファイルを 1 つ足した写しのビルド: 足したモードの名前と説明のカードが、並び順のとおりいちばん後ろに出る。
    const extra = await openFresh({ at: extraOrigin });
    const names = [...MODES.map((m) => m.name), EXTRA_NAME];
    expect(await modeNames(extra, names)).toEqual(names);
    const extraList = await cards(extra, 'モード');
    const card = extraList[extraList.length - 1]!;
    expect(card.visible).toBe(true);
    expect(card.text).toContain(EXTRA_NAME);
    expect(card.text).toContain(EXTRA_DESCRIPTION);
    for (const [i, m] of MODES.entries()) expect(extraList[i]!.text, m.name).toContain(m.description);
    // 足したモードのカードも選べる。
    await clickCard(extra, 'モード', EXTRA_NAME);
    await extra.waitFor(`window.__cards('モード')[${MODES.length}]?.getAttribute('aria-checked') === 'true'`);
    expect(expectOneSelected(await cards(extra, 'モード'), '足したモードを選んだとき').text).toContain(EXTRA_NAME);
    noExceptions(extra);
  });
});
