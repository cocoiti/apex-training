// docs/spec/screens.md「データの読み込み」（UI-103-1・UI-103-2）と、docs/spec/architecture.md「テストのための読み込みの完了の印」
// （ARC-103-1〜ARC-103-3）の受け入れテスト。QA が SPEC だけから書いたもの。
// 公開された入口（ビルドの結果を /apex-training/ で配信した画面、<html> の data-app-state、武器の JSON、
// SPEC に書かれた localStorage のキーと値の形、ブラウザを使うテストの道具 tests/helpers/browser.ts の goto・reload）だけを使う。
//
// マップと武器の JSON の応答を遅らせるため、ビルドの結果をこのファイルのサーバーで配信する。サーバーは .json の要求に、
// 要求を受けてから DELAY_MS たってから応答する（ページの側の時計ではなく、配信の遅さの再現）。テストは実時間で待たず、
// 条件で待つ。「応答が届く前」は、サーバーがまだ JSON を 1 つも返していないこと（返した数を数える）で確かめる。
// マップの JSON は配布物の assets/range-*.json（src/data/maps/range.json）。
// カードは画面で観察できる形（role="radiogroup" の aria-label「武器」「モード」の中の role="radio"）で、
// 履歴の画面の選択肢は label の文字が「武器」「モード」「入力方式」で始まる select で読む。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, extname, join, normalize, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, listenOnFreePort, originOf, waitUntil, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
/** ページを開く練習の乱数の種（docs/spec/architecture.md「テストのための乱数の種の固定」）。テストが失敗したときのメッセージにも出る。 */
const SEED = 10301;
/** マップと武器の JSON の応答の遅れ（SPEC の 3 秒）。 */
const DELAY_MS = 3_000;
const STATE = 'data-app-state';
const chromium = findChromium();

/** SPEC の値（実装の定数には依存しない）。 */
const MODE_NAMES = ['反復練習', '追いエイム', '追いエイム＋リコイル', 'フリック'];
const REPS_ID = 'ghost';
const historyKey = (input: string, weapon: string, mode: string) => `apex-training:history:${input}:${weapon}:${mode}`;
const entry = (meanError: number, at: string) => ({ at, meanError, hitRate: 50, groupingRadius: 1, shots: 28 });

interface WeaponJson {
  id: string;
  name: string;
  magSize: number;
  measured: boolean;
}
/** 武器の一覧（計測した武器データ）。 */
const MEASURED: WeaponJson[] = readdirSync(join(ROOT, 'src/data/weapons'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(ROOT, 'src/data/weapons', f), 'utf8')) as WeaponJson)
  .filter((w) => w.measured === true);
const byName = (name: string) => {
  const w = MEASURED.find((x) => x.name === name);
  if (!w) throw new Error(`武器の一覧にない: ${name}`);
  return w;
};

// ---------------------------------------------------------------------------
// JSON の応答を遅らせる配信
// ---------------------------------------------------------------------------

interface SlowServer {
  server: Server;
  /** .json の応答を返すまでの遅れ（ms）。 */
  delay: number;
  /** true ならマップの JSON に 404 を返す。 */
  mapNotFound: boolean;
  /** 受けた .json の要求の数。 */
  jsonRequested: number;
  /** 返した .json の応答の数（404 を含む）。 */
  jsonAnswered: number;
}

async function serveSlow(dir: string, base: string): Promise<SlowServer> {
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
  };
  const state = { delay: DELAY_MS, mapNotFound: false, jsonRequested: 0, jsonAnswered: 0 } as SlowServer;
  const answer = (res: ServerResponse, status: number, file?: string) => {
    if (res.destroyed) return;
    if (file === undefined) return void res.writeHead(status, { 'cache-control': 'no-store' }).end();
    res.writeHead(status, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(readFileSync(file));
  };
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (!path.startsWith(base)) return void answer(res, 404);
    let file = normalize(join(dir, path.slice(base.length)));
    if (!file.startsWith(dir)) return void answer(res, 404);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (extname(file) !== '.json') return void answer(res, existsSync(file) ? 200 : 404, existsSync(file) ? file : undefined);
    state.jsonRequested += 1;
    const isMap = basename(file).startsWith('range-');
    const respond = (target: string) => {
      state.jsonAnswered += 1;
      if (state.mapNotFound && isMap) return answer(res, 404);
      answer(res, existsSync(target) ? 200 : 404, existsSync(target) ? target : undefined);
    };
    // 配信の遅さの再現（テストの側の待ちではない）。要求ごとに、受けてから delay ms たってから応答する。
    setTimeout(() => respond(file), state.delay);
  };
  state.server = await listenOnFreePort(createServer(handle));
  return state;
}

// ---------------------------------------------------------------------------
// ページに入れるスクリプト
// ---------------------------------------------------------------------------

const PAGE_INIT = `
  window.__vis = (el) => { el = typeof el === 'string' ? document.querySelector(el) : el;
    return !!el && !el.closest('[hidden]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0; };
  window.__state = () => document.documentElement.getAttribute(${JSON.stringify(STATE)});
  window.__top = () => document.querySelector('[data-screen="top"]');
  window.__cards = (label) => { const t = window.__top(); const g = t && t.querySelector('[role="radiogroup"][aria-label="' + label + '"]');
    return g ? [...g.querySelectorAll('[role="radio"]')] : []; };
  window.__historySelect = (caption) => { const s = document.querySelector('[data-screen="history"]');
    return s ? [...s.querySelectorAll('select')].find((x) => (x.closest('label')?.textContent ?? x.getAttribute('aria-label') ?? '').trim().startsWith(caption)) ?? null : null; };
  window.__options = (caption) => { const s = window.__historySelect(caption); return s ? [...s.options].map((o) => o.textContent.trim()) : []; };
  window.__selected = (caption) => { const s = window.__historySelect(caption); return s ? (s.selectedOptions[0]?.textContent.trim() ?? '') : ''; };
  window.__ammo = () => { const m = (document.querySelector('[data-hud="ammo"]')?.textContent ?? '').match(/\\d+/); return m ? Number(m[0]) : NaN; };
  window.__snapshot = () => ({
    weaponCards: window.__cards('武器').map((c) => c.textContent.replace(/\\s+/g, ' ').trim()),
    modeCards: window.__cards('モード').length,
    historyWeapons: window.__options('武器'),
    historyModes: window.__options('モード'),
  });
  // 初めのスクリプトの時点ではまだ <html> がないので、document の下の属性の変化を見る。
  // data-app-state の移り変わりを、変わったときの画面の様子と一緒に記録する。setAttribute なら変わったその場で、
  // それ以外（dataset など）の変え方なら MutationObserver の知らせで記録する。
  window.__transitions = [];
  const record = (value, via) => window.__transitions.push({ value, via, at: window.__snapshot() });
  const original = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    const result = original.call(this, name, value);
    if (this === document.documentElement && name === ${JSON.stringify(STATE)}) record(String(value), 'setAttribute');
    return result;
  };
  let last = null;
  new MutationObserver(() => {
    const value = window.__state();
    if (value !== last) {
      const prev = window.__transitions[window.__transitions.length - 1];
      if (!prev || prev.value !== value) record(value, 'observer');
      last = value;
    }
  }).observe(document, { attributes: true, subtree: true, attributeFilter: [${JSON.stringify(STATE)}] });
`;

interface Snapshot {
  weaponCards: string[];
  modeCards: number;
  historyWeapons: string[];
  historyModes: string[];
}
interface Transition {
  value: string;
  via: string;
  at: Snapshot;
}

const TOP_SHOWN = `window.__vis(window.__top())`;
const START = '[data-screen="top"] a[href="#/play"]';

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('QA: マップと武器の JSON の読み込みが遅いとき（#103）', () => {
  const temps: string[] = [];
  let slow: SlowServer | undefined;
  let browser: Browser | undefined;
  let origin = '';
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));

  beforeAll(async () => {
    const dist = mkdtempSync(join(tmpdir(), 'slow-data-load-qa-'));
    temps.push(dist);
    const build = spawnSync(`npm run build -- --outDir "${dist}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`ビルドが失敗した:\n${build.stdout}${build.stderr}`);
    const assets = readdirSync(join(dist, 'assets'));
    if (!assets.some((f) => f.startsWith('range-') && f.endsWith('.json'))) throw new Error(`配布物にマップの JSON がない: ${assets.join(', ')}`);
    slow = await serveSlow(dist, BASE);
    origin = originOf(slow.server);
    browser = await launchBrowser(chromium!);
  }, 300_000);

  afterEach(async () => {
    await browser?.closePages();
    // 遅れた応答が残っていても次のテストの数に混ざらないよう、数え直す前に、受けた要求がすべて返るまで待つ。
    if (slow) await waitUntil(() => slow!.jsonAnswered >= slow!.jsonRequested, '遅らせた JSON の応答がすべて返る');
    if (slow) Object.assign(slow, { delay: DELAY_MS, mapNotFound: false, jsonRequested: 0, jsonAnswered: 0 });
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((ok) => (slow ? slow.server.close(ok) : ok(undefined)));
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  /** 新しいタブを開き、PAGE_INIT を入れる。 */
  async function fresh(): Promise<Page> {
    const page = await browser!.newPage();
    await page.addInitScript(PAGE_INIT);
    return page;
  }

  /** まだ JSON の応答を 1 つも返していないことを確かめる（「応答が届く前」の前提）。 */
  const beforeAnyResponse = (what: string) => {
    expect(slow!.jsonAnswered, `${what}: JSON の応答がまだ返っていない（前提）`).toBe(0);
  };

  // -------------------------------------------------------------------------
  describe('ARC-103-1: 応答が届くまで data-app-state が loading で、カードと履歴の選択肢ができたあとに ready、マップが 404 なら error', () => {
    it('3 秒遅らせて開くと、応答が届くまで loading のままで、ready になった時点でトップのカードと履歴の画面の選択肢ができている', async () => {
      const page = await fresh();
      await page.goto(appUrl(origin, BASE, '#/', { render: false, seed: SEED }), { waitForApp: false });
      // ページのスクリプトが動き出し（印が付き）、JSON の要求が出るまで待つ。
      await page.waitFor(`window.__state() !== null`);
      await waitUntil(() => slow!.jsonRequested > 0, 'JSON の要求が出る');
      // 応答が届くまで、読むたびに loading であることを確かめる（読んだあとにまだ応答が返っていなかった読みだけを数える）。
      const samples: string[] = [];
      await waitUntil(
        async () => {
          const value = await page.evaluate<string | null>('window.__state()');
          if (slow!.jsonAnswered > 0) return true;
          samples.push(String(value));
          return false;
        },
        'JSON の応答が返る',
      );
      expect(samples.length).toBeGreaterThan(0);
      expect(new Set(samples), `応答が届く前の data-app-state: ${samples.join(', ')}`).toEqual(new Set(['loading']));
      // 応答が届いたあとに ready になる。
      await page.waitFor(`window.__state() === 'ready'`);
      const transitions = await page.evaluate<Transition[]>('window.__transitions');
      const values = transitions.map((t) => t.value);
      expect(values.filter((v) => v !== 'loading'), JSON.stringify(values)).toEqual(['ready']);
      const ready = transitions.find((t) => t.value === 'ready')!;
      // ready になった時点で、トップ画面の武器・モードのカードと、履歴の画面の武器・モードの選択肢ができている。
      expect(ready.at.weaponCards.length, JSON.stringify(ready)).toBe(MEASURED.length);
      expect(ready.at.modeCards, JSON.stringify(ready)).toBe(MODE_NAMES.length);
      expect([...ready.at.historyWeapons].sort(), JSON.stringify(ready)).toEqual(MEASURED.map((w) => w.name).sort());
      expect(ready.at.historyModes, JSON.stringify(ready)).toEqual(MODE_NAMES);
      expect(exceptions(page)).toEqual([]);
    }, 60_000);

    it('マップの JSON が 404 になるときは error になる', async () => {
      slow!.mapNotFound = true;
      const page = await fresh();
      await page.goto(appUrl(origin, BASE, '#/', { render: false, seed: SEED }), { waitForApp: false });
      await page.waitFor(`window.__state() === 'error' || window.__state() === 'ready'`);
      expect(await page.evaluate<string | null>('window.__state()')).toBe('error');
      const values = (await page.evaluate<Transition[]>('window.__transitions')).map((t) => t.value);
      expect(values).not.toContain('ready');
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('ARC-103-2: テストの道具でページを開くと、戻った時点で ready でカードと選択肢が埋まっている。待たない形は応答の前に戻る', () => {
    it('既定の goto は、3 秒遅れの応答が届いて ready になってから戻り、トップの武器のカードと履歴の画面の武器の選択肢が埋まっている', async () => {
      const page = await fresh();
      await page.goto(appUrl(origin, BASE, '#/', { render: false, seed: SEED }));
      const state = await page.evaluate<string | null>('window.__state()');
      const snap = await page.evaluate<Snapshot>('window.__snapshot()');
      expect(slow!.jsonAnswered, '戻った時点で JSON の応答が返っている').toBeGreaterThan(0);
      expect(state).toBe('ready');
      expect(snap.weaponCards.length, JSON.stringify(snap)).toBe(MEASURED.length);
      expect([...snap.historyWeapons].sort(), JSON.stringify(snap)).toEqual(MEASURED.map((w) => w.name).sort());
    }, 60_000);

    it('既定の reload も、ready になってから戻る', async () => {
      const page = await fresh();
      await page.goto(appUrl(origin, BASE, '#/', { render: false, seed: SEED }));
      const answered = slow!.jsonAnswered;
      await page.reload();
      expect(slow!.jsonAnswered, '読み込み直しの JSON の応答も返っている').toBeGreaterThan(answered);
      expect(await page.evaluate<string | null>('window.__state()')).toBe('ready');
      const snap = await page.evaluate<Snapshot>('window.__snapshot()');
      expect(snap.weaponCards.length, JSON.stringify(snap)).toBe(MEASURED.length);
      expect([...snap.historyWeapons].sort(), JSON.stringify(snap)).toEqual(MEASURED.map((w) => w.name).sort());
    }, 60_000);

    it('待たない形（waitForApp: false）で開くと、応答が届く前に戻る', async () => {
      const page = await fresh();
      await page.goto(appUrl(origin, BASE, '#/', { render: false, seed: SEED }), { waitForApp: false });
      beforeAnyResponse('goto（待たない形）が戻った時点');
      const state = await page.evaluate<string | null>('window.__state()');
      beforeAnyResponse('data-app-state を読んだ時点');
      expect(state).not.toBe('ready');
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('UI-103-1: 応答が届く前に「開始」を押すと、届いたあとに一覧の最初の武器・反復練習の練習が始まり、残弾が出る', () => {
    it('3 秒遅らせたトップ画面で、応答の前に「開始」を押すと、待ちの上限（10 秒）の中でプレイ画面に残弾が出る', async () => {
      const page = await fresh();
      await page.goto(appUrl(origin, BASE, '#/', { render: false, manualClock: true, seed: SEED }), { waitForApp: false });
      await page.waitFor(`${TOP_SHOWN} && !!document.querySelector(${JSON.stringify(START)})`);
      beforeAnyResponse('「開始」を押す前');
      await page.clickSelector(START);
      beforeAnyResponse('「開始」を押した時点');
      // 待ちの上限は既定の 10 秒のまま。
      await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]') && window.__ammo() > 0`);
      expect(await page.evaluate<string | null>('window.__state()')).toBe('ready');
      const hud = await page.evaluate<{ weapon: string; ammo: number }>(
        `({ weapon: (document.querySelector('[data-hud="weapon"]')?.textContent ?? '').trim(), ammo: window.__ammo() })`,
      );
      // 一覧の最初の武器（トップ画面の武器のカードの最初）と、モードの並び順の最初（反復練習）が選ばれたままで始まっている。
      const chosen = await page.evaluate<{ firstWeapon: string; checkedWeapon: string; firstMode: string; checkedMode: string }>(`(() => {
        const name = (c) => c ? c.textContent.replace(/\\s+/g, ' ').trim() : '';
        const w = window.__cards('武器'); const m = window.__cards('モード');
        return { firstWeapon: name(w[0]), checkedWeapon: name(w.find((c) => c.getAttribute('aria-checked') === 'true')),
          firstMode: name(m[0]), checkedMode: name(m.find((c) => c.getAttribute('aria-checked') === 'true')) }; })()`);
      expect(chosen.checkedWeapon).toBe(chosen.firstWeapon);
      expect(chosen.firstMode).toContain(MODE_NAMES[0]);
      expect(chosen.checkedMode).toBe(chosen.firstMode);
      const first = MEASURED.find((w) => chosen.firstWeapon.includes(w.name));
      expect(first, `最初の武器のカード: ${chosen.firstWeapon}`).toBeDefined();
      expect(hud.weapon).toContain(first!.name);
      // 反復練習の始めの残弾は装弾数。
      expect(hud.ammo).toBe(first!.magSize);
      expect(exceptions(page)).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('UI-103-2: 応答が届く前に #/history を開くと、届いたあとに武器・モードの選択肢が並び、最初の武器・反復練習・マウスの履歴が出る', () => {
    it('3 秒遅らせて #/history を開くと、L-STAR を含むすべての武器と登録されたモードが並び、選ばれた組の履歴が表示される', async () => {
      const page = await fresh();
      await page.goto(appUrl(origin, BASE, '#/', { render: false, seed: SEED }));
      // 武器ごとに件数の違う履歴を入れておき、どの組の履歴が表示されたかを件数で見分ける。
      const seed: Record<string, string> = {};
      const counts = new Map<string, number>();
      MEASURED.forEach((w, i) => {
        const n = i + 2;
        counts.set(w.name, n);
        const entries = Array.from({ length: n }, (_, k) => entry(1 + k / 10, `2026-01-0${k + 1}T00:00:00.000Z`));
        seed[historyKey('mouse', w.id, REPS_ID)] = JSON.stringify({ version: 1, entries });
      });
      await page.evaluate(`(() => { localStorage.clear(); const seed = ${JSON.stringify(seed)}; for (const k in seed) localStorage.setItem(k, seed[k]); location.hash = '#/history'; })()`);
      await waitUntil(() => slow!.jsonAnswered >= slow!.jsonRequested, '最初に開いたときの JSON の応答がすべて返る');
      Object.assign(slow!, { jsonRequested: 0, jsonAnswered: 0 });
      await page.reload({ waitForApp: false });
      await page.waitFor(`location.hash === '#/history' && window.__vis('[data-screen="history"]')`);
      beforeAnyResponse('履歴の画面が出た時点');
      // 応答が届いたあとに選択肢ができる（待ちの上限は既定の 10 秒）。
      await page.waitFor(`window.__options('武器').length >= ${MEASURED.length} && window.__options('モード').length >= ${MODE_NAMES.length}`);
      expect(slow!.jsonAnswered).toBeGreaterThan(0);
      const weapons = await page.evaluate<string[]>(`window.__options('武器')`);
      expect([...weapons].sort()).toEqual(MEASURED.map((w) => w.name).sort());
      expect(weapons).toContain('L-STAR');
      expect(await page.evaluate<string[]>(`window.__options('モード')`)).toEqual(MODE_NAMES);
      // 開いたときに選ばれる組: 一覧の最初の武器・反復練習・マウス。
      const firstCard = await page.evaluate<string>(`(window.__cards('武器')[0]?.textContent ?? '').replace(/\\s+/g, ' ').trim()`);
      const first = MEASURED.find((w) => firstCard.includes(w.name));
      expect(first, `トップ画面の最初の武器のカード: ${firstCard}`).toBeDefined();
      expect(await page.evaluate<string>(`window.__selected('武器')`)).toBe(first!.name);
      expect(weapons[0]).toBe(first!.name);
      expect(await page.evaluate<string>(`window.__selected('モード')`)).toBe(MODE_NAMES[0]);
      expect(await page.evaluate<string>(`window.__selected('入力方式')`)).toBe('マウス');
      // その組の履歴（入れた件数の一覧の行）が表示される。
      const expected = counts.get(first!.name)!;
      await page.waitFor(`(() => { const t = [...document.querySelectorAll('[data-screen="history"] table')].find((x) => window.__vis(x));
        return !!t && [...t.querySelectorAll('tbody tr')].filter((r) => window.__vis(r)).length === ${expected}; })()`);
      const text = await page.evaluate<string>(`document.querySelector('[data-screen="history"]').innerText`);
      expect(text).not.toContain('まだ履歴がありません');
      expect(exceptions(page)).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('ARC-103-3: 3 秒遅らせても、既存のテストと同じ手順が待ちの上限（10 秒）を伸ばさずに通る', () => {
    it('ポインターロックの失敗の表示・一時停止中のマウスの入力・クロスヘア・弾痕のテストと同じ手順で練習を始め、プレイ画面に残弾が出る', async () => {
      // tests/acceptance/mouse-qa.acceptance.test.ts の openPlay と同じ手順（既定の goto → トップの表示 → 「開始」→ プレイ画面と残弾 → 描画 5 回）。
      const page = await fresh();
      await page.goto(appUrl(origin, BASE, '', { seed: SEED }));
      await page.waitFor(`document.querySelector('[data-screen="top"]') && !document.querySelector('[data-screen="top"]').hidden`);
      await page.clickSelector('[data-screen="top"] a[href="#/play"]');
      await page.waitFor(`!document.querySelector('[data-screen="play"]').hidden && window.__ammo() > 0`);
      await page.frames(5);
      expect(slow!.jsonAnswered).toBeGreaterThan(0);
      expect(await page.evaluate<boolean>(`window.__vis('[data-screen="play"]')`)).toBe(true);
      expect(await page.evaluate<number>('window.__ammo()')).toBeGreaterThan(0);
    }, 60_000);

    it('苦手な区間・履歴を消すテストと同じ手順で履歴の画面を開き、武器の選択肢に L-STAR がある', async () => {
      // tests/acceptance/weak-sections-qa・history-qa の openFresh と openHistory と同じ手順
      // （既定の goto → localStorage を空に → 既定の reload → トップの表示 → ハッシュで #/history → 選択肢があるまで待つ）。待ちはすべて既定の 10 秒。
      const page = await fresh();
      await page.goto(appUrl(origin, BASE, '#/', { render: false, manualClock: true, seed: SEED }));
      await page.evaluate(`(() => { localStorage.clear(); window.__beforeReload = true; })()`);
      await page.reload({ ignoreCache: false });
      await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && window.__vis('[data-screen="top"]')`);
      await page.evaluate(`location.hash = '#/history'`);
      await page.waitFor(`window.__vis('[data-screen="history"]') && document.querySelectorAll('[data-screen="history"] select option').length > 0`);
      await page.frames(2);
      expect(slow!.jsonAnswered).toBeGreaterThan(0);
      const weapons = await page.evaluate<string[]>(`window.__options('武器')`);
      expect(weapons).toContain('L-STAR');
      expect([...weapons].sort()).toEqual(MEASURED.map((w) => w.name).sort());
      expect(byName('L-STAR').id).toBe('lstar');
    }, 60_000);
  });
});
