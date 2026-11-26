// docs/spec/modes.md（MODE-5〜MODE-11）、docs/spec/screens.md（UI-1・UI-10）と
// docs/spec/weapons.md（WPN-1・WPN-2・WPN-3 のトップ画面の部分）の受け入れテスト。WPN-21 は measured-weapons-qa が確かめる。
// 公開された入口（ビルドの結果を /apex-training/ で配信した画面、武器の JSON、モードの共通の型）だけを使い、実装の内部には依存しない。
// 画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、パッドは Gamepad API（navigator.getGamepads）の形で与える。
// 弾痕は、撃つ前と撃ったあと（リコイルが戻りきってから）の画面写しの差として読む（tests/helpers/png.ts）。
// MODE-5・WPN-1・WPN-2 はリポジトリの写しにモードのファイルと武器の JSON を足してビルドし、その画面で確かめる。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, waitUntil, type AppUrlOptions, type Browser, type Page } from '../helpers/browser';
import { decodePng, type Image } from '../helpers/png';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const WIDTH = 1280;
const HEIGHT = 800;
const chromium = findChromium();

/** SPEC の値（実装の定数には依存しない）。 */
const IDLE_END = 2; // 撃たない時間でリザルトに移るまでの秒数
const RECOVERY = 0.5; // リコイルの戻りの時間

interface WeaponJson {
  id: string;
  name: string;
  category: string;
  rpm: number;
  magSize: number;
  randomness: number;
  pattern: { dx: number; dy: number }[];
  measured: boolean;
}

const WEAPON_FILES: WeaponJson[] = readdirSync(join(ROOT, 'src/data/weapons'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(ROOT, 'src/data/weapons', f), 'utf8')) as WeaponJson);
/** 武器の一覧（weapons.md）: 計測した武器データ（measured が true）だけ。 */
const WEAPONS = WEAPON_FILES.filter((w) => w.measured === true);
const byName = (name: string) => {
  const w = WEAPONS.find((x) => x.name === name);
  if (!w) throw new Error(`武器がない: ${name}`);
  return w;
};

type RGB = [number, number, number];
const distance = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---------------------------------------------------------------------------
// 画面の操作
// ---------------------------------------------------------------------------

/** Gamepad API の形の、標準配置のパッド 1 台。右スティックは軸 2・3、R2 はボタン 7。 */
const FAKE_PAD = `
  // ページの時計（ミリ秒）。clock=manual で開いたページはテストが進める時計、そうでなければ performance.now。
  window.__now = () => (window.__apexTestClock ? window.__apexTestClock.now() * 1000 : performance.now());
  // 次の描画まで進める。clock=manual なら時計を 60Hz の 1 描画分（1/60 秒）進めて描画し、そうでなければ次の描画を待つ。
  window.__frame = () => (window.__apexTestClock ? (window.__apexTestClock.advance(1 / 60, 1 / 60), Promise.resolve())
    : new Promise((r) => requestAnimationFrame(r)));
  window.__pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) };
  // __pulse: 次に読まれた 1 回だけ R2 を押した値にし、その次に読まれたときは離した値にする（読まれた時刻を __pulseAt に残す）。
  window.__pulse = 0;
  window.__pulseAt = [];
  navigator.getGamepads = () => {
    const buttons = window.__pad.buttons.map((b) => ({ ...b }));
    if (window.__pulse === 1) { buttons[7] = { value: 1, pressed: true, touched: true }; window.__pulse = 2; window.__pulseAt = [window.__now()]; }
    else if (window.__pulse === 2) { window.__pulse = 0; window.__pulseAt.push(window.__now()); }
    return [{ id: 'acceptance pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard',
      timestamp: window.__now(), axes: window.__pad.axes.map((v, i) => (i === 2 && window.__now() < window.__stickUntil ? window.__stickX : v)), buttons, vibrationActuator: null }];
  };
  // __tiltRight(x, ms): 右スティックを右へ x だけ、ページの時計で ms ミリ秒のあいだ倒す（そのあとは戻した値を返す）。
  window.__stickUntil = 0; window.__stickX = 0;
  window.__tiltRight = (x, ms) => { window.__stickX = x; window.__stickUntil = window.__now() + ms; };
  window.__setR2 = (v) => { window.__pad.buttons[7] = { value: v, pressed: v >= 0.5, touched: v > 0 }; };
  addEventListener('hashchange', () => {
    if (location.hash === '#/result') window.__resultAt = window.__now();
  });
  window.__releasedAt = undefined;
  // __simTime(): HUD の経過時間（練習の時計、秒）。撃たない時間やリコイルの戻りは練習の時計で進むので、待つ条件はこれで決める。
  window.__simTime = () => { const m = (document.querySelector('[data-hud="time"]')?.textContent ?? '').match(/[\\d.]+/); return m ? Number(m[0]) : NaN; };
  window.__releasedSim = undefined;
  window.__ammo = () => { const m = (document.querySelector('[data-hud="ammo"]')?.textContent ?? '').match(/\\d+/); return m ? Number(m[0]) : NaN; };
`;

/** newPage で開いたページの URL のクエリ（render=off・clock=manual）。 */
const urlOptions = new WeakMap<Page, AppUrlOptions>();

async function screenshot(page: Page): Promise<Image> {
  return decodePng(await page.screenshot());
}

/**
 * 離してから（ページの時計で）リコイルの戻りの時間が過ぎ、そのあと描画されてからの画面写し。
 * 撃たない時間（2 秒）でリザルトに移る前に写すため、画面写しを何枚も撮って止まるのを待つことはしない。
 */
async function afterRecovery(page: Page): Promise<Image> {
  await sinceRelease(page, (RECOVERY + 0.2) * 1000);
  await page.frames(2);
  return screenshot(page);
}

/**
 * 練習の時計（HUD の経過時間）で、離してから ms ミリ秒たつまで待つ。練習が終わると練習の時計は止まるので、
 * プレイ画面から移ったときも待つのをやめる（続く画面の確認で失敗する）。
 */
const sinceRelease = (page: Page, ms: number) =>
  until(page, `location.hash !== '#/play' || (window.__releasedSim !== undefined && window.__simTime() - window.__releasedSim >= ${ms / 1000})`, ms + 10_000);

/** clock=manual で開いたページで練習の時間を決めているテストの開き方（3D は描画しない）。 */
const MANUAL = { render: false, manualClock: true };

/**
 * ページの式が真になるまで待つ。clock=manual で開いたページはページの時計を進め（実時間では待たない）、
 * そうでないページは実際の描画を待つ。
 */
async function until(page: Page, expression: string, timeout = 10_000) {
  if (await page.evaluate<boolean>('!!window.__apexTestClock')) await page.advanceClockUntil(expression);
  else await page.waitFor(expression, timeout);
}

/** ページの時計の今の時刻（秒）。 */
const clockNow = (page: Page) => page.evaluate<number>('window.__now() / 1000');

const hash = (page: Page) => page.evaluate<string>('location.hash');
const ammo = (page: Page) => page.evaluate<number>('window.__ammo()');
const hudText = (page: Page, key: string) => page.evaluate<string>(`document.querySelector('[data-hud="${key}"]')?.textContent ?? ''`);

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

/** トップ画面を開き、武器とモードを選んで「開始」を押し、プレイ画面になるまで待つ。 */
async function start(page: Page, origin: string, weapon: string, mode: string) {
  await page.goto(appUrl(origin, BASE, '#/', urlOptions.get(page)));
  await page.waitFor(`!document.querySelector('[data-screen="top"]').hidden && document.querySelector('#weapon').options.length > 0 && document.querySelector('#mode').options.length > 0`);
  await choose(page, '#weapon', weapon);
  await choose(page, '#mode', mode);
  await page.clickSelector('[data-screen="top"] a[href="#/play"]');
  await page.waitFor(`location.hash === '#/play' && !document.querySelector('[data-screen="play"]').hidden && window.__ammo() > 0`);
  // 練習のシーンが何度か描画されるまで待つ。
  await page.frames(5);
}

/** HTML の画面を見えなくし、キャンバスだけを写す（HUD の文字は textContent で読める）。 */
async function hideHtml(page: Page) {
  await page.evaluate(`for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.visibility = 'hidden'`);
  // 隠した状態で描画し直されるまで待つ。
  await page.frames(2);
}

/**
 * R2 を、パッドが 1 回読まれるあいだだけ押す。押す前と離したあとの残弾と、押していた時間（秒、パッドが読まれた時刻の差）を返す。
 * 発射は時間で判定するので、押していた時間が発射間隔より長いと 2 発以上撃つ（描画が遅いとき）。
 */
async function tap(page: Page): Promise<{ before: number; after: number; held: number }> {
  const r = await page.evaluate<{ before: number; held: number }>(`(async () => {
    const before = window.__ammo(); window.__pulse = 1; const t0 = performance.now();
    while (window.__pulse !== 0 && performance.now() - t0 < 3000) await window.__frame();
    window.__releasedAt = window.__now(); window.__releasedSim = window.__simTime();
    return { before, held: (window.__pulseAt[1] - window.__pulseAt[0]) / 1000 }; })()`);
  // 撃った弾が HUD の残弾に出るまで待つ（離したことを読んだ描画で HUD も書き換わっている）。
  await until(page, `window.__ammo() < ${r.before} || location.hash !== '#/play'`);
  return { ...r, after: await ammo(page) };
}

/** 1 発だけ撃てたと言える押していた時間か（発射間隔より、固定ステップの刻みの分の余裕を持って短い）。 */
const singleShot = (w: WeaponJson, held: number) => held < 60 / w.rpm - 0.02;

/** R2 を押し続け、残弾が left 以下になったら離す。離したときの残弾を返す。 */
async function holdUntil(page: Page, left: number): Promise<number> {
  return page.evaluate<number>(`(async () => {
    window.__setR2(1); const t0 = performance.now();
    while (!(window.__ammo() <= ${left}) && location.hash === '#/play' && performance.now() - t0 < 15000) await window.__frame();
    window.__setR2(0); window.__releasedAt = window.__now(); window.__releasedSim = window.__simTime(); return window.__ammo(); })()`);
}

// ---------------------------------------------------------------------------
// 画面写しの比較
// ---------------------------------------------------------------------------

/** 2 枚の画面写しで色が変わった画素。 */
function changedPixels(a: Image, b: Image, tol = 40): [number, number][] {
  const out: [number, number][] = [];
  for (let y = 0; y < a.height; y += 1) for (let x = 0; x < a.width; x += 1) if (distance(a.pixel(x, y), b.pixel(x, y)) > tol) out.push([x, y]);
  return out;
}

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('練習モードの画面', () => {
  const temps: string[] = [];
  let site = '';
  let mainDist = '';
  let copyDist = '';
  let copyBuild = { status: null as number | null, output: '' };
  let firstCopyDist = '';
  let firstCopyBuild = { status: null as number | null, output: '' };
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  /** 配信する中身を切り替える（site はビルドの結果へのシンボリックリンク）。 */
  const serveDist = (dir: string) => {
    if (existsSync(site)) unlinkSync(site);
    symlinkSync(dir, site, 'dir');
  };
  /** 新しいタブ。options は start で開く URL のクエリ（既定は描画し、実時間で進む）。 */
  const newPage = async (options: AppUrlOptions = {}) => {
    const page = await browser!.newPage();
    await page.addInitScript(FAKE_PAD);
    urlOptions.set(page, options);
    return page;
  };
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));

  beforeAll(async () => {
    const work = mkdtempSync(join(tmpdir(), 'modes-acc-'));
    temps.push(work);
    mainDist = join(work, 'main-dist');
    const build = spawnSync(`npm run build -- --outDir "${mainDist}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`ビルドが失敗した:\n${build.stdout}${build.stderr}`);

    // MODE-5・WPN-1・WPN-2: リポジトリの写しにモードのファイルと武器の JSON を足してビルドする。
    const copy = join(work, 'copy');
    for (const entry of ['src', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'eslint.config.js', 'scripts']) {
      if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
    }
    symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), 'dir');
    writeFileSync(join(copy, 'src/modes/recoil/acceptance-extra.ts'), EXTRA_MODE);
    writeFileSync(join(copy, 'src/data/weapons/acceptance-new.json'), JSON.stringify(NEW_WEAPON, null, 2));
    const noRpm: Record<string, unknown> = { ...NEW_WEAPON, id: 'acceptance-no-rpm', name: '受け入れ-rpmなし' };
    delete noRpm.rpm;
    writeFileSync(join(copy, 'src/data/weapons/acceptance-no-rpm.json'), JSON.stringify(noRpm, null, 2));
    copyDist = join(work, 'copy-dist');
    const r = spawnSync(`npm run build -- --outDir "${copyDist}" --emptyOutDir`, {
      cwd: copy,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, APEX_ACCEPTANCE_NESTED: '1', FORCE_COLOR: '0' },
    });
    copyBuild = { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    // MODE-5: 同じ写しの足したモードのファイルを、並び順が反復練習より前のものに書き換えてもう一度ビルドする（足したファイルは 1 つのまま）。
    writeFileSync(join(copy, 'src/modes/recoil/acceptance-extra.ts'), EXTRA_MODE.replace('order: 100000', 'order: -100000'));
    firstCopyDist = join(work, 'copy-first-dist');
    const r2 = spawnSync(`npm run build -- --outDir "${firstCopyDist}" --emptyOutDir`, {
      cwd: copy,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, APEX_ACCEPTANCE_NESTED: '1', FORCE_COLOR: '0' },
    });
    firstCopyBuild = { status: r2.status, output: `${r2.stdout ?? ''}${r2.stderr ?? ''}` };

    site = join(work, 'site');
    serveDist(mainDist);
    server = await serveStatic(site, BASE);
    origin = originOf(server);
    browser = await launchBrowser(chromium!);
  }, 300_000);

  // テストが終わるたびに開いたタブを閉じ、裏で描画し続けるタブを残さない。

  afterEach(async () => {

    await browser?.closePages();

  });


  afterAll(async () => {
    await browser?.close();
    await new Promise((ok) => (server ? server.close(ok) : ok(undefined)));
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  describe('トップ画面', () => {
    it('UI-10 / WPN-3: 武器の選択肢が category ごとにまとめて表示され、一覧のすべての武器（L-STAR と C.A.R. SMG の 2 つだけ）が選択肢に出る', async () => {
      serveDist(mainDist);
      const page = await newPage();
      await page.goto(`${origin}${BASE}#/`);
      await page.waitFor(`document.querySelector('#weapon').options.length > 0`);
      const groups = await page.evaluate<{ label: string; names: string[] }[]>(`[...document.querySelector('#weapon').children].map((g) => ({
        label: g.tagName === 'OPTGROUP' ? g.label : '', names: g.tagName === 'OPTGROUP' ? [...g.children].map((o) => o.textContent.trim()) : [g.textContent.trim()] }))`);
      // すべてが category の見出しの下にある。
      expect(groups.every((g) => g.label !== ''), JSON.stringify(groups)).toBe(true);
      // 見出しは category ごとに 1 つ。
      const categories = [...new Set(WEAPONS.map((w) => w.category))].sort();
      expect(groups.map((g) => g.label).sort()).toEqual(categories);
      // 各見出しの下は、その category の武器ちょうど。
      for (const g of groups) {
        expect(g.names.slice().sort(), g.label).toEqual(WEAPONS.filter((w) => w.category === g.label).map((w) => w.name).sort());
      }
      // 一覧のすべての武器が 1 回ずつ出る。WPN-3: L-STAR と C.A.R. SMG の 2 つだけが出て、仮データの 5 つは出ない。
      const all = groups.flatMap((g) => g.names);
      expect(all.slice().sort()).toEqual(WEAPONS.map((w) => w.name).sort());
      expect(all.slice().sort()).toEqual(['C.A.R. SMG', 'L-STAR']);
      for (const name of ['R-301', 'R-99', 'フラットライン', 'ボルト', 'スピットファイア']) expect(all).not.toContain(name);
      // 選べる武器は 1 つ。
      expect(await page.evaluate<boolean>(`!document.querySelector('#weapon').multiple`)).toBe(true);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('UI-1: 武器を選んで「開始」を押すと、プレイ画面になり、選んだ武器名が HUD に表示される（すべての武器）', async () => {
      serveDist(mainDist);
      const page = await newPage();
      for (const w of WEAPONS) {
        for (const mode of ['反復練習']) {
          await start(page, origin, w.name, mode);
          expect(await hash(page)).toBe('#/play');
          expect(await hudText(page, 'weapon'), `${w.name} / ${mode}`).toContain(w.name);
          for (const other of WEAPONS.filter((x) => x !== w && !x.name.includes(w.name) && !w.name.includes(x.name))) {
            expect(await hudText(page, 'weapon')).not.toContain(other.name);
          }
        }
      }
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  describe('MODE-5 / WPN-1 / WPN-2: 写しにモードのファイルと武器の JSON を足してビルドしたトップ画面', () => {
    it('写しのビルドが通る', () => {
      expect(copyBuild.status, copyBuild.output).toBe(0);
    });

    it('MODE-5: 足したモードで、ほかのファイルを変えずにモードの選択肢が出て、反復練習と足したモードが並び順の順に並ぶ', async () => {
      serveDist(copyDist);
      const page = await newPage();
      await page.goto(`${origin}${BASE}#/`);
      await page.waitFor(`document.querySelector('#mode').options.length > 0`);
      const modes = await page.evaluate<string[]>(`[...document.querySelector('#mode').options].map((o) => o.textContent.trim())`);
      expect(modes).toEqual(['反復練習', '追いエイム', '追いエイム＋リコイル', '受け入れの追加モード']);
      // モードが 2 つ以上なので、選択肢の欄が見えている。
      expect(await page.evaluate<boolean>(`document.querySelector('#mode').getClientRects().length > 0 && !document.querySelector('#mode').closest('[hidden]')`)).toBe(true);
      // 足したモードで練習を始められる。
      await start(page, origin, 'L-STAR', '受け入れの追加モード');
      expect(await hash(page)).toBe('#/play');
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('MODE-5: 足したモードの並び順が反復練習より小さいときは、足したモードが反復練習の前に並び、開いたときに選ばれている', async () => {
      expect(firstCopyBuild.status, firstCopyBuild.output).toBe(0);
      serveDist(firstCopyDist);
      const page = await newPage();
      await page.goto(`${origin}${BASE}#/`);
      await page.waitFor(`document.querySelector('#mode').options.length > 0`);
      const modes = await page.evaluate<string[]>(`[...document.querySelector('#mode').options].map((o) => o.textContent.trim())`);
      expect(modes).toEqual(['受け入れの追加モード', '反復練習', '追いエイム', '追いエイム＋リコイル']);
      expect(await page.evaluate<boolean>(`document.querySelector('#mode').getClientRects().length > 0 && !document.querySelector('#mode').closest('[hidden]')`)).toBe(true);
      // 開いたときは並び順の最初のモードが選ばれている（screens.md「トップ画面」）。
      expect(await page.evaluate<string>(`document.querySelector('#mode').selectedOptions[0]?.textContent.trim() ?? ''`)).toBe('受け入れの追加モード');
      // 反復練習も選んで始められる。
      await start(page, origin, 'L-STAR', '反復練習');
      expect(await hash(page)).toBe('#/play');
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('WPN-1 / WPN-2: 足した武器はその category の下に出て、rpm が欠けた武器は出ず、ファイル名と rpm がコンソールに出る', async () => {
      serveDist(copyDist);
      const page = await newPage();
      await page.goto(`${origin}${BASE}#/`);
      await page.waitFor(`document.querySelector('#weapon').options.length > 0`);
      // rpm が欠けた武器の知らせがコンソールに出るまで待つ。
      await waitUntil(() => page.errors.some((e) => e.includes('acceptance-no-rpm')), 'rpm が欠けた武器のファイル名がコンソールに出る');
      const groups = await page.evaluate<{ label: string; names: string[] }[]>(`[...document.querySelectorAll('#weapon optgroup')].map((g) => ({
        label: g.label, names: [...g.children].map((o) => o.textContent.trim()) }))`);
      const accGroup = groups.find((g) => g.label === NEW_WEAPON.category);
      expect(accGroup?.names, JSON.stringify(groups)).toEqual([NEW_WEAPON.name]);
      const all = groups.flatMap((g) => g.names);
      expect(all).not.toContain('受け入れ-rpmなし');
      for (const w of WEAPONS) expect(all).toContain(w.name);
      const log = page.errors.join('\n');
      expect(log).toContain('acceptance-no-rpm');
      expect(log).toContain('rpm');
    }, 60_000);

  });

  // -------------------------------------------------------------------------
  describe('練習の終わり', () => {
    it.each(WEAPONS.map((w) => [w.name, w] as const))('MODE-6: %s で 1 マガジンを撃ち切ると、リザルト画面に移る', async (_name, w) => {
      serveDist(mainDist);
      const page = await newPage(MANUAL);
      await start(page, origin, w.name, '反復練習');
      const t0 = await clockNow(page);
      // R2 を押し続ける。残弾 0 になってもそのまま。
      await page.evaluate(`window.__setR2(1)`);
      await until(page, `location.hash === '#/result'`, 20_000);
      const elapsed = (await clockNow(page)) - t0;
      await page.evaluate(`window.__setR2(0)`);
      expect(await page.evaluate<boolean>(`!document.querySelector('[data-screen="result"]').hidden && document.querySelector('[data-screen="play"]').hidden`)).toBe(true);
      // 撃ち切るまで（magSize - 1 回の発射間隔）より前には移らない。撃たない時間（2 秒）を待たずに移る。
      const fireTime = ((w.magSize - 1) * 60) / w.rpm;
      expect(elapsed).toBeGreaterThanOrEqual(fireTime * 0.9);
      expect(elapsed).toBeLessThan(fireTime + IDLE_END);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('MODE-6: 撃ち切る直前（残弾が残っているあいだ）はプレイ画面のまま', async () => {
      serveDist(mainDist);
      const page = await newPage(MANUAL);
      const w = byName('L-STAR');
      await start(page, origin, w.name, '反復練習');
      const left = await holdUntil(page, 3);
      expect(left).toBeGreaterThan(0);
      expect(await hash(page)).toBe('#/play');
    }, 60_000);

    it('MODE-7: 撃って離し、2 秒たつ前に押し直すとプレイ画面のまま残弾から続けて撃て、離して 2 秒撃たないとリザルト画面に移る', async () => {
      serveDist(mainDist);
      const page = await newPage(MANUAL);
      // 発射間隔が長め（600 rpm）の武器。離した描画のあいだに次の弾が出にくい。
      const w = byName('L-STAR');
      await start(page, origin, w.name, '反復練習');
      const first = await holdUntil(page, w.magSize - 5);
      expect(first).toBeLessThan(w.magSize);
      // 離してから 1.5 秒（2 秒たつ前）。ページの時計で測る。
      await sinceRelease(page, 1500);
      expect(await hash(page)).toBe('#/play');
      expect(await ammo(page)).toBe(first);
      // 押し直すと残弾から続けて撃つ（装弾数に戻らない）。
      const again = await tap(page);
      expect(again.before).toBe(first);
      expect(again.after).toBeLessThan(first);
      if (singleShot(w, again.held)) expect(again.after).toBe(first - 1);
      const second = again.after;
      // もう一度 1.5 秒待っても（最初に離してからは 3 秒以上）プレイ画面のまま。
      await sinceRelease(page, 1500);
      expect(await hash(page)).toBe('#/play');
      expect(await ammo(page)).toBe(second);
      // 離してから 2 秒撃たないと、リザルト画面に移る。
      await until(page, `location.hash === '#/result'`);
      const idle = await page.evaluate<number>(`(window.__resultAt - window.__releasedAt) / 1000`);
      expect(idle).toBeGreaterThanOrEqual(IDLE_END - 0.2);
      expect(idle).toBeLessThan(IDLE_END + 1);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('MODE-8: 練習を始めて 1 発も撃たずに 2 秒以上たっても、プレイ画面のまま', async () => {
      serveDist(mainDist);
      const page = await newPage(MANUAL);
      const w = byName('L-STAR');
      for (const mode of ['反復練習']) {
        await start(page, origin, w.name, mode);
        // 始めてから（練習の時計で）撃たない時間 + 2 秒たつまで待つ。
        await until(page, `window.__simTime() >= ${IDLE_END + 2}`, 20_000);
        expect(await hash(page), mode).toBe('#/play');
        expect(await page.evaluate<boolean>(`!document.querySelector('[data-screen="play"]').hidden`)).toBe(true);
        expect(await ammo(page)).toBe(w.magSize);
        // そのあと撃てる。
        const t = await tap(page);
        expect(t.before).toBe(w.magSize);
        expect(t.after).toBeLessThan(w.magSize);
      }
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('HUD', () => {
    it.each(WEAPONS.map((w) => [w.name, w] as const))('MODE-9: %s で始めると HUD の残弾が装弾数で、1 発撃つごとに 1 減る', async (_name, w) => {
      serveDist(mainDist);
      const page = await newPage(MANUAL);
      await start(page, origin, w.name, '反復練習');
      // 画面写しを使わないので、描画を軽くして 1 回の描画の間隔（押していた時間）を短くする。マシンが混んでいても 1 発で離しやすい。
      await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 200, deviceScaleFactor: 1, mobile: false });
      await page.waitFor(`document.querySelector('canvas').getBoundingClientRect().width === 320`);
      await page.frames(2);
      expect(await ammo(page)).toBe(w.magSize);
      expect(await hudText(page, 'ammo')).toContain(String(w.magSize));
      // 1 発ずつ撃つ。描画が遅く 1 発で離せなかった回（押していた時間が発射間隔を超えた回）は数えない。
      let expected = w.magSize;
      let verified = 0;
      for (let i = 0; i < 20 && verified < 4 && expected > 2; i += 1) {
        // 押し直しは、離してから（練習の時計で）発射間隔より長くたってから（間隔の内に押し直しても次の弾は出ない）。
        if (i > 0) await sinceRelease(page, 60_000 / w.rpm + 100);
        const t = await tap(page);
        expect(t.before).toBe(expected);
        expect(t.after, `${i + 1} 回目`).toBeLessThan(expected);
        if (singleShot(w, t.held)) {
          expect(t.after, `${i + 1} 回目（押していた時間 ${t.held} 秒）`).toBe(expected - 1);
          verified += 1;
        }
        expected = t.after;
      }
      expect(verified, '1 発だけ撃てた回').toBeGreaterThanOrEqual(3);
    }, 60_000);

    it('MODE-9: 押し続けたあいだも、HUD の残弾は 1 ずつ減り、撃った数だけ減る', async () => {
      serveDist(mainDist);
      const page = await newPage(MANUAL);
      const w = byName('L-STAR');
      await start(page, origin, w.name, '反復練習');
      const seen = await page.evaluate<number[]>(`(async () => {
        const seen = [window.__ammo()]; window.__setR2(1); const t0 = window.__now();
        while (window.__now() - t0 < 1500) { const a = window.__ammo(); if (a !== seen[seen.length - 1]) seen.push(a); await window.__frame(); }
        window.__setR2(0); return seen; })()`);
      expect(seen[0]).toBe(w.magSize);
      // 表示は減る一方。
      for (let i = 1; i < seen.length; i += 1) expect(seen[i]!).toBeLessThan(seen[i - 1]!);
      // 1.5 秒で撃つ数（押し始めに 1 発、以後 60 / rpm 秒ごと）だけ減る。
      const shots = w.magSize - seen[seen.length - 1]!;
      const expectedShots = Math.floor((1.5 * w.rpm) / 60) + 1;
      expect(Math.abs(shots - expectedShots)).toBeLessThanOrEqual(1);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('弾痕', () => {
    it('MODE-10: 撃った弾の弾痕は、練習が終わるまで壁と的の上に表示され続ける', async () => {
      serveDist(mainDist);
      const page = await newPage();
      const w = byName('C.A.R. SMG');
      await start(page, origin, w.name, '反復練習');
      await hideHtml(page);
      const base = await screenshot(page);
      const target = base.pixel(WIDTH / 2, HEIGHT / 2);
      const wall = base.pixel(WIDTH / 2 + 80, HEIGHT / 2);
      // 的の範囲（中心の色が続く範囲）。
      const onTarget = ([x, y]: [number, number]) => Math.abs(x - WIDTH / 2) <= 14 && Math.abs(y - HEIGHT / 2) <= 14;

      // 1 回目: 少し撃って離す（1 発目は的に、続く弾は的の上の壁に当たる）。
      await holdUntil(page, w.magSize - 8);
      const shot1 = changedPixels(base, await afterRecovery(page));
      expect(shot1.length).toBeGreaterThan(0);
      expect(shot1.some(onTarget), '的の上の弾痕').toBe(true);
      expect(shot1.some((p) => !onTarget(p) && distance(base.pixel(p[0], p[1]), wall) < 30), '壁の上の弾痕').toBe(true);
      expect(shot1.some((p) => distance(base.pixel(p[0], p[1]), target) < 30), '的の色の上の弾痕').toBe(true);

      // 2 回目以降: 2 秒たつ前に押し直して撃ち足す。前の弾痕は消えずに残る（時間がたっても）。
      let previous = shot1;
      for (let round = 0; round < 3; round += 1) {
        await tap(page);
        const now = changedPixels(base, await afterRecovery(page));
        expect(await hash(page)).toBe('#/play');
        const set = new Set(now.map(([x, y]) => y * WIDTH + x));
        const lost = previous.filter(([x, y]) => !set.has(y * WIDTH + x));
        // 新しい弾痕が重なって色が変わることはあるが、前の弾痕の画素が元の壁・的の色に戻ることはない。
        expect(lost.length, `消えた画素 ${JSON.stringify(lost.slice(0, 10))}`).toBe(0);
        previous = now;
      }
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('MODE-11: パッドで L-STAR を選んで（モードは反復練習）開始し、右スティックで照準を動かして R2 を押し続けると、弾痕が壁に残り、撃ち切るとリザルト画面に移る', async () => {
      serveDist(mainDist);
      const page = await newPage();
      const w = byName('L-STAR');
      await start(page, origin, w.name, '反復練習');
      await hideHtml(page);
      const base = await screenshot(page);
      const wall = base.pixel(WIDTH / 2 + 80, HEIGHT / 2);
      // 的の板の色: 中心の近くで、壁と違う色のうちいちばん多い色（リングの線の間に見える）。
      const counts = new Map<string, [[number, number, number], number]>();
      for (let dy = -12; dy <= 12; dy += 1) {
        for (let dx = -12; dx <= 12; dx += 1) {
          const c = base.pixel(WIDTH / 2 + dx, HEIGHT / 2 + dy);
          if (distance(c, wall) > 40) counts.set(c.join(','), [c, (counts.get(c.join(','))?.[1] ?? 0) + 1]);
        }
      }
      const target = [...counts.values()].sort((a, b) => b[1] - a[1])[0]![0];
      // 右スティックを右に少し倒して照準を動かす。中心から的が外れ、壁の上を向く。
      // 倒す時間はページの時計で決め（パッドがそのあいだだけ倒した値を返す）、戻したあと画面が止まるまで待つ。
      await page.evaluate(`window.__tiltRight(0.4, 150)`);
      await page.waitFor(`performance.now() >= window.__stickUntil`);
      const moved = decodePng(await page.stableScreenshot());
      expect(distance(moved.pixel(WIDTH / 2, HEIGHT / 2), target), '照準が動いた').toBeGreaterThan(30);
      expect(distance(moved.pixel(WIDTH / 2, HEIGHT / 2), wall), '照準は壁の上').toBeLessThan(20);
      // R2 を押し続ける。途中で、撃った弾の弾痕が壁に残っているかを見る（照準はそのまま）。
      await page.evaluate(`window.__setR2(1)`);
      await page.waitFor(`window.__ammo() <= ${w.magSize - 6}`, 10_000);
      // 押し続けたまま、まだ撃ち切っていないうちに写す。リコイルで画面は上にずれるので、壁の色と違う点を中心の縦の線の近くで探す。
      const during = await screenshot(page);
      expect(await hash(page)).toBe('#/play');
      /** 中心の縦の帯の中で、弾痕の色（黄、#ffd84a）に近い画素の数。壁・的・床・空には黄に近い色はない。 */
      const yellow: [number, number, number] = [0xff, 0xd8, 0x4a];
      const foreign = (img: Image) => {
        let n = 0;
        for (let y = 0; y < HEIGHT; y += 1) {
          for (let x = WIDTH / 2 - 40; x <= WIDTH / 2 + 40; x += 1) if (distance(img.pixel(x, y), yellow) < 60) n += 1;
        }
        return n;
      };
      // 対照: 撃つ前は、帯の中に弾痕の色がない（クロスヘアなどの HTML は隠している）。
      expect(foreign(moved)).toBe(0);
      const marks = foreign(during);
      expect(marks, '押し続けているあいだに壁に残った弾痕の画素').toBeGreaterThan(0);
      // 押し続けたまま撃ち切ると、リザルト画面に移る。
      await page.waitFor(`location.hash === '#/result'`, 15_000);
      await page.evaluate(`window.__setR2(0)`);
      expect(await page.evaluate<boolean>(`!document.querySelector('[data-screen="result"]').hidden`)).toBe(true);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });
});

/** MODE-5: 足すモードのファイル（共通の型 TrainingMode を default で export する）。並び順は反復練習のあと。 */
const EXTRA_MODE = `import type { TrainingMode } from '../types';

const mode: TrainingMode = {
  id: 'acceptance-extra',
  name: '受け入れの追加モード',
  category: 'recoil',
  order: 100000,
  setup() {},
  step() {
    return true;
  },
  result() {
    return {};
  },
  teardown() {},
};

export default mode;
`;

/** WPN-1: 足す武器（新しい category）。 */
const NEW_WEAPON = {
  id: 'acceptance-new',
  name: '受け入れ-新武器',
  category: 'ACC',
  version: 'S31-Cipher',
  source: '仮データ（受け入れテスト）',
  rpm: 600,
  magSize: 3,
  pattern: [
    { dx: 0.1, dy: 0.3 },
    { dx: -0.1, dy: 0.4 },
    { dx: 0.2, dy: 0.5 },
  ],
  randomness: 0,
  measured: true,
};
