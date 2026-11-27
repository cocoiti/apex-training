// docs/spec/architecture.md「テストのための乱数の種の固定」の受け入れ条件 ARC-44〜ARC-48・ARC-50 を、ブラウザで確かめる QA の受け入れテスト。
// QA が SPEC だけから書いたもの。公開された入口（ビルドの結果を /apex-training/ で配信した画面、URL のクエリ、SPEC に書かれた
// localStorage のキーと値の形、画面写し、src/ の公開関数）だけを使い、実装の内部には依存しない。
//
// 受け入れ条件の ID を名前に持つブラウザのテストは fixed-seed-qa.acceptance.test.ts（tests/acceptance/README.md の表）なので、
// このファイルのテストの名前には ID を書かず、各テストの上のコメントに書く（ARC-29）。
// 種を付けずに開くとき（ARC-47・ARC-48）は NO_SEED を使う。このファイルは tests/helpers/test-seed.ts の UNSEEDED_PAGE_FILES にある。
//
// フリックの的の位置はページの中から読めないので、3D を描画して（render を付けない）画面写しを撮り、練習の的の色の画素の重心を
// 的の位置として読む。照準は動かさずに撃つので、画面の中の位置は的の向きだけで決まる。
// ページの時計はテストから進める（clock=manual）。Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { InputRecording } from '../../src/input/recording';
import { parseMap } from '../../src/sim/map';
import { replayRecording } from '../../src/sim/practice';
import { parseWeapon } from '../../src/sim/weapon';
import { appUrl, findChromium, launchBrowser, NO_SEED, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';
import { decodePng } from '../helpers/png';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
/** 受け入れ条件の種と、比べる別の種。 */
const SEED = 12345;
const OTHER_SEED = 12346;
/** 0 以上 2³² 未満の整数でない seed の値（ARC-47）。 */
const INVALID_SEEDS = ['abc', '-1', '1.5', '4294967296'] as const;
const chromium = findChromium();
const CX = 640;
const CY = 400;
/** 固定ステップ（architecture.md、既定 1/120 秒）。 */
const DT = 1 / 120;
const FLICK = 'フリック';
const REPEAT = '反復練習';
const LSTAR = 'L-STAR';
const TARGETS = 20;

// ---------------------------------------------------------------------------
// ページに入れるスクリプトと画面の操作
// ---------------------------------------------------------------------------

const PAGE_INIT = `
  window.__vis = (sel) => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    return !!el && !el.closest('[hidden]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0; };
  window.__hudMode = () => (document.querySelector('[data-hud="mode"]')?.textContent ?? '').trim();
  window.__ammo = () => { const m = (document.querySelector('[data-hud="ammo"]')?.textContent ?? '').match(/\\d+/); return m ? Number(m[0]) : NaN; };
`;

const TOP_READY = `window.__vis('[data-screen="top"]') && document.querySelector('#mode').options.length > 0 && document.querySelector('#count').options.length > 0`;

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

const now = (page: Page) => page.evaluate<number>('window.__apexTestClock.now()');

async function advanceTo(page: Page, t: number) {
  const d = t - (await now(page));
  if (d < -1e-9) throw new Error(`時計がすでに ${t} を過ぎている（今 ${await now(page)}）`);
  if (d > 1e-9) await page.advanceClock(d);
}

const mouseButton = (page: Page, type: 'mousePressed' | 'mouseReleased') =>
  page.send('Input.dispatchMouseEvent', { type, x: CX, y: CY, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });

/** プレイ画面でクリックしてポインターロックを掛ける（マウスは動かさない）。 */
async function lock(page: Page) {
  await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]')`);
  if (await page.evaluate<boolean>('!!document.pointerLockElement')) return;
  await page.frames(3);
  await mouseButton(page, 'mousePressed');
  await mouseButton(page, 'mouseReleased');
  await page.waitFor('!!document.pointerLockElement', 5000);
  await page.frames(2);
}

/** 押して 3 ステップ後に離す（照準は動かさない）。 */
async function click(page: Page) {
  await mouseButton(page, 'mousePressed');
  await page.advanceClock(3 * DT);
  await mouseButton(page, 'mouseReleased');
}

async function untilResult(page: Page) {
  await page.advanceClockUntil(`location.hash === '#/result'`, { step: 1 / 60, limit: 30 });
  await page.evaluate('document.pointerLockElement && document.exitPointerLock()');
  await page.waitFor(`window.__vis('[data-screen="result"]') && !document.pointerLockElement`);
  await page.frames(2);
}

/** 見えているボタンかリンクを表示名で探してクリックする。 */
async function clickByText(page: Page, scope: string, label: string) {
  const box = await page.evaluate<{ x: number; y: number } | null>(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(`${scope} a, ${scope} button`)})].find((e) => window.__vis(e) && e.textContent.trim() === ${JSON.stringify(label)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!box) throw new Error(`${scope} に「${label}」がない`);
  await page.click(box.x, box.y);
}

/** 履歴（localStorage の apex-training:history:）のうち、キーに part を含む組の最後の 1 件（at を除く）。 */
async function lastHistory(page: Page, part: string): Promise<Record<string, unknown>> {
  const raw = await page.evaluate<Record<string, string>>(`(() => { const out = {}; for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i);
    if (k.startsWith('apex-training:history:') && k.includes(${JSON.stringify(part)})) out[k] = localStorage.getItem(k); } return out; })()`);
  const keys = Object.keys(raw);
  if (keys.length !== 1) throw new Error(`${part} の履歴の組が 1 つでない: ${JSON.stringify(keys)}`);
  const entries = (JSON.parse(raw[keys[0]!]!) as { entries: Record<string, unknown>[] }).entries;
  const rest = { ...entries[entries.length - 1]! };
  delete rest.at;
  return rest;
}

/**
 * リザルト画面に見えている指標（見出し → 値の文字）。照準を動かさずに撃つと的に当たらず、比べる指標が求まらないので履歴に残らない
 * （scoring.md「練習の履歴」）。そのため、フリックのズレの平均は画面の指標から読む。
 */
const resultMetrics = (page: Page) =>
  page.evaluate<Record<string, string>>(`(() => { const out = {}; for (const dt of document.querySelectorAll('[data-screen="result"] dt')) {
    if (!window.__vis(dt)) continue; const dd = dt.nextElementSibling; if (dd && dd.tagName === 'DD') out[dt.textContent.trim()] = dd.textContent.trim(); } return out; })()`);
/** 指標のうち、見出しに「ズレ」を含むもの（フリックのズレの平均）の値の文字。 */
async function flickError(page: Page): Promise<string> {
  const m = await resultMetrics(page);
  const k = Object.keys(m).find((x) => x.includes('ズレ'));
  if (k === undefined) throw new Error(`リザルト画面にズレの指標がない: ${JSON.stringify(m)}`);
  return m[k]!;
}

// 練習の的の色の画素 ---------------------------------------------------------

let targetColor: [number, number, number] | undefined;
const CLIP = { x: CX - 480, y: CY - 160, width: 960, height: 320 };

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
  return n === 0 ? { n, x: NaN, y: NaN } : { n, x: sx / n, y: sy / n };
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
  if (!top || top[1] < 20) throw new Error(`的が出たあとの画面写しの差が見つからない: ${JSON.stringify([...counts].slice(0, 5))}`);
  targetColor = top[0].split(',').map(Number) as [number, number, number];
}

/** 1 つの的の観測（画面の重心と、練習の開始から見えた時刻）。 */
interface Seen {
  x: number;
  y: number;
  /** 練習の開始から、その的が画面に見えた時刻（秒）。 */
  t: number;
}

/**
 * 3D を描画するページで、練習が始まった直後から n 個の的を、照準を動かさずに決まった時刻の並びで撃ち、
 * 出た的の画面の位置と見えた時刻を返す（1 個目の的が出る前は見えないことも確かめる）。
 */
async function observeFlick(page: Page, startedAt: number, n = TARGETS): Promise<Seen[]> {
  await advanceTo(page, startedAt + 1 - 0.03);
  const before = await page.screenshot();
  if (targetColor) expect((await findTarget(page)).n, '1 個目の的は練習の開始から 1 秒より前に出ない').toBe(0);
  await advanceTo(page, startedAt + 1 + 1 / 30);
  if (!targetColor) learnTargetColor(before, await page.screenshot());
  const seen: Seen[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = await findTarget(page);
    if (t.n === 0) throw new Error(`${i + 1} 個目の的が画面に見えない`);
    seen.push({ x: t.x, y: t.y, t: Number(((await now(page)) - startedAt).toFixed(4)) });
    await click(page);
    // 撃った的はそのステップで消え、次の的がそのステップの終わりに出る。描画が追いつくよう少し進める。
    await page.advanceClock(1 / 30);
  }
  return seen;
}

const samePositions = (a: Seen[], b: Seen[], tol = 1.5) => a.length === b.length && a.every((p, i) => Math.hypot(p.x - b[i]!.x, p.y - b[i]!.y) <= tol);
const differentPositions = (a: Seen[], b: Seen[], tol = 4) => a.some((p, i) => b[i] === undefined || Math.hypot(p.x - b[i]!.x, p.y - b[i]!.y) > tol);
const fmt = (s: Seen[]) => s.map((p) => `(${p.x.toFixed(1)},${p.y.toFixed(1)})@${p.t}`).join(' ');

/** 3D を描画しないページで、照準を動かさずに n 回撃つ（1 回目は 1 個目の的が出たあと）。 */
async function shootBlind(page: Page, startedAt: number, n = TARGETS) {
  if ((await now(page)) < startedAt + 1.05) await advanceTo(page, startedAt + 1.05);
  for (let i = 0; i < n; i += 1) {
    await click(page);
    await page.advanceClock(0.05);
  }
}

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('QA: URL の seed による練習の乱数の種の固定（ブラウザ）', () => {
  let work = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  const noErrors = (page: Page) => expect(page.errors, page.errors.join('\n')).toEqual([]);

  /** url を新しいタブで開き、localStorage を空にして読み込み直したトップ画面にする。 */
  async function open(url: string): Promise<Page> {
    const page = await browser!.newPage();
    await page.goto(url);
    await page.evaluate(`localStorage.clear()`);
    await page.addInitScript(PAGE_INIT);
    await page.evaluate(`window.__beforeReload = true`);
    await page.reload({ ignoreCache: false });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && ${TOP_READY}`, 15_000);
    return page;
  }
  /** seed=12345（other なら 12346）を付けたトップ画面の URL。 */
  const seeded = (other: boolean, render: boolean) => appUrl(origin, BASE, '#/', { render, manualClock: true, seed: other ? OTHER_SEED : SEED });

  /** トップ画面でモード（と武器）を選んで「開始」を押し、ポインターロックを掛ける。練習の開始の時計を返す。 */
  async function start(page: Page, mode: string, weapon?: string): Promise<number> {
    await page.waitFor(TOP_READY);
    if (weapon) await choose(page, '#weapon', weapon);
    await choose(page, '#mode', mode);
    await choose(page, '#count', 1);
    await page.clickSelector('[data-screen="top"] a[href="#/play"]');
    await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]')`);
    const startedAt = await now(page);
    await lock(page);
    return startedAt;
  }

  /** リザルト画面の「もう一度」で始め直し、ポインターロックを掛ける。練習の開始の時計を返す。 */
  async function retry(page: Page): Promise<number> {
    await clickByText(page, '[data-screen="result"]', 'もう一度');
    await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]')`);
    const startedAt = await now(page);
    await lock(page);
    return startedAt;
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'seed-query-qa-'));
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

  // ARC-44
  it(`seed=${SEED} で開き直して 2 回フリックを 20 個進めると的の位置と出た時刻の並びが一致し、seed=${OTHER_SEED} では一致しない`, { timeout: 300_000 }, async () => {
    const runs: { seen: Seen[]; metrics: Record<string, string>; error: string }[] = [];
    for (const other of [false, false, true]) {
      const seed = other ? OTHER_SEED : SEED;
      const page = await open(seeded(other, true));
      expect(await page.evaluate<string>('location.search'), '開いた URL の seed').toContain(`seed=${seed}`);
      const startedAt = await start(page, FLICK);
      expect(await page.evaluate<string>('window.__hudMode()')).toBe('的: 0 / 20');
      const seen = await observeFlick(page, startedAt);
      await untilResult(page);
      runs.push({ seen, metrics: await resultMetrics(page), error: await flickError(page) });
      noErrors(page);
      await browser!.closePages();
    }
    const [a, b, c] = runs as [(typeof runs)[0], (typeof runs)[0], (typeof runs)[0]];
    expect(a.seen).toHaveLength(TARGETS);
    // 20 個の的は同じ所に出続けない（位置を読めていることの確認）。
    expect(new Set(a.seen.map((p) => `${Math.round(p.x / 5)},${Math.round(p.y / 5)}`)).size).toBeGreaterThan(10);
    expect(samePositions(a.seen, b.seen), `1 回目: ${fmt(a.seen)}\n2 回目: ${fmt(b.seen)}`).toBe(true);
    expect(b.seen.map((p) => p.t)).toEqual(a.seen.map((p) => p.t));
    expect(b.metrics).toEqual(a.metrics);
    expect(differentPositions(a.seen, c.seen), `seed=${SEED}: ${fmt(a.seen)}\nseed=${OTHER_SEED}: ${fmt(c.seen)}`).toBe(true);
    expect(c.error).not.toBe(a.error);
  });

  // ARC-45
  it(`seed=${SEED} で開いたページでフリックを 1 セット終え、リザルト画面の「もう一度」で始め直すと的の位置の並びが 1 回目と一致する`, { timeout: 240_000 }, async () => {
    const page = await open(seeded(false, true));
    const first = await observeFlick(page, await start(page, FLICK));
    await untilResult(page);
    const firstMetrics = await resultMetrics(page);
    const startedAt = await retry(page);
    expect(await page.evaluate<string>('window.__hudMode()')).toBe('的: 0 / 20');
    const second = await observeFlick(page, startedAt);
    await untilResult(page);
    expect(samePositions(first, second), `1 回目: ${fmt(first)}\nもう一度: ${fmt(second)}`).toBe(true);
    expect(await resultMetrics(page)).toEqual(firstMetrics);
    noErrors(page);
  });

  // ARC-46
  it(`seed=${SEED} で開き直して L-STAR を同じ入力で 2 回撃つと弾痕の位置が一致し、その結果は種 ${SEED} の入力の記録の再生と一致する`, { timeout: 180_000 }, async () => {
    interface Shot {
      points: string[];
      history: Record<string, unknown>;
    }
    const shots: Shot[] = [];
    for (let i = 0; i < 2; i += 1) {
      const page = await open(seeded(false, false));
      const startedAt = await start(page, REPEAT, LSTAR);
      const full = await page.evaluate<number>('window.__ammo()');
      expect(full).toBeGreaterThan(5);
      // 開始から 0.5 秒のステップの真ん中で押し、照準を動かさずに撃ち切る。
      await advanceTo(page, startedAt + 0.5 + DT / 2);
      await mouseButton(page, 'mousePressed');
      await untilResult(page);
      await mouseButton(page, 'mouseReleased');
      // 弾痕の散布図の点（各弾の水平・垂直のズレを描いたもの）。
      const points = await page.evaluate<string[]>(`[...document.querySelectorAll('[data-screen="result"] svg circle')]
        .map((c) => [c.getAttribute('cx'), c.getAttribute('cy'), c.getAttribute('r')].join(','))`);
      shots.push({ points, history: await lastHistory(page, ':lstar:') });
      noErrors(page);
      await browser!.closePages();
    }
    const [a, b] = shots as [Shot, Shot];
    expect(a.points.length, '散布図の点').toBeGreaterThan(5);
    expect(b.points).toEqual(a.points);
    expect(b.history).toEqual(a.history);

    // 照準を動かさずに 1 マガジンを撃ち切った記録を、種 12345 と 12346 でブラウザなしに再生し、ページの結果がどちらに当たるかを見る。
    const map = parseMap(JSON.parse(readFileSync(join(ROOT, 'src/data/maps/range.json'), 'utf8')));
    const weapon = parseWeapon(JSON.parse(readFileSync(join(ROOT, 'src/data/weapons/lstar.json'), 'utf8')));
    if (!map.ok || !weapon.ok) throw new Error('マップか武器を読み込めない');
    expect(weapon.weapon.randomness).not.toBe(0);
    const replay = (seed: number) => {
      const recording: InputRecording = {
        seed,
        actions: [
          { time: 0.5, action: { type: 'fire', pressed: true } },
          { time: 20, action: { type: 'fire', pressed: false } },
        ],
      };
      return replayRecording(recording, { map: map.map, weapon: weapon.weapon }).score;
    };
    const mine = replay(SEED);
    const other = replay(OTHER_SEED);
    expect(mine.shots).toBe(a.history.shots);
    expect(other.meanDeviation).not.toBeCloseTo(mine.meanDeviation!, 6);
    expect(a.history.meanError as number).toBeCloseTo(mine.meanDeviation!, 6);
    expect(a.history.groupingRadius as number).toBeCloseTo(mine.groupingRadius!, 6);
  });

  // ARC-47
  it.each(['なし', ...INVALID_SEEDS] as string[])(
    'seed が %s のページでフリックを 2 回始めると、誤りを出さずに始まり、2 回の的の位置の並びが一致しない',
    { timeout: 180_000 },
    async (value: string) => {
      // 的の位置を画面写しで読むので 3D を描画する（render を付けない）。
      const url =
        value === 'なし'
          ? appUrl(origin, BASE, '#/', { manualClock: true, seed: NO_SEED })
          : `${origin}${BASE}?clock=manual&seed=${encodeURIComponent(value)}#/`;
      const page = await open(url);
      noErrors(page);
      const runs: Seen[][] = [];
      for (let i = 0; i < 2; i += 1) {
        const startedAt = i === 0 ? await start(page, FLICK) : await retry(page);
        expect(await page.evaluate<string>('location.hash')).toBe('#/play');
        expect(await page.evaluate<string>('window.__hudMode()')).toBe('的: 0 / 20');
        // 初めの 5 個の的の位置を読み、残りは照準を動かさずに撃って練習を終える。
        runs.push(await observeFlick(page, startedAt, 5));
        await shootBlind(page, startedAt, TARGETS - 5);
        await untilResult(page);
      }
      noErrors(page);
      expect(differentPositions(runs[0]!, runs[1]!), `1 回目: ${fmt(runs[0]!)}\n2 回目: ${fmt(runs[1]!)}`).toBe(true);
    },
  );

  // ARC-48
  it('seed を付けずに開くと、どの画面にも種の欄・操作・値の表示がなく、画面の中のリンクと遷移のあとの URL に seed が付かない', { timeout: 180_000 }, async () => {
    const page = await open(appUrl(origin, BASE, '#/', { render: false, manualClock: true, seed: NO_SEED }));
    const visited: string[] = [];
    const check = async (screen: string) => {
      const st = await page.evaluate<{ href: string; links: string[]; controls: string[]; text: string }>(`(() => {
        const root = document.querySelector('[data-screen="${screen}"]');
        const controls = [...document.querySelectorAll('input, select, textarea, button, [contenteditable], [role="button"], [role="textbox"]')]
          .filter((e) => window.__vis(e))
          .map((e) => [e.id, e.getAttribute('name'), e.getAttribute('placeholder'), e.getAttribute('aria-label'), e.getAttribute('title'),
            e.closest('label')?.textContent ?? '', e.textContent ?? ''].join('|'));
        return { href: location.href, links: [...document.querySelectorAll('a[href]')].map((a) => a.href), controls, text: root ? root.innerText : '' }; })()`);
      visited.push(`${screen}: ${st.href}`);
      expect(st.text.length, `${screen} の画面が出ている`).toBeGreaterThan(0);
      expect(st.href, `${screen} の URL`).not.toMatch(/seed/i);
      expect(st.links.filter((l) => /seed/i.test(l)), `${screen} のリンク`).toEqual([]);
      const seedish = /seed|シード|乱数|種(?!類)/i;
      expect(st.controls.filter((c) => seedish.test(c)), `${screen} の入力の欄・操作`).toEqual([]);
      expect(st.text, `${screen} の表示`).not.toMatch(seedish);
    };

    await check('top');
    await page.clickSelector('[data-screen="top"] a[href="#/settings"]');
    await page.waitFor(`location.hash === '#/settings' && window.__vis('[data-screen="settings"]')`);
    await check('settings');
    await page.evaluate(`history.back()`);
    await page.waitFor(TOP_READY);
    await page.clickSelector('[data-screen="top"] a[href="#/history"]');
    await page.waitFor(`location.hash === '#/history' && window.__vis('[data-screen="history"]')`);
    await check('history');
    await page.evaluate(`history.back()`);
    await page.waitFor(TOP_READY);

    let startedAt = await start(page, FLICK);
    await check('play');
    await shootBlind(page, startedAt);
    await untilResult(page);
    await check('result');
    startedAt = await retry(page);
    await check('play');
    await shootBlind(page, startedAt);
    await untilResult(page);
    await check('result');
    await clickByText(page, '[data-screen="result"]', '武器変更');
    await page.waitFor(TOP_READY);
    await check('top');
    // 練習を終えたあとの履歴の画面（推移や一覧が出ているとき）。
    await page.clickSelector('[data-screen="top"] a[href="#/history"]');
    await page.waitFor(`location.hash === '#/history' && window.__vis('[data-screen="history"]')`);
    await check('history');
    noErrors(page);
    expect(visited.every((v) => !/seed/i.test(v)), visited.join('\n')).toBe(true);
  });

  // ARC-48（補足）: seed を付けて開いても、画面に種の値が出ない。
  it(`seed=${SEED} を付けて開いても、トップ・プレイ・リザルトに種の値が出ず、もう一度のあとの URL は開いた URL のクエリのまま`, { timeout: 120_000 }, async () => {
    const page = await open(seeded(false, false));
    const search = await page.evaluate<string>('location.search');
    const text = () => page.evaluate<string>('document.body.innerText');
    expect(await text()).not.toContain(String(SEED));
    const startedAt = await start(page, FLICK);
    expect(await text()).not.toContain(String(SEED));
    await shootBlind(page, startedAt);
    await untilResult(page);
    expect(await text()).not.toContain(String(SEED));
    await retry(page);
    expect(await page.evaluate<string>('location.search')).toBe(search);
    noErrors(page);
  });

  // ARC-50
  it('固定の種でページを開いたブラウザのテストが失敗すると、失敗のメッセージかテストの名前にその種の値が出る', { timeout: 180_000 }, () => {
    // ブラウザの道具でページを実際に開いて（Chromium）、わざと失敗するテストのファイルを、別の Vitest で流す。
    const dir = join(work, 'seed-fail-fixture');
    const site = join(dir, 'site');
    mkdirSync(site, { recursive: true });
    writeFileSync(join(site, 'index.html'), '<!doctype html><title>x</title><p>fixture</p>');
    const helpers = join(ROOT, 'tests', 'helpers');
    const fixtureSeed = 97531;
    const fixture = [
      `import { afterAll, beforeAll, expect, it } from 'vitest';`,
      `import { appUrl, findChromium, launchBrowser, originOf, serveStatic } from ${JSON.stringify(join(helpers, 'browser.ts'))};`,
      `const SEED = ${fixtureSeed};`,
      `let server; let browser; let origin = '';`,
      `beforeAll(async () => { server = await serveStatic(${JSON.stringify(site)}, '/apex-training/'); origin = originOf(server);`,
      `  browser = await launchBrowser(findChromium()); }, 60000);`,
      `afterAll(async () => { await browser?.close(); await new Promise((ok) => server.close(ok)); });`,
      `it('わざと失敗する', async () => {`,
      `  const page = await browser.newPage();`,
      `  await page.goto(appUrl(origin, '/apex-training/', '#/', { render: false, seed: SEED }));`,
      `  expect(await page.evaluate('document.title')).toBe('ちがう');`,
      `}, 60000);`,
    ].join('\n');
    writeFileSync(join(dir, 'fail.test.ts'), fixture);
    writeFileSync(join(dir, 'vitest.config.mjs'), `export default { test: { include: ['fail.test.ts'] } };`);
    const report = join(dir, 'report.json');
    const out = spawnSync(
      'npx',
      ['vitest', 'run', '--root', dir, '--config', join(dir, 'vitest.config.mjs'), '--reporter', 'default', '--reporter', 'json', '--outputFile.json', report],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' }, timeout: 150_000 },
    );
    expect(out.status, out.stdout + out.stderr).toBe(1);
    const json = JSON.parse(readFileSync(report, 'utf8')) as {
      testResults: { assertionResults: { title: string; fullName: string; status: string; failureMessages: string[] }[] }[];
    };
    const failed = json.testResults.flatMap((r) => r.assertionResults).filter((a) => a.status === 'failed');
    expect(failed).toHaveLength(1);
    const shown = `${failed[0]!.fullName}\n${failed[0]!.failureMessages.join('\n')}`;
    expect(shown).toContain(String(fixtureSeed));
    // 画面に出す報告にも出る。
    expect(out.stdout + out.stderr).toContain(String(fixtureSeed));
  });
});
