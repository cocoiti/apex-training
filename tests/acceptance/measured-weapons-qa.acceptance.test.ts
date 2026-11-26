// Issue #50（計測した値の武器だけを武器の一覧と選択肢に出す）の受け入れテスト。
// docs/spec/weapons.md の WPN-21・WPN-22・WPN-23、modes.md の MODE-1 を、公開された入口だけで確かめる。
// WPN-1・WPN-3 は modes.acceptance、SCO-18・SCO-20 は result-qa、SCO-23・SCO-26・UI-24 は history-qa、MODE-23 は retry-sets-qa が
// 確かめる（tests/acceptance/README.md）。
// 入口は、ビルドの結果を /apex-training/ で配信した画面（ヘッドレスの Chromium、tests/helpers/browser.ts）、
// ブラウザのコンソール、SPEC に書かれた localStorage のキーと値の形、src/data/weapons/ と docs/measurements/ の JSON。
// WPN-21・WPN-22 はリポジトリの写しに武器の JSON を足してビルドし、その画面で確かめる。
// 画面は render=off・clock=manual で開き、撃つのはパッドの R2（Gamepad API の形で与える）。時計はテストから進める。
// Chromium がなければ画面の確認を飛ばす。入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, waitUntil, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const WEAPONS_DIR = join(ROOT, 'src/data/weapons');
const MEASUREMENTS_DIR = join(ROOT, 'docs/measurements');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const chromium = findChromium();
/** 3D を描画せず、ページの時計をテストから進める（docs/spec/architecture.md「テストのための描画の省略と時計の差し替え」）。 */
const APP = { render: false, manualClock: true };

/** SPEC の名前と値（実装の定数には依存しない）。 */
const MEASURED_NAMES = ['C.A.R. SMG', 'L-STAR'];
const PLACEHOLDER_NAMES = ['R-301', 'R-99', 'フラットライン', 'ボルト', 'スピットファイア'];
const MODES = ['反復練習'];

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

/** 標準配置のパッド 1 台（R2 はボタン 7）。 */
const FAKE_PAD = `
  window.__pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) };
  navigator.getGamepads = () => [{ id: 'acceptance pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard',
    timestamp: 0, axes: window.__pad.axes.slice(), buttons: window.__pad.buttons.map((b) => ({ ...b })), vibrationActuator: null }];
  window.__btn = (i, on) => { window.__pad.buttons[i] = { value: on ? 1 : 0, pressed: on, touched: on }; };
`;

const PAGE_INIT = `
  window.__num = (sel) => { const m = (document.querySelector(sel)?.textContent ?? '').match(/-?\\d+(?:\\.\\d+)?/); return m ? Number(m[0]) : NaN; };
  window.__ammo = () => window.__num('[data-hud="ammo"]');
  window.__vis = (sel) => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    return !!el && !el.closest('[hidden]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0; };
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

/** トップ画面で武器とモードを選んで「開始」を押し、プレイ画面で撃てるようになるまで待つ。 */
async function start(page: Page, weapon: string, mode: string) {
  await openTop(page);
  await choose(page, '#weapon', weapon);
  await choose(page, '#mode', mode);
  await page.clickSelector('[data-screen="top"] a[href="#/play"]');
  await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]') && window.__ammo() > 0`);
  await page.frames(2);
}

/**
 * 1 回の練習（武器とモードを選び、パッドの R2 を押し続けて撃ち切り、リザルト画面が表示されるまで）。
 * ページの時計（clock=manual）を進めて撃つので、実時間では待たない。
 */
async function practice(page: Page, weapon: string, mode: string): Promise<string> {
  await start(page, weapon, mode);
  await page.evaluate('window.__btn(7, true)');
  await page.frames(2);
  await waitUntil(async () => {
    await page.advanceClock(0.5);
    return page.evaluate<boolean>(`location.hash === '#/result'`);
  }, '撃ち切ってリザルト画面に移る');
  await page.evaluate('window.__btn(7, false)');
  await page.waitFor(`window.__vis('[data-screen="result"]')`);
  return page.evaluate<string>(`document.querySelector('#result-summary')?.textContent ?? document.querySelector('[data-screen="result"]').innerText`);
}

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

  /**
   * 新しいタブで localStorage を空にし、読み込み直したトップ画面を開く。3D は描画せず（render=off）、
   * ページの時計はテストから進める（clock=manual）。標準配置のパッドをつなぐ。
   */
  async function openFresh(): Promise<Page> {
    const page = await browser!.newPage();
    await page.goto(appUrl(origin, BASE, '#/', APP));
    await page.evaluate('localStorage.clear()');
    await page.addInitScript(PAGE_INIT);
    await page.addInitScript(FAKE_PAD);
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

  afterEach(async () => {
    await browser?.closePages();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((ok) => (server ? server.close(ok) : ok(undefined)));
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  describe('WPN-21 / WPN-22: 写しに武器の JSON を足してビルドする', () => {
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
  describe('MODE-1: 武器の一覧の武器それぞれで、反復練習を最後まで練習できる', () => {
    for (const weapon of ['L-STAR', 'C.A.R. SMG']) {
      it(`MODE-1: ${weapon} で反復練習を撃ち切ると、リザルト画面が表示される`, async () => {
        serveDist(mainDist);
        const page = await openFresh();
        for (const mode of MODES) {
          const summary = await practice(page, weapon, mode);
          expect(summary, `${weapon} / ${mode}`).toContain(weapon);
          expect(summary, `${weapon} / ${mode}`).toContain(mode);
          // 採点する（リザルトに採点結果の指標が出る）。
          expect(await page.evaluate<boolean>(`window.__vis('#result-metrics')`), `${weapon} / ${mode}: リザルトに指標が出る`).toBe(true);
          expect(await page.evaluate<string>(`document.querySelector('#result-metrics').innerText`)).toMatch(/\d/);
        }
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 150_000);
    }
  });
});
