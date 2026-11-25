// Issue #50（計測した値の武器だけを武器の一覧と選択肢に出す）の受け入れテスト。
// docs/spec/weapons.md の WPN-1・WPN-3・WPN-21・WPN-22・WPN-23、modes.md の MODE-1・MODE-23、
// scoring.md の SCO-18・SCO-20・SCO-23・SCO-26、screens.md の UI-24 を、公開された入口だけで確かめる。
// 入口は、ビルドの結果を /apex-training/ で配信した画面（ヘッドレスの Chromium、tests/helpers/browser.ts）、
// ブラウザのコンソール、SPEC に書かれた localStorage のキーと値の形、src/data/weapons/ と docs/measurements/ の JSON。
// WPN-1・WPN-21・WPN-22 はリポジトリの写しに武器の JSON を足してビルドし、その画面で確かめる。
// 撃つのはマウス（ポインターロック + 左ボタン）。Chromium がなければ画面の確認を飛ばす。入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findChromium, launchBrowser, originOf, serveStatic, waitUntil, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const WEAPONS_DIR = join(ROOT, 'src/data/weapons');
const MEASUREMENTS_DIR = join(ROOT, 'docs/measurements');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const CX = 640;
const CY = 400;
const chromium = findChromium();

/** SPEC の名前と値（実装の定数には依存しない）。 */
const MEASURED_NAMES = ['C.A.R. SMG', 'L-STAR'];
const PLACEHOLDER_NAMES = ['R-301', 'R-99', 'フラットライン', 'ボルト', 'スピットファイア'];
const MODES = ['パターン観察', '反復練習', 'センター維持'];
const BEST_UPDATED = '自己ベスト更新';
const BEST_KEY = 'apex-training:best:mouse:lstar:center';
const HISTORY_KEY = 'apex-training:history:mouse:lstar:center';

interface WeaponJson {
  id: string;
  name: string;
  category: string;
  source: string;
  magSize: number;
  measured: unknown;
}
const weaponFiles = () =>
  readdirSync(WEAPONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: f, json: JSON.parse(readFileSync(join(WEAPONS_DIR, f), 'utf8')) as WeaponJson }));

/** 項目の確認を通る武器の JSON（weapons.md の項目の表のとおり）。 */
const qaWeapon = (id: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name,
  category: 'LMG',
  version: 'S31-Cipher',
  source: 'QA の受け入れテストで足した武器',
  rpm: 600,
  magSize: 4,
  pattern: [
    { dx: 0.1, dy: 0.3 },
    { dx: -0.1, dy: 0.4 },
    { dx: 0.2, dy: 0.5 },
    { dx: 0, dy: 0.5 },
  ],
  randomness: 0,
  measured: true,
  ...extra,
});
const CAR_ID = weaponFiles().find((f) => f.json.name === 'C.A.R. SMG')?.json.id ?? 'C.A.R. SMG の JSON がない';
const NEW_WEAPON = qaWeapon('qa-new-measured', 'QA-計測済み');
const PLACEHOLDER = qaWeapon('qa-placeholder', 'QA-仮データ', { measured: false, source: '仮データ（QA）' });
/** WPN-22: measured が欠けたもの、真偽値でないもの（文字列・数・null）。 */
const BAD_MEASURED: Record<string, Record<string, unknown>> = {
  'qa-no-measured': (() => {
    const w = qaWeapon('qa-no-measured', 'QA-measuredなし');
    delete w.measured;
    return w;
  })(),
  'qa-text-measured': qaWeapon('qa-text-measured', 'QA-measured文字列', { measured: 'true' }),
  'qa-number-measured': qaWeapon('qa-number-measured', 'QA-measured数', { measured: 1 }),
  'qa-null-measured': qaWeapon('qa-null-measured', 'QA-measurednull', { measured: null }),
};

// ---------------------------------------------------------------------------
// WPN-23: リポジトリの武器の JSON と計測の記録
// ---------------------------------------------------------------------------

describe('WPN-23: src/data/weapons/ の JSON と計測の記録', () => {
  const files = weaponFiles();

  it('measured が true のものには同じ id の計測の記録（docs/measurements/<id>.json）がある', () => {
    const measured = files.filter((f) => f.json.measured === true);
    expect(measured.map((f) => f.json.name).sort()).toEqual(MEASURED_NAMES);
    for (const { json } of measured) {
      const record = join(MEASUREMENTS_DIR, `${json.id}.json`);
      expect(existsSync(record), `${json.id} の計測の記録がない: ${record}`).toBe(true);
      // 記録は JSON として読める。
      expect(() => JSON.parse(readFileSync(record, 'utf8'))).not.toThrow();
    }
  });

  it('measured が false のもの（R-301・R-99・フラットライン・ボルト・スピットファイア）は source に仮データであることが書かれている', () => {
    const placeholders = files.filter((f) => f.json.measured === false);
    expect(placeholders.map((f) => f.json.name).sort()).toEqual([...PLACEHOLDER_NAMES].sort());
    for (const { json } of placeholders) expect(json.source, json.name).toContain('仮データ');
    // measured はすべての JSON で真偽値。
    for (const { file, json } of files) expect(typeof json.measured, file).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// 画面の読み取りと操作
// ---------------------------------------------------------------------------

const PAGE_INIT = `
  window.__num = (sel) => { const m = (document.querySelector(sel)?.textContent ?? '').match(/-?\\d+(?:\\.\\d+)?/); return m ? Number(m[0]) : NaN; };
  window.__ammo = () => window.__num('[data-hud="ammo"]');
  window.__vis = (sel) => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    return !!el && !el.closest('[hidden]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0; };
  window.__round = () => { const el = document.querySelector('[data-hud="round"]'); return el && window.__vis(el) ? el.textContent.trim() : ''; };
  window.__interlude = () => window.__vis('#interlude');
`;

const optionsOf = (page: Page, selector: string) =>
  page.evaluate<string[]>(`[...document.querySelector(${JSON.stringify(selector)}).options].map((o) => o.textContent.trim())`);

/** 選択肢の表示名（数なら表示の中の数）から値を選ぶ（キーボードで選んだときと同じく input と change を出す）。 */
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

/** 履歴の画面の、表示名 caption の label の中の select。 */
const historySelect = (caption: string) =>
  `[...document.querySelector('[data-screen="history"]').querySelectorAll('select')].find((x) => (x.closest('label')?.textContent ?? x.getAttribute('aria-label') ?? '').trim().startsWith(${JSON.stringify(caption)}))`;

async function chooseHistory(page: Page, caption: string, label: string) {
  const ok = await page.evaluate<boolean>(`(() => {
    const s = ${historySelect(caption)};
    if (!s) return false;
    const o = [...s.options].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  if (!ok) throw new Error(`履歴の画面の ${caption} に ${label} の選択肢がない`);
  await page.frames(2);
}

/** 同じページのままハッシュで履歴の画面を開き、武器の選択肢の表示名を返す。 */
async function openHistory(page: Page): Promise<string[]> {
  await page.evaluate(`location.hash = '#/history'`);
  await page.waitFor(`window.__vis('[data-screen="history"]') && !!(${historySelect('武器')}) && (${historySelect('武器')}).options.length > 0`);
  await page.frames(2);
  return page.evaluate<string[]>(`[...(${historySelect('武器')}).options].map((o) => o.textContent.trim())`);
}

/** トップ画面を開いて、武器の選択肢の表示名を返す。 */
async function openTop(page: Page): Promise<string[]> {
  await page.evaluate(`location.hash = '#/'`);
  await page.waitFor(`window.__vis('[data-screen="top"]') && document.querySelector('#weapon').options.length > 0 && document.querySelector('#mode').options.length > 0`);
  return optionsOf(page, '#weapon');
}

const mouseButton = (page: Page, type: 'mousePressed' | 'mouseReleased') =>
  page.send('Input.dispatchMouseEvent', { type, x: CX, y: CY, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });

/** ポインターロックしていなければ、画面の中央をクリックしてロックする。 */
async function lock(page: Page) {
  if (await page.evaluate<boolean>('!!document.pointerLockElement')) return;
  await page.frames(3);
  await waitUntil(() => page.lockPointerBy(() => page.click(CX, CY), 1_000), 'クリックでポインターロックが掛かる', { timeout: 15_000 });
  await page.frames(2);
}

/** トップ画面で武器・モード・回数を選んで「開始」を押し、プレイ画面で撃てるようになるまで待つ。 */
async function start(page: Page, weapon: string, mode: string, count = 1) {
  await openTop(page);
  await choose(page, '#weapon', weapon);
  await choose(page, '#mode', mode);
  if (await page.evaluate<boolean>(`!!document.querySelector('#count')`)) await choose(page, '#count', count);
  await page.clickSelector('[data-screen="top"] a[href="#/play"]');
  await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]') && window.__ammo() > 0`);
  await lock(page);
}

/** 左ボタンを押し続けて 1 マガジンを撃ち切る。pull があれば撃っているあいだにマウスを下へ動かす。 */
async function fireAll(page: Page, pull = 0) {
  await mouseButton(page, 'mousePressed');
  if (pull) {
    let y = CY;
    for (let i = 0; i < 15; i += 1) {
      await page.frames(3);
      y += pull;
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: CX, y, buttons: 1, button: 'left' });
    }
  }
  await page.waitFor(`window.__ammo() === 0 || location.hash !== '#/play' || window.__interlude()`, 20_000);
  await mouseButton(page, 'mouseReleased');
}

interface ResultState {
  text: string;
  summary: string;
  meanError: string;
}
const resultState = (page: Page) =>
  page.evaluate<ResultState>(`(() => {
    const screen = document.querySelector('[data-screen="result"]');
    let meanError = '';
    for (const dt of screen.querySelectorAll('dt')) { if (window.__vis(dt) && dt.textContent.includes('平均ズレ')) { meanError = dt.nextElementSibling?.textContent.trim() ?? ''; break; } }
    return { text: screen.innerText, summary: document.querySelector('#result-summary')?.textContent ?? screen.innerText, meanError }; })()`);

/** 1 回の練習（武器とモードを選んで撃ち切り、リザルト画面が表示されるまで）。 */
async function practice(page: Page, weapon: string, mode: string, pull = 0): Promise<ResultState> {
  await start(page, weapon, mode);
  await fireAll(page, pull);
  await page.waitFor(`location.hash === '#/result' && window.__vis('[data-screen="result"]')`, 15_000);
  await page.evaluate('document.exitPointerLock()');
  await page.frames(2);
  return resultState(page);
}

/** 「0.53°」などから数を取り出す。 */
const num = (s: string): number => {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) throw new Error(`数がない: ${s}`);
  return Number(m[0]);
};

const getItem = (page: Page, key: string) => page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(key)})`);
const keysWith = (page: Page, prefix: string) =>
  page.evaluate<string[]>(`Object.keys(localStorage).filter((k) => k.startsWith(${JSON.stringify(prefix)})).sort()`);

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('計測した武器だけを選択肢に出す（画面）', () => {
  const temps: string[] = [];
  let mainDist = '';
  /** 写し A: 計測した新しい武器・measured が false の武器・measured の誤りの武器を足したビルド。 */
  let distA = '';
  /** 写し B: 写し A の measured が false の武器だけを measured: true にしてビルドし直したもの。 */
  let distB = '';
  let buildA = { status: null as number | null, output: '' };
  let buildB = { status: null as number | null, output: '' };
  let site = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));

  const serveDist = (dir: string) => {
    if (existsSync(site)) unlinkSync(site);
    symlinkSync(dir, site, 'dir');
  };

  /** 新しいタブで localStorage を空にし（seed を入れ）、読み込み直したトップ画面を開く。 */
  async function openFresh(seed: Record<string, string> = {}): Promise<Page> {
    const page = await browser!.newPage();
    await page.goto(`${origin}${BASE}#/`);
    await page.evaluate(`(() => { localStorage.clear(); const seed = ${JSON.stringify(seed)}; for (const k in seed) localStorage.setItem(k, seed[k]); })()`);
    await page.addInitScript(PAGE_INIT);
    await page.evaluate('window.__beforeReload = true');
    await page.send('Page.reload', { ignoreCache: false });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && window.__vis('[data-screen="top"]')`, 15_000);
    return page;
  }

  const build = (cwd: string, outDir: string) => {
    const r = spawnSync(`npm run build -- --outDir "${outDir}" --emptyOutDir`, {
      cwd,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, APEX_ACCEPTANCE_NESTED: '1', FORCE_COLOR: '0' },
    });
    return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  beforeAll(async () => {
    const work = mkdtempSync(join(tmpdir(), 'measured-qa-'));
    temps.push(work);
    mainDist = join(work, 'main-dist');
    const main = build(ROOT, mainDist);
    if (main.status !== 0) throw new Error(`ビルドが失敗した:\n${main.output}`);

    const copy = join(work, 'copy');
    for (const entry of ['src', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'eslint.config.js', 'scripts', 'public']) {
      if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
    }
    symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), 'dir');
    const dir = join(copy, 'src/data/weapons');
    const put = (id: string, json: Record<string, unknown>) => writeFileSync(join(dir, `${id}.json`), JSON.stringify(json, null, 2));
    put(NEW_WEAPON.id as string, NEW_WEAPON);
    put(PLACEHOLDER.id as string, PLACEHOLDER);
    for (const [id, json] of Object.entries(BAD_MEASURED)) put(id, json);
    distA = join(work, 'dist-a');
    buildA = build(copy, distA);
    // 同じ JSON の measured だけを true にしてビルドし直す（コードは変えない）。
    put(PLACEHOLDER.id as string, { ...PLACEHOLDER, measured: true });
    distB = join(work, 'dist-b');
    buildB = build(copy, distB);

    site = join(work, 'site');
    serveDist(mainDist);
    server = await serveStatic(site, BASE);
    origin = originOf(server);
    browser = await launchBrowser(chromium!);
  }, 400_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((ok) => (server ? server.close(ok) : ok(undefined)));
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  describe('WPN-3: リポジトリのままのビルド', () => {
    it('WPN-3: トップ画面の武器の選択肢は L-STAR と C.A.R. SMG の 2 つだけで、仮データの 5 つは出ない（履歴の画面も同じ）', async () => {
      serveDist(mainDist);
      const page = await openFresh();
      const top = await openTop(page);
      expect(top.slice().sort(), JSON.stringify(top)).toEqual(MEASURED_NAMES);
      for (const name of PLACEHOLDER_NAMES) expect(top).not.toContain(name);
      const history = await openHistory(page);
      expect(history.slice().sort(), JSON.stringify(history)).toEqual(MEASURED_NAMES);
      // 仮データの武器の JSON について、開発者向けの誤りは出ない。
      for (const { file } of weaponFiles()) expect(page.errors.filter((e) => e.includes(file))).toEqual([]);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('WPN-1 / WPN-21 / WPN-22: 写しに武器の JSON を足してビルドする', () => {
    it('コードを変えずに写しのビルドが 2 回とも通る', () => {
      expect(buildA.status, buildA.output.slice(-4000)).toBe(0);
      expect(buildB.status, buildB.output.slice(-4000)).toBe(0);
    });

    /** 写しのビルドを開き、measured の誤りの知らせがすべて出るまで待ってから、トップ画面と履歴の画面の選択肢を読む。 */
    async function readCopy(dist: string) {
      serveDist(dist);
      const page = await openFresh();
      const top = await openTop(page);
      await waitUntil(
        () => Object.keys(BAD_MEASURED).every((id) => page.errors.some((e) => e.includes(`${id}.json`))),
        'measured の誤りの武器のファイル名がすべてコンソールに出る',
      );
      const history = await openHistory(page);
      return { page, top, history };
    }

    it('WPN-1: measured が true の新しい武器の JSON を足してビルドすると、トップ画面と履歴の画面の武器の選択肢に出る', async () => {
      const { page, top, history } = await readCopy(distA);
      for (const names of [top, history]) {
        expect(names, JSON.stringify(names)).toContain(NEW_WEAPON.name);
        for (const name of MEASURED_NAMES) expect(names).toContain(name);
      }
      // 足した武器は、その category の見出しの下に出る。
      await openTop(page);
      const groups = await page.evaluate<{ label: string; names: string[] }[]>(`[...document.querySelectorAll('#weapon optgroup')].map((g) => ({
        label: g.label, names: [...g.children].map((o) => o.textContent.trim()) }))`);
      expect(groups.find((g) => g.label === NEW_WEAPON.category)?.names, JSON.stringify(groups)).toContain(NEW_WEAPON.name);
      expect(page.errors.filter((e) => e.includes(NEW_WEAPON.id as string))).toEqual([]);
      // 足した武器で練習を始められる。
      await start(page, NEW_WEAPON.name as string, 'センター維持');
      expect(await page.evaluate<string>(`document.querySelector('[data-hud="weapon"]')?.textContent ?? ''`)).toContain(NEW_WEAPON.name);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('WPN-21: measured が false の武器はトップ画面と履歴の画面の選択肢に出ず誤りも出ない。measured を true にしてビルドすると両方に出る', async () => {
      const a = await readCopy(distA);
      for (const names of [a.top, a.history]) {
        expect(names, JSON.stringify(names)).not.toContain(PLACEHOLDER.name);
        for (const name of PLACEHOLDER_NAMES) expect(names).not.toContain(name);
      }
      expect(a.page.errors.filter((e) => e.includes(PLACEHOLDER.id as string)), a.page.errors.join('\n')).toEqual([]);
      expect(exceptions(a.page), a.page.errors.join('\n')).toEqual([]);

      const b = await readCopy(distB);
      for (const names of [b.top, b.history]) expect(names, JSON.stringify(names)).toContain(PLACEHOLDER.name);
      expect(b.page.errors.filter((e) => e.includes(PLACEHOLDER.id as string)), b.page.errors.join('\n')).toEqual([]);
      // ほかの仮データの武器は出ないまま。
      for (const name of PLACEHOLDER_NAMES) expect(b.top).not.toContain(name);
      expect(exceptions(b.page), b.page.errors.join('\n')).toEqual([]);
    }, 90_000);

    it('WPN-22: measured が欠けた・真偽値でない武器は選択肢に出ず、ファイル名と measured の誤りがコンソールに出る', async () => {
      const { page, top, history } = await readCopy(distA);
      for (const [id, json] of Object.entries(BAD_MEASURED)) {
        for (const names of [top, history]) expect(names, id).not.toContain(json.name);
        const message = page.errors.find((e) => e.includes(`${id}.json`));
        expect(message, page.errors.join('\n')).toBeDefined();
        expect(message, id).toMatch(/measured/);
      }
      // ほかの武器は一覧に残る。
      for (const name of [...MEASURED_NAMES, NEW_WEAPON.name as string]) expect(top).toContain(name);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('MODE-1: 武器の一覧の武器それぞれで、3 つのモードを最後まで練習できる', () => {
    for (const weapon of ['L-STAR', 'C.A.R. SMG']) {
      it(`MODE-1: ${weapon} でパターン観察・反復練習・センター維持を撃ち切ると、それぞれリザルト画面が表示される`, async () => {
        serveDist(mainDist);
        const page = await openFresh();
        for (const mode of MODES) {
          const r = await practice(page, weapon, mode);
          expect(r.summary, `${weapon} / ${mode}`).toContain(weapon);
          expect(r.summary, `${weapon} / ${mode}`).toContain(mode);
        }
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 150_000);
    }
  });

  // -------------------------------------------------------------------------
  describe('自己ベストと履歴（例の武器が L-STAR）', () => {
    it('SCO-18: 自己ベストがない状態で、マウスで L-STAR とセンター維持を練習して終えると「自己ベスト更新」が表示され、apex-training:best:mouse:lstar:center にその平均ズレが保存される', async () => {
      serveDist(mainDist);
      const page = await openFresh();
      expect(await getItem(page, BEST_KEY)).toBeNull();
      const r = await practice(page, 'L-STAR', 'センター維持');
      expect(r.text).toContain(BEST_UPDATED);
      const raw = await getItem(page, BEST_KEY);
      expect(raw, `${BEST_KEY} がない: ${JSON.stringify(await keysWith(page, 'apex-training:best:'))}`).not.toBeNull();
      const best = JSON.parse(raw!) as { version: number; meanError: number };
      expect(best.version).toBe(1);
      expect(Math.abs(best.meanError - num(r.meanError)), `保存 ${best.meanError}、表示 ${r.meanError}`).toBeLessThanOrEqual(0.0051);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('SCO-20: L-STAR とセンター維持の自己ベストがある状態で、L-STAR と反復練習、C.A.R. SMG とセンター維持を初めて練習すると「自己ベスト更新」が表示され、L-STAR とセンター維持の自己ベストは変わらない', async () => {
      serveDist(mainDist);
      const seeded = JSON.stringify({ version: 1, meanError: 0.001, groupingRadius: 0.001, hitRate: 100, shots: 1, achievedAt: '2026-01-01T00:00:00.000Z' });
      const page = await openFresh({ [BEST_KEY]: seeded });
      const ghost = await practice(page, 'L-STAR', '反復練習');
      expect(ghost.text, 'L-STAR / 反復練習').toContain(BEST_UPDATED);
      expect(await getItem(page, BEST_KEY)).toBe(seeded);
      const car = await practice(page, 'C.A.R. SMG', 'センター維持');
      expect(car.text, 'C.A.R. SMG / センター維持').toContain(BEST_UPDATED);
      expect(await getItem(page, BEST_KEY)).toBe(seeded);
      // それぞれ別のキーに保存されている（L-STAR とセンター維持のほかに 2 つ）。
      const keys = await keysWith(page, 'apex-training:best:mouse:');
      expect(keys.filter((k) => k !== BEST_KEY), JSON.stringify(keys)).toHaveLength(2);
      expect(keys.some((k) => k.startsWith('apex-training:best:mouse:lstar:') && k !== BEST_KEY), JSON.stringify(keys)).toBe(true);
      expect(keys).toContain(`apex-training:best:mouse:${CAR_ID}:center`);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 90_000);

    /** SCO-23 で 3 回練習したページとリザルトの平均ズレ（UI-24 で続けて使う）。 */
    let threeRuns: { page: Page; shown: number[] } | undefined;

    it('SCO-23: 履歴がない状態で、マウスで L-STAR とセンター維持を 3 回練習すると、apex-training:history:mouse:lstar:center に 3 件が古い順に保存され、各件にその練習の値が入る', async () => {
      serveDist(mainDist);
      const page = await openFresh();
      expect(await getItem(page, HISTORY_KEY)).toBeNull();
      const shown: number[] = [];
      // 回ごとに補正の量を変え、平均ズレが回で違うようにする。
      for (const pull of [0, 6, 2]) shown.push(num((await practice(page, 'L-STAR', 'センター維持', pull)).meanError));
      const raw = await getItem(page, HISTORY_KEY);
      expect(raw, `${HISTORY_KEY} がない: ${JSON.stringify(await keysWith(page, 'apex-training:history:'))}`).not.toBeNull();
      const stored = JSON.parse(raw!) as { version: number; entries: { at: string; meanError: number; hitRate: number; groupingRadius: number; shots: number }[] };
      expect(stored.version).toBe(1);
      expect(stored.entries).toHaveLength(3);
      const times = stored.entries.map((e) => Date.parse(e.at));
      for (const t of times) expect(Number.isFinite(t)).toBe(true);
      expect(times.slice().sort((a, b) => a - b)).toEqual(times);
      stored.entries.forEach((e, i) => {
        expect(Math.abs(e.meanError - shown[i]!), `${i + 1} 件目: 保存 ${e.meanError}、表示 ${shown[i]}`).toBeLessThanOrEqual(0.0051);
        for (const k of ['hitRate', 'groupingRadius', 'shots'] as const) expect(Number.isFinite(e[k]), k).toBe(true);
        expect(e.shots).toBeGreaterThan(0);
      });
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      threeRuns = { page, shown };
    }, 120_000);

    it('UI-24: マウスで L-STAR とセンター維持を 3 回練習したあと、履歴の画面で L-STAR・センター維持・マウスを選ぶと、グラフに 3 点が回の順に、一覧に 3 回分の平均ズレがリザルトと同じ順で表示される', async () => {
      expect(threeRuns, 'SCO-23 の 3 回の練習が終わっていない').toBeDefined();
      const { page, shown } = threeRuns!;
      await openHistory(page);
      await chooseHistory(page, '武器', 'L-STAR');
      await chooseHistory(page, 'モード', 'センター維持');
      await chooseHistory(page, '入力方式', 'マウス');
      const view = await page.evaluate<{ points: { x: number; y: number }[]; headers: string[]; rows: string[][] }>(`(() => {
        const screen = document.querySelector('[data-screen="history"]');
        const svg = [...screen.querySelectorAll('svg')].find((s) => window.__vis(s));
        const points = svg ? [...svg.querySelectorAll('circle')].map((c) => { const p = new DOMPoint(c.cx.baseVal.value, c.cy.baseVal.value).matrixTransform(c.getScreenCTM()); return { x: p.x, y: p.y }; }) : [];
        const table = [...screen.querySelectorAll('table')].find((t) => window.__vis(t));
        return { points,
          headers: table ? [...table.querySelectorAll('thead th')].map((c) => c.textContent.trim()) : [],
          rows: table ? [...table.querySelectorAll('tbody tr')].filter((tr) => window.__vis(tr)).map((tr) => [...tr.cells].map((c) => c.textContent.trim())) : [] }; })()`);
      expect(view.points).toHaveLength(3);
      // 回の順に左から右へ並ぶ。
      const xs = view.points.map((p) => p.x);
      expect(xs.slice().sort((a, b) => a - b)).toEqual(xs);
      expect(new Set(xs.map((x) => Math.round(x))).size).toBe(3);
      const col = view.headers.findIndex((h) => h.includes('平均ズレ'));
      expect(col, JSON.stringify(view.headers)).toBeGreaterThanOrEqual(0);
      const listed = view.rows.map((r) => num(r[col]!));
      expect(listed).toHaveLength(3);
      // 一覧が古い順でも新しい順でも、回の順に読み直すとリザルトの値と同じ順になる。
      const roundCol = view.headers.findIndex((h) => h === '回' || h.includes('回'));
      const ordered = roundCol >= 0 && roundCol !== col
        ? view.rows.map((r, i) => ({ n: num(r[roundCol]!), v: listed[i]! })).sort((a, b) => a.n - b.n).map((x) => x.v)
        : listed;
      ordered.forEach((v, i) => expect(Math.abs(v - shown[i]!), `${i + 1} 回目: 一覧 ${v}、リザルト ${shown[i]}`).toBeLessThanOrEqual(0.0051));
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('SCO-26: L-STAR とセンター維持の履歴がある状態で、L-STAR と反復練習を練習して終えると、L-STAR とセンター維持のマウスの履歴は変わらない', async () => {
      serveDist(mainDist);
      const seeded = JSON.stringify({ version: 1, entries: [{ at: '2026-01-01T00:00:00.000Z', meanError: 1.23, hitRate: 50, groupingRadius: 1, shots: 10 }] });
      const page = await openFresh({ [HISTORY_KEY]: seeded });
      await practice(page, 'L-STAR', '反復練習');
      expect(await getItem(page, HISTORY_KEY)).toBe(seeded);
      // 反復練習の練習は別のキーの履歴に入る。
      const keys = await keysWith(page, 'apex-training:history:mouse:lstar:');
      expect(keys.filter((k) => k !== HISTORY_KEY), JSON.stringify(keys)).toHaveLength(1);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('MODE-23: 自己ベストがない状態で、マウスで L-STAR とセンター維持の回数 5 のセットを最後まで練習すると、5 回のうち平均ズレが最も小さい回の平均ズレが apex-training:best:mouse:lstar:center に保存される', async () => {
      serveDist(mainDist);
      const page = await openFresh();
      expect(await getItem(page, BEST_KEY)).toBeNull();
      await start(page, 'L-STAR', 'センター維持', 5);
      const pulls = [0, 8, 3, 5, 1];
      for (let n = 1; n <= 5; n += 1) {
        await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]') && !window.__interlude() && window.__ammo() > 0 && window.__round().includes('${n} / 5')`, 10_000);
        await lock(page);
        await fireAll(page, pulls[n - 1]!);
        if (n < 5) {
          await page.waitFor('window.__interlude()', 5_000);
          await page.frames(2);
          // 「次へ」（Space）で次の回を始める。
          await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: ' ' });
          await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
        }
      }
      await page.waitFor(`location.hash === '#/set-result' && window.__vis('[data-screen="set-result"]')`, 10_000);
      await page.frames(2);
      const rounds = await page.evaluate<string[]>(`[...document.querySelectorAll('#set-rounds li')].filter((li) => window.__vis(li)).map((li) => li.innerText.trim())`);
      expect(rounds, JSON.stringify(rounds)).toHaveLength(5);
      const values = rounds.map((r) => {
        const d = r.match(/\d+\.\d{2}/g);
        if (!d) throw new Error(`平均ズレがない: ${r}`);
        return Number(d.at(-1));
      });
      const raw = await getItem(page, BEST_KEY);
      expect(raw, `${BEST_KEY} がない: ${JSON.stringify(await keysWith(page, 'apex-training:best:'))}`).not.toBeNull();
      const best = JSON.parse(raw!) as { meanError: number };
      expect(Math.abs(best.meanError - Math.min(...values)), `保存 ${best.meanError}、一覧 ${values.join(', ')}`).toBeLessThanOrEqual(0.0051);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 180_000);
  });
});
