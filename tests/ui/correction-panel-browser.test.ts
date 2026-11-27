// 補正のパネルのパターンの表示（docs/spec/screens.md「補正のパネル」の簡易のとき）を、ビルドした画面で確かめる。
// パッドは navigator.getGamepads を差し替えて与え、window.__pad のボタンをテストが変える。
// 画面は render=off・clock=manual で開き、撃つ時間はページの時計を進めて決める。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { simplePattern } from '../../src/sim/simple-pattern';
import { parseWeapon } from '../../src/sim/weapon';
import { segmentLabel } from '../../src/ui/correction-panel';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
/** ページを開く練習の乱数の種（docs/spec/architecture.md「テストのための乱数の種の固定」）。テストが失敗したときのメッセージにも出る。 */
const SEED = 12345;
const chromium = findChromium();
const R2 = 7;
/** 3D は描画せず（render=off）、ページの時計はテストから進める（clock=manual）。 */
const APP = { render: false, manualClock: true, seed: SEED };

const parsed = parseWeapon(JSON.parse(readFileSync(join(ROOT, 'src/data/weapons/lstar.json'), 'utf8')));
if (!parsed.ok) throw new Error('lstar.json を読めない');
const lstar = parsed.weapon;
const simple = simplePattern(lstar);

const PAD_INIT = `
  window.__pad = { buttons: [], axes: [0, 0, 0, 0] };
  const makePad = () => ({ id: 'panel-pad', index: 0, connected: true, mapping: 'standard', timestamp: performance.now(),
    axes: window.__pad.axes.slice(),
    buttons: Array.from({ length: 17 }, (_, i) => { const p = window.__pad.buttons.includes(i); return { value: p ? 1 : 0, pressed: p, touched: p }; }) });
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: function () { return [makePad(), null, null, null]; } });
`;

/** パネルの表示の今の様子。 */
interface PanelView {
  readonly visible: boolean;
  readonly viewBox: string | null;
  readonly idealCount: string | null;
  readonly legend: string;
  readonly segmentsHidden: boolean;
  readonly labels: string[];
  readonly current: string[];
  readonly shot: string | null;
  readonly dotVisibility: string | null;
}

const readPanel = (page: Page) =>
  page.evaluate<PanelView>(`(() => {
    const root = document.querySelector('[data-screen="play"] .correction-panel');
    const list = root.querySelector('.correction-panel-segments');
    const dot = root.querySelector('[data-panel="current"]');
    return {
      visible: !root.hidden,
      viewBox: root.querySelector('svg').getAttribute('viewBox'),
      idealCount: root.querySelector('[data-series="ideal"]').getAttribute('data-count'),
      legend: root.querySelector('[data-legend="ideal"]').textContent,
      segmentsHidden: list.hidden,
      labels: [...list.querySelectorAll('li')].map((li) => li.textContent),
      current: [...list.querySelectorAll('li.current')].map((li) => li.textContent),
      shot: dot.getAttribute('data-shot'),
      dotVisibility: dot.getAttribute('visibility'),
    };
  })()`);

describe.skipIf(NESTED || !chromium)('補正のパネルのパターンの表示', () => {
  let work = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';

  /** 設定を入れて L-STAR の反復練習を始め、パネルが出るまで待つ。 */
  async function startPractice(patternDisplay: 'detailed' | 'simple'): Promise<Page> {
    const page = await browser!.newPage();
    await page.addInitScript(PAD_INIT);
    await page.goto(appUrl(origin, BASE, '#/', APP));
    const common = JSON.stringify({ patternDisplay, inputMethod: 'pad' });
    await page.evaluate(`(() => { window.__beforeReload = true; localStorage.clear(); localStorage.setItem('apex-training:settings:common', ${JSON.stringify(common)}) })()`);
    await page.reload({ timeout: 15_000 });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && document.querySelector('#weapon').options.length > 0`, 15_000);
    await page.evaluate(`(() => {
      for (const [id, value] of [['weapon', 'lstar'], ['mode', 'ghost']]) {
        const s = document.getElementById(id); s.value = value; s.dispatchEvent(new Event('change', { bubbles: true }));
      } })()`);
    await page.clickSelector('#start');
    await page.waitFor(`!document.querySelector('[data-screen="play"] .correction-panel').hidden`, 15_000);
    return page;
  }

  /** R2 を押してページの時計を進め、パネルの次の発が shot 発目以降になった描画で離す。離したときの次の発（何発目か）を返す。 */
  async function fireUntil(page: Page, shot: number): Promise<number> {
    await page.evaluate(`window.__pad.buttons = [${R2}]`);
    await page.advanceClockUntil(`Number(document.querySelector('[data-panel="current"]').getAttribute('data-shot')) >= ${shot}`, { limit: 10 });
    await page.evaluate(`window.__pad.buttons = []`);
    // 離したあとに撃った弾があっても、残りの描画で止まった状態を読む。
    await page.advanceClock(10 / 60);
    return Number(await page.evaluate<string>(`document.querySelector('[data-panel="current"]').getAttribute('data-shot')`));
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'correction-panel-'));
    const dist = join(work, 'dist');
    const build = spawnSync(`npm run build -- --outDir "${dist}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8' });
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

  it('設定画面に「パターンの表示（補正のパネル）」の詳細 / 簡易の選択肢があり、既定は詳細', async () => {
    const page = await browser!.newPage();
    await page.goto(appUrl(origin, BASE, '#/', APP));
    await page.evaluate(`(() => { window.__beforeReload = true; localStorage.clear(); location.hash = '#/settings' })()`);
    await page.reload({ timeout: 15_000 });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && !document.querySelector('[data-screen="settings"]').hidden`, 15_000);
    const field = await page.evaluate<{ label: string; value: string; options: string[] }>(`(() => {
      const s = document.getElementById('setting-pattern-display');
      return { label: s.closest('label').firstChild.textContent.trim(), value: s.value, options: [...s.options].map((o) => o.textContent) };
    })()`);
    expect(field).toEqual({ label: 'パターンの表示（補正のパネル）', value: 'detailed', options: ['詳細', '簡易'] });
    await page.send('Page.close');
  });

  it('簡易では理想の線が簡易版の頂点の折れ線になり、区切りの言葉の強調が撃つごとに進み、範囲は詳細と同じ', async () => {
    const detailedPage = await startPractice('detailed');
    const detailed = await readPanel(detailedPage);
    expect(detailed.idealCount).toBe(String(lstar.magSize + 1));
    expect(detailed.legend).toBe('理想');
    expect(detailed.segmentsHidden).toBe(true);
    expect(detailed.labels).toEqual([]);
    await detailedPage.send('Page.close');

    const page = await startPractice('simple');
    const before = await readPanel(page);
    expect(before.idealCount).toBe(String(simple.segments.length + 1));
    expect(before.legend).toBe('理想（簡易）');
    expect(before.segmentsHidden).toBe(false);
    expect(before.labels).toEqual(simple.segments.map(segmentLabel));
    expect(before.shot).toBe('1');
    expect(before.current).toEqual([segmentLabel(simple.segments[0]!)]);
    expect(before.viewBox).toBe(detailed.viewBox);

    // 2 本目の区切りが受け持つ発まで撃つと、強調がその発を受け持つ区切りに移る。
    const second = simple.segments[1];
    if (second) {
      const shot = await fireUntil(page, second.from + 1);
      const owner = simple.segments.find((s) => s.from < shot && shot <= s.to);
      expect(owner).toBeDefined();
      expect((await readPanel(page)).current).toEqual([owner && segmentLabel(owner)]);
    }
    await page.evaluate(`window.__pad.buttons = [${R2}]`);
    await page.advanceClockUntil(`document.querySelector('[data-panel="current"]').getAttribute('visibility') === 'hidden'`, { limit: 15 });
    const after = await readPanel(page);
    expect(after.current).toEqual([]);
    await page.send('Page.close');
  });
});
