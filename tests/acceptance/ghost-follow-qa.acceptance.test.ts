// docs/spec/modes.md のゴースト追従の受け入れ条件（MODE-1・MODE-3・MODE-12〜MODE-15）と、docs/spec/screens.md の
// 設定を練習に当てる受け入れ条件（UI-4・UI-16・UI-17）の QA の受け入れテスト。
// 公開された入口だけを使う: ビルドの結果を /apex-training/ で配信した画面（トップ・設定・プレイ・リザルト）と、武器・マップの JSON。
// 画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、画面写しの画素を読んで確かめる（tests/helpers/png.ts）。
//
// ゴーストの見つけ方: ゴーストの色や形は SPEC にないので、HTML の画面を隠したキャンバスだけの画面写しを、ゴーストを出さない
// パターン観察の同じ時点の画面写しと比べ、違う画素をゴーストとみなす（色はその画素から求め、以後はその色でゴーストを探す）。
// ゴーストの画面上の位置: 照準を動かさないとき、カメラは「開始時の照準 + リコイルの累積」を、ゴーストは
// 「開始時の照準 + 次の弾の理想の補正軌道 + リコイルの累積」を向くので、ゴーストは画面の中心から理想の補正軌道の角度だけずれた位置に出る。
// 角度から画面上の位置への換算は screens.md の式（FOV 90・1280×800）。
//
// MODE-13 は randomness 0 の武器が要るため、リポジトリの写しに受け入れテスト用の武器（randomness 0・rpm 30・装弾数 5、
// pattern はマウスの 1 カウントの角度の整数倍）を足してビルドした画面で確かめる。照準はポインターロック中のマウスの移動
// （DevTools の mouseMoved の座標の差が movementX / movementY になる）で動かす。
// パッドは Gamepad API（navigator.getGamepads）の形で与え、R2 で撃つ。
// サーバーと DevTools のポートは OS に選ばせる（並行して動くほかの作業ツリーとぶつからないように）。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { findChromium, launchBrowser, serveStatic, type Browser, type Page } from '../helpers/browser';
import { decodePng, type Image } from '../helpers/png';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const WIDTH = 1280;
const HEIGHT = 800;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;
const chromium = findChromium();

/** SPEC の値（実装の定数には依存しない）。 */
const RECOVERY = 0.5; // 戻りの時間（weapons.md）
const IDLE_END = 2; // 撃たない時間でリザルトに移るまでの秒数（modes.md）
const DEG_PER_COUNT = 1.5 * 0.022; // 既定の感度 1.5 での 1 カウントの角度（mouse.md）

interface WeaponJson {
  id: string;
  name: string;
  category: string;
  rpm: number;
  magSize: number;
  randomness: number;
  pattern: { dx: number; dy: number }[];
}

const WEAPONS: WeaponJson[] = readdirSync(join(ROOT, 'src/data/weapons'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(ROOT, 'src/data/weapons', f), 'utf8')) as WeaponJson);
const byName = (name: string) => {
  const w = WEAPONS.find((x) => x.name === name);
  if (!w) throw new Error(`武器がない: ${name}`);
  return w;
};
const MVP_WEAPONS = ['R-301', 'R-99', 'フラットライン', 'ボルト', 'スピットファイア', 'L-STAR'];

const RANGE = JSON.parse(readFileSync(join(ROOT, 'src/data/maps/range.json'), 'utf8')) as {
  spawn: { position: [number, number, number]; yaw: number; pitch: number };
  boxes: { kind: string; center: [number, number, number]; size: [number, number, number] }[];
};

/** MODE-13: randomness 0 の受け入れテスト用の武器（rpm 30: 発射間隔 2 秒のあいだに照準を動かして写せるように）。pattern は 1 カウントの角度（0.033 度）の整数倍のカウント数で決める。 */
const ZERO_COUNTS: [number, number][] = [
  [0, 30],
  [9, 30],
  [-12, 27],
  [15, 24],
  [-6, 30],
];
const ZERO_WEAPON: WeaponJson & { version: string; source: string } = {
  id: 'qa-zero-spread',
  name: 'QA-ブレなし',
  category: 'QA',
  version: 'S31-Cipher',
  source: '仮データ（受け入れテスト）',
  rpm: 30,
  magSize: ZERO_COUNTS.length,
  randomness: 0,
  pattern: ZERO_COUNTS.map(([x, y]) => ({ dx: x * DEG_PER_COUNT, dy: y * DEG_PER_COUNT })),
};

type RGB = [number, number, number];
type Point = [number, number];
const distance = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rad = (d: number) => (d * Math.PI) / 180;

/** i 発目（1 から）の理想の補正軌道: 1〜i 発目の pattern の合計の反転（weapons.md）。 */
function ideal(w: WeaponJson, i: number) {
  let yaw = 0;
  let pitch = 0;
  for (let k = 0; k < i; k += 1) {
    yaw -= w.pattern[k]!.dx;
    pitch -= w.pattern[k]!.dy;
  }
  return { yaw, pitch };
}

/** 照準の向きから (yaw, pitch) 度ずれた方向の画面上の位置。FOV 90（既定）・1280×800（screens.md の換算）。 */
function project({ yaw, pitch }: { yaw: number; pitch: number }): Point {
  const dx = Math.cos(rad(pitch)) * Math.sin(rad(yaw));
  const dy = Math.sin(rad(pitch));
  const dz = Math.cos(rad(pitch)) * Math.cos(rad(yaw));
  const tanV = Math.tan(rad(45)) * 0.75;
  const tanH = tanV * (WIDTH / HEIGHT);
  return [CX + ((dx / dz) / tanH) * (WIDTH / 2), CY - ((dy / dz) / tanV) * (HEIGHT / 2)];
}

/** FOV F・縦横比 A の水平・縦の視野角の半分の tan（screens.md の換算）。 */
function halfTans(fov: number, aspect: number) {
  const tanV = Math.tan(rad(fov / 2)) * 0.75;
  return { tanH: tanV * aspect, tanV };
}

// ---------------------------------------------------------------------------
// 画面の操作
// ---------------------------------------------------------------------------

/** Gamepad API の形の、標準配置のパッド 1 台。R2 はボタン 7。 */
const FAKE_PAD = `
  window.__pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) };
  navigator.getGamepads = () => [{ id: 'acceptance pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard',
    timestamp: performance.now(), axes: window.__pad.axes.slice(), buttons: window.__pad.buttons.map((b) => ({ ...b })), vibrationActuator: null }];
  window.__setR2 = (v) => { window.__pad.buttons[7] = { value: v, pressed: v >= 0.5, touched: v > 0 }; };
  window.__ammo = () => { const m = (document.querySelector('[data-hud="ammo"]')?.textContent ?? '').match(/\\d+/); return m ? Number(m[0]) : NaN; };
`;

const hash = (page: Page) => page.evaluate<string>('location.hash');
const ammo = (page: Page) => page.evaluate<number>('window.__ammo()');
const resultText = (page: Page) => page.evaluate<string>(`document.querySelector('[data-screen="result"]')?.innerText ?? ''`);

async function screenshot(page: Page): Promise<Image> {
  const { data } = await page.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  return decodePng(Buffer.from(data, 'base64'));
}

/** HTML の画面（HUD・クロスヘア）を隠し、キャンバスだけを写す。 */
async function canvasOnly(page: Page): Promise<Image> {
  await page.evaluate(`document.getElementById('ui').style.visibility = 'hidden'`);
  await pause(120);
  const img = await screenshot(page);
  await page.evaluate(`document.getElementById('ui').style.visibility = ''`);
  return img;
}

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

/** ネイティブのピッカーを使う欄（色・選択肢）に値を入れ、input と change を発火させる。 */
async function setNative(page: Page, id: string, value: string) {
  await page.evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await pause(100);
}

/** 保存された設定を消す（既定値の状態にする）。 */
async function resetSettings(page: Page, origin: string) {
  await page.goto(`${origin}${BASE}#/`);
  await page.evaluate('localStorage.clear()');
}

/** 設定画面を開く。 */
async function openSettings(page: Page, origin: string) {
  await page.goto(`${origin}${BASE}#/settings`);
  await page.waitFor(`!document.querySelector('[data-screen="settings"]').hidden && document.getElementById('setting-fov')`);
}

/** 設定画面の FOV に値を入れて Enter で確定する。 */
async function typeFov(page: Page, value: string) {
  await page.clickSelector('#setting-fov');
  await page.evaluate(`document.getElementById('setting-fov').select()`);
  await page.send('Input.insertText', { text: value });
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined });
  }
  await pause(100);
}

/** トップ画面を開き、武器とモードを選んで「開始」を押し、プレイ画面になるまで待つ。 */
async function start(page: Page, origin: string, weapon: string, mode: string) {
  await page.goto(`${origin}${BASE}#/`);
  await page.waitFor(`!document.querySelector('[data-screen="top"]').hidden && document.querySelector('#weapon').options.length > 0 && document.querySelector('#mode').options.length > 0`);
  await choose(page, '#weapon', weapon);
  await choose(page, '#mode', mode);
  await page.clickSelector('[data-screen="top"] a[href="#/play"]');
  await page.waitFor(`location.hash === '#/play' && !document.querySelector('[data-screen="play"]').hidden && window.__ammo() > 0`);
  await pause(600);
}

/** R2 を押し続け、残弾が left 以下になったら離す。離したときの残弾を返す。 */
async function holdUntil(page: Page, left: number): Promise<number> {
  return page.evaluate<number>(`(async () => {
    window.__setR2(1); const t0 = performance.now();
    while (!(window.__ammo() <= ${left}) && location.hash === '#/play' && performance.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 1));
    window.__setR2(0); return window.__ammo(); })()`);
}

/** 残弾が left になるまで待つ（R2 は押したまま）。 */
const waitAmmo = (page: Page, left: number, timeout = 10_000) => page.waitFor(`window.__ammo() === ${left}`, timeout);

// ---------------------------------------------------------------------------
// ゴーストの検出
// ---------------------------------------------------------------------------

/** 2 枚の画面写しで色が変わった画素。 */
function changedPixels(a: Image, b: Image, tol = 40): Point[] {
  const out: Point[] = [];
  for (let y = 0; y < a.height; y += 1) for (let x = 0; x < a.width; x += 1) if (distance(a.pixel(x, y), b.pixel(x, y)) > tol) out.push([x, y]);
  return out;
}

const centroid = (ps: Point[]): Point => [ps.reduce((s, p) => s + p[0], 0) / ps.length, ps.reduce((s, p) => s + p[1], 0) / ps.length];
const spread = (ps: Point[]) => {
  const c = centroid(ps);
  return Math.max(...ps.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])));
};

/** 色 c に近い画素（ゴーストの色で探す）。 */
function pixelsOfColor(img: Image, c: RGB, tol = 45): Point[] {
  const out: Point[] = [];
  for (let y = 0; y < img.height; y += 1) for (let x = 0; x < img.width; x += 1) if (distance(img.pixel(x, y), c) < tol) out.push([x, y]);
  return out;
}

/** 画素の色の中央値（成分ごと）。 */
function medianColor(img: Image, ps: Point[]): RGB {
  const ch = (i: 0 | 1 | 2) => {
    const v = ps.map(([x, y]) => img.pixel(x, y)[i]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)]!;
  };
  return [ch(0), ch(1), ch(2)];
}

const fmt = (p: Point | undefined) => (p ? `(${p[0].toFixed(1)}, ${p[1].toFixed(1)})` : 'なし');

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('QA: ゴースト追従と、設定の練習への反映', () => {
  const temps: string[] = [];
  const servers: Server[] = [];
  let browser: Browser | undefined;
  let main = '';
  let copy = '';
  /** パターン観察で始めた直後のキャンバス（ゴーストのない対照）。 */
  let patternBase: Image;
  /** ゴーストの色（MODE-12 の対照との差から求める）。 */
  let ghostColor: RGB;

  /** テストごとに開いたタブ（描画の負荷で時間の判定がずれないよう、テストが終わったら閉じる）。 */
  let opened: Page[] = [];
  const newPage = async () => {
    const page = await browser!.newPage();
    await page.addInitScript(FAKE_PAD);
    opened.push(page);
    return page;
  };
  afterEach(async () => {
    for (const p of opened) await Promise.race([p.send('Page.close').catch(() => undefined), pause(1000)]);
    opened = [];
  });
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));

  /** ゴーストの色で探したゴーストの画素の中心（なければ undefined）。 */
  async function ghostAt(page: Page): Promise<{ center: Point | undefined; count: number; size: number }> {
    const ps = pixelsOfColor(await canvasOnly(page), ghostColor);
    return { center: ps.length ? centroid(ps) : undefined, count: ps.length, size: ps.length ? spread(ps) : 0 };
  }

  beforeAll(async () => {
    const work = mkdtempSync(join(tmpdir(), 'ghost-qa-'));
    temps.push(work);
    const mainDist = join(work, 'main-dist');
    const build = spawnSync(`npm run build -- --outDir "${mainDist}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`ビルドが失敗した:\n${build.stdout}${build.stderr}`);

    // MODE-13: リポジトリの写しに randomness 0 の武器を足してビルドする。
    const repo = join(work, 'copy');
    for (const entry of ['src', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'eslint.config.js', 'scripts']) {
      if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(repo, entry), { recursive: true });
    }
    symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'), 'dir');
    writeFileSync(join(repo, 'src/data/weapons/qa-zero-spread.json'), JSON.stringify(ZERO_WEAPON, null, 2));
    const copyDist = join(work, 'copy-dist');
    const r = spawnSync(`npm run build -- --outDir "${copyDist}" --emptyOutDir`, {
      cwd: repo,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, APEX_ACCEPTANCE_NESTED: '1', FORCE_COLOR: '0' },
    });
    if (r.status !== 0) throw new Error(`写しのビルドが失敗した:\n${r.stdout}${r.stderr}`);

    for (const [dir, set] of [
      [mainDist, (o: string) => (main = o)],
      [copyDist, (o: string) => (copy = o)],
    ] as const) {
      const server = await serveStatic(dir, BASE, 0);
      servers.push(server);
      set(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    }
    browser = await launchBrowser(chromium!, 0);

    // 対照: パターン観察（ゴーストを表示しない）で始めた直後のキャンバス。
    const ref = await newPage();
    await resetSettings(ref, main);
    await start(ref, main, 'R-301', 'パターン観察');
    patternBase = await canvasOnly(ref);
    opened = [];
    await Promise.race([ref.send('Page.close').catch(() => undefined), pause(1000)]);

    // ゴーストの色: ゴースト追従で始めた直後のキャンバスと対照の違う画素の色。
    const page = await newPage();
    await start(page, main, 'R-301', 'ゴースト追従');
    const diff = changedPixels(patternBase, await canvasOnly(page));
    if (diff.length === 0) throw new Error('ゴースト追従で始めても、パターン観察と違う画素がない（ゴーストが見えない）');
    ghostColor = medianColor(await canvasOnly(page), diff);
    // ゴーストの色は、対照のキャンバス（壁・的・背景）にない色。
    expect(pixelsOfColor(patternBase, ghostColor).length, `ゴーストの色 ${ghostColor} が対照にもある`).toBe(0);
    await Promise.race([page.send('Page.close').catch(() => undefined), pause(1000)]);
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    for (const s of servers) await new Promise((ok) => s.close(ok));
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  describe('MODE-12: 1 発も撃っていないとき、ゴーストは開始時の照準 + 1 発目の理想の補正軌道の向きに表示される', () => {
    it.each([...MVP_WEAPONS.map((n) => [n, byName(n), 'main'] as const), [ZERO_WEAPON.name, ZERO_WEAPON, 'copy'] as const])(
      '%s',
      async (_name, w, site) => {
        const origin = site === 'main' ? main : copy;
        const page = await newPage();
        await resetSettings(page, origin);
        await start(page, origin, w.name, 'ゴースト追従');
        const expected = project(ideal(w, 1));
        // 対照（パターン観察）と違う画素は、ゴーストの 1 か所だけ。
        const diff = changedPixels(patternBase, await canvasOnly(page));
        expect(diff.length, 'ゴーストが表示されていない').toBeGreaterThan(0);
        expect(spread(diff), 'ゴースト以外にも違う画素がある').toBeLessThan(20);
        const c = centroid(diff);
        expect(Math.hypot(c[0] - expected[0], c[1] - expected[1]), `ゴースト ${fmt(c)} 期待 ${fmt(expected)}`).toBeLessThanOrEqual(1.5);
        // 撃たずに時間がたっても（2 秒を超えても）同じ位置のまま。
        await pause((IDLE_END + 0.5) * 1000);
        expect(await hash(page)).toBe('#/play');
        const later = await ghostAt(page);
        expect(later.center, 'ゴーストが消えた').toBeDefined();
        expect(Math.hypot(later.center![0] - expected[0], later.center![1] - expected[1]), `ゴースト ${fmt(later.center)} 期待 ${fmt(expected)}`).toBeLessThanOrEqual(1.5);
        expect(await ammo(page)).toBe(w.magSize);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      },
      60_000,
    );
  });

  // -------------------------------------------------------------------------
  describe('MODE-3: ゴーストは次の弾で照準を合わせるべき位置に表示され、1 発撃つごとに次の位置へ進む', () => {
    it(`${ZERO_WEAPON.name}（rpm 30）で R2 を押し続け、各発のあとにゴーストが次の発の理想の補正軌道の位置にある`, async () => {
      const w = ZERO_WEAPON;
      const page = await newPage();
      await resetSettings(page, copy);
      await start(page, copy, w.name, 'ゴースト追従');
      const seen: Point[] = [];
      await page.evaluate(`window.__setR2(1)`);
      for (let i = 1; i < w.magSize; i += 1) {
        await waitAmmo(page, w.magSize - i);
        await pause(150);
        expect(await ammo(page), `${i} 発目のあと、次の発の前に写せていない`).toBe(w.magSize - i);
        const g = await ghostAt(page);
        const expected = project(ideal(w, i + 1));
        expect(g.center, `${i} 発目のあとにゴーストがない`).toBeDefined();
        expect(Math.hypot(g.center![0] - expected[0], g.center![1] - expected[1]), `${i} 発目のあと: ゴースト ${fmt(g.center)} 期待 ${fmt(expected)}`).toBeLessThanOrEqual(2);
        seen.push(g.center!);
      }
      await page.evaluate(`window.__setR2(0)`);
      // 発ごとに位置が変わる（進む）。
      for (let i = 1; i < seen.length; i += 1) expect(Math.hypot(seen[i]![0] - seen[i - 1]![0], seen[i]![1] - seen[i - 1]![1])).toBeGreaterThan(5);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('R-301 で 1 発だけ撃つと、ゴーストが 1 発目の位置から 2 発目の位置へ進む', async () => {
      const w = byName('R-301');
      const page = await newPage();
      await resetSettings(page, main);
      await start(page, main, w.name, 'ゴースト追従');
      const before = await ghostAt(page);
      // パッドが 1 回読まれる間だけ押す代わりに、1 発撃ったら離す（発射間隔 74ms より短く押す）。
      const left = await page.evaluate<number>(`(async () => {
        window.__setR2(1); const t0 = performance.now();
        while (window.__ammo() === ${w.magSize} && performance.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 1));
        window.__setR2(0); return window.__ammo(); })()`);
      expect(w.magSize - left).toBeGreaterThanOrEqual(1);
      // 戻りの時間（0.5 秒）がたつ前に写す。撃った数は写したあとの残弾で数える（離すのが間に合わず 2 発撃つことがある）。
      const after = await ghostAt(page);
      const shots = w.magSize - (await ammo(page));
      const expected = project(ideal(w, shots + 1));
      expect(after.center).toBeDefined();
      expect(Math.hypot(after.center![0] - expected[0], after.center![1] - expected[1]), `ゴースト ${fmt(after.center)} 期待 ${fmt(expected)}（${shots} 発）`).toBeLessThanOrEqual(2);
      expect(Math.hypot(after.center![0] - before.center![0], after.center![1] - before.center![1])).toBeGreaterThan(2);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('MODE-13: randomness 0 の武器で、各発を撃つときにクロスヘアをゴーストに重ねて撃つと、全弾が中心に当たる', () => {
    it(`${ZERO_WEAPON.name}: マウスで照準をゴーストに重ねてから撃ち、撃つたびに次のゴーストに重ね直す`, async () => {
      const w = ZERO_WEAPON;
      const page = await newPage();
      await resetSettings(page, copy);
      await start(page, copy, w.name, 'ゴースト追従');
      // ポインターロックを掛ける（この クリックでは撃たない: ロックしていない間のボタンは射撃にならない）。
      await page.click(CX, CY);
      await page.waitFor('!!document.pointerLockElement', 5000);
      await pause(300);
      expect(await ammo(page), 'ポインターロックのクリックで撃った').toBe(w.magSize);

      let cursor: Point = [CX, CY];
      let held = 0;
      /** (dx, dy) カウントだけマウスを動かす（1 回の移動は 10 カウントまで）。 */
      const move = async (dx: number, dy: number) => {
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 10));
        const from = cursor;
        for (let s = 1; s <= steps; s += 1) {
          const x = from[0] + Math.round((dx * s) / steps);
          const y = from[1] + Math.round((dy * s) / steps);
          await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: held ? 'left' : 'none', buttons: held });
        }
        cursor = [from[0] + dx, from[1] + dy];
      };
      /** クロスヘア（画面の中心）とゴーストのずれ（ピクセル）。 */
      const offCenter = async (label: string) => {
        await pause(150);
        const g = await ghostAt(page);
        expect(g.center, `${label}: ゴーストがない`).toBeDefined();
        return Math.hypot(g.center![0] - CX, g.center![1] - CY);
      };

      // 撃つ前: ゴーストは中心から外れている。1 発目の pattern と逆向きに動かすと、クロスヘアがゴーストに重なる。
      expect(await offCenter('撃つ前')).toBeGreaterThan(5);
      // 右に動かすとヨーが増え、前（movementY が負）に動かすとピッチが増える（mouse.md）。理想の補正軌道は pattern の反転。
      await move(-ZERO_COUNTS[0]![0], ZERO_COUNTS[0]![1]);
      expect(await offCenter('1 発目の前'), '1 発目の前にクロスヘアがゴーストに重ならない').toBeLessThanOrEqual(1.5);

      // 撃ち始める（左ボタンを押し続ける）。各発のあと、次のゴーストへ照準を動かして重ね直す。
      held = 1;
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cursor[0], y: cursor[1], button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i < w.magSize; i += 1) {
        await waitAmmo(page, w.magSize - i);
        // 撃った直後は、ゴーストが次の位置へ進んでクロスヘアから外れる。
        await move(-ZERO_COUNTS[i]![0], ZERO_COUNTS[i]![1]);
        const off = await offCenter(`${i + 1} 発目の前`);
        expect(await ammo(page), `${i + 1} 発目の前に重ね直せていない（次の発を撃った）`).toBe(w.magSize - i);
        expect(off, `${i + 1} 発目の前にクロスヘアがゴーストに重ならない`).toBeLessThanOrEqual(1.5);
      }
      // 撃ち切るとリザルト画面に移る。
      await page.waitFor(`location.hash === '#/result'`, 10_000);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cursor[0], y: cursor[1], button: 'left', buttons: 0, clickCount: 1 });
      await pause(300);
      const text = await resultText(page);
      // 全弾が中心に当たる: 平均ズレ 0・グルーピング半径 0（scoring.md）。
      expect(text).toContain(`${w.magSize} 発`);
      expect(text, text).toMatch(/平均ズレ\s*0(\.0+)?\s*°/);
      expect(text, text).toMatch(/グルーピング半径\s*0(\.0+)?\s*°/);
      expect(text).toContain('よくまとまっている');
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it(`対照: ${ZERO_WEAPON.name} で照準を動かさずに撃ち切ると、中心に当たらない（平均ズレが 0 でない）`, async () => {
      const page = await newPage();
      await resetSettings(page, copy);
      await start(page, copy, ZERO_WEAPON.name, 'ゴースト追従');
      await page.evaluate(`window.__setR2(1)`);
      await page.waitFor(`location.hash === '#/result'`, 15_000);
      await page.evaluate(`window.__setR2(0)`);
      await pause(300);
      const text = await resultText(page);
      const m = text.match(/平均ズレ\s*([\d.]+)\s*°/);
      expect(m, text).not.toBeNull();
      expect(Number(m![1])).toBeGreaterThan(0.5);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('MODE-14: 1 マガジンを撃ち切ると、ゴーストが表示から消えてリザルト画面に移る', () => {
    it.each([
      [ZERO_WEAPON.name, ZERO_WEAPON, 'copy'] as const,
      ['R-301', byName('R-301'), 'main'] as const,
    ])('%s', async (_name, w, site) => {
      const origin = site === 'main' ? main : copy;
      const page = await newPage();
      await resetSettings(page, origin);
      await start(page, origin, w.name, 'ゴースト追従');
      await page.evaluate(`window.__setR2(1)`);
      if (w.rpm <= 60) {
        // 撃ち切る直前（残弾 1）は、まだゴーストが表示されている。
        await waitAmmo(page, 1);
        expect((await ghostAt(page)).count, '撃ち切る前にゴーストが消えた').toBeGreaterThan(0);
      }
      await page.waitFor(`location.hash === '#/result'`, 15_000);
      await page.evaluate(`window.__setR2(0)`);
      expect(await page.evaluate<boolean>(`!document.querySelector('[data-screen="result"]').hidden && document.querySelector('[data-screen="play"]').hidden`)).toBe(true);
      // リザルト画面の後ろのキャンバスにもゴーストがない。
      for (const wait of [0, 500]) {
        await pause(wait);
        const g = await ghostAt(page);
        expect(g.count, `リザルト画面でゴーストが表示されている ${fmt(g.center)}`).toBe(0);
      }
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('MODE-15: 数発撃って fire を離し、戻りの時間（0.5 秒）より長く待つと、ゴーストが 1 発目の位置に戻る', () => {
    it.each([['R-301'], ['フラットライン']])('%s', async (name) => {
      const w = byName(name);
      const page = await newPage();
      await resetSettings(page, main);
      await start(page, main, w.name, 'ゴースト追従');
      const first = project(ideal(w, 1));
      const left = await holdUntil(page, w.magSize - 6);
      const released = Date.now();
      expect(w.magSize - left).toBeGreaterThanOrEqual(6);
      // 離した直後（戻りの時間の途中）は、次に撃つ発の位置にある（1 発目の位置から離れている）。
      // 撃った数は写したあとの残弾で数える（離すのが間に合わず 1 発多く撃つことがある）。戻りの途中はリコイルが動いているので、
      // カメラの補間の分（数ピクセル）の差を許す。
      const during = await ghostAt(page);
      const shots = w.magSize - (await ammo(page));
      const next = project(ideal(w, shots + 1));
      expect(during.center).toBeDefined();
      expect(Math.hypot(during.center![0] - next[0], during.center![1] - next[1]), `離した直後: ゴースト ${fmt(during.center)} 期待 ${fmt(next)}`).toBeLessThanOrEqual(5);
      expect(Math.hypot(during.center![0] - first[0], during.center![1] - first[1])).toBeGreaterThan(10);
      // 戻りの時間より長く（離してから約 1.1 秒）待つ。撃たない時間（2 秒）より前なのでプレイ画面のまま。
      await pause(Math.max(0, (RECOVERY + 0.3) * 1000 - (Date.now() - released)));
      expect(await hash(page)).toBe('#/play');
      const after = await ghostAt(page);
      // 写したのは撃たない時間（2 秒）がたつ前（リザルトに移る前のプレイ画面）。
      expect(Date.now() - released, '写すのが遅れた').toBeLessThan(IDLE_END * 1000);
      expect(after.center).toBeDefined();
      expect(Math.hypot(after.center![0] - first[0], after.center![1] - first[1]), `戻ったあと: ゴースト ${fmt(after.center)} 期待 ${fmt(first)}`).toBeLessThanOrEqual(1.5);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('UI-4: 設定画面でゴースト表示を OFF にしてゴースト追従を始めると、ゴーストが表示されず、撃ち切るとリザルトに採点結果が表示される', () => {
    it('R-301', async () => {
      const w = byName('R-301');
      const page = await newPage();
      await resetSettings(page, main);
      await openSettings(page, main);
      expect(await page.evaluate<boolean>(`document.getElementById('setting-ghost').checked`)).toBe(true);
      await page.clickSelector('#setting-ghost');
      await pause(100);
      expect(await page.evaluate<boolean>(`document.getElementById('setting-ghost').checked`)).toBe(false);

      await start(page, main, w.name, 'ゴースト追従');
      // 撃つ前: パターン観察と同じ画面（ゴーストがない）。
      const base = await canvasOnly(page);
      expect(changedPixels(patternBase, base).length, 'ゴースト表示 OFF なのに、パターン観察と違う画素がある').toBe(0);
      expect(pixelsOfColor(base, ghostColor).length).toBe(0);
      // 撃っている途中も、離した直後もゴーストがない。
      await holdUntil(page, w.magSize - 8);
      expect((await ghostAt(page)).count, '撃ったあとにゴーストが表示された').toBe(0);
      // 撃ち切るとリザルトに採点結果が表示される。
      await page.evaluate(`window.__setR2(1)`);
      await page.waitFor(`location.hash === '#/result'`, 15_000);
      await page.evaluate(`window.__setR2(0)`);
      await pause(300);
      const text = await resultText(page);
      expect(text).toContain('ゴースト追従');
      expect(text, text).toMatch(/平均ズレ\s*[\d.]+\s*°/);
      expect(text, text).toMatch(/グルーピング半径\s*[\d.]+\s*°/);
      expect(text, text).toMatch(/下げすぎ|下げ不足|横の補正不足|よくまとまっている/);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('対照: パターン観察で撃ち切ったリザルトには採点結果が出ない', async () => {
      const page = await newPage();
      await resetSettings(page, main);
      await start(page, main, 'R-301', 'パターン観察');
      await page.evaluate(`window.__setR2(1)`);
      await page.waitFor(`location.hash === '#/result'`, 15_000);
      await page.evaluate(`window.__setR2(0)`);
      await pause(300);
      expect(await resultText(page)).not.toMatch(/平均ズレ/);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('UI-16: クロスヘアの色と形を変えてから練習を始めると、プレイ画面のクロスヘアがその色と形で表示される', () => {
    const RED: RGB = [255, 0, 0];
    /** 画面の中心の 61×61 の範囲で、色 c に近い画素（中心からの相対位置）。 */
    const near = (img: Image, c: RGB): Point[] => {
      const out: Point[] = [];
      for (let dy = -30; dy <= 30; dy += 1) for (let dx = -30; dx <= 30; dx += 1) if (distance(img.pixel(CX + dx, CY + dy), c) < 60) out.push([dx, dy]);
      return out;
    };

    it('#ff0000 と十字', async () => {
      const page = await newPage();
      await resetSettings(page, main);
      // 対照: 既定（点・#77ccff）で始めたときは、中心に赤い画素がない。
      await start(page, main, 'R-301', 'パターン観察');
      expect(near(await screenshot(page), RED).length).toBe(0);
      const dot = near(await screenshot(page), [0x77, 0xcc, 0xff]);
      expect(dot.length, '既定のクロスヘア（#77ccff の点）が見えない').toBeGreaterThan(0);

      await openSettings(page, main);
      await setNative(page, 'setting-crosshair-color', '#ff0000');
      await setNative(page, 'setting-crosshair-shape', 'cross');
      await start(page, main, 'R-301', 'パターン観察');
      const img = await screenshot(page);
      const red = near(img, RED);
      expect(red.length, 'クロスヘアが #ff0000 で表示されていない').toBeGreaterThan(0);
      expect(near(img, [0x77, 0xcc, 0xff]).length, '既定の色のクロスヘアが残っている').toBe(0);
      // 十字: 中心を通る横と縦の線に沿って伸び、斜めの方向には画素がない（点・輪と区別する）。
      const horizontal = red.filter(([, y]) => Math.abs(y) <= 1);
      const vertical = red.filter(([x]) => Math.abs(x) <= 1);
      const reachX = Math.max(...horizontal.map(([x]) => Math.abs(x)));
      const reachY = Math.max(...vertical.map(([, y]) => Math.abs(y)));
      const dotReach = Math.max(...dot.map(([x, y]) => Math.hypot(x, y)));
      expect(reachX, '横の腕がない').toBeGreaterThanOrEqual(Math.max(4, dotReach + 2));
      expect(reachY, '縦の腕がない').toBeGreaterThanOrEqual(Math.max(4, dotReach + 2));
      // 右と左、上と下の両方に伸びる。
      expect(horizontal.some(([x]) => x <= -3) && horizontal.some(([x]) => x >= 3)).toBe(true);
      expect(vertical.some(([, y]) => y <= -3) && vertical.some(([, y]) => y >= 3)).toBe(true);
      const diagonal = red.filter(([x, y]) => Math.abs(x) >= 3 && Math.abs(y) >= 3);
      expect(diagonal.length, `斜めにも画素がある（十字でない） ${JSON.stringify(diagonal.slice(0, 10))}`).toBe(0);
      // 十字の中心は画面の中心（照準の向き）。
      const c = centroid(red);
      expect(Math.hypot(c[0], c[1])).toBeLessThanOrEqual(1.5);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('UI-17: FOV を 110 にしてから練習を始めると、FOV 90 より壁と的が小さく表示され、視野角は FOV 110 から求めた値になる', () => {
    /** 色 c が続く区間（中心の点 (x, y) から左右・上下へ）。 */
    function extent(img: Image, x: number, y: number, axis: 'x' | 'y', c: RGB): [number, number] {
      const at = (i: number) => (axis === 'x' ? img.pixel(i, y) : img.pixel(x, i));
      const limit = axis === 'x' ? WIDTH : HEIGHT;
      let lo = axis === 'x' ? x : y;
      let hi = lo;
      while (lo - 1 >= 0 && distance(at(lo - 1), c) < 30) lo -= 1;
      while (hi + 1 < limit && distance(at(hi + 1), c) < 30) hi += 1;
      return [lo, hi + 1];
    }

    async function measure(page: Page, origin: string, fov: number | undefined) {
      await resetSettings(page, origin);
      if (fov !== undefined) {
        await openSettings(page, origin);
        await typeFov(page, String(fov));
        expect(await page.evaluate<string>(`document.getElementById('setting-fov').value`)).toBe(String(fov));
      }
      await start(page, origin, 'R-301', 'パターン観察');
      const img = await canvasOnly(page);
      const target = img.pixel(CX, CY);
      // 壁の色は、的の下で壁の下端より上（FOV 110 で壁の下端は中心から約 60 ピクセル下）の画素。
      const wall = img.pixel(CX, CY + 30);
      expect(distance(target, wall), '中心に的が見えない').toBeGreaterThan(40);
      return {
        targetX: extent(img, CX, CY, 'x', target),
        targetY: extent(img, CX, CY, 'y', target),
        wallX: extent(img, CX, CY + 30, 'x', wall),
        wallY: extent(img, CX + 100, CY, 'y', wall),
      };
    }

    /** FOV で、出現位置から箱の手前の面の縁が画面のどこに出るか（screens.md の換算）。 */
    function expectedEdges(fov: number, kind: string) {
      const box = RANGE.boxes.find((b) => b.kind === kind)!;
      const [ex, ey, ez] = RANGE.spawn.position;
      const dist = ez - (box.center[2] + box.size[2] / 2);
      const { tanH, tanV } = halfTans(fov, WIDTH / HEIGHT);
      const sx = (m: number) => CX + ((m - ex) / dist / tanH) * (WIDTH / 2);
      const sy = (m: number) => CY - ((m - ey) / dist / tanV) * (HEIGHT / 2);
      return {
        x: [sx(box.center[0] - box.size[0] / 2), sx(box.center[0] + box.size[0] / 2)] as const,
        y: [sy(box.center[1] + box.size[1] / 2), sy(box.center[1] - box.size[1] / 2)] as const,
      };
    }

    it('FOV 90 と FOV 110 で始めて、壁と的の画面上の大きさを比べる', async () => {
      const page = await newPage();
      const at90 = await measure(page, main, 90);
      const at110 = await measure(page, main, 110);
      const size = (r: [number, number]) => r[1] - r[0];
      // FOV 110 のほうが壁と的が小さい。
      expect(size(at110.targetX)).toBeLessThan(size(at90.targetX));
      expect(size(at110.targetY)).toBeLessThan(size(at90.targetY));
      expect(size(at110.wallX)).toBeLessThan(size(at90.wallX));
      expect(size(at110.wallY)).toBeLessThan(size(at90.wallY));
      // 視野角は FOV から求めた値: 壁と的の縁が、その FOV の換算で求めた位置に出る（FOV 90 も確かめる）。
      for (const [fov, m] of [[90, at90], [110, at110]] as const) {
        const wall = expectedEdges(fov, 'wall');
        const target = expectedEdges(fov, 'target');
        const check = (label: string, got: [number, number], want: readonly [number, number]) => {
          expect(Math.abs(got[0] - want[0]), `FOV ${fov} ${label}: ${got} 期待 ${want.map((v) => v.toFixed(1))}`).toBeLessThanOrEqual(2);
          expect(Math.abs(got[1] - want[1]), `FOV ${fov} ${label}: ${got} 期待 ${want.map((v) => v.toFixed(1))}`).toBeLessThanOrEqual(2);
        };
        check('壁の左右', m.wallX, wall.x);
        check('壁の上下', m.wallY, wall.y);
        check('的の左右', m.targetX, target.x);
        check('的の上下', m.targetY, target.y);
      }
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('MODE-1: MVP の 6 つの武器それぞれで、3 つのモードを最後まで練習でき、リザルト画面が表示される', () => {
    it('トップ画面の選択肢に 6 つの武器と 3 つのモードがある', async () => {
      const page = await newPage();
      await page.goto(`${main}${BASE}#/`);
      await page.waitFor(`document.querySelector('#mode').options.length > 0`);
      const weapons = await page.evaluate<string[]>(`[...document.querySelector('#weapon').options].map((o) => o.textContent.trim())`);
      const modes = await page.evaluate<string[]>(`[...document.querySelector('#mode').options].map((o) => o.textContent.trim())`);
      for (const n of MVP_WEAPONS) expect(weapons).toContain(n);
      expect(modes).toEqual(expect.arrayContaining(['パターン観察', 'ゴースト追従', 'センター維持']));
    });

    it.each(MVP_WEAPONS.flatMap((n) => ['パターン観察', 'ゴースト追従', 'センター維持'].map((m) => [n, m] as const)))(
      '%s / %s',
      async (name, mode) => {
        const page = await newPage();
        await resetSettings(page, main);
        await start(page, main, name, mode);
        await page.evaluate(`window.__setR2(1)`);
        await page.waitFor(`location.hash === '#/result'`, 20_000);
        await page.evaluate(`window.__setR2(0)`);
        await pause(200);
        expect(await page.evaluate<boolean>(`!document.querySelector('[data-screen="result"]').hidden`)).toBe(true);
        const text = await resultText(page);
        expect(text).toContain(name);
        expect(text).toContain(mode);
        if (mode !== 'パターン観察') expect(text, text).toMatch(/平均ズレ/);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      },
      60_000,
    );
  });
});
