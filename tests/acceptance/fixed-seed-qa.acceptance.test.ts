// docs/spec/architecture.md「テストのための乱数の種の固定」（ARC-44〜ARC-48）のブラウザで確かめる受け入れテスト。
// ビルドの結果を /apex-training/ で配信した画面を、URL の seed を付けて（ARC-47・ARC-48 は付けずに）開く。
// テストのコードの調べ（ARC-49〜ARC-51）は tests/architecture/test-seed.test.ts にある。
//
// フリックの的の位置はページの中から読めないので、3D を描画して画面写しを撮り、練習の的の色の画素の重心を的の位置とする
// （tests/acceptance/flick-browser-qa.acceptance.test.ts と同じ読み方）。的は撃つと（当たっても外れても）消えて次の的が出るので、
// 照準を動かさずに撃ち、次の的が画面に出た時計の時刻を出た時刻とする。ページの時計はテストから進める（clock=manual）。
// 武器のブレは、リザルト画面の弾痕の散布図（度の座標の SVG）の点で比べる。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import repeatMode from '../../src/modes/recoil/ghost';
import { replayPracticeSession } from '../../src/modes/session';
import { shotDeviations } from '../../src/sim/scoring';
import { parseMap } from '../../src/sim/map';
import { parseWeapon } from '../../src/sim/weapon';
import { createWorld } from '../../src/sim/world';
import { appUrl, findChromium, launchBrowser, NO_SEED, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';
import { decodePng } from '../helpers/png';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
/** 固定する種（ARC-44〜ARC-46）と、比べる別の種。テストが失敗したときのメッセージにも出る。 */
const SEED = 12345;
const OTHER_SEED = 12346;
/** 種として読めない seed の値（ARC-47）。付けないときと同じく練習ごとに種を選ぶ。 */
const INVALID_SEEDS = ['abc', '-1', '1.5', '4294967296'];
const CX = 640;
const CY = 400;
const chromium = findChromium();
/** 固定ステップ（architecture.md、既定 1/120 秒）。 */
const DT = 1 / 120;
const FLICK = 'フリック';
const LSTAR = 'L-STAR';
const TARGETS = 20;

const PAGE_INIT = `
  window.__vis = (sel) => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    return !!el && !el.closest('[hidden]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0; };
  window.__clockNow = () => window.__apexTestClock.now();
`;
const TOP_READY = `window.__vis('[data-screen="top"]') && document.querySelector('#mode').options.length > 0 && document.querySelector('#weapon').options.length > 0`;

const now = (page: Page) => page.evaluate<number>('window.__clockNow()');

/** ページの時計を時刻 t まで進める（過ぎていたら失敗）。 */
async function advanceTo(page: Page, t: number) {
  const d = t - (await now(page));
  if (d < -1e-9) throw new Error(`時計がすでに ${t} を過ぎている（今 ${await now(page)}）`);
  if (d > 1e-9) await page.advanceClock(d);
}

/** 選択肢の表示名から値を選ぶ（キーボードで選んだときと同じく input と change を出す）。 */
async function choose(page: Page, selector: string, label: string) {
  const ok = await page.evaluate<boolean>(`(() => {
    const s = document.querySelector(${JSON.stringify(selector)});
    const o = s && [...s.options].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  if (!ok) throw new Error(`${selector} に ${label} の選択肢がない`);
}

// マウス -------------------------------------------------------------------

const mouse = (page: Page, type: 'mousePressed' | 'mouseReleased') =>
  page.send('Input.dispatchMouseEvent', { type, x: CX, y: CY, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });

/** プレイ画面でクリックしてポインターロックを掛ける（掛かっていれば何もしない）。 */
async function lock(page: Page) {
  await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]')`);
  if (await page.evaluate<boolean>('!!document.pointerLockElement')) return;
  await page.frames(3);
  await mouse(page, 'mousePressed');
  await mouse(page, 'mouseReleased');
  await page.waitFor('!!document.pointerLockElement', 5000);
  await page.frames(2);
}

// 練習の的の画素 ---------------------------------------------------------------

let targetColor: [number, number, number] | undefined;
const CLIP = { x: CX - 480, y: CY - 160, width: 960, height: 320 };

/** 画面写しの中の練習の的の画素の数と重心（小数第 1 位まで）。 */
async function findTarget(page: Page): Promise<{ n: number; x: number; y: number }> {
  if (!targetColor) throw new Error('的の色がまだ分からない');
  const { data } = await page.send<{ data: string }>('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, clip: { ...CLIP, scale: 1 } });
  const img = decodePng(Buffer.from(data, 'base64'));
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const [r, g, b] = img.pixel(x, y);
      if (Math.abs(r - targetColor[0]) + Math.abs(g - targetColor[1]) + Math.abs(b - targetColor[2]) < 60) {
        n += 1;
        sx += CLIP.x + x + 0.5;
        sy += CLIP.y + y + 0.5;
      }
    }
  }
  const round = (v: number) => Math.round(v * 10) / 10;
  return n === 0 ? { n, x: NaN, y: NaN } : { n, x: round(sx / n), y: round(sy / n) };
}

/** 1 個目の的が出る前と出たあとの画面写しの差から、練習の的の色を求める。 */
function learnTargetColor(before: Buffer, after: Buffer) {
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
  if (!top || top[1] < 20) throw new Error('的が出たあとの画面写しの差が見つからない');
  targetColor = top[0].split(',').map(Number) as [number, number, number];
}

/** 出た的 1 つ（画面の重心と、練習の開始から出るまでの時刻（秒、小数第 4 位まで））。 */
interface SeenTarget {
  x: number;
  y: number;
  t: number;
}

const sameTarget = (a: { x: number; y: number; n: number }, b: { x: number; y: number; n: number }) => a.n === b.n && Math.hypot(a.x - b.x, a.y - b.y) < 0.05;

describe.skipIf(!chromium || NESTED)('テストのための乱数の種の固定（architecture.md）', () => {
  let work = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));

  /** 新しいタブで localStorage を空にし、query（seed=... など。clock=manual は必ず付ける）を付けたトップ画面を開く。 */
  async function openPage(url: string): Promise<Page> {
    const page = await browser!.newPage();
    await page.goto(url);
    await page.evaluate(`localStorage.clear(); location.hash = '#/'; window.__beforeReload = true`);
    await page.addInitScript(PAGE_INIT);
    await page.send('Page.reload', { ignoreCache: false });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && ${TOP_READY}`, 15_000);
    return page;
  }
  /** 種 SEED（other なら OTHER_SEED）を付けて（render が false なら 3D を描画せずに）開く。 */
  const seeded = (which: 'fixed' | 'other', render = true) =>
    openPage(appUrl(origin, BASE, '#/', { render, manualClock: true, seed: which === 'fixed' ? SEED : OTHER_SEED }));
  /** seed の値（文字のまま）を付けて、3D を描画して開く。undefined なら付けない。 */
  const withRawSeed = (raw: string | undefined) =>
    openPage(raw === undefined ? appUrl(origin, BASE, '#/', { manualClock: true, seed: NO_SEED }) : `${origin}${BASE}?clock=manual&seed=${encodeURIComponent(raw)}#/`);

  /** トップ画面でフリックを選んで「開始」を押し、ポインターロックを掛ける。練習の開始の時計を返す。 */
  async function startFlick(page: Page): Promise<number> {
    await page.waitFor(TOP_READY);
    await choose(page, '#mode', FLICK);
    await choose(page, '#count', '1 回');
    await page.clickSelector('[data-screen="top"] a[href="#/play"]');
    await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]')`);
    const startedAt = await now(page);
    await lock(page);
    return startedAt;
  }

  /** 練習の開始から 1 個目の的が出るまで進め、的の色をまだ知らなければ出る前後の画面写しから求める。 */
  async function untilFirstTarget(page: Page, startedAt: number) {
    await advanceTo(page, startedAt + 1 - 0.03);
    const before = await page.screenshot();
    await advanceTo(page, startedAt + 1 + 1 / 60);
    if (!targetColor) learnTargetColor(before, await page.screenshot());
  }

  /**
   * 出ている的から順に、照準を動かさずに撃ち、出た的の位置（画面の重心）と出た時刻を n 個読む。
   * 撃ってから 1 ステップずつ進め、画面に前と違う的が見えた時刻を次の的の出た時刻とする。n 個目を読んだら撃って終える。
   */
  async function readTargets(page: Page, startedAt: number, n = TARGETS): Promise<SeenTarget[]> {
    await untilFirstTarget(page, startedAt);
    let current = await findTarget(page);
    const seen: SeenTarget[] = [{ x: current.x, y: current.y, t: 1 }];
    while (seen.length < n) {
      if (current.n === 0) throw new Error(`${seen.length} 個目の的が画面に見えない`);
      await mouse(page, 'mousePressed');
      let next = current;
      for (let step = 0; step < 12 && (next.n === 0 || sameTarget(next, current)); step += 1) {
        await page.advanceClock(DT);
        next = await findTarget(page);
      }
      await mouse(page, 'mouseReleased');
      seen.push({ x: next.x, y: next.y, t: Math.round(((await now(page)) - startedAt) * 10000) / 10000 });
      current = next;
      await page.advanceClock(2 * DT);
    }
    return seen;
  }

  /** 照準を動かさずに撃ち続けて、フリックの練習を終えてリザルト画面にする（撃った的は数えない）。 */
  async function finishFlick(page: Page) {
    for (let i = 0; i < TARGETS + 2 && !(await page.evaluate<boolean>(`location.hash === '#/result'`)); i += 1) {
      await mouse(page, 'mousePressed');
      await page.advanceClock(3 * DT);
      await mouse(page, 'mouseReleased');
      await page.advanceClock(0.05);
    }
    await page.advanceClockUntil(`location.hash === '#/result'`, { step: 1 / 60, limit: 15 });
    await page.evaluate('document.pointerLockElement && document.exitPointerLock()');
    await page.waitFor(`window.__vis('[data-screen="result"]')`);
  }

  /** リザルト画面の「もう一度」で始め直し、ポインターロックを掛ける。練習の開始の時計を返す。 */
  async function retry(page: Page): Promise<number> {
    await page.clickSelector('#retry');
    await page.waitFor(`location.hash === '#/play'`);
    const startedAt = await now(page);
    await lock(page);
    return startedAt;
  }

  /** 1 回の練習の的の位置の並び。 */
  const positions = (seen: SeenTarget[]) => seen.map(({ x, y }) => ({ x, y }));

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'fixed-seed-qa-'));
    const dist = join(work, 'dist');
    const env = { ...process.env, APEX_ACCEPTANCE_NESTED: '1', FORCE_COLOR: '0' };
    const build = spawnSync(`npm run build -- --outDir "${dist}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8', env });
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

  it(`ARC-44: seed=${SEED} で開いてフリックの的が 20 個出るまで進めると、開き直した 2 回で的の位置と出た時刻の並びが一致し、seed=${OTHER_SEED} では一致しない`, { timeout: 240_000 }, async () => {
    const run = async (which: 'fixed' | 'other') => {
      const page = await seeded(which);
      const seen = await readTargets(page, await startFlick(page));
      expect(exceptions(page)).toEqual([]);
      return seen;
    };
    const first = await run('fixed');
    const second = await run('fixed');
    expect(first).toHaveLength(TARGETS);
    // 20 個がそれぞれ見えていて、同じ位置に重なっていない（的を読めている）。
    expect(new Set(first.map((s) => `${s.x},${s.y}`)).size).toBeGreaterThan(TARGETS / 2);
    expect(second).toEqual(first);
    const other = await run('other');
    expect(positions(other)).not.toEqual(positions(first));
  });

  it(`ARC-45: seed=${SEED} で開いたページでフリックを 1 セット終え、リザルト画面の「もう一度」で始め直すと、的の位置の並びが 1 回目と一致する`, { timeout: 240_000 }, async () => {
    const page = await seeded('fixed');
    const first = await readTargets(page, await startFlick(page));
    await finishFlick(page);
    const again = await readTargets(page, await retry(page));
    expect(positions(again)).toEqual(positions(first));
    expect(exceptions(page)).toEqual([]);
  });

  it(`ARC-46: seed=${SEED} で開いたページで randomness が 0 でない L-STAR を同じ入力で撃つと、開き直した 2 回で弾痕の位置が一致し、入力の記録の種は ${SEED}`, { timeout: 120_000 }, async () => {
    const weapon = parseWeapon(JSON.parse(readFileSync(join(ROOT, 'src/data/weapons/lstar.json'), 'utf8')));
    if (!weapon.ok) throw new Error(JSON.stringify(weapon.errors));
    expect(weapon.weapon.randomness).toBeGreaterThan(0);
    /** 反復練習で L-STAR を 2 秒押し続けて離し、リザルト画面の弾痕の散布図の点（度）を読む。 */
    const shoot = async (which: 'fixed' | 'other') => {
      const page = await seeded(which, false);
      await choose(page, '#weapon', LSTAR);
      await page.clickSelector('[data-screen="top"] a[href="#/play"]');
      await lock(page);
      await page.advanceClock(0.1);
      await mouse(page, 'mousePressed');
      await page.advanceClock(2);
      await mouse(page, 'mouseReleased');
      await page.advanceClockUntil(`location.hash === '#/result'`, { step: 1 / 60, limit: 15 });
      await page.waitFor(`window.__vis('[data-screen="result"]')`);
      const points = await page.evaluate<{ yaw: number; pitch: number }[]>(`[...document.querySelectorAll('[data-plot="scatter"] [data-series="shots"] circle')]
        .map((c) => ({ yaw: Number(c.getAttribute('cx')), pitch: -Number(c.getAttribute('cy')) }))`);
      expect(exceptions(page)).toEqual([]);
      return points;
    };
    const first = await shoot('fixed');
    const second = await shoot('fixed');
    expect(first.length).toBeGreaterThan(5);
    expect(second).toEqual(first);
    expect(await shoot('other')).not.toEqual(first);

    // 入力の記録の種: 同じ入力（照準を動かさずに押し続け、離す）の記録を種 SEED で再生した弾痕が、画面の弾痕と一致する。
    const map = parseMap(JSON.parse(readFileSync(join(ROOT, 'src/data/maps/range.json'), 'utf8')));
    if (!map.ok) throw new Error(JSON.stringify(map.errors));
    const replay = (seed: number) => {
      const world = createWorld(map.map);
      const session = replayPracticeSession(
        { seed, actions: [{ time: 0.1, action: { type: 'fire', pressed: true } }, { time: 2.1, action: { type: 'fire', pressed: false } }] },
        { world, weapon: weapon.weapon, mode: repeatMode },
      );
      const num = (v: number) => (Math.round(v * 10000) / 10000 || 0);
      return shotDeviations(session.shots, world.center).map((p) => ({ yaw: num(p.yaw), pitch: num(p.pitch) }));
    };
    expect(replay(SEED)).toEqual(first);
    expect(replay(OTHER_SEED)).not.toEqual(first);
  });

  describe('ARC-47: seed を付けずに、または種として読めない値を付けて開くと、ページは誤りを出さずに練習が始まり、練習ごとに的の位置が変わる', () => {
    it.each([undefined, ...INVALID_SEEDS])('seed=%s', { timeout: 120_000 }, async (raw) => {
      const page = await withRawSeed(raw);
      const first = await readTargets(page, await startFlick(page), 3);
      expect(first.every((s) => Number.isFinite(s.x))).toBe(true);
      await finishFlick(page);
      const again = await readTargets(page, await retry(page), 3);
      expect(again.every((s) => Number.isFinite(s.x))).toBe(true);
      expect(positions(again)).not.toEqual(positions(first));
      expect(exceptions(page)).toEqual([]);
    });
  });

  it('ARC-48: seed を付けずに開くと、トップ・設定・プレイ・リザルト・履歴の画面に種の入力の欄・操作・値の表示がなく、リンクと遷移のあとの URL に seed が付かない', { timeout: 120_000 }, async () => {
    const page = await openPage(appUrl(origin, BASE, '#/', { render: false, manualClock: true, seed: NO_SEED }));
    /** 見えている画面の、種に関する欄・操作・文言と、seed の付いたリンク。 */
    const inspect = (screen: string) =>
      page.evaluate<{ shown: boolean; controls: string[]; texts: string[]; links: string[]; url: string }>(`(() => {
        const el = document.querySelector('[data-screen="${screen}"]');
        const shown = window.__vis(el);
        const about = (s) => /seed|乱数|種(?!類)/i.test(s ?? '');
        const controls = [...el.querySelectorAll('input, select, textarea, button, a, [role="button"]')].filter((c) => window.__vis(c))
          .filter((c) => about(c.id) || about(c.name) || about(c.textContent) || about(c.getAttribute('aria-label')) || about(c.closest('label')?.textContent) || [...(c.options ?? [])].some((o) => about(o.textContent)))
          .map((c) => c.outerHTML.slice(0, 120));
        const texts = about(el.innerText) ? [el.innerText.match(/.{0,20}(?:seed|乱数|種(?!類)).{0,20}/i)?.[0] ?? ''] : [];
        const links = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => /seed/i.test(h));
        return { shown, controls, texts, links, url: location.href };
      })()`);
    const expectClean = async (screen: string) => {
      const state = await inspect(screen);
      expect(state.shown, screen).toBe(true);
      expect(state.controls, screen).toEqual([]);
      expect(state.texts, screen).toEqual([]);
      expect(state.links, screen).toEqual([]);
      expect(state.url, screen).not.toMatch(/seed/i);
    };

    await expectClean('top');
    await page.clickSelector('[data-screen="top"] a[href="#/settings"]');
    await page.waitFor(`window.__vis('[data-screen="settings"]')`);
    await expectClean('settings');
    await page.evaluate(`location.hash = '#/'`);
    await page.waitFor(TOP_READY);
    await startFlick(page);
    await expectClean('play');
    await page.advanceClock(1.1);
    await finishFlick(page);
    await expectClean('result');
    await page.evaluate(`location.hash = '#/history'`);
    await page.waitFor(`window.__vis('[data-screen="history"]')`);
    await expectClean('history');
    expect(exceptions(page)).toEqual([]);
  });
});
