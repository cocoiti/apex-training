// docs/spec/screens.md の設定画面の受け入れ条件（UI-2・UI-11〜UI-15）と docs/spec/mouse.md の MOU-4・MOU-12 の QA の受け入れテスト。
// 公開された入口だけを使う: ビルドの結果を /apex-training/ で配信した設定画面（#/settings）の入力欄と cm/360 の表示。
// 画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、文字の入力・Enter・クリックは DevTools プロトコルで実際の入力として送る。
// 色の選択（input type="color"）と選択肢（select）はネイティブのピッカーを操作できないため、値を入れて input / change を発火させる。
// 保存先の localStorage のキーは実装の内部なので決め打ちせず、設定を変えたあとに増えたキーを保存先とみなす（UI-15）。
// サーバーと DevTools のポートは OS に選ばせる（並行して動くほかの作業ツリーとぶつからないように）。
// 「開始」を押した時点の設定で練習が始まること（screens.md「設定項目」、mouse.md の換算）は、同じタブで設定を変えてから
// トップ画面に戻って「開始」を押し、プレイ画面のクロスヘアの属性と、ポインターロック中にマウスを動かしたあとの描画で確かめる。
// ポインターロック中の DevTools の mouseMoved は、座標の差がそのまま movementX / movementY（カウント）になる。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { projectAngleOffset } from '../../src/render/fov';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';
import { decodePng, type Image } from '../helpers/png';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
/** ページを開く練習の乱数の種（docs/spec/architecture.md「テストのための乱数の種の固定」）。テストが失敗したときのメッセージにも出る。 */
const SEED = 12345;
const chromium = findChromium();
const WIDTH = 1280;
const HEIGHT = 800;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;

type RGB = [number, number, number];
const distance = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** HTML の画面を見えなくし、画面の動きが止まってから（続けて撮った画面写しが同じになってから）キャンバスだけを写す。 */
async function canvasOnly(page: Page): Promise<Image> {
  await page.evaluate(`document.getElementById('ui').style.visibility = 'hidden'`);
  // 隠した状態で描画し直されるまで待つ。
  await page.frames(2);
  const img = decodePng(await page.stableScreenshot());
  await page.evaluate(`document.getElementById('ui').style.visibility = ''`);
  return img;
}

/**
 * 色 c に近い画素のまとまりの中心。axis が 'row' なら行 at を横に、'column' なら列 at を縦に見る。
 * 的はリングの暗い線で区切られるので、12 px 以内の切れ目はつなげ、画素がいちばん多いまとまりの両端の中点を返す。
 */
function blobCenter(img: Image, axis: 'row' | 'column', at: number, c: RGB): number | undefined {
  const length = axis === 'row' ? WIDTH : HEIGHT;
  const hits: number[] = [];
  for (let i = 0; i < length; i += 1) if (distance(axis === 'row' ? img.pixel(i, at) : img.pixel(at, i), c) < 30) hits.push(i);
  let best: [number, number, number] | undefined;
  let group: [number, number, number] | undefined;
  for (const i of hits) {
    if (group && i - group[1] <= 12) group = [group[0], i, group[2] + 1];
    else group = [i, i, 1];
    if (!best || group[2] > best[2]) best = group;
  }
  if (!best) return undefined;
  // 反復練習では中心に人形（docs/spec/architecture.md「人形の的」）が見え、中心を通る列では頭の上端（+0.525 m）から胴の下端（-0.275 m）までが
  // 人形の色になる（その下は脚のあいだの空き）。的の中心（人形の中心）はその上端から 0.525 ÷ 0.8 の所。
  return axis === 'column' ? best[0] + (best[1] - best[0]) * (0.525 / 0.8) : (best[0] + best[1]) / 2;
}

/** 的の板の色。中心の近くで、壁（中心から 80 px 右）と違う色のうち、いちばん多い色（リングの線の間に見える板の色）。 */
function boardColor(img: Image): RGB {
  const wall = img.pixel(CX + 80, CY);
  const counts = new Map<string, [RGB, number]>();
  for (let dy = -12; dy <= 12; dy += 1) {
    for (let dx = -12; dx <= 12; dx += 1) {
      const c = img.pixel(CX + dx, CY + dy);
      if (distance(c, wall) <= 40) continue;
      const key = c.join(',');
      counts.set(key, [c, (counts.get(key)?.[1] ?? 0) + 1]);
    }
  }
  const [best] = [...counts.values()].sort((a, b) => b[1] - a[1]);
  return best ? best[0] : img.pixel(CX, CY);
}

/** (CX, CY) から 10 カウントずつ (dx, dy) の向きへ steps 回動かす。 */
async function drag(page: Page, dx: number, dy: number, steps: number) {
  for (let i = 1; i <= steps; i += 1) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: CX + dx * i, y: CY + dy * i, buttons: 0, button: 'none' });
  }
}

interface Shown {
  inputMethod: string;
  fov: string;
  crosshairColor: string;
  crosshairShape: string;
  ghost: boolean;
  sound: boolean;
  volume: string;
  dpi: string;
  sensitivity: string;
  adsMultiplier: string;
  cmPer360: string;
}

/** 設定画面に表示されている値。 */
const shown = (page: Page) =>
  page.evaluate<Shown>(`(() => {
    const v = (id) => document.getElementById(id).value;
    return {
      inputMethod: v('setting-input-method'),
      fov: v('setting-fov'),
      crosshairColor: v('setting-crosshair-color').toLowerCase(),
      crosshairShape: v('setting-crosshair-shape'),
      ghost: document.getElementById('setting-ghost').checked,
      sound: document.getElementById('setting-sound').checked,
      volume: v('setting-volume'),
      dpi: v('setting-dpi'),
      sensitivity: v('setting-sensitivity'),
      adsMultiplier: v('setting-ads-multiplier'),
      cmPer360: document.getElementById('setting-cm-per-360').textContent.trim(),
    };
  })()`);

const press = async (page: Page, key: 'Enter' | 'Tab') => {
  const code = key === 'Enter' ? 13 : 9;
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text: key === 'Enter' ? '\r' : undefined });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
};

/**
 * 入力欄をクリックして中身を選び、text を打つ。commit が 'enter' なら Enter で、'blur' なら見出しをクリックして欄から離れて確定する。
 * 確定（keydown の Enter・change）の処理は入力を送った時点で終わっているので、欄から離れるときは欄からフォーカスが外れたことを待つ。
 */
async function typeInto(page: Page, id: string, text: string, commit: 'enter' | 'blur' | 'none' = 'enter') {
  await page.clickSelector(`#${id}`);
  await page.evaluate(`document.getElementById(${JSON.stringify(id)}).select()`);
  if (text === '') {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  } else {
    await page.send('Input.insertText', { text });
  }
  if (commit === 'enter') await press(page, 'Enter');
  if (commit === 'blur') {
    await page.clickSelector('[data-screen="settings"] h2');
    await page.waitFor(`document.activeElement !== document.getElementById(${JSON.stringify(id)})`);
  }
}

/** ネイティブのピッカーを使う欄（色・選択肢）に値を入れ、input と change を発火させる（処理は発火の中で終わる）。 */
async function setNative(page: Page, id: string, value: string) {
  await page.evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

/** パターンの表示の項目で選ばれている選択肢の文字（「詳細」「簡易」）。 */
const patternDisplayLabel = (page: Page) =>
  page.evaluate<string>(`document.getElementById('setting-pattern-display').selectedOptions[0]?.textContent.trim() ?? ''`);

/** 設定画面の補正のパネルの ON/OFF の項目（以前の項目）の数。パターンの表示（補正のパネル）の選択は数えない。 */
const correctionPanelToggles = (page: Page) =>
  page.evaluate<number>(`(() => {
    const root = document.querySelector('[data-screen="settings"]');
    const byId = root.querySelector('#setting-correction-panel') ? 1 : 0;
    const byLabel = [...root.querySelectorAll('input[type="checkbox"], input[type="radio"]')]
      .filter((i) => ((i.closest('label')?.textContent ?? '') + (i.labels ? [...i.labels].map((l) => l.textContent).join('') : '')).includes('補正のパネル')).length;
    const selects = [...root.querySelectorAll('select')]
      .filter((s) => s.id !== 'setting-pattern-display')
      .filter((s) => ((s.closest('label')?.textContent ?? '') + (s.labels ? [...s.labels].map((l) => l.textContent).join('') : '')).includes('補正のパネル')).length;
    return byId + byLabel + selects; })()`);

/** パターンの表示を選択肢の文字（「詳細」「簡易」）で選ぶ。 */
async function choosePatternDisplay(page: Page, label: string) {
  const ok = await page.evaluate<boolean>(`(() => {
    const el = document.getElementById('setting-pattern-display');
    const o = [...el.options].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (!o) return false;
    el.value = o.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  if (!ok) throw new Error(`パターンの表示に ${label} の選択肢がない`);
}

describe.skipIf(NESTED || !chromium)('QA: 設定画面の受け入れ条件', () => {
  const temps: string[] = [];
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  let page: Page;

  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), 'settings-qa-dist-'));
    temps.push(out);
    const build = spawnSync(`npm run build -- --outDir "${out}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`ビルドが失敗した:\n${build.stdout}${build.stderr}`);
    server = await serveStatic(out, BASE);
    origin = originOf(server);
    browser = await launchBrowser(chromium!);
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((ok) => (server ? server.close(ok) : ok(undefined)));
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  /** 練習に設定が当たることを画面写しで確かめるテストの describe の名前。このテストだけが 3D を描画する。 */
  const RENDERED = '練習は「開始」を押した時点で保存されている設定で始まる';
  /** 設定画面の URL。描画を確かめるテストのほかは 3D を描画しない（render=off）。 */
  const settingsUrl = () => appUrl(origin, BASE, '#/settings', { render: (expect.getState().currentTestName ?? '').includes(RENDERED), seed: SEED });
  /** 設定画面が表示され、保存された値が欄に入っている（cm/360 が表示されている）まで待つ。 */
  const waitSettings = (p: Page) =>
    p.waitFor(
      `document.querySelector('[data-screen="settings"]') && !document.querySelector('[data-screen="settings"]').hidden && document.getElementById('setting-fov') && document.getElementById('setting-cm-per-360').textContent.trim() !== ''`,
    );

  /** 設定画面を開き直す（再読み込み）。読み込む前の文書に印を付け、印のない新しい文書になったことを待つ。 */
  async function reload(p: Page) {
    await p.evaluate('window.__beforeReload = true');
    await p.send('Page.reload', { ignoreCache: true });
    await p.waitFor('!window.__beforeReload && document.readyState === "complete"');
    await waitSettings(p);
  }

  const noExceptions = (p: Page) => expect(p.errors.filter((e) => e.startsWith('exception:')), p.errors.join('\n')).toEqual([]);

  afterEach(async () => {
    await browser?.closePages();
  });

  // 毎回、保存された設定のない状態（一度も変えていない状態）から始める。
  beforeEach(async () => {
    page = await browser!.newPage();
    await page.goto(settingsUrl());
    await page.evaluate('localStorage.clear()');
    await reload(page);
  });

  describe('UI-13: 設定を一度も変えずに開くと既定値が表示される', () => {
    it('入力方式は自動、FOV 90、クロスヘアは点と #77ccff、ゴースト表示は OFF、音は ON、音量 50、DPI 800、感度 1.5、ADS 倍率 1.0', async () => {
      const s = await shown(page);
      expect(s.inputMethod).toBe('auto');
      expect(await page.evaluate<string>(`document.getElementById('setting-input-method').selectedOptions[0].textContent.trim()`)).toBe('自動');
      expect(s.fov).toBe('90');
      expect(s.crosshairShape).toBe('dot');
      expect(await page.evaluate<string>(`document.getElementById('setting-crosshair-shape').selectedOptions[0].textContent.trim()`)).toBe('点');
      expect(s.crosshairColor).toBe('#77ccff');
      expect(s.ghost).toBe(false);
      expect(s.sound).toBe(true);
      expect(s.volume).toBe('50');
      expect(await page.evaluate<string>(`document.getElementById('setting-volume').closest('label')?.textContent.trim() ?? ''`)).toContain('音量');
      expect(s.dpi).toBe('800');
      expect(Number(s.sensitivity)).toBe(1.5);
      expect(s.sensitivity).toMatch(/^1\.5/);
      expect(Number(s.adsMultiplier)).toBe(1);
      expect(s.adsMultiplier).toMatch(/^1(\.0+)?$/);
      noExceptions(page);
    });

    it('パターンの表示は詳細で、補正のパネルの ON/OFF の項目は表示されない（#64）', async () => {
      expect(await patternDisplayLabel(page)).toBe('詳細');
      expect(await correctionPanelToggles(page), '補正のパネルの ON/OFF の項目がある').toBe(0);
      const text = await page.evaluate<string>(`document.querySelector('[data-screen="settings"]').innerText`);
      expect(text).not.toContain('センター維持');
      noExceptions(page);
    });
  });

  describe('UI-2: 感度を変えて再読み込みすると、保存の操作なしで変えた感度が残る', () => {
    it('Enter で確定して再読み込み', async () => {
      await typeInto(page, 'setting-sensitivity', '2.3', 'enter');
      await reload(page);
      expect(Number((await shown(page)).sensitivity)).toBe(2.3);
    });

    it('欄から離れて確定して再読み込み', async () => {
      await typeInto(page, 'setting-sensitivity', '0.8', 'blur');
      await reload(page);
      expect(Number((await shown(page)).sensitivity)).toBe(0.8);
    });
  });

  describe('UI-11: FOV・クロスヘアの色と形・ゴースト表示を変えて再読み込みすると、変えた値が残る', () => {
    it('FOV 100、色 #ff3366、形 十字、ゴースト ON', async () => {
      await typeInto(page, 'setting-fov', '100', 'enter');
      await setNative(page, 'setting-crosshair-color', '#ff3366');
      await setNative(page, 'setting-crosshair-shape', 'cross');
      await page.clickSelector('#setting-ghost');
      await page.waitFor(`document.getElementById('setting-ghost').checked`);
      expect((await shown(page)).ghost).toBe(true);

      await reload(page);
      const s = await shown(page);
      expect(s.fov).toBe('100');
      expect(s.crosshairColor).toBe('#ff3366');
      expect(s.crosshairShape).toBe('cross');
      expect(s.ghost).toBe(true);
      // 変えていない項目は既定値のまま。
      expect(s.sound).toBe(true);
      expect(s.dpi).toBe('800');
      noExceptions(page);
    });

    it('パターンの表示を簡易にして再読み込みすると簡易が残り、補正のパネルの項目は出ない（#64）', async () => {
      await typeInto(page, 'setting-fov', '105', 'enter');
      await choosePatternDisplay(page, '簡易');
      expect(await patternDisplayLabel(page)).toBe('簡易');
      await reload(page);
      expect(await patternDisplayLabel(page)).toBe('簡易');
      expect((await shown(page)).fov).toBe('105');
      expect(await correctionPanelToggles(page)).toBe(0);
      noExceptions(page);
    });

    it('音 OFF・音量 30 も、音 ON・音量 100 も残る', async () => {
      await page.clickSelector('#setting-sound');
      await page.waitFor(`!document.getElementById('setting-sound').checked`);
      await typeInto(page, 'setting-volume', '30', 'enter');
      await reload(page);
      let s = await shown(page);
      expect([s.sound, s.volume]).toEqual([false, '30']);
      await page.clickSelector('#setting-sound');
      await page.waitFor(`document.getElementById('setting-sound').checked`);
      await typeInto(page, 'setting-volume', '100', 'enter');
      await reload(page);
      s = await shown(page);
      expect([s.sound, s.volume]).toEqual([true, '100']);
      noExceptions(page);
    });

    it('形 輪でも残る', async () => {
      await setNative(page, 'setting-crosshair-shape', 'circle');
      await reload(page);
      expect((await shown(page)).crosshairShape).toBe('circle');
    });
  });

  describe('UI-12: 範囲の外の数は近いほうの端の値にして保存し、再読み込みしたあともその値が表示される', () => {
    it('FOV に 150 を入力すると 110', async () => {
      await typeInto(page, 'setting-fov', '150', 'enter');
      expect((await shown(page)).fov).toBe('110');
      await reload(page);
      expect((await shown(page)).fov).toBe('110');
    });

    it('FOV に 50 を入力すると 70', async () => {
      await typeInto(page, 'setting-fov', '50', 'blur');
      expect((await shown(page)).fov).toBe('70');
      await reload(page);
      expect((await shown(page)).fov).toBe('70');
    });

    it('DPI に 50 を入力すると 100', async () => {
      await typeInto(page, 'setting-dpi', '50', 'enter');
      expect((await shown(page)).dpi).toBe('100');
      await reload(page);
      expect((await shown(page)).dpi).toBe('100');
    });
  });

  describe('UI-14: 感度の欄を空にするか数として読めない値で確定すると、直前の値のまま保存され、欄の表示も戻る', () => {
    it('空にして Enter で確定（直前は既定値の 1.5）', async () => {
      await typeInto(page, 'setting-sensitivity', '', 'enter');
      expect(Number((await shown(page)).sensitivity)).toBe(1.5);
      expect((await shown(page)).sensitivity).not.toBe('');
      await reload(page);
      expect(Number((await shown(page)).sensitivity)).toBe(1.5);
    });

    it('数として読めない値を入れて欄から離れて確定（直前は 2.5）', async () => {
      await typeInto(page, 'setting-sensitivity', '2.5', 'enter');
      await typeInto(page, 'setting-sensitivity', 'abc', 'blur');
      expect(Number((await shown(page)).sensitivity)).toBe(2.5);
      await reload(page);
      expect(Number((await shown(page)).sensitivity)).toBe(2.5);
    });

    it('空にして欄から離れて確定（直前は 3）', async () => {
      await typeInto(page, 'setting-sensitivity', '3', 'enter');
      await typeInto(page, 'setting-sensitivity', '', 'blur');
      expect(Number((await shown(page)).sensitivity)).toBe(3);
      await reload(page);
      expect(Number((await shown(page)).sensitivity)).toBe(3);
    });
  });

  describe('UI-15: localStorage に JSON として読めない設定の値があっても、エラーで止まらず既定値が表示される', () => {
    it('設定を変えて増えた保存先のキーをすべて壊れた文字列にして開き直す', async () => {
      const before = await page.evaluate<string[]>('Object.keys(localStorage)');
      // 共通とマウスの両方の区分の保存先を作るため、両方の項目を変える。
      await typeInto(page, 'setting-fov', '100', 'enter');
      await setNative(page, 'setting-crosshair-shape', 'cross');
      await page.clickSelector('#setting-sound');
      await typeInto(page, 'setting-dpi', '1600', 'enter');
      await typeInto(page, 'setting-sensitivity', '2', 'enter');
      const after = await page.evaluate<string[]>('Object.keys(localStorage)');
      const keys = after.filter((k) => !before.includes(k));
      expect(keys.length, '設定を変えても localStorage に何も保存されていない').toBeGreaterThan(0);

      await page.evaluate(`for (const k of ${JSON.stringify(keys)}) localStorage.setItem(k, '{"broken": ')`);
      const fresh = await browser!.newPage();
      await fresh.goto(settingsUrl());
      await waitSettings(fresh);
      const s = await shown(fresh);
      expect(s).toEqual({
        inputMethod: 'auto',
        fov: '90',
        crosshairColor: '#77ccff',
        crosshairShape: 'dot',
        ghost: false,
        sound: true,
        volume: '50',
        dpi: '800',
        sensitivity: s.sensitivity,
        adsMultiplier: s.adsMultiplier,
        cmPer360: '34.6',
      });
      expect(Number(s.sensitivity)).toBe(1.5);
      expect(Number(s.adsMultiplier)).toBe(1);
      noExceptions(fresh);
      // 壊れた値のまま開いても、そのあと変えた設定はまた保存される。
      await typeInto(fresh, 'setting-fov', '80', 'enter');
      await reload(fresh);
      expect((await shown(fresh)).fov).toBe('80');
      noExceptions(fresh);
    });
  });

  describe('MOU-4: DPI 800・感度 1.5 を入力すると cm/360 が 34.6 と表示される', () => {
    it('別の値にしてから DPI 800・感度 1.5 を入力し直す', async () => {
      await typeInto(page, 'setting-dpi', '1600', 'enter');
      await typeInto(page, 'setting-sensitivity', '3', 'enter');
      expect((await shown(page)).cmPer360).not.toBe('34.6');
      await typeInto(page, 'setting-dpi', '800', 'enter');
      await typeInto(page, 'setting-sensitivity', '1.5', 'enter');
      expect((await shown(page)).cmPer360).toBe('34.6');
    });
  });

  describe('MOU-12: DPI 1600・感度 1.0 で cm/360 が 26.0、続けて ADS 倍率を 0.5 にしても 26.0 のまま', () => {
    it('入力したその場（確定の前）と確定のあと、ADS 倍率を変えたあと', async () => {
      await typeInto(page, 'setting-dpi', '1600', 'enter');
      await typeInto(page, 'setting-sensitivity', '1.0', 'none');
      expect((await shown(page)).cmPer360, '確定の前（その場）の表示').toBe('26.0');
      await press(page, 'Enter');
      expect((await shown(page)).cmPer360).toBe('26.0');
      await typeInto(page, 'setting-ads-multiplier', '0.5', 'enter');
      const s = await shown(page);
      expect(Number(s.adsMultiplier)).toBe(0.5);
      expect(s.cmPer360).toBe('26.0');
      noExceptions(page);
    });
  });
  describe('練習は「開始」を押した時点で保存されている設定で始まる（screens.md「設定項目」、mouse.md の換算）', () => {
    /** 設定画面からトップ画面に戻り（読み直さない）、「開始」を押してプレイ画面に入る。 */
    async function startFromTop(p: Page) {
      await p.clickSelector('[data-screen="settings"] a[href="#/"]');
      await p.waitFor(`!document.querySelector('[data-screen="top"]').hidden && document.querySelector('#weapon').options.length > 0`);
      await p.clickSelector('#start');
      await p.waitFor(`!document.querySelector('[data-screen="play"]').hidden`);
      // プレイ画面の描画が始まるまで待つ（的の位置は canvasOnly が画面の動きが止まるのを待って写す）。
      await p.frames(5);
    }

    /** 開始時に画面の中心に見える的（板）の色を返し、ポインターロックを掛ける。 */
    async function targetColorAndLock(p: Page): Promise<RGB> {
      const start = await canvasOnly(p);
      const target = boardColor(start);
      expect(Math.abs(blobCenter(start, 'row', CY, target)! - CX), '開始時に的が中心にない').toBeLessThanOrEqual(2);
      expect(distance(target, start.pixel(CX + 150, CY)), '開始時に中心に的が見えない').toBeGreaterThan(40);
      await p.click(CX, CY);
      await p.waitFor('!!document.pointerLockElement', 5000);
      return target;
    }

    it('クロスヘア: 保存した色 #ff3366 と形 十字がプレイ画面のクロスヘアに当たる', async () => {
      await setNative(page, 'setting-crosshair-color', '#ff3366');
      await setNative(page, 'setting-crosshair-shape', 'cross');
      await startFromTop(page);
      const crosshair = await page.evaluate<{ shape: string; color: string }>(`(() => {
        const el = document.querySelector('[data-screen="play"] .crosshair');
        return { shape: el.dataset.shape, color: getComputedStyle(el).getPropertyValue('--crosshair-color').trim().toLowerCase() };
      })()`);
      expect(crosshair).toEqual({ shape: 'cross', color: '#ff3366' });
      noExceptions(page);
    }, 60_000);

    it('感度と FOV: 感度 2.0・FOV 110 で前に 1000 カウント動かすと、ピッチが 44 度（既定の 33 度でなく）増えて描画される', async () => {
      await typeInto(page, 'setting-fov', '110', 'enter');
      await typeInto(page, 'setting-sensitivity', '2.0', 'enter');
      await startFromTop(page);
      const target = await targetColorAndLock(page);
      // 前（movementY が負）に 1000 カウント。
      await drag(page, 0, -10, 100);
      const center = blobCenter(await canvasOnly(page), 'column', CX, target);
      // ピッチが上がると、的は画面の中心から 高さの半分 × tan(44°) ÷ tan(縦の視野角 / 2) 下に描画される（screens.md）。
      const expected = CY + projectAngleOffset({ yaw: 0, pitch: -44 }, 110, WIDTH, HEIGHT).y;
      const withDefaultSensitivity = CY + projectAngleOffset({ yaw: 0, pitch: -33 }, 110, WIDTH, HEIGHT).y;
      expect(expected - withDefaultSensitivity).toBeGreaterThan(80);
      expect(center, `的の中心 ${center} 期待 ${expected}`).toBeDefined();
      expect(Math.abs(center! - expected), `的の中心 ${center} 期待 ${expected}`).toBeLessThanOrEqual(8);
      noExceptions(page);
    }, 60_000);

    it('FOV: FOV 70 で右に 1000 カウント動かすと、的が FOV 70 の視野角で 33 度ぶん左に描画される', async () => {
      await typeInto(page, 'setting-fov', '70', 'enter');
      await startFromTop(page);
      const target = await targetColorAndLock(page);
      await drag(page, 10, 0, 100);
      const center = blobCenter(await canvasOnly(page), 'row', CY, target);
      // カメラの視野角が fieldOfView(70) なら約 495 px 左、既定の FOV 90 のままなら約 346 px 左。
      const expected = CX - projectAngleOffset({ yaw: 33, pitch: 0 }, 70, WIDTH, HEIGHT).x;
      const withDefaultFov = CX - projectAngleOffset({ yaw: 33, pitch: 0 }, 90, WIDTH, HEIGHT).x;
      expect(withDefaultFov - expected).toBeGreaterThan(80);
      expect(center, `的の中心 ${center} 期待 ${expected}`).toBeDefined();
      expect(Math.abs(center! - expected), `的の中心 ${center} 期待 ${expected}`).toBeLessThanOrEqual(8);
      noExceptions(page);
    }, 60_000);
  });
});
