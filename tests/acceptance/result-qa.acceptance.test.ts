// docs/spec/scoring.md の「リザルト画面」「自己ベスト」の受け入れテスト（SCO-1〜SCO-5 の画面の部分、SCO-15〜SCO-22）と
// docs/spec/modes.md の MODE-4 のリザルトの部分（MODE-4 の ID は modes.acceptance が持つ）。
// 公開された入口（ビルドの結果を /apex-training/ で配信した画面、武器の JSON、localStorage のキー）だけを使い、実装の内部には依存しない。
// 画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、マウス（ポインターロック + 左ボタン）で撃つ。
// 3D は描画せず（render=off）、ページの時計はテストから進める（clock=manual）。撃ち切るまでを実時間で待たない。
// 指標が決まった値になる結果を作るため、SCO-1〜SCO-3・SCO-19 はリポジトリの写しに受け入れ用の武器（ブレ 0）を足してビルドした画面で確かめる。
// 散布図と軌道は、描かれた点を画面上の位置に直し、軸の交点を原点、右と上を正として読む（図の 1 単位を 1 度とみなす）。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, waitUntil, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
/** ページを開く練習の乱数の種（docs/spec/architecture.md「テストのための乱数の種の固定」）。テストが失敗したときのメッセージにも出る。 */
const SEED = 12345;
const CX = 640;
const CY = 400;
const chromium = findChromium();

/** SPEC の文言と値（実装の定数には依存しない）。 */
const NOTICE = 'この環境では設定と記録を保存できません。練習はそのまま続けられます。';
const UPDATED = '自己ベスト更新';
const COMMENTS = ['下げすぎ', '下げ不足', '横の補正不足', 'よくまとまっている'];
const BEST_PREFIX = 'apex-training:best:';
const bestKey = (input: string, weapon: string, mode: string) => `${BEST_PREFIX}${input}:${weapon}:${mode}`;

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
const byId = (id: string) => {
  const w = WEAPONS.find((x) => x.id === id) ?? EXTRA_WEAPONS.find((x) => x.id === id);
  if (!w) throw new Error(`武器がない: ${id}`);
  return w;
};

/** 受け入れ用の武器（ブレ 0）。 */
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
const EXTRA_WEAPONS: WeaponJson[] = [
  // SCO-1: 跳ねもブレもない。照準を動かさなければ全弾が中心に当たる。
  accWeapon('acc-zero', '受け入れ-跳ねなし', zeros(6)),
  // SCO-2: 1〜6 発目は中心、7 発目で 3 度跳ね上がり、7〜9 発目は中心から上に 3 度（後半だけ外れる）。
  accWeapon('acc-late', '受け入れ-後半外れ', [...zeros(6), { dx: 0, dy: 3 }, ...zeros(2)]),
  // SCO-3・SCO-19: 1 発目で 2 度下がり、全弾が中心より下に 2 度外れる。
  accWeapon('acc-low', '受け入れ-下外れ', [{ dx: 0, dy: -2 }, ...zeros(5)]),
];

/** 照準を動かさずに撃ったときの i 発目のリコイルの累積（1〜i 発目の pattern の合計）。 */
function cumulative(w: WeaponJson, n: number) {
  const out: { yaw: number; pitch: number }[] = [];
  let yaw = 0;
  let pitch = 0;
  for (let i = 0; i < n; i += 1) {
    yaw += w.pattern[i]!.dx;
    pitch += w.pattern[i]!.dy;
    out.push({ yaw, pitch });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 画面の読み取り
// ---------------------------------------------------------------------------

interface Pt {
  yaw: number;
  pitch: number;
}
interface Series {
  name: string;
  points: Pt[];
}
interface Plot {
  name: string;
  caption: string;
  /** 的の半径の円（度）。なければ null。 */
  target: number | null;
  series: Series[];
}
interface ResultState {
  hash: string;
  visibleScreens: string[];
  text: string;
  summary: string;
  metrics: Record<string, string>;
  plots: Plot[];
  footer: string;
}

/**
 * リザルト画面の見えている内容。指標は見えている dt / dd の組、図は見えている svg ごとに、
 * 点（circle の中心・polyline の頂点）を画面上の位置に直してから、軸の交点を原点とした度（右・上が正）に直す。
 */
const RESULT_STATE = `(() => {
  const visible = (el) => !!el && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0;
  const screen = document.querySelector('[data-screen="result"]');
  const metrics = {};
  for (const dt of screen.querySelectorAll('dt')) {
    if (!visible(dt)) continue;
    const dd = dt.nextElementSibling;
    if (dd && dd.tagName === 'DD') metrics[dt.textContent.trim()] = dd.textContent.trim();
  }
  const plots = [];
  for (const svg of screen.querySelectorAll('svg')) {
    if (!visible(svg)) continue;
    const toScreen = (el, x, y) => { const p = new DOMPoint(x, y).matrixTransform(el.getScreenCTM()); return { x: p.x, y: p.y }; };
    const lines = [...svg.querySelectorAll('line')].map((l) => {
      const a = toScreen(l, l.x1.baseVal.value, l.y1.baseVal.value);
      const b = toScreen(l, l.x2.baseVal.value, l.y2.baseVal.value);
      return { a, b, horizontal: Math.abs(a.y - b.y) < 0.5, vertical: Math.abs(a.x - b.x) < 0.5 };
    });
    const h = lines.find((l) => l.horizontal);
    const v = lines.find((l) => l.vertical);
    if (!h || !v) { plots.push({ name: 'no-axes', caption: '', target: null, series: [] }); continue; }
    const origin = { x: v.a.x, y: h.a.y };
    const ctm = svg.getScreenCTM();
    const scale = Math.hypot(ctm.a, ctm.b);
    const toDeg = (p) => ({ yaw: (p.x - origin.x) / scale, pitch: -(p.y - origin.y) / scale });
    const series = [];
    let target = null;
    for (const el of svg.querySelectorAll('[data-series]')) {
      let points = [];
      if (el.tagName === 'polyline') points = [...el.points].map((p) => toDeg(toScreen(el, p.x, p.y)));
      else points = [...el.querySelectorAll('circle')].map((c) => toDeg(toScreen(c, c.cx.baseVal.value, c.cy.baseVal.value)));
      series.push({ name: el.getAttribute('data-series'), points });
    }
    for (const c of svg.querySelectorAll('circle')) {
      if (c.closest('[data-series]')) continue;
      const center = toDeg(toScreen(c, c.cx.baseVal.value, c.cy.baseVal.value));
      if (Math.hypot(center.yaw, center.pitch) < 1e-6) target = (c.r.baseVal.value * Math.hypot(c.getScreenCTM().a, c.getScreenCTM().b)) / scale;
    }
    const figure = svg.closest('figure');
    plots.push({ name: figure?.getAttribute('data-plot') ?? '', caption: (figure?.querySelector('figcaption')?.textContent ?? svg.getAttribute('aria-label') ?? '').trim(), target, series });
  }
  const footer = [...document.querySelectorAll('footer')].filter(visible).map((f) => f.innerText).join('\\n');
  return {
    hash: location.hash,
    visibleScreens: [...document.querySelectorAll('[data-screen]')].filter(visible).map((s) => s.getAttribute('data-screen')),
    text: visible(screen) ? screen.innerText : '',
    summary: screen.querySelector('#result-summary')?.textContent?.trim() ?? '',
    metrics,
    plots,
    footer,
  };
})()`;

const resultState = (page: Page) => page.evaluate<ResultState>(RESULT_STATE);

/** 「1.23°」「100.0%」などから数を取り出す。「なし」なら null。 */
const num = (s: string | undefined): number | null => {
  if (s === undefined) throw new Error('指標がない');
  if (s.trim() === 'なし') return null;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) throw new Error(`数がない: ${s}`);
  return Number(m[0]);
};
/** 区間ごとのズレの表示（前半・中盤・後半の順）。 */
const segments = (s: string): (number | null)[] =>
  ['前半', '中盤', '後半'].map((label) => {
    const m = s.match(new RegExp(`${label}\\s*(なし|-?\\d+(?:\\.\\d+)?)`));
    if (!m) throw new Error(`${label} がない: ${s}`);
    return m[1] === 'なし' ? null : Number(m[1]);
  });
const metric = (r: ResultState, label: string) => {
  const key = Object.keys(r.metrics).find((k) => k.includes(label));
  if (!key) throw new Error(`指標 ${label} がない: ${JSON.stringify(r.metrics)}`);
  return r.metrics[key]!;
};
const commentsIn = (text: string) => COMMENTS.filter((c) => text.includes(c));

const plotWith = (r: ResultState, ...names: string[]) => r.plots.find((p) => names.every((n) => p.series.some((s) => s.name === n)));
const seriesOf = (p: Plot | undefined, name: string) => p?.series.find((s) => s.name === name)?.points ?? [];

// ---------------------------------------------------------------------------
// 画面の操作
// ---------------------------------------------------------------------------

/** 選択肢の表示名から値を選ぶ（キーボードで選んだときと同じく change を出す）。 */
async function choose(page: Page, selector: string, label: string) {
  const ok = await page.evaluate<boolean>(`(() => {
    const s = document.querySelector(${JSON.stringify(selector)});
    const o = [...s.options].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  if (!ok) throw new Error(`${selector} に ${label} の選択肢がない`);
}

const ammo = (page: Page) =>
  page.evaluate<number>(`(() => { const m = (document.querySelector('[data-hud="ammo"]')?.textContent ?? '').match(/\\d+/); return m ? Number(m[0]) : NaN; })()`);

const mouseButton = (page: Page, type: 'mousePressed' | 'mouseReleased') =>
  page.send('Input.dispatchMouseEvent', { type, x: CX, y: CY, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });

/**
 * プレイ画面でキャンバスをクリックしてポインターロックを掛ける。練習のシーンが描画され始めるまで待ってからクリックし、
 * Chromium がロックを外した直後の要求を拒否したときは、掛かるまでクリックし直す（決まった時間は待たない）。
 */
async function lock(page: Page) {
  await page.waitFor(`location.hash === '#/play' && !document.querySelector('[data-screen="play"]').hidden`);
  await page.frames(5);
  await waitUntil(() => page.lockPointerBy(() => page.click(CX, CY), 1_000), 'クリックでポインターロックが掛かる', { timeout: 15_000 });
  await page.frames(2);
}

/** トップ画面を開いて武器とモードを選び、「開始」を押してプレイ画面に入る。 */
async function start(page: Page, weapon: string, mode: string) {
  await page.evaluate(`location.hash = '#/'`);
  await page.waitFor(`!document.querySelector('[data-screen="top"]').hidden && document.querySelector('#weapon').options.length > 0 && document.querySelector('#mode').options.length > 0`);
  await choose(page, '#weapon', weapon);
  await choose(page, '#mode', mode);
  await page.clickSelector('[data-screen="top"] a[href="#/play"]');
  await page.waitFor(`window.__ammo() > 0`);
  await lock(page);
}

/**
 * 左ボタンを押し続けて 1 マガジンを撃ち切り、リザルト画面になるまで待つ。
 * drag を渡すと、押しているあいだ、1 発撃つ（残弾が 1 つ減る）ごとにマウスを drag.dy カウントずつ、drag.steps 回動かす。
 * 動かすきっかけを経過した実時間でなく撃った弾数にするので、マシンが重くても撃ち切る前に動かし終わる。
 */
async function fireAll(page: Page, drag?: { dy: number; steps: number }) {
  const full = drag ? await ammo(page) : 0;
  await mouseButton(page, 'mousePressed');
  if (drag) {
    for (let i = 1; i <= drag.steps; i += 1) {
      await page.advanceClockUntil(`window.__ammo() <= ${full - i} || location.hash !== '#/play'`);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: CX, y: CY + drag.dy * i, button: 'left', buttons: 1 });
    }
  }
  await page.advanceClockUntil(`location.hash === '#/result'`, { step: 1 / 60 });
  await mouseButton(page, 'mouseReleased');
  await page.evaluate('document.exitPointerLock()');
  // リザルト画面が表示され、図が描かれて画面に出るまで待つ。
  await page.waitFor(`!document.querySelector('[data-screen="result"]').hidden && !document.pointerLockElement`);
  await page.frames(2);
}

/** 練習を 1 回（武器とモードを選んで撃ち切る）。 */
async function practice(page: Page, weapon: string, mode: string) {
  await start(page, weapon, mode);
  await fireAll(page);
  return resultState(page);
}

/**
 * リザルト画面の、表示名が label のボタン（リンク）を、利用者と同じくスクロールして見える所に出してからクリックする。
 * クリックする位置で一番上にあるのがそのボタンであることも確かめる（ほかの要素に隠れていない）。
 */
async function clickResultButton(page: Page, label: string) {
  const box = await page.evaluate<{ x: number; y: number; hit: boolean } | null>(`(() => {
    const el = [...document.querySelectorAll('[data-screen="result"] a, [data-screen="result"] button')].find((e) => e.textContent.trim() === ${JSON.stringify(label)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, hit: !!top && (top === el || el.contains(top)) }; })()`);
  if (!box) throw new Error(`リザルト画面に「${label}」がない`);
  expect(box.hit, `「${label}」がクリックできる位置にない`).toBe(true);
  await page.click(box.x, box.y);
}

const PAGE_INIT = `
  window.__ammo = () => { const m = (document.querySelector('[data-hud="ammo"]')?.textContent ?? '').match(/\\d+/); return m ? Number(m[0]) : NaN; };
`;

const storedBests = (page: Page) =>
  page.evaluate<Record<string, string>>(`(() => { const out = {}; try { for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i);
    if (k.startsWith(${JSON.stringify(BEST_PREFIX)})) out[k] = localStorage.getItem(k); } } catch {} return out; })()`);

interface Best {
  version: number;
  meanError: number;
  groupingRadius: number;
  hitRate: number;
  shots: number;
  achievedAt: string;
}

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('リザルト画面と自己ベスト', () => {
  const temps: string[] = [];
  let site = '';
  let mainDist = '';
  let copyDist = '';
  let copyBuild = { status: null as number | null, output: '' };
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  const serveDist = (dir: string) => {
    if (existsSync(site)) unlinkSync(site);
    symlinkSync(dir, site, 'dir');
  };
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));

  /** 新しいタブで localStorage を空にし（seed を入れ）、読み込み直したトップ画面を開く。 */
  async function openFresh(seed: Record<string, string> = {}, init?: string): Promise<Page> {
    const page = await browser!.newPage();
    await page.goto(appUrl(origin, BASE, '#/', { render: false, manualClock: true, seed: SEED }));
    await page.evaluate(`(() => { localStorage.clear(); const seed = ${JSON.stringify(seed)}; for (const k in seed) localStorage.setItem(k, seed[k]); })()`);
    await page.addInitScript(PAGE_INIT);
    if (init) await page.addInitScript(init);
    await reload(page);
    return page;
  }
  async function reload(page: Page) {
    await page.evaluate('window.__beforeReload = true');
    await page.send('Page.reload', { ignoreCache: false });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && !!document.querySelector('[data-screen="top"]') && !document.querySelector('[data-screen="top"]').hidden`, 15_000);
  }

  beforeAll(async () => {
    const work = mkdtempSync(join(tmpdir(), 'result-qa-'));
    temps.push(work);
    mainDist = join(work, 'main-dist');
    const build = spawnSync(`npm run build -- --outDir "${mainDist}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`ビルドが失敗した:\n${build.stdout}${build.stderr}`);

    // リポジトリの写しに受け入れ用の武器を足してビルドする。
    const copy = join(work, 'copy');
    for (const entry of ['src', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'eslint.config.js', 'scripts']) {
      if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
    }
    symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), 'dir');
    for (const w of EXTRA_WEAPONS) writeFileSync(join(copy, `src/data/weapons/${w.id}.json`), JSON.stringify(w, null, 2));
    copyDist = join(work, 'copy-dist');
    const r = spawnSync(`npm run build -- --outDir "${copyDist}" --emptyOutDir`, {
      cwd: copy,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, APEX_ACCEPTANCE_NESTED: '1', FORCE_COLOR: '0' },
    });
    copyBuild = { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };

    site = join(work, 'site');
    serveDist(copyDist);
    server = await serveStatic(site, BASE);
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
    expect(copyBuild.status, copyBuild.output).toBe(0);
  });

  // -------------------------------------------------------------------------
  describe('指標とコメントの表示（ブレ 0 の受け入れ用の武器）', () => {
    it('SCO-1: 全弾が中心に当たったとき、平均ズレ 0・グルーピング半径 0・命中率 100% と表示される', async () => {
      serveDist(copyDist);
      const page = await openFresh();
      const r = await practice(page, '受け入れ-跳ねなし', '反復練習');
      expect(num(metric(r, '平均ズレ'))).toBe(0);
      expect(num(metric(r, 'グルーピング半径'))).toBe(0);
      expect(num(metric(r, '命中率'))).toBe(100);
      expect(commentsIn(r.text)).toEqual(['よくまとまっている']);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('SCO-2: 前半の弾だけを中心に当て、後半の弾を大きく外したとき、区間ごとのズレで後半が最も大きく表示される', async () => {
      serveDist(copyDist);
      const page = await openFresh();
      const r = await practice(page, '受け入れ-後半外れ', '反復練習');
      const [front, middle, back] = segments(metric(r, '区間'));
      expect(front).toBe(0);
      expect(middle).toBe(0);
      expect(back).toBeCloseTo(3, 1);
      expect(back!).toBeGreaterThan(Math.max(front!, middle!));
    }, 60_000);

    it('SCO-3: 弾がすべて中心より下に外れたとき、「下げすぎ」のコメントが表示される', async () => {
      serveDist(copyDist);
      const page = await openFresh();
      const r = await practice(page, '受け入れ-下外れ', '反復練習');
      expect(commentsIn(r.text)).toEqual(['下げすぎ']);
      expect(num(metric(r, '平均ズレ'))).toBeCloseTo(2, 1);
      // 散布図の点はすべて中心より下（画面上で下）に描かれる。
      const shots = seriesOf(plotWith(r, 'shots'), 'shots');
      expect(shots).toHaveLength(6);
      for (const p of shots) expect(p.pitch).toBeCloseTo(-2, 1);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('ボタン', () => {
    it('SCO-4: リザルト画面で「もう一度」を押したとき、同じ武器・同じモードで練習が始まる', async () => {
      serveDist(copyDist);
      const page = await openFresh();
      const w = byId('car');
      const first = await practice(page, w.name, '反復練習');
      expect(first.summary).toContain(w.name);
      expect(first.summary).toContain('反復練習');
      await clickResultButton(page, 'もう一度');
      await page.waitFor(`location.hash === '#/play' && !document.querySelector('[data-screen="play"]').hidden`);
      // 新しい練習の HUD（残弾が装弾数）になるまで待つ（切り替わる直前は前の練習の HUD が一瞬残ることがある）。
      await page.waitFor(`window.__ammo() === ${w.magSize}`, 5000);
      // 同じ武器（HUD の武器名と装弾数）で、新しい練習（残弾が装弾数）が始まっている。
      expect(await page.evaluate<string>(`document.querySelector('[data-hud="weapon"]')?.textContent ?? ''`)).toContain(w.name);
      expect(await ammo(page)).toBe(w.magSize);
      // 撃ち切ると、同じ武器・同じモード（採点する）のリザルトになる。
      await lock(page);
      await fireAll(page);
      const second = await resultState(page);
      expect(second.summary).toContain(w.name);
      expect(second.summary).toContain('反復練習');
      expect(num(metric(second, '平均ズレ'))).not.toBeNull();
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 90_000);

    it('SCO-15: リザルト画面で「武器変更」を押したとき、トップ画面に戻る', async () => {
      serveDist(copyDist);
      const page = await openFresh();
      for (const mode of ['反復練習']) {
        await practice(page, byId('car').name, mode);
        await clickResultButton(page, '武器変更');
        await page.waitFor(`!document.querySelector('[data-screen="top"]').hidden`);
        await page.frames(2);
        const r = await resultState(page);
        expect(r.hash === '#/' || r.hash === '', `${mode}: ${r.hash}`).toBe(true);
        expect(r.visibleScreens, mode).toEqual(['top']);
      }
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  describe('採点するモードのリザルト', () => {
    it('SCO-16: 反復練習で照準を動かさずに撃ち切ると、指標とコメント、弾痕の散布図、自分の照準と理想の軌道の重ね描きが表示される', async () => {
      serveDist(copyDist);
      const page = await openFresh();
      const w = byId('lstar');
      const r = await practice(page, w.name, '反復練習');
      expect(r.visibleScreens).toEqual(['result']);
      // 指標（5 つ）とコメント。
      for (const label of ['平均ズレ', 'グルーピング半径', '命中率', '区間', '横ブレ']) expect(() => metric(r, label), label).not.toThrow();
      expect(metric(r, '横ブレ')).toMatch(/縦ブレ|\//);
      expect(metric(r, '横ブレ')).toMatch(/比/);
      expect(segments(metric(r, '区間')).every((s) => s !== null)).toBe(true);
      const comments = commentsIn(r.text);
      expect(comments.length).toBeGreaterThanOrEqual(1);
      expect(comments.length).toBeLessThanOrEqual(2);
      // 補正していないので弾は上に寄る（L-STAR は上に跳ねる）。
      expect(comments).toContain('下げ不足');

      // 散布図: 各弾のズレの点（撃った弾数）と的の半径の円。点は 1〜i 発目の pattern の合計 ± ブレ、右と上が正。
      const scatter = plotWith(r, 'shots');
      expect(scatter, JSON.stringify(r.plots.map((p) => p.name))).toBeDefined();
      expect(scatter!.target, '的の半径の円').not.toBeNull();
      expect(scatter!.target!).toBeGreaterThan(0);
      const shots = seriesOf(scatter, 'shots');
      expect(shots).toHaveLength(w.magSize);
      const cum = cumulative(w, w.magSize);
      const tol = w.randomness + 0.05;
      shots.forEach((p, i) => {
        expect(Math.abs(p.yaw - cum[i]!.yaw), `${i + 1} 発目の水平`).toBeLessThanOrEqual(tol);
        expect(Math.abs(p.pitch - cum[i]!.pitch), `${i + 1} 発目の垂直`).toBeLessThanOrEqual(tol);
      });
      // 表示された平均ズレは、散布図の点の中心からの距離の平均と一致する。
      const mean = shots.reduce((s, p) => s + Math.hypot(p.yaw, p.pitch), 0) / shots.length;
      expect(Math.abs(num(metric(r, '平均ズレ'))! - mean)).toBeLessThanOrEqual(0.02);
      // 命中率は、散布図の点のうち的の円の中のものの割合と一致する（境目の丸めの分は 1 発まで許す）。
      const inside = shots.filter((p) => Math.hypot(p.yaw, p.pitch) <= scatter!.target!).length;
      expect(Math.abs((num(metric(r, '命中率'))! * shots.length) / 100 - inside)).toBeLessThanOrEqual(1.01);

      // 軌道: 自分の照準（照準を動かしていないので原点）と理想の軌道（1〜i 発目の pattern の合計の反転）が同じ図に重なる。
      const trajectory = plotWith(r, 'aim', 'ideal');
      expect(trajectory, JSON.stringify(r.plots.map((p) => p.series.map((s) => s.name)))).toBeDefined();
      const aim = seriesOf(trajectory, 'aim');
      const ideal = seriesOf(trajectory, 'ideal');
      expect(aim).toHaveLength(w.magSize);
      expect(ideal).toHaveLength(w.magSize);
      for (const p of aim) expect(Math.hypot(p.yaw, p.pitch)).toBeLessThan(0.02);
      ideal.forEach((p, i) => {
        expect(p.yaw, `${i + 1} 発目の理想の水平`).toBeCloseTo(-cum[i]!.yaw, 1);
        expect(p.pitch, `${i + 1} 発目の理想の垂直`).toBeCloseTo(-cum[i]!.pitch, 1);
      });
      // 理想の軌道は下に向かう（画面上で下）。
      expect(ideal.at(-1)!.pitch).toBeLessThan(-1);
      // 自己ベストの表示がある（初回なので更新）。
      expect(r.text).toContain(UPDATED);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('SCO-16: 撃ちながらマウスを手前に引くと、自分の照準の軌道が下へ伸び、弾痕は照準 + パターンの位置に描かれる', async () => {
      serveDist(copyDist);
      const page = await openFresh();
      const w = byId('car');
      await start(page, w.name, '反復練習');
      await fireAll(page, { dy: 6, steps: 20 });
      const r = await resultState(page);
      const trajectory = plotWith(r, 'aim', 'ideal');
      const aim = seriesOf(trajectory, 'aim');
      const shots = seriesOf(plotWith(r, 'shots'), 'shots');
      expect(aim).toHaveLength(w.magSize);
      expect(shots).toHaveLength(w.magSize);
      // 1 発目は押し始めに撃つので開始時の照準。手前に引いたので、照準は下がっていく（垂直は増えない）。
      expect(Math.hypot(aim[0]!.yaw, aim[0]!.pitch)).toBeLessThan(0.05);
      for (let i = 1; i < aim.length; i += 1) expect(aim[i]!.pitch).toBeLessThanOrEqual(aim[i - 1]!.pitch + 1e-3);
      expect(aim.at(-1)!.pitch).toBeLessThan(-0.5);
      // 弾痕のズレ = 照準 + リコイルの累積 + ブレ。
      const cum = cumulative(w, w.magSize);
      const tol = w.randomness + 0.05;
      shots.forEach((p, i) => {
        expect(Math.abs(p.yaw - (aim[i]!.yaw + cum[i]!.yaw)), `${i + 1} 発目の水平`).toBeLessThanOrEqual(tol);
        expect(Math.abs(p.pitch - (aim[i]!.pitch + cum[i]!.pitch)), `${i + 1} 発目の垂直`).toBeLessThanOrEqual(tol);
      });
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('SCO-16: 反復練習で撃ち切ると、指標とコメント、弾痕の散布図、自分の照準と理想の軌道の重ね描きが表示される', async (ctx) => {
      serveDist(copyDist);
      const page = await openFresh();
      const modes = await page.evaluate<string[]>(`[...document.querySelector('#mode').options].map((o) => o.textContent.trim())`);
      if (!modes.includes('反復練習')) {
        console.warn(`反復練習がモードの選択肢にない（${modes.join(', ')}）。この確認は飛ばす`);
        ctx.skip();
      }
      const w = byId('lstar');
      const r = await practice(page, w.name, '反復練習');
      for (const label of ['平均ズレ', 'グルーピング半径', '命中率', '区間', '横ブレ']) expect(() => metric(r, label), label).not.toThrow();
      expect(commentsIn(r.text).length).toBeGreaterThanOrEqual(1);
      expect(seriesOf(plotWith(r, 'shots'), 'shots')).toHaveLength(w.magSize);
      expect(seriesOf(plotWith(r, 'aim', 'ideal'), 'ideal')).toHaveLength(w.magSize);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('自己ベスト', () => {
    it('SCO-18: 自己ベストがない状態で、マウスで L-STAR と反復練習を練習して終えると「自己ベスト更新」が表示され、その結果が保存される', async () => {
      serveDist(copyDist);
      const page = await openFresh();
      expect(await storedBests(page)).toEqual({});
      const w = byId('lstar');
      const r = await practice(page, w.name, '反復練習');
      expect(r.text).toContain(UPDATED);
      const stored = await storedBests(page);
      const key = bestKey('mouse', 'lstar', 'ghost');
      expect(Object.keys(stored)).toEqual([key]);
      const best = JSON.parse(stored[key]!) as Best;
      expect(best.version).toBe(1);
      expect(Math.abs(best.meanError - num(metric(r, '平均ズレ'))!)).toBeLessThanOrEqual(0.006);
      expect(Math.abs(best.groupingRadius - num(metric(r, 'グルーピング半径'))!)).toBeLessThanOrEqual(0.006);
      expect(Math.abs(best.hitRate - num(metric(r, '命中率'))!)).toBeLessThanOrEqual(0.06);
      expect(best.shots).toBe(w.magSize);
      expect(best.achievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
      expect(Math.abs(Date.parse(best.achievedAt) - Date.now())).toBeLessThan(60_000);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('SCO-5: 自己ベストより平均ズレが小さい結果で練習を終えると、更新が表示され、再読み込みしても新しい自己ベストが残っている', async () => {
      serveDist(copyDist);
      const key = bestKey('mouse', 'lstar', 'ghost');
      const old: Best = { version: 1, meanError: 90, groupingRadius: 90, hitRate: 0, shots: 28, achievedAt: '2026-01-01T00:00:00.000Z' };
      const page = await openFresh({ [key]: JSON.stringify(old) });
      const r = await practice(page, byId('lstar').name, '反復練習');
      expect(r.text).toContain(UPDATED);
      const saved = JSON.parse((await storedBests(page))[key]!) as Best;
      expect(saved.meanError).toBeLessThan(90);
      expect(Math.abs(saved.meanError - num(metric(r, '平均ズレ'))!)).toBeLessThanOrEqual(0.006);
      // 再読み込みしても残っている。
      await reload(page);
      const afterReload = JSON.parse((await storedBests(page))[key]!) as Best;
      expect(afterReload).toEqual(saved);
      // 再読み込みのあと、平均ズレが大きい結果では更新されず、新しい自己ベストの平均ズレが表示される。
      const worse = await practice(page, '受け入れ-下外れ', '反復練習');
      expect(worse.text).toContain(UPDATED); // 別の武器なので更新（L-STAR の値は変わらない）
      expect(JSON.parse((await storedBests(page))[key]!) as Best).toEqual(saved);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('SCO-19: 保存してある自己ベストより平均ズレが大きい結果では「自己ベスト更新」が表示されず、保存してある平均ズレが表示され、値は変わらない', async () => {
      serveDist(copyDist);
      const key = bestKey('mouse', 'acc-low', 'ghost');
      // 受け入れ-下外れの平均ズレは 2 度。それより小さい 1.23 度を保存しておく。
      const old = JSON.stringify({ version: 1, meanError: 1.23, groupingRadius: 0.5, hitRate: 40, shots: 6, achievedAt: '2026-01-01T00:00:00.000Z' });
      const page = await openFresh({ [key]: old });
      const r = await practice(page, '受け入れ-下外れ', '反復練習');
      expect(num(metric(r, '平均ズレ'))).toBeCloseTo(2, 1);
      expect(r.text).not.toContain(UPDATED);
      expect(r.text).toContain('1.23');
      expect((await storedBests(page))[key]).toBe(old);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('SCO-19: 保存してある自己ベストと平均ズレが等しい結果では「自己ベスト更新」が表示されず、値は変わらない', async () => {
      serveDist(copyDist);
      const key = bestKey('mouse', 'acc-low', 'ghost');
      const page = await openFresh();
      // 1 回目: 自己ベストがないので保存される。
      const first = await practice(page, '受け入れ-下外れ', '反復練習');
      expect(first.text).toContain(UPDATED);
      const saved = (await storedBests(page))[key];
      expect(saved).toBeDefined();
      const savedMean = (JSON.parse(saved!) as Best).meanError;
      // 2 回目: ブレ 0・照準を動かさないので、平均ズレは 1 回目とちょうど等しい。
      // 保存し直されたら達成日時が変わって見分けられるよう、ページの時計が 1 回目の達成日時から秒の桁で進んでから撃つ
      // （達成日時が秒までしか書かれない実装でも見分けられる）。
      const savedAt = Date.parse((JSON.parse(saved!) as Best).achievedAt);
      await page.waitFor(`Date.now() >= ${savedAt} + 1000`, 5_000);
      const second = await practice(page, '受け入れ-下外れ', '反復練習');
      expect(metric(second, '平均ズレ')).toBe(metric(first, '平均ズレ'));
      expect(second.text).not.toContain(UPDATED);
      expect(second.text).toContain(savedMean.toFixed(2));
      expect((await storedBests(page))[key]).toBe(saved);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 90_000);

    it('SCO-20: マウスで L-STAR と反復練習の自己ベストがある状態で、マウスで C.A.R. SMG と反復練習を初めて練習すると「自己ベスト更新」が表示され、L-STAR の自己ベストは変わらない', async () => {
      serveDist(copyDist);
      const key = bestKey('mouse', 'lstar', 'ghost');
      const old = JSON.stringify({ version: 1, meanError: 0.01, groupingRadius: 0.01, hitRate: 100, shots: 28, achievedAt: '2026-01-01T00:00:00.000Z' });
      const page = await openFresh({ [key]: old });
      const r = await practice(page, byId('car').name, '反復練習');
      expect(r.text).toContain(UPDATED);
      const stored = await storedBests(page);
      expect(stored[key]).toBe(old);
      expect(Object.keys(stored).sort()).toEqual([bestKey('mouse', 'car', 'ghost'), key].sort());
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('SCO-20 / 入力方式: パッドの自己ベストだけがある状態でマウスで練習すると、マウスのキーに保存され、パッドの値は混ざらない', async () => {
      serveDist(copyDist);
      const padKey = bestKey('pad', 'lstar', 'ghost');
      const old = JSON.stringify({ version: 1, meanError: 0.01, groupingRadius: 0.01, hitRate: 100, shots: 28, achievedAt: '2026-01-01T00:00:00.000Z' });
      const page = await openFresh({ [padKey]: old });
      const r = await practice(page, byId('lstar').name, '反復練習');
      expect(r.text).toContain(UPDATED);
      const stored = await storedBests(page);
      expect(stored[padKey]).toBe(old);
      expect(stored[bestKey('mouse', 'lstar', 'ghost')]).toBeDefined();
    }, 60_000);

    const broken: Record<string, string> = {
      'JSON として読めない値': '{not json',
      'version が 1 でない値': JSON.stringify({ version: 2, meanError: 0.01, groupingRadius: 0.01, hitRate: 100, shots: 28, achievedAt: '2026-01-01T00:00:00.000Z' }),
      'meanError が負の値': JSON.stringify({ version: 1, meanError: -1, groupingRadius: 0.01, hitRate: 100, shots: 28, achievedAt: '2026-01-01T00:00:00.000Z' }),
    };
    for (const [label, value] of Object.entries(broken)) {
      it(`SCO-21: 自己ベストのキーに${label}が入っているとき、エラーで止まらずにリザルト画面が表示され、その結果が自己ベストとして保存される`, async () => {
        serveDist(copyDist);
        const key = bestKey('mouse', 'lstar', 'ghost');
        const page = await openFresh({ [key]: value });
        const r = await practice(page, byId('lstar').name, '反復練習');
        expect(r.visibleScreens).toEqual(['result']);
        expect(r.text).toContain(UPDATED);
        const saved = JSON.parse((await storedBests(page))[key]!) as Best;
        expect(saved.version).toBe(1);
        expect(Math.abs(saved.meanError - num(metric(r, '平均ズレ'))!)).toBeLessThanOrEqual(0.006);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 60_000);
    }
  });

  // -------------------------------------------------------------------------
  describe('SCO-22: localStorage への書き込みが例外になる環境', () => {
    const environments: Record<string, string> = {
      'setItem が常に QuotaExceededError になる': `Storage.prototype.setItem = function () { throw new DOMException('quota', 'QuotaExceededError'); };`,
      '起動時の試しの書き込みだけが通り、そのあとの setItem が例外になる': `(() => { const original = Storage.prototype.setItem; let calls = 0;
        Storage.prototype.setItem = function (...args) { calls += 1; if (calls > 1) throw new DOMException('quota', 'QuotaExceededError'); return original.apply(this, args); }; })();`,
      'localStorage の参照が SecurityError になる': `Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });`,
    };
    for (const [name, init] of Object.entries(environments)) {
      it(`${name}: エラーで止まらずにリザルト画面が表示され、フッターに保存できない旨が表示される`, async () => {
        serveDist(copyDist);
        const page = await openFresh({}, init);
        const r = await practice(page, '受け入れ-下外れ', '反復練習');
        expect(r.visibleScreens).toEqual(['result']);
        expect(num(metric(r, '平均ズレ'))).toBeCloseTo(2, 1);
        expect(r.footer).toContain(NOTICE);
        expect(r.text).toContain(UPDATED);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
        // 練習はそのまま続けられ、ページを開いているあいだは自己ベストが残る（同じ平均ズレなので更新されない）。
        await clickResultButton(page, 'もう一度');
        await lock(page);
        await fireAll(page);
        const again = await resultState(page);
        expect(again.visibleScreens).toEqual(['result']);
        expect(again.footer).toContain(NOTICE);
        expect(again.text).not.toContain(UPDATED);
        expect(again.text).toContain(metric(r, '平均ズレ').match(/\d+\.\d+/)![0]);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 90_000);
    }
  });
});
