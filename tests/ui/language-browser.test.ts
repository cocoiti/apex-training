// 表示の言語（docs/spec/screens.md「表示の言語」、docs/spec/overview.md「表示の言語」「権利と表記」「保存」、docs/spec/modes.md「モードの登録」）を、
// ビルドした画面で確かめる。ブラウザの言語は tests/helpers/browser.ts の newPage の language で与える（既定は ja-JP）。
// 画面は render=off・clock=manual で開く。パッドは navigator.getGamepads を差し替えて与え、window.__btn でボタンを押す。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const chromium = findChromium();
const APP = { render: false, manualClock: true };
const LANGUAGE_KEY = 'apex-training:language';
const UNOFFICIAL_EN = 'Unofficial fan tool. Not affiliated with EA or Respawn.';
const FLICK_BEST = 'apex-training:best:mouse:-:flick:far:small';
const FLICK_HISTORY = 'apex-training:history:mouse:-:flick:far:small';
const STORAGE_EN = "Settings and records can't be saved in this environment. You can keep practicing.";

/** パッドの標準配置のボタン番号。 */
const A = 0;
const B = 1;
const R2 = 7;
const DOWN = 13;
const RIGHT = 15;

const PAGE_INIT = `
  window.__pad = { mapping: 'standard', buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) };
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: function () {
    return [{ id: 'lang-test-pad', index: 0, connected: true, mapping: window.__pad.mapping, timestamp: performance.now(), axes: [0, 0, 0, 0],
      buttons: window.__pad.buttons.map((b) => ({ ...b })), vibrationActuator: null }, null, null, null]; } });
  window.__btn = (i, on) => { window.__pad.buttons[i] = { value: on ? 1 : 0, pressed: on, touched: on }; };
  window.__vis = (el) => !!el && !el.closest('[hidden]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0;
  // 表示している文字と、表示している要素の aria-label・title・placeholder。言語の欄（「言語 / Language」と「日本語」）は除く（UI-127）。
  window.__shownTexts = () => {
    const root = document.querySelector('#ui');
    const language = document.querySelector('#settings-language');
    let text = root.innerText;
    if (window.__vis(language)) text = text.replace(language.innerText, '');
    const attrs = [...root.querySelectorAll('[aria-label], [title], [placeholder]')].filter((e) => window.__vis(e) && !language.contains(e))
      .flatMap((e) => ['aria-label', 'title', 'placeholder'].map((a) => e.getAttribute(a)).filter((v) => v));
    return { text, attrs, title: document.title, lang: document.documentElement.lang };
  };
`;

/** ひらがな・カタカナ・漢字。 */
const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

interface Shown {
  readonly text: string;
  readonly attrs: string[];
  readonly title: string;
  readonly lang: string;
}

const shown = (page: Page) => page.evaluate<Shown>('window.__shownTexts()');

/** 表示している文字・属性のうち、日本語の文字を含む行。 */
async function japaneseIn(page: Page): Promise<string[]> {
  const s = await shown(page);
  return [...s.text.split('\n'), ...s.attrs, s.title].filter((line) => JAPANESE.test(line));
}

const textOf = (page: Page, selector: string) => page.evaluate<string>(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').trim()`);

/** select の値を変え、利用者が選んだときと同じく input と change を送る。 */
async function choose(page: Page, selector: string, value: string): Promise<void> {
  const ok = await page.evaluate<boolean>(`(() => {
    const s = document.querySelector(${JSON.stringify(selector)});
    if (!s || ![...s.options].some((o) => o.value === ${JSON.stringify(value)})) return false;
    s.value = ${JSON.stringify(value)};
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  if (!ok) throw new Error(`${selector} に ${value} の選択肢がない`);
}

/** パッドのボタンを押して離す（押した描画と離した描画を進める）。 */
async function press(page: Page, button: number): Promise<void> {
  await page.evaluate(`window.__btn(${button}, true)`);
  await page.advanceClock(2 / 60);
  await page.evaluate(`window.__btn(${button}, false)`);
  await page.advanceClock(2 / 60);
}

describe.skipIf(NESTED || !chromium)('表示の言語', () => {
  let work = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';

  /** ブラウザの言語 language で、保存を消した状態（seed は消したあとに足す値）でトップ画面を開く。init はページのスクリプトより先に実行する。 */
  async function open(language: string, { seed = {}, init = '', hash = '#/' }: { seed?: Record<string, string>; init?: string; hash?: string } = {}): Promise<Page> {
    const page = await browser!.newPage({ language });
    await page.addInitScript(PAGE_INIT);
    await page.goto(appUrl(origin, BASE, hash, APP));
    await page.evaluate(`(() => { localStorage.clear(); for (const [k, v] of Object.entries(${JSON.stringify(seed)})) localStorage.setItem(k, v); })()`);
    if (init) await page.addInitScript(init);
    await page.evaluate('location.reload()');
    await ready(page);
    return page;
  }

  /** 読み込みが終わり、トップ画面のカードが出るまで待つ。 */
  const ready = (page: Page) => page.waitFor(`document.readyState === 'complete' && document.querySelectorAll('#mode-cards .card').length === 4`, 15_000);

  async function reload(page: Page): Promise<void> {
    await page.evaluate('location.reload()');
    await ready(page);
  }

  /** トップ画面で武器・モード・回数・練習の選択肢を選んで「開始」を押し、練習が始まるまで進める。 */
  async function startPractice(page: Page, mode: string, { count = '1', options = {} }: { count?: string; options?: Record<string, string> } = {}) {
    await page.evaluate(`location.hash = '#/'`);
    await page.waitFor(`window.__vis(document.querySelector('[data-screen="top"]'))`);
    await choose(page, '#mode', mode);
    await choose(page, '#count', count);
    for (const [id, value] of Object.entries(options)) await choose(page, `#${id}`, value);
    // 前の練習の HUD の表示を消し、この練習が始まったことを HUD で見分ける。
    await page.evaluate(`document.querySelector('[data-hud="input"]').textContent = ''`);
    await page.clickSelector('#start');
    await untilPracticing(page);
  }

  /** プレイ画面で練習が始まる（HUD に入力方式が出る）まで待つ。練習は「開始」のあとに非同期で始まるので、1 描画ずつ進めながら待つ。 */
  const untilPracticing = (page: Page) =>
    page.waitFor(`location.hash === '#/play' && (window.__apexTestClock.advance(1 / 60, 1 / 60), document.querySelector('[data-hud="input"]').textContent !== '')`);

  /** パッドの R2 を押したまま、式が真になるまで時計を進めて離す。 */
  async function fireUntil(page: Page, expression: string, limit = 30): Promise<void> {
    await page.evaluate(`window.__btn(${R2}, true)`);
    await page.advanceClockUntil(expression, { step: 1 / 60, limit });
    await page.evaluate(`window.__btn(${R2}, false)`);
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'language-'));
    const dist = join(work, 'dist');
    // 計測の同意の案内も確かめるので、コンテナ ID を入れてビルドする（許可しないので gtm.js は読み込まない）。
    const build = spawnSync(`npm run build -- --outDir "${dist}" --emptyOutDir`, {
      cwd: ROOT,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, APEX_GTM_CONTAINER_ID: 'GTM-LANGTEST' },
    });
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

  it('UI-125: ブラウザの言語が en-US で言語を保存していないと英語、ja-JP なら日本語で、<html lang> とタイトルが合う', async () => {
    const en = await open('en-US');
    expect([await textOf(en, '#start'), await textOf(en, '#open-settings')]).toEqual(['Start', 'Settings']);
    expect(await shown(en)).toMatchObject({ lang: 'en', title: 'Hyper Aim Training (Unofficial)' });
    const ja = await open('ja-JP');
    expect([await textOf(ja, '#start'), await textOf(ja, '#open-settings')]).toEqual(['開始', '設定']);
    expect(await shown(ja)).toMatchObject({ lang: 'ja', title: 'Hyper Aim Training（非公式）' });
  });

  it('UI-126・UI-131: 日本語の設定画面で言語の欄を English に変えると、読み込み直さずに英語になり、ほかの画面も英語で、再読み込みしても英語のまま', async () => {
    const page = await open('ja-JP', { hash: '#/settings' });
    await page.evaluate(`location.hash = '#/settings'; window.__notReloaded = true;`);
    await page.waitFor(`window.__vis(document.querySelector('[data-screen="settings"]'))`);
    const field = () =>
      page.evaluate<{ legend: string; label: string; options: string[]; value: string }>(`(() => {
        const s = document.querySelector('#setting-language');
        return { legend: document.querySelector('#settings-language legend').textContent.trim(), label: s.closest('label').firstChild.textContent.trim(),
          options: [...s.options].map((o) => o.textContent), value: s.value }; })()`);
    expect(await field()).toEqual({ legend: '言語 / Language', label: '言語 / Language', options: ['日本語', 'English'], value: 'ja' });
    expect(await textOf(page, '[data-screen="settings"] h2')).toBe('設定');
    // 入力方式の欄の値は、言語を変えても変わらない。
    await choose(page, '#setting-input-method', 'pad');
    await choose(page, '#setting-language', 'en');
    expect(await page.evaluate<boolean>('window.__notReloaded === true')).toBe(true);
    expect(await textOf(page, '[data-screen="settings"] h2')).toBe('Settings');
    expect(await shown(page)).toMatchObject({ lang: 'en', title: 'Hyper Aim Training (Unofficial)' });
    expect(await field()).toEqual({ legend: '言語 / Language', label: '言語 / Language', options: ['日本語', 'English'], value: 'en' });
    expect(await page.evaluate<string>(`document.querySelector('#setting-input-method').value`)).toBe('pad');
    expect(await japaneseIn(page)).toEqual([]);
    expect(await page.evaluate<string | null>(`localStorage.getItem('${LANGUAGE_KEY}')`)).toBe('en');

    await page.evaluate(`location.hash = '#/'`);
    await page.waitFor(`window.__vis(document.querySelector('[data-screen="top"]'))`);
    expect(await textOf(page, '#start')).toBe('Start');
    expect(await japaneseIn(page)).toEqual([]);
    await page.evaluate(`location.hash = '#/history'`);
    await page.waitFor(`window.__vis(document.querySelector('[data-screen="history"]'))`);
    expect(await textOf(page, '[data-screen="history"] h2')).toBe('History');
    expect(await japaneseIn(page)).toEqual([]);

    await reload(page);
    expect(await textOf(page, '#start')).toBe('Start');
    expect(await shown(page)).toMatchObject({ lang: 'en' });
  });

  it('UI-130: パッドだけでトップ画面から設定画面を開き、言語の欄を English に変えると英語になり、再読み込みしても英語のまま', async () => {
    const page = await open('ja-JP', { seed: { 'apex-training:analytics-consent': 'denied' } });
    // 十字キーの下で「設定」のリンクまで移り、A / × で開く。
    const focused = () => page.evaluate<string>(`document.querySelector('.pad-focus')?.id ?? ''`);
    for (let i = 0; i < 12 && (await focused()) !== 'open-settings'; i += 1) await press(page, DOWN);
    expect(await focused()).toBe('open-settings');
    await press(page, A);
    await page.waitFor(`location.hash === '#/settings'`);
    // 設定画面のいちばん上の項目は言語の欄。右で次の選択肢（English）にする。
    await press(page, DOWN);
    expect(await focused()).toBe('setting-language');
    await press(page, RIGHT);
    await page.waitFor(`document.documentElement.lang === 'en'`);
    expect(await textOf(page, '[data-screen="settings"] h2')).toBe('Settings');
    await reload(page);
    expect(await textOf(page, '#start')).toBe('Start');
  });

  it('UI-134・OVR-29: 保存できない環境で en-US なら保存できない旨が英語で出て、言語を選び直してもエラーで止まらずすぐ切り替わり、ほかの画面でもそのまま', async () => {
    const throwing = `Storage.prototype.setItem = function () { throw new DOMException('quota', 'QuotaExceededError'); };`;
    const page = await open('en-US', { init: throwing });
    const notice = () =>
      page.evaluate<{ shown: boolean; next: string }>(`(() => { const n = document.querySelector('#storage-notice');
        return { shown: window.__vis(n) ? n.textContent : '', next: n.nextElementSibling.textContent }; })()`);
    expect(await notice()).toEqual({ shown: STORAGE_EN, next: UNOFFICIAL_EN });
    await page.evaluate(`location.hash = '#/settings'`);
    await page.waitFor(`window.__vis(document.querySelector('[data-screen="settings"]'))`);
    await choose(page, '#setting-language', 'ja');
    expect(await textOf(page, '[data-screen="settings"] h2')).toBe('設定');
    expect((await notice()).shown).toBe('この環境では設定と記録を保存できません。練習はそのまま続けられます。');
    await choose(page, '#setting-language', 'en');
    expect(await textOf(page, '[data-screen="settings"] h2')).toBe('Settings');
    await page.evaluate(`location.hash = '#/history'`);
    await page.waitFor(`window.__vis(document.querySelector('[data-screen="history"]'))`);
    expect(await japaneseIn(page)).toEqual([]);
    expect(await notice()).toEqual({ shown: STORAGE_EN, next: UNOFFICIAL_EN });
    expect(page.errors).toEqual([]);
  });

  it('MODE-57: 英語のトップ画面のモードのカードは表の順と英語の説明で、フリックの練習の選択肢は英語で、日本語と同じ自己ベスト・履歴に保存される', async () => {
    const page = await open('en-US', { seed: { 'apex-training:analytics-consent': 'denied' } });
    const cards = await page.evaluate<{ name: string; description: string }[]>(`[...document.querySelectorAll('#mode-cards .card')].map((c) => ({
      name: c.querySelector('.card-name').textContent, description: c.querySelector('.card-description').textContent }))`);
    expect(cards).toEqual([
      { name: 'Recoil Drill', description: "Fire the same weapon's recoil again and again until the pattern is in your hands" },
      { name: 'Tracking', description: 'Keep your crosshair on a target moving left and right' },
      { name: 'Tracking + Recoil', description: 'Keep your crosshair on a moving target while controlling recoil' },
      { name: 'Flick', description: 'Snap to targets that appear at random spots and shoot fast' },
    ]);
    await choose(page, '#mode', 'flick');
    const fields = await page.evaluate<{ label: string; options: string[] }[]>(`[...document.querySelectorAll('#mode-options .choice')].filter((c) => window.__vis(c))
      .map((c) => ({ label: c.querySelector('span').textContent, options: [...c.querySelector('select').options].map((o) => o.textContent) }))`);
    expect(fields).toEqual([
      { label: 'Spawn range', options: ['Near', 'Normal', 'Far'] },
      { label: 'Target size', options: ['Large', 'Medium', 'Small'] },
    ]);
    // 日本語で保存した形のフリック（遠い・小、マウス）の自己ベストと履歴が、英語のトップ画面と履歴の画面にそのまま出る。
    const best = JSON.stringify({ version: 1, timePerHit: 0.523, meanTime: 0.6, hitRate: 90, hits: 18, targets: 20, meanError: 0.4, achievedAt: '2026-11-26T10:00:00.000Z' });
    const history = JSON.stringify({ version: 1, entries: [{ at: '2026-11-26T10:00:00.000Z', timePerHit: 0.523, meanTime: 0.6, hitRate: 90, hits: 18, targets: 20, meanError: 0.4 }] });
    const seeded = await open('en-US', {
      seed: { 'apex-training:analytics-consent': 'denied', [FLICK_BEST]: best, [FLICK_HISTORY]: history, 'apex-training:settings:common': JSON.stringify({ inputMethod: 'mouse' }) },
    });
    await choose(seeded, '#mode', 'flick');
    await choose(seeded, '#flick-range', 'far');
    await choose(seeded, '#flick-size', 'small');
    expect(await textOf(seeded, '#mode-cards .card[data-value="flick"] .card-best')).toBe('Personal best: 0.523 s');
    await seeded.evaluate(`location.hash = '#/history'`);
    await seeded.waitFor(`window.__vis(document.querySelector('[data-screen="history"]'))`);
    await choose(seeded, '#history-mode', 'flick');
    await choose(seeded, '#history-flick-range', 'far');
    await choose(seeded, '#history-flick-size', 'small');
    const rows = await seeded.evaluate<string[]>(`[...document.querySelectorAll('#history-list td[data-field]')].map((td) => td.textContent)`);
    expect(rows).toEqual(['0.523 s', '0.600 s', '90.0%', '0.40°']);
    expect(await seeded.evaluate<string[]>(`[...document.querySelector('#history-flick-range').options].map((o) => o.textContent)`)).toEqual(['Near', 'Normal', 'Far']);
    expect(await seeded.evaluate<Record<string, string | null>>(`({ best: localStorage.getItem('${FLICK_BEST}'), history: localStorage.getItem('${FLICK_HISTORY}') })`)).toEqual({ best, history });
  });

  it('UI-127・UI-129・OVR-28: 英語のとき、全画面と同意の案内に日本語の文字がなく、フッターは英語の非公式の表記で、フリックのシェアの文が英語の形', async () => {
    const page = await open('en-US');
    const footer = () => textOf(page, '.footer .unofficial');
    const noJapanese = async (where: string) => expect(await japaneseIn(page), where).toEqual([]);

    // トップ画面（同意の案内を含む）。
    expect(await page.evaluate<boolean>(`window.__vis(document.querySelector('#consent-banner'))`)).toBe(true);
    await noJapanese('top');
    expect(await footer()).toBe(UNOFFICIAL_EN);
    for (const [hash, screen] of [
      ['#/settings', 'settings'],
      ['#/history', 'history'],
      ['#/settings/pad', 'settings-pad'],
      ['#/settings/pad/mapping', 'settings-pad-mapping'],
    ] as const) {
      await page.evaluate(`location.hash = '${hash}'`);
      await page.waitFor(`window.__vis(document.querySelector('[data-screen="${screen}"]'))`);
      await page.advanceClock(2 / 60);
      await noJapanese(screen);
      expect(await footer()).toBe(UNOFFICIAL_EN);
    }
    // 標準配置でないパッドのボタン割り当て画面。
    await page.evaluate(`window.__pad.mapping = ''`);
    await page.advanceClock(2 / 60);
    await page.waitFor(`window.__vis(document.querySelector('#mapping-body'))`);
    await noJapanese('settings-pad-mapping (nonstandard)');
    await page.evaluate(`window.__pad.mapping = 'standard'`);
    await page.advanceClock(2 / 60);
    expect(await page.evaluate<boolean>(`window.__vis(document.querySelector('#consent-banner'))`)).toBe(true);
    await page.clickSelector('#consent-deny');
    await page.waitFor(`!window.__vis(document.querySelector('#consent-banner'))`);

    // 反復練習の練習中と、回数 5 の短いリザルト、1 回目で B / ○ でやめたセットのまとめ。
    await startPractice(page, 'ghost', { count: '5' });
    await page.evaluate(`window.__btn(${R2}, true)`);
    await page.advanceClock(0.3);
    await noJapanese('play (Recoil Drill)');
    await fireUntil(page, `window.__vis(document.querySelector('#interlude'))`);
    await noJapanese('interlude');
    await press(page, B);
    await page.waitFor(`location.hash === '#/set-result'`);
    await page.waitFor(`window.__vis(document.querySelector('[data-screen="set-result"]'))`);
    await noJapanese('set-result');
    expect(await footer()).toBe(UNOFFICIAL_EN);

    // 反復練習のリザルト画面（パッドの入力推移のグラフを含む）。
    await startPractice(page, 'ghost');
    await fireUntil(page, `location.hash === '#/result'`);
    await page.waitFor(`window.__vis(document.querySelector('[data-screen="result"]'))`);
    await noJapanese('result (Recoil Drill)');
    expect(await footer()).toBe(UNOFFICIAL_EN);

    // 追いエイムの練習中。
    await startPractice(page, 'tracking');
    await page.advanceClock(1);
    await noJapanese('play (Tracking)');

    // フリックの練習中とリザルト画面のシェアの文。
    await startPractice(page, 'flick', { options: { 'flick-range': 'far', 'flick-size': 'small' } });
    await page.advanceClock(1.2);
    expect(await textOf(page, '[data-hud="mode"]')).toBe('Targets: 0 / 20');
    await noJapanese('play (Flick)');
    for (let i = 0; i < 25 && (await page.evaluate<string>('location.hash')) !== '#/result'; i += 1) {
      await press(page, R2);
      await page.advanceClock(0.5);
    }
    await page.advanceClockUntil(`location.hash === '#/result'`, { step: 1 / 60, limit: 5 });
    await page.waitFor(`window.__vis(document.querySelector('[data-screen="result"]'))`);
    await noJapanese('result (Flick)');
    // シェアの機能もクリップボードも使えないときは、シェアの文を読み取り専用の欄に出す。
    await page.evaluate(`Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });`);
    await page.evaluate(`document.querySelector('#result-share').click()`);
    await page.waitFor(`window.__vis(document.querySelector('#result-share-text'))`);
    const lines = (await page.evaluate<string>(`document.querySelector('#result-share-text').value`)).split('\n');
    expect(lines[0]).toBe('Hyper Aim Training (unofficial fan tool) result');
    expect(lines[1]).toBe('Mode: Flick / Spawn range: Far / Target size: Small');
    expect(lines[2]).toMatch(/^Time per hit: (\d+\.\d{3} s|N\/A) \/ Hit rate: \d+\.\d%$/);
    await noJapanese('result (Flick, share)');
  });

  it('UI-133: 日本語で反復練習を 1 回終えて保存した履歴は、英語に変えたあとの履歴の画面にそのまま出て、モードの名前と指標の名前が英語', async () => {
    const page = await open('ja-JP', { seed: { 'apex-training:analytics-consent': 'denied' } });
    await choose(page, '#weapon', 'lstar');
    await page.evaluate(`location.hash = '#/'`);
    await page.clickSelector('#start');
    await untilPracticing(page);
    await fireUntil(page, `location.hash === '#/result'`);
    const history = () =>
      page.evaluate<{ mode: string; heads: string[]; cells: string[] }>(`(() => {
        const s = document.querySelector('#history-mode');
        return { mode: s.options[s.selectedIndex].textContent, heads: [...document.querySelectorAll('#history-list th')].map((th) => th.textContent),
          cells: [...document.querySelectorAll('#history-list td')].slice(1).map((td) => td.textContent) }; })()`);
    await page.evaluate(`location.hash = '#/history'`);
    await page.waitFor(`document.querySelectorAll('#history-list tr[data-round]').length === 1`);
    const ja = await history();
    expect(ja.mode).toBe('反復練習');
    expect(ja.heads).toEqual(['回', '終えた日時', '平均ズレ', '命中率', 'グルーピング半径']);
    const stored = await page.evaluate<string | null>(`localStorage.getItem('apex-training:history:pad:lstar:ghost')`);

    await page.evaluate(`location.hash = '#/settings'`);
    await page.waitFor(`window.__vis(document.querySelector('[data-screen="settings"]'))`);
    await choose(page, '#setting-language', 'en');
    await page.evaluate(`location.hash = '#/history'`);
    await page.waitFor(`document.querySelector('[data-screen="history"] h2').textContent === 'History' && document.querySelectorAll('#history-list tr[data-round]').length === 1`);
    const en = await history();
    expect(en.mode).toBe('Recoil Drill');
    expect(en.heads).toEqual(['#', 'Finished at', 'Avg. error', 'Hit rate', 'Grouping radius']);
    expect(en.cells).toEqual(ja.cells);
    expect(await page.evaluate<string | null>(`localStorage.getItem('apex-training:history:pad:lstar:ghost')`)).toBe(stored);
  });

  it('UI-128: 英語で L-STAR の反復練習を 1 回練習して自己ベストを更新したシェアの文は、英語のシェアの文の形', async () => {
    const page = await open('en-US', { seed: { 'apex-training:analytics-consent': 'denied' } });
    await choose(page, '#weapon', 'lstar');
    await startPractice(page, 'ghost');
    await fireUntil(page, `location.hash === '#/result'`);
    await page.evaluate(`Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } } });`);
    await page.evaluate(`document.querySelector('#result-share').click()`);
    await page.waitFor(`typeof window.__copied === 'string'`);
    expect(await textOf(page, '#result-share-message')).toBe('Copied');
    const lines = (await page.evaluate<string>('window.__copied')).split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('Hyper Aim Training (unofficial fan tool) result');
    expect(lines[1]).toBe('Weapon: L-STAR / Mode: Recoil Drill');
    expect(lines[2]).toMatch(/^Avg\. error: \d+\.\d{2}° \/ Hit rate: \d+\.\d%$/);
    expect(lines[3]).toBe('New personal best!');
    expect(lines[4]).toBe('https://cocoiti.github.io/apex-training/');
  });
});
