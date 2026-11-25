// Issue #51「パターン観察モードをなくし、すべてのモードを採点する」の QA の受け入れテスト。
// 対象: MODE-1（変更）・MODE-2（欠番）・MODE-26（欠番）・MODE-27（変更）・MODE-28（追加）・UI-26（変更）・
// SCO-17（欠番）・SCO-25（欠番）・PAD-18（変更）・PAD-19（変更）。
// 公開された入口（docs/spec/、ビルドの結果を /apex-training/ で配信した画面、index.html の要素、武器の JSON、
// localStorage の自己ベスト・履歴のキー）だけを使い、実装の内部には依存しない。
// 画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、パッドは Gamepad API（navigator.getGamepads）の形で与える。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const CX = 640;
const CY = 400;
const chromium = findChromium();

/** SPEC の文言と値（実装の定数には依存しない）。 */
const GHOST = '反復練習';
const CENTER = 'センター維持';
const PATTERN = 'パターン観察';
const OLD_GHOST = 'ゴースト追従';
const MODES = [GHOST, CENTER];
const PAD_NAME = 'acceptance pad (STANDARD GAMEPAD)';
const OLD_BEST_KEY = 'apex-training:best:mouse:lstar:pattern';
const OLD_HISTORY_KEY = 'apex-training:history:mouse:lstar:pattern';

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
const LISTED = [byId('lstar'), byId('car')];
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
const ammo = (page: Page) => page.evaluate<number>('window.__ammo()');

const waitTop = (page: Page) =>
  page.waitFor(
    `window.__vis('[data-screen="top"]') && document.querySelector('#weapon').options.length > 0 && document.querySelector('#mode').options.length > 0`,
    15_000,
  );
const waitResult = (page: Page) => page.waitFor(`location.hash === '#/result' && window.__vis('[data-screen="result"]')`, 30_000);

/** 設定画面で入力方式を選んでトップ画面に戻る。 */
async function setInput(page: Page, input: string) {
  await page.evaluate(`location.hash = '#/settings'`);
  await page.waitFor(`window.__vis('[data-screen="settings"]')`);
  await choose(page, '#setting-input-method', input);
  await page.frames(6);
  await page.evaluate(`location.hash = '#/'`);
  await waitTop(page);
}

/** トップ画面で武器・モード・回数を選び（mode が undefined なら選ばない）、「開始」を押してプレイ画面で練習が始まるまで待つ。 */
async function start(page: Page, weapon: WeaponJson, mode: string | undefined, count = 1) {
  await page.evaluate(`location.hash = '#/'`);
  await waitTop(page);
  await choose(page, '#weapon', weapon.name);
  if (mode) await choose(page, '#mode', mode);
  if (count !== 1) await choose(page, '#count', count);
  await page.clickSelector('[data-screen="top"] a[href="#/play"]');
  await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]') && window.__ammo() === ${weapon.magSize}`, 10_000);
  await page.frames(4);
}

/** パッドの R2 を押し続けて撃ち切る（残弾が 0 になるか、練習中でなくなったら離す）。 */
async function padFireAll(page: Page) {
  await page.evaluate(`(async () => {
    window.__btn(7, true); const t0 = performance.now();
    while (window.__ammo() > 0 && location.hash === '#/play' && !window.__interlude() && performance.now() - t0 < 20000) await new Promise((r) => requestAnimationFrame(r));
    window.__btn(7, false); })()`);
}

const mouseButton = (page: Page, type: 'mousePressed' | 'mouseReleased') =>
  page.send('Input.dispatchMouseEvent', { type, x: CX, y: CY, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });

async function lock(page: Page) {
  await page.click(CX, CY);
  await page.waitFor('!!document.pointerLockElement', 5000);
  await page.frames(6);
}

/** マウスの左ボタンを押し続けて撃ち切り、リザルト画面を待つ。 */
async function mouseFireAll(page: Page) {
  await lock(page);
  await mouseButton(page, 'mousePressed');
  await waitResult(page);
  await mouseButton(page, 'mouseReleased');
  await page.frames(6);
}

async function openHistory(page: Page) {
  await page.evaluate(`location.hash = '#/history'`);
  await page.waitFor(`window.__vis('[data-screen="history"]') && document.querySelector('#history-mode').options.length > 0`);
  await page.frames(2);
}

const storageKeys = (page: Page) => page.evaluate<string[]>('Object.keys(localStorage)');

// ---------------------------------------------------------------------------

describe('SPEC: パターン観察の受け入れ条件は欠番になっている', () => {
  it('MODE-2・MODE-26・SCO-17・SCO-25 は受け入れ条件に残っていない（欠番）', () => {
    const ids = specIds();
    for (const id of ['MODE-2', 'MODE-26', 'SCO-17', 'SCO-25']) expect(ids, id).not.toContain(id);
    // 変更・追加された条件はある。
    for (const id of ['MODE-1', 'MODE-27', 'MODE-28', 'UI-26', 'PAD-18', 'PAD-19']) expect(ids, id).toContain(id);
  });

  it('SPEC のモードは反復練習とセンター維持の 2 つで、パターン観察はモードとして書かれていない', () => {
    const modes = SPEC('modes.md');
    expect(modes).toContain('モードは、反復練習・センター維持の 2 つ');
    expect(modes).not.toMatch(/^### パターン観察/m);
  });
});

describe.skipIf(NESTED || !chromium)('QA: パターン観察モードをなくし、すべてのモードを採点する（#51）', () => {
  let work = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  const pages: Page[] = [];
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));

  /** 新しいタブで localStorage を storage にしてから読み込み直したトップ画面を開く。 */
  async function openFresh(storage: Record<string, string> = {}): Promise<Page> {
    for (const p of pages.splice(0)) await p.send('Page.close').catch(() => {});
    const page = await browser!.newPage();
    pages.push(page);
    await page.addInitScript(PAGE_INIT);
    await page.goto(`${origin}${BASE}#/`);
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
  describe('MODE-1: 武器の一覧の武器それぞれで、反復練習とセンター維持を最後まで練習でき、リザルト画面が表示される', () => {
    for (const w of LISTED) {
      for (const mode of MODES) {
        it(`${w.name}・${mode}`, async () => {
          const page = await openFresh();
          await start(page, w, mode);
          expect(await page.evaluate<string>(`document.querySelector('[data-hud="weapon"]').textContent`)).toContain(w.name);
          await padFireAll(page);
          await waitResult(page);
          await page.frames(4);
          expect(await page.evaluate<string[]>('window.__screens()')).toEqual(['result']);
          const summary = await page.evaluate<string>(`document.querySelector('#result-summary').innerText`);
          expect(summary).toContain(w.name);
          expect(summary).toContain(mode);
          // どちらのモードも採点する（リザルトに採点結果の指標が出る）。
          expect(await page.evaluate<boolean>(`window.__vis('#result-metrics')`), 'リザルトに指標が出る').toBe(true);
          expect(await page.evaluate<string>(`document.querySelector('#result-metrics').innerText`)).toMatch(/\d/);
          expect(exceptions(page), page.errors.join('\n')).toEqual([]);
        }, 90_000);
      }
    }
  });

  // -------------------------------------------------------------------------
  describe('MODE-2・MODE-26・SCO-17・SCO-25（欠番）: パターン観察は画面のどこからも選べず、そのキーは保存されない', () => {
    it('トップ画面と履歴の画面にパターン観察の選択肢がなく、両モードを練習しても :pattern のキーが保存されない', async () => {
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
      // 練習した 2 つのモードはどちらも採点され、履歴に保存される（SCO の「すべてのモードを採点する」）。
      expect(keys.some((k) => k.startsWith('apex-training:history:') && k.endsWith(':lstar:ghost')), keys.join('\n')).toBe(true);
      expect(keys.some((k) => k.startsWith('apex-training:history:') && k.endsWith(':lstar:center')), keys.join('\n')).toBe(true);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  describe('MODE-27: モードの選択肢と「反復練習」の言葉', () => {
    it('トップ画面のモードの選択肢に「反復練習」「センター維持」だけが出て、「ゴースト追従」と「パターン観察」は出ない', async () => {
      const page = await openFresh();
      const modes = await options(page, '#mode');
      expect(modes).toEqual(MODES);
      const top = await page.evaluate<string>(`document.querySelector('[data-screen="top"]').innerText`);
      expect(top).not.toContain(OLD_GHOST);
      expect(top).not.toContain(PATTERN);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    for (const mode of MODES) {
      it(`回数 5 の${mode}のセットで、HUD・短いリザルト・セットのまとめに、モードの名前のほかに「反復練習」が出ない`, async () => {
        const page = await openFresh();
        await start(page, LSTAR, mode, 5);
        const huds: string[] = [];
        const interludes: string[] = [];
        for (let n = 1; n <= 5; n += 1) {
          await page.waitFor(`location.hash === '#/play' && !window.__interlude() && window.__ammo() === ${LSTAR.magSize} && window.__hudText().includes('${n} / 5')`, 15_000);
          huds.push(await page.evaluate<string>('window.__hudText()'));
          await padFireAll(page);
          if (n < 5) {
            await page.waitFor('window.__interlude()', 10_000);
            interludes.push(await page.evaluate<string>(`document.querySelector('#interlude').innerText`));
            huds.push(await page.evaluate<string>('window.__hudText()'));
            // 「次へ」（Space）で次の回へ。
            await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: ' ' });
            await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
          }
        }
        await page.waitFor(`location.hash === '#/set-result' && window.__vis('[data-screen="set-result"]')`, 15_000);
        await page.frames(4);
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
    it('トップ画面が開き、選択肢は 2 つで反復練習が選ばれ、そのまま開始すると反復練習が始まり、履歴の画面にもパターン観察が出ず、キーは残る', async () => {
      const best = JSON.stringify({ version: 1, meanError: 1.23, groupingRadius: 1, hitRate: 50, shots: 28, achievedAt: '2026-01-01T00:00:00.000Z' });
      const history = JSON.stringify({ version: 1, entries: [{ at: '2026-01-01T00:00:00.000Z', meanError: 4.56, hitRate: 50, groupingRadius: 1, shots: 28 }] });
      const page = await openFresh({ [OLD_BEST_KEY]: best, [OLD_HISTORY_KEY]: history });
      expect(await page.evaluate<string[]>('window.__screens()')).toEqual(['top']);
      expect(await options(page, '#mode')).toEqual(MODES);
      expect(await selected(page, '#mode')).toBe(GHOST);
      // モードは選び直さずに「開始」を押す（武器も既定のまま）。
      await page.clickSelector('[data-screen="top"] a[href="#/play"]');
      await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]') && window.__ammo() > 0`, 10_000);
      // 反復練習は補正のパネルを必ず表示する（MODE-24）。
      await page.waitFor(`window.__vis('.correction-panel')`, 5000);
      await padFireAll(page);
      await waitResult(page);
      expect(await page.evaluate<string>(`document.querySelector('#result-summary').innerText`)).toContain(GHOST);
      // 履歴の画面のモードの選択肢にもパターン観察は出ない。
      await openHistory(page);
      expect(await options(page, '#history-mode')).toEqual(MODES);
      expect(await page.evaluate<string>(`document.querySelector('[data-screen="history"]').innerText`)).not.toContain(PATTERN);
      // 2 つのキーは消されずに残る。
      expect(await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(OLD_BEST_KEY)})`)).toBe(best);
      expect(await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(OLD_HISTORY_KEY)})`)).toBe(history);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 90_000);

    it('以前のキーがある状態で履歴の画面を直接開いても、エラーにならずモードの選択肢は 2 つで、キーは残る', async () => {
      const best = JSON.stringify({ version: 1, meanError: 1.23, groupingRadius: 1, hitRate: 50, shots: 28, achievedAt: '2026-01-01T00:00:00.000Z' });
      const history = JSON.stringify({ version: 1, entries: [{ at: '2026-01-01T00:00:00.000Z', meanError: 4.56, hitRate: 50, groupingRadius: 1, shots: 28 }] });
      const page = await openFresh({ [OLD_BEST_KEY]: best, [OLD_HISTORY_KEY]: history });
      await page.goto(`${origin}${BASE}#/history`);
      await openHistory(page);
      expect(await options(page, '#history-mode')).toEqual(MODES);
      for (const m of MODES) {
        await choose(page, '#history-mode', m);
        await page.frames(2);
        expect(await page.evaluate<string>(`document.querySelector('[data-screen="history"]').innerText`)).not.toContain('4.56');
      }
      expect(await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(OLD_BEST_KEY)})`)).toBe(best);
      expect(await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(OLD_HISTORY_KEY)})`)).toBe(history);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('UI-26: 履歴の画面のモードの選択肢', () => {
    it('反復練習とセンター維持だけが出る', async () => {
      const page = await openFresh();
      await page.clickSelector('[data-screen="top"] a[href="#/history"]');
      await openHistory(page);
      expect(await options(page, '#history-mode')).toEqual(MODES);
      const text = await page.evaluate<string>(`document.querySelector('[data-screen="history"]').innerText`);
      expect(text).not.toContain(PATTERN);
      expect(text).not.toContain(OLD_GHOST);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('PAD-18: スティック型のガイドが表示されないとき', () => {
    /** 撃つ前と撃っているあいだのガイドの表示を何度も読む。 */
    async function sampleWhileFiring(page: Page, fire: 'pad' | 'mouse') {
      const seen: boolean[] = [];
      for (let i = 0; i < 10; i += 1) {
        seen.push(await page.evaluate<boolean>('window.__guideVisible()'));
        await page.frames(2);
      }
      if (fire === 'pad') await page.evaluate('window.__btn(7, true)');
      else await mouseButton(page, 'mousePressed');
      for (let i = 0; i < 30; i += 1) {
        seen.push(await page.evaluate<boolean>('window.__guideVisible()'));
        await page.frames(2);
      }
      if (fire === 'pad') await page.evaluate('window.__btn(7, false)');
      else await mouseButton(page, 'mouseReleased');
      return seen;
    }

    for (const mode of MODES) {
      it(`入力方式がマウスのとき（${mode}）`, async () => {
        const page = await openFresh();
        await setInput(page, 'マウス');
        await start(page, LSTAR, mode);
        await lock(page);
        const seen = await sampleWhileFiring(page, 'mouse');
        expect(await ammo(page), 'マウスで撃てている').toBeLessThan(LSTAR.magSize);
        expect(seen.some(Boolean)).toBe(false);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 60_000);
    }

    it('センター維持のとき（入力方式パッド）', async () => {
      const page = await openFresh();
      await setInput(page, 'パッド');
      await start(page, LSTAR, CENTER);
      const seen = await sampleWhileFiring(page, 'pad');
      expect(await ammo(page), 'パッドで撃てている').toBeLessThan(LSTAR.magSize);
      expect(seen.some(Boolean)).toBe(false);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('対照: 反復練習を入力方式パッドで練習しているときはガイドが表示される', async () => {
      const page = await openFresh();
      await setInput(page, 'パッド');
      await start(page, LSTAR, GHOST);
      await page.waitFor('window.__guideVisible()', 5000);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('入力方式が「自動」でパッドで練習中にマウスを操作したとき、ガイドが消える', async () => {
      const page = await openFresh();
      await setInput(page, '自動');
      await start(page, LSTAR, GHOST);
      await lock(page);
      await page.evaluate('window.__btn(7, true)');
      await page.waitFor(`window.__ammo() <= ${LSTAR.magSize - 3}`, 5000);
      await page.waitFor('window.__guideVisible()', 3000);
      await page.evaluate('window.__btn(7, false)');
      await page.frames(6);
      expect(await ammo(page)).toBeGreaterThan(0);
      for (let i = 1; i <= 10; i += 1) {
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: CX + i * 12, y: CY + i * 3, button: 'none', buttons: 0 });
        await page.frames(2);
      }
      await page.waitFor('!window.__guideVisible()', 2000);
      expect(await page.evaluate<string>('location.hash')).toBe('#/play');
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('PAD-19: リザルト画面の右スティックの入力推移のグラフ', () => {
    const padVisible = (page: Page) => page.evaluate<boolean>(`window.__vis('#result-pad')`);
    const resultText = (page: Page) => page.evaluate<string>(`document.querySelector('[data-screen="result"]').innerText`);

    for (const mode of MODES) {
      it(`マウスで${mode}を練習して終えたときは表示されない`, async () => {
        const page = await openFresh();
        await setInput(page, 'マウス');
        await start(page, LSTAR, mode);
        await mouseFireAll(page);
        expect(await padVisible(page)).toBe(false);
        expect(await resultText(page)).not.toContain(PAD_NAME);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 60_000);

      it(`パッドで${mode}を練習して終えたときは、左右と上下のグラフと使ったパッドの名前が表示される`, async () => {
        const page = await openFresh();
        await setInput(page, 'パッド');
        await start(page, LSTAR, mode);
        await page.evaluate('window.__pad.axes[2] = 0.3; window.__pad.axes[3] = 0.2');
        await padFireAll(page);
        await waitResult(page);
        await page.evaluate('window.__pad.axes[2] = 0; window.__pad.axes[3] = 0');
        await page.frames(6);
        expect(await padVisible(page)).toBe(true);
        const text = await page.evaluate<string>(`document.querySelector('#result-pad').innerText`);
        expect(text).toContain(PAD_NAME);
        expect(text).toContain('左右');
        expect(text).toContain('上下');
        expect(text).toContain('自分');
        expect(text).toContain('理想');
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 60_000);
    }
  });
});
