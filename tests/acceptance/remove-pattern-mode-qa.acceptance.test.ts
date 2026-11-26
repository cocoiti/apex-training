// Issue #51「パターン観察モードをなくし、すべてのモードを採点する」と Issue #64「センター維持モードをなくし、反復練習だけにする」の
// QA の受け入れテスト。
// 対象: MODE-2・MODE-26・SCO-17・SCO-25・MODE-4・UI-58・UI-61（欠番）・MODE-27・MODE-28（変更）・MODE-29・UI-75（追加）。
// MODE-1 は measured-weapons-qa、UI-26 は history-qa、PAD-18・PAD-19 は pad-guide-browser-qa が確かめる（tests/acceptance/README.md）。
// 公開された入口（docs/spec/、ビルドの結果を /apex-training/ で配信した画面、index.html の要素、武器の JSON、
// localStorage の自己ベスト・履歴のキー）だけを使い、実装の内部には依存しない。
// 画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、パッドは Gamepad API（navigator.getGamepads）の形で与える。
// 画面は render=off・clock=manual で開き、練習の時間（撃ち切る・撃たない 2 秒）はページの時計を進めて決める。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const chromium = findChromium();
/** 3D は描画せず（render=off）、ページの時計はテストから進める（clock=manual）。 */
const APP = { render: false, manualClock: true };
/** ページの時計（clock=manual）を 60Hz の描画 frames 回分進める。実時間では待たない。 */
const settle = (page: Page, frames: number) => page.advanceClock(frames / 60);

/** SPEC の文言と値（実装の定数には依存しない）。 */
const GHOST = '反復練習';
const CENTER = 'センター維持';
const PATTERN = 'パターン観察';
const OLD_GHOST = 'ゴースト追従';
/** セットを最後まで練習して確かめるモード（反復練習）。 */
const MODES = [GHOST];
/** 登録されたモード（docs/spec/modes.md「モードの登録」）。 */
const ALL_MODES = [GHOST, '追いエイム', '追いエイム＋リコイル', 'フリック'];
const PAD_NAME = 'acceptance pad (STANDARD GAMEPAD)';
const OLD_BEST_KEY = 'apex-training:best:mouse:lstar:pattern';
const OLD_HISTORY_KEY = 'apex-training:history:mouse:lstar:pattern';
const CENTER_BEST_KEY = 'apex-training:best:mouse:lstar:center';
const CENTER_HISTORY_KEY = 'apex-training:history:mouse:lstar:center';
const COMMON_SETTINGS_KEY = 'apex-training:settings:common';
/**
 * 変更の前のビルド（センター維持と補正のパネルの設定があったとき）で、設定画面の補正のパネルを OFF にし、FOV を 100 にしたときに
 * 保存された共通の設定の値そのもの（QA が変更の前のビルドの画面を操作して localStorage から写した）。
 */
const LEGACY_COMMON = JSON.stringify({
  inputMethod: 'auto',
  fov: 100,
  crosshairShape: 'dot',
  crosshairColor: '#77ccff',
  ghost: false,
  correctionPanel: false,
  patternDisplay: 'detailed',
  sound: true,
});
const PAD_CENTER_BEST_KEY = 'apex-training:best:pad:lstar:center';
const PAD_GHOST_BEST_KEY = 'apex-training:best:pad:lstar:ghost';

interface WeaponJson {
  id: string;
  name: string;
  magSize: number;
  measured?: boolean;
}
const WEAPONS: WeaponJson[] = readdirSync(join(ROOT, 'src/data/weapons'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(ROOT, 'src/data/weapons', f), 'utf8')) as WeaponJson);
const byId = (id: string) => {
  const w = WEAPONS.find((x) => x.id === id);
  if (!w) throw new Error(`武器がない: ${id}`);
  return w;
};
/** 武器の一覧の武器（weapons.md: L-STAR と C.A.R. SMG）。 */
const LSTAR = byId('lstar');

const SPEC = (name: string) => readFileSync(join(ROOT, 'docs/spec', name), 'utf8');
/** SPEC の受け入れ条件の ID（「- **ID**:」の行）。 */
const specIds = () =>
  readdirSync(join(ROOT, 'docs/spec'))
    .filter((f) => f.endsWith('.md'))
    .flatMap((f) => [...SPEC(f).matchAll(/^- \*\*([A-Z]+-\d+)\*\*:/gm)].map((m) => m[1]!));

const PAGE_INIT = `
  window.__pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) };
  navigator.getGamepads = () => [{ id: ${JSON.stringify(PAD_NAME)}, index: 0, connected: true, mapping: 'standard',
    timestamp: performance.now(), axes: window.__pad.axes.slice(), buttons: window.__pad.buttons.map((b) => ({ ...b })), vibrationActuator: null }];
  window.__btn = (i, on) => { window.__pad.buttons[i] = { value: on ? 1 : 0, pressed: on, touched: on }; };
  window.__vis = (sel) => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    return !!el && !el.closest('[hidden]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0; };
  window.__ammo = () => { const m = (document.querySelector('[data-hud="ammo"]')?.textContent ?? '').match(/\\d+/); return m ? Number(m[0]) : NaN; };
  window.__screens = () => [...document.querySelectorAll('[data-screen]')].filter((s) => window.__vis(s)).map((s) => s.getAttribute('data-screen'));
  window.__guideVisible = () => window.__vis('.pad-guide');
  window.__interlude = () => window.__vis('#interlude');
  window.__hudText = () => [...document.querySelectorAll('[data-hud]')].filter((e) => window.__vis(e)).map((e) => e.innerText).join(' ');
`;

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

const options = (page: Page, selector: string) =>
  page.evaluate<string[]>(`[...document.querySelector(${JSON.stringify(selector)}).options].map((o) => o.textContent.trim())`);
const selected = (page: Page, selector: string) =>
  page.evaluate<string>(`document.querySelector(${JSON.stringify(selector)}).selectedOptions[0]?.textContent.trim() ?? ''`);

const waitTop = (page: Page) =>
  page.waitFor(
    `window.__vis('[data-screen="top"]') && document.querySelector('#weapon').options.length > 0 && document.querySelector('#mode').options.length > 0`,
    15_000,
  );
/** ページの時計を進めてリザルト画面に移るのを待つ。 */
const waitResult = async (page: Page) => {
  await page.advanceClockUntil(`location.hash === '#/result'`);
  await page.waitFor(`location.hash === '#/result' && window.__vis('[data-screen="result"]')`, 30_000);
};

/** トップ画面で武器・モード・回数を選び（mode が undefined なら選ばない）、「開始」を押してプレイ画面で練習が始まるまで待つ。 */
async function start(page: Page, weapon: WeaponJson, mode: string | undefined, count = 1) {
  await page.evaluate(`location.hash = '#/'`);
  await waitTop(page);
  await choose(page, '#weapon', weapon.name);
  if (mode) await choose(page, '#mode', mode);
  if (count !== 1) await choose(page, '#count', count);
  await page.clickSelector('[data-screen="top"] a[href="#/play"]');
  await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]') && window.__ammo() === ${weapon.magSize}`, 10_000);
  await settle(page, 4);
}

/** パッドの R2 を押し続けて撃ち切る（ページの時計を進め、残弾が 0 になるか、練習中でなくなったら離す）。 */
async function padFireAll(page: Page) {
  await page.evaluate('window.__btn(7, true)');
  await page.advanceClockUntil(`window.__ammo() === 0 || location.hash !== '#/play' || window.__interlude()`, { limit: 20 });
  await page.evaluate('window.__btn(7, false)');
}

async function openHistory(page: Page) {
  await page.evaluate(`location.hash = '#/history'`);
  await page.waitFor(`window.__vis('[data-screen="history"]') && document.querySelector('#history-mode').options.length > 0`);
  await settle(page, 2);
}

/**
 * 画面（top・history）のモードの欄。選択肢の select が画面に描かれているかと、画面の文字。
 * hidden 属性が CSS の display で上書きされて描かれていることもあるので、属性ではなく描かれているか（大きさと可視性）で見る。
 */
const modeView = (page: Page, screen: 'top' | 'history') =>
  page.evaluate<{ selectShown: boolean; text: string }>(`(() => {
    const root = document.querySelector('[data-screen="${screen}"]');
    // トップ画面はモードのカードの並び、履歴の画面はモードの select（docs/spec/screens.md「トップ画面」「履歴の画面」）。
    const select = root.querySelector('#mode-cards') ?? root.querySelector('select[id$="mode"]');
    const r = select ? select.getBoundingClientRect() : null;
    const shown = !!select && select.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && !!r && r.width > 0 && r.height > 0;
    return { selectShown: shown, text: root.innerText }; })()`);

const storageKeys = (page: Page) => page.evaluate<string[]>('Object.keys(localStorage)');

// ---------------------------------------------------------------------------

describe('SPEC: パターン観察の受け入れ条件は欠番になっている', () => {
  it('パターン観察の 4 つの受け入れ条件は受け入れ条件に残っていない（欠番）', () => {
    const ids = specIds();
    for (const id of ['MODE-2', 'MODE-26', 'SCO-17', 'SCO-25']) expect(ids, id).not.toContain(id);
    // 変更・追加された条件はある。
    for (const id of ['MODE-1', 'MODE-27', 'MODE-28', 'UI-26', 'PAD-18', 'PAD-19']) expect(ids, id).toContain(id);
  });

  it('センター維持と補正のパネルの設定の 3 つの受け入れ条件は欠番で、追加した条件はある', () => {
    const ids = specIds();
    for (const id of ['MODE-4', 'UI-58', 'UI-61']) expect(ids, id).not.toContain(id);
    for (const id of ['MODE-29', 'UI-75', 'SCO-39']) expect(ids, id).toContain(id);
  });

  it('SPEC のモードは反復練習・追いエイム・追いエイム＋リコイル・フリックの 4 つで、パターン観察とセンター維持はモードとして書かれていない', () => {
    const modes = SPEC('modes.md');
    expect(modes).toContain('今のモードは反復練習（リコイル）と、追いエイム・追いエイム＋リコイル・フリック（エイム）の 4 つ');
    expect(modes).not.toMatch(/^### パターン観察/m);
    expect(modes).not.toMatch(/^### センター維持/m);
  });
});

describe.skipIf(NESTED || !chromium)('QA: パターン観察モードをなくし、すべてのモードを採点する（#51）', () => {
  let work = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  const pages: Page[] = [];
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));

  /** 新しいタブで localStorage を storage にしてから読み込み直したトップ画面を開く（render=off・clock=manual）。 */
  async function openFresh(storage: Record<string, string> = {}): Promise<Page> {
    for (const p of pages.splice(0)) await p.send('Page.close').catch(() => {});
    const page = await browser!.newPage();
    pages.push(page);
    await page.addInitScript(PAGE_INIT);
    await page.goto(appUrl(origin, BASE, '#/', APP));
    await page.evaluate(`localStorage.clear(); for (const [k, v] of Object.entries(${JSON.stringify(storage)})) localStorage.setItem(k, v);`);
    await page.evaluate('window.__beforeReload = true');
    await page.send('Page.reload', { ignoreCache: false });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete'`, 15_000);
    await waitTop(page);
    return page;
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'remove-pattern-qa-'));
    const dist = join(work, 'dist');
    const build = spawnSync(`npm run build -- --outDir "${dist}" --emptyOutDir`, {
      cwd: ROOT,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, APEX_ACCEPTANCE_NESTED: '1', FORCE_COLOR: '0' },
    });
    if (build.status !== 0) throw new Error(`ビルドが失敗した:\n${build.stdout}${build.stderr}`);
    server = await serveStatic(dist, BASE);
    origin = originOf(server);
    browser = await launchBrowser(chromium!);
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((ok) => (server ? server.close(ok) : ok(undefined)));
    if (work) rmSync(work, { recursive: true, force: true });
  });


  // -------------------------------------------------------------------------
  describe('パターン観察の受け入れ条件（欠番）: パターン観察は画面のどこからも選べず、そのキーは保存されない', () => {
    it('トップ画面と履歴の画面にパターン観察の選択肢がなく、反復練習を練習しても :pattern のキーが保存されない', async () => {
      const page = await openFresh();
      expect(await options(page, '#mode')).not.toContain(PATTERN);
      expect(await page.evaluate<string>(`document.querySelector('[data-screen="top"]').innerText`)).not.toContain(PATTERN);
      for (const mode of MODES) {
        await start(page, LSTAR, mode);
        await padFireAll(page);
        await waitResult(page);
        expect(await page.evaluate<string>(`document.querySelector('[data-screen="result"]').innerText`)).not.toContain(PATTERN);
      }
      await openHistory(page);
      expect(await options(page, '#history-mode')).not.toContain(PATTERN);
      const keys = await storageKeys(page);
      expect(keys.filter((k) => k.endsWith(':pattern')), keys.join('\n')).toEqual([]);
      // 練習したモードは採点され、履歴に保存される（SCO の「すべてのモードを採点する」）。
      expect(keys.some((k) => k.startsWith('apex-training:history:') && k.endsWith(':lstar:ghost')), keys.join('\n')).toBe(true);
      expect(keys.filter((k) => k.endsWith(':center')), keys.join('\n')).toEqual([]);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  describe('MODE-27: モードの選択肢と「反復練習」の言葉', () => {
    it('トップ画面のモードの選択肢に「反復練習」「追いエイム」「追いエイム＋リコイル」が並んで「反復練習」が選ばれ、「ゴースト追従」「パターン観察」「センター維持」は出ない', async () => {
      const page = await openFresh();
      const view = await modeView(page, 'top');
      expect(view.selectShown, 'モードの選択肢の欄が見えていない').toBe(true);
      expect(await selected(page, '#mode')).toBe(GHOST);
      expect(await options(page, '#mode')).toEqual(ALL_MODES);
      const top = view.text;
      expect(top).not.toContain(OLD_GHOST);
      expect(top).not.toContain(PATTERN);
      expect(top).not.toContain(CENTER);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    for (const mode of MODES) {
      it(`回数 5 の${mode}のセットで、HUD・短いリザルト・セットのまとめに、モードの名前のほかに「反復練習」が出ない`, async () => {
        const page = await openFresh();
        await start(page, LSTAR, mode, 5);
        const huds: string[] = [];
        const interludes: string[] = [];
        for (let n = 1; n <= 5; n += 1) {
          await page.advanceClockUntil(`location.hash === '#/play' && !window.__interlude() && window.__ammo() === ${LSTAR.magSize} && window.__hudText().includes('${n} / 5')`, { limit: 15 });
          huds.push(await page.evaluate<string>('window.__hudText()'));
          await padFireAll(page);
          if (n < 5) {
            await page.advanceClockUntil('window.__interlude()', { limit: 10 });
            interludes.push(await page.evaluate<string>(`document.querySelector('#interlude').innerText`));
            huds.push(await page.evaluate<string>('window.__hudText()'));
            // 「次へ」（Space）で次の回へ。
            await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: ' ' });
            await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
          }
        }
        await page.advanceClockUntil(`location.hash === '#/set-result'`, { limit: 15 });
        await page.waitFor(`location.hash === '#/set-result' && window.__vis('[data-screen="set-result"]')`, 15_000);
        await settle(page, 4);
        expect(huds).toHaveLength(9);
        for (const h of huds) expect(h, h).not.toContain(GHOST);
        expect(interludes).toHaveLength(4);
        for (const t of interludes) expect(t, t).not.toContain(GHOST);
        const heading = await page.evaluate<string>(`document.querySelector('#set-summary').innerText`);
        const whole = await page.evaluate<string>(`document.querySelector('[data-screen="set-result"]').innerText`);
        const count = (s: string) => s.split(GHOST).length - 1;
        // 見出しの武器・モード・入力方式にはモードの名前が出る。
        expect(heading).toContain(mode);
        // 「反復練習」が出てよいのは見出しのモードの名前だけ。
        expect(count(whole), whole).toBe(mode === GHOST ? 1 : 0);
        expect(count(heading), heading).toBe(mode === GHOST ? 1 : 0);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 180_000);
    }
  });

  // -------------------------------------------------------------------------
  describe('MODE-28: 以前のパターン観察のキーがあっても開ける', () => {
    it('トップ画面が開き、モードの選択肢にパターン観察は出ず「反復練習」が選ばれ、そのまま開始すると反復練習が始まり、履歴の画面にもパターン観察が出ず、キーは残る', async () => {
      const best = JSON.stringify({ version: 1, meanError: 1.23, groupingRadius: 1, hitRate: 50, shots: 28, achievedAt: '2026-01-01T00:00:00.000Z' });
      const history = JSON.stringify({ version: 1, entries: [{ at: '2026-01-01T00:00:00.000Z', meanError: 4.56, hitRate: 50, groupingRadius: 1, shots: 28 }] });
      const page = await openFresh({ [OLD_BEST_KEY]: best, [OLD_HISTORY_KEY]: history });
      expect(await page.evaluate<string[]>('window.__screens()')).toEqual(['top']);
      const view = await modeView(page, 'top');
      expect(view.selectShown, 'モードの選択肢の欄が見えていない').toBe(true);
      expect(await selected(page, '#mode')).toBe(GHOST);
      expect(view.text).not.toContain(PATTERN);
      expect(await selected(page, '#mode')).toBe(GHOST);
      // モードは選び直さずに「開始」を押す（武器も既定のまま）。
      await page.clickSelector('[data-screen="top"] a[href="#/play"]');
      await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]') && window.__ammo() > 0`, 10_000);
      // 反復練習は補正のパネルを必ず表示する（MODE-24）。
      await page.advanceClockUntil(`window.__vis('.correction-panel')`, { limit: 5 });
      await padFireAll(page);
      await waitResult(page);
      expect(await page.evaluate<string>(`document.querySelector('#result-summary').innerText`)).toContain(GHOST);
      // 履歴の画面のモードにもパターン観察は出ない。
      await openHistory(page);
      expect((await modeView(page, 'history')).selectShown).toBe(true);
      expect(await options(page, '#history-mode')).toEqual(ALL_MODES);
      expect(await page.evaluate<string>(`document.querySelector('[data-screen="history"]').innerText`)).not.toContain(PATTERN);
      // 2 つのキーは消されずに残る。
      expect(await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(OLD_BEST_KEY)})`)).toBe(best);
      expect(await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(OLD_HISTORY_KEY)})`)).toBe(history);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 90_000);

    it('以前のキーがある状態で履歴の画面を直接開いても、エラーにならずモードの選択肢は登録されたモードだけで、キーは残る', async () => {
      const best = JSON.stringify({ version: 1, meanError: 1.23, groupingRadius: 1, hitRate: 50, shots: 28, achievedAt: '2026-01-01T00:00:00.000Z' });
      const history = JSON.stringify({ version: 1, entries: [{ at: '2026-01-01T00:00:00.000Z', meanError: 4.56, hitRate: 50, groupingRadius: 1, shots: 28 }] });
      const page = await openFresh({ [OLD_BEST_KEY]: best, [OLD_HISTORY_KEY]: history });
      await page.goto(appUrl(origin, BASE, '#/history', APP));
      await openHistory(page);
      expect(await options(page, '#history-mode')).toEqual(ALL_MODES);
      for (const m of MODES) {
        await choose(page, '#history-mode', m);
        await settle(page, 2);
        expect(await page.evaluate<string>(`document.querySelector('[data-screen="history"]').innerText`)).not.toContain('4.56');
      }
      expect(await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(OLD_BEST_KEY)})`)).toBe(best);
      expect(await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(OLD_HISTORY_KEY)})`)).toBe(history);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('MODE-29: 以前のセンター維持のキーと、補正のパネルを OFF にした古い共通の設定があっても開ける', () => {
    const best = JSON.stringify({ version: 1, meanError: 0.01, groupingRadius: 1, hitRate: 50, shots: 28, achievedAt: '2026-01-01T00:00:00.000Z' });
    const history = JSON.stringify({ version: 1, entries: [{ at: '2026-01-01T00:00:00.000Z', meanError: 4.56, hitRate: 50, groupingRadius: 1, shots: 28 }] });
    const oldCommon = JSON.stringify({ correctionPanel: false });
    const seed = { [CENTER_BEST_KEY]: best, [CENTER_HISTORY_KEY]: history, [COMMON_SETTINGS_KEY]: oldCommon };

    it('トップ画面のモードの選択肢にセンター維持は出ず「反復練習」が選ばれ、そのまま開始すると補正のパネル付きで反復練習が始まり、撃ち切ると採点結果が出て、キーは残る', async () => {
      const page = await openFresh(seed);
      expect(await page.evaluate<string[]>('window.__screens()')).toEqual(['top']);
      const view = await modeView(page, 'top');
      expect(view.selectShown, 'モードの選択肢の欄が見えていない').toBe(true);
      expect(await selected(page, '#mode')).toBe(GHOST);
      expect(view.text).not.toContain(CENTER);
      await page.clickSelector('[data-screen="top"] a[href="#/play"]');
      await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]') && window.__ammo() > 0`, 10_000);
      await page.advanceClockUntil(`window.__vis('.correction-panel')`, { limit: 5 });
      expect(await page.evaluate<boolean>(`window.__vis('.correction-panel')`), '補正のパネルが表示されない').toBe(true);
      await padFireAll(page);
      await waitResult(page);
      expect(await page.evaluate<string>(`document.querySelector('#result-summary').innerText`)).toContain(GHOST);
      expect(await page.evaluate<string>(`document.querySelector('#result-metrics').innerText`)).toMatch(/平均ズレ\s*[\d.]+\s*°/);
      expect(await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(CENTER_BEST_KEY)})`)).toBe(best);
      expect(await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(CENTER_HISTORY_KEY)})`)).toBe(history);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 90_000);

    it('設定画面と履歴の画面がエラーにならずに開き、どちらにもセンター維持と補正のパネルの項目が出ず、キーは残る', async () => {
      const page = await openFresh(seed);
      await page.evaluate(`location.hash = '#/settings'`);
      await page.waitFor(`window.__vis('[data-screen="settings"]') && document.getElementById('setting-fov').value !== ''`);
      const settings = await page.evaluate<{ text: string; panelChecks: number }>(`(() => ({
        text: document.querySelector('[data-screen="settings"]').innerText,
        panelChecks: [...document.querySelectorAll('[data-screen="settings"] input[type="checkbox"]')]
          .filter((i) => (i.closest('label')?.textContent ?? '').includes('補正のパネル')).length }))()`);
      expect(settings.text).not.toContain(CENTER);
      expect(settings.panelChecks, '補正のパネルの ON/OFF の項目がある').toBe(0);
      await openHistory(page);
      const view = await modeView(page, 'history');
      expect(view.selectShown).toBe(true);
      expect(view.text).not.toContain(CENTER);
      expect(view.text).not.toContain('補正のパネル');
      // 以前のセンター維持の履歴（平均ズレ 4.56）は表示しない。
      expect(view.text).not.toContain('4.56');
      expect(await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(CENTER_BEST_KEY)})`)).toBe(best);
      expect(await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(CENTER_HISTORY_KEY)})`)).toBe(history);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('変更の前のビルドが保存した共通の設定（補正のパネル OFF）と、以前のセンター維持の自己ベストがあっても、反復練習はパネル付きで始まり、センター維持の自己ベストを使わずに採点・保存する', async () => {
      // パッドの L-STAR の以前のセンター維持の自己ベストは、どの結果にも負けない小さな値にしておく。
      const padCenterBest = JSON.stringify({ version: 1, meanError: 0.0001, groupingRadius: 0, hitRate: 100, shots: 28, achievedAt: '2026-01-01T00:00:00.000Z' });
      const page = await openFresh({ ...seed, [COMMON_SETTINGS_KEY]: LEGACY_COMMON, [PAD_CENTER_BEST_KEY]: padCenterBest });
      const view = await modeView(page, 'top');
      expect(view.selectShown, 'モードの選択肢の欄が見えていない').toBe(true);
      expect(await selected(page, '#mode')).toBe(GHOST);
      await start(page, LSTAR, undefined);
      await page.advanceClockUntil(`window.__vis('.correction-panel')`, { limit: 5 });
      expect(await page.evaluate<boolean>(`window.__vis('.correction-panel')`), '補正のパネルが表示されない').toBe(true);
      await padFireAll(page);
      await waitResult(page);
      const result = await page.evaluate<string>(`document.querySelector('[data-screen="result"]').innerText`);
      expect(result).toMatch(/平均ズレ\s*[\d.]+\s*°/);
      // 反復練習の自己ベストはまだないので更新になる（センター維持の自己ベストと比べない）。
      expect(result).toContain('自己ベスト更新');
      expect(result).not.toContain(CENTER);
      expect(await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(PAD_GHOST_BEST_KEY)})`)).not.toBeNull();
      expect(await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(PAD_CENTER_BEST_KEY)})`)).toBe(padCenterBest);
      expect(await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(CENTER_BEST_KEY)})`)).toBe(best);
      expect(await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(CENTER_HISTORY_KEY)})`)).toBe(history);
      // 設定画面は変更の前に保存した FOV 100 を表示し、補正のパネルの項目はない。
      await page.evaluate(`location.hash = '#/settings'`);
      await page.waitFor(`window.__vis('[data-screen="settings"]') && document.getElementById('setting-fov').value !== ''`);
      expect(await page.evaluate<string>(`document.getElementById('setting-fov').value`)).toBe('100');
      expect(await page.evaluate<boolean>(`!!document.getElementById('setting-correction-panel')`)).toBe(false);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  it('UI-75: 変更の前のビルドが保存した共通の設定（補正のパネル OFF・FOV 100）そのままでも、設定画面は FOV 100 を表示して補正のパネルの項目を出さず、反復練習ではパネルが表示される', async () => {
    const page = await openFresh({ [COMMON_SETTINGS_KEY]: LEGACY_COMMON });
    await page.evaluate(`location.hash = '#/settings'`);
    await page.waitFor(`window.__vis('[data-screen="settings"]') && document.getElementById('setting-fov').value !== ''`);
    expect(await page.evaluate<string>(`document.getElementById('setting-fov').value`)).toBe('100');
    const settings = await page.evaluate<{ text: string; panelInputs: number }>(`(() => {
      const root = document.querySelector('[data-screen="settings"]');
      const labelOf = (el) => ((el.closest('label')?.textContent ?? '') + (el.labels ? [...el.labels].map((l) => l.textContent).join('') : ''));
      return { text: root.innerText,
        panelInputs: (root.querySelector('#setting-correction-panel') ? 1 : 0)
          + [...root.querySelectorAll('input, select')].filter((el) => el.id !== 'setting-pattern-display' && labelOf(el).includes('補正のパネル')).length }; })()`);
    expect(settings.panelInputs, '補正のパネルの項目がある').toBe(0);
    expect(settings.text).not.toContain('補正のパネル（センター維持）');
    expect(settings.text).not.toContain(CENTER);
    await start(page, LSTAR, undefined);
    await page.advanceClockUntil(`window.__vis('.correction-panel')`, { limit: 5 });
    expect(await page.evaluate<boolean>(`window.__vis('.correction-panel')`), '補正のパネルが表示されない').toBe(true);
    expect(exceptions(page), page.errors.join('\n')).toEqual([]);
  }, 60_000);

  // -------------------------------------------------------------------------
  it('UI-75: 古い補正のパネルの項目（OFF）と FOV 100 を保存した共通の設定でも、設定画面は FOV 100 を表示して補正のパネルの項目を出さず、反復練習ではパネルが表示される', async () => {
    const page = await openFresh({ [COMMON_SETTINGS_KEY]: JSON.stringify({ correctionPanel: false, fov: 100 }) });
    await page.evaluate(`location.hash = '#/settings'`);
    await page.waitFor(`window.__vis('[data-screen="settings"]') && document.getElementById('setting-fov').value !== ''`);
    expect(await page.evaluate<string>(`document.getElementById('setting-fov').value`)).toBe('100');
    const panelChecks = await page.evaluate<number>(`[...document.querySelectorAll('[data-screen="settings"] input[type="checkbox"]')]
      .filter((i) => (i.closest('label')?.textContent ?? '').includes('補正のパネル')).length`);
    expect(panelChecks, '補正のパネルの ON/OFF の項目がある').toBe(0);
    await start(page, LSTAR, undefined);
    await page.advanceClockUntil(`window.__vis('.correction-panel')`, { limit: 5 });
    expect(await page.evaluate<boolean>(`window.__vis('.correction-panel')`), '補正のパネルが表示されない').toBe(true);
    expect(exceptions(page), page.errors.join('\n')).toEqual([]);
  }, 60_000);
});
