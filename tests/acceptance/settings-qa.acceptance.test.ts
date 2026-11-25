// docs/spec/screens.md の設定画面の受け入れ条件（UI-2・UI-11〜UI-15）と docs/spec/mouse.md の MOU-4・MOU-12 の QA の受け入れテスト。
// 公開された入口だけを使う: ビルドの結果を /apex-training/ で配信した設定画面（#/settings）の入力欄と cm/360 の表示。
// 画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、文字の入力・Enter・クリックは DevTools プロトコルで実際の入力として送る。
// 色の選択（input type="color"）と選択肢（select）はネイティブのピッカーを操作できないため、値を入れて input / change を発火させる。
// 保存先の localStorage のキーは実装の内部なので決め打ちせず、設定を変えたあとに増えたキーを保存先とみなす（UI-15）。
// サーバーと DevTools のポートは OS に選ばせる（並行して動くほかの作業ツリーとぶつからないように）。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findChromium, launchBrowser, serveStatic, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const chromium = findChromium();
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Shown {
  inputMethod: string;
  fov: string;
  crosshairColor: string;
  crosshairShape: string;
  ghost: boolean;
  sound: boolean;
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

/** 入力欄をクリックして中身を選び、text を打つ。commit が 'enter' なら Enter で、'blur' なら見出しをクリックして欄から離れて確定する。 */
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
  if (commit === 'blur') await page.clickSelector('[data-screen="settings"] h2');
  await pause(100);
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
    server = await serveStatic(out, BASE, 0);
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await launchBrowser(chromium!, 0);
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((ok) => (server ? server.close(ok) : ok(undefined)));
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  const settingsUrl = () => `${origin}${BASE}#/settings`;
  const waitSettings = (p: Page) =>
    p.waitFor(`document.querySelector('[data-screen="settings"]') && !document.querySelector('[data-screen="settings"]').hidden && document.getElementById('setting-fov')`);

  /** 設定画面を開き直す（再読み込み）。 */
  async function reload(p: Page) {
    await p.send('Page.reload', { ignoreCache: true });
    await pause(200);
    await p.waitFor('document.readyState === "complete"');
    await waitSettings(p);
    await pause(200);
  }

  const noExceptions = (p: Page) => expect(p.errors.filter((e) => e.startsWith('exception:')), p.errors.join('\n')).toEqual([]);

  // 毎回、保存された設定のない状態（一度も変えていない状態）から始める。
  beforeEach(async () => {
    page = await browser!.newPage();
    await page.goto(settingsUrl());
    await page.evaluate('localStorage.clear()');
    await reload(page);
  });

  describe('UI-13: 設定を一度も変えずに開くと既定値が表示される', () => {
    it('入力方式は自動、FOV 90、クロスヘアは点と #77ccff、ゴースト表示と音は ON、DPI 800、感度 1.5、ADS 倍率 1.0', async () => {
      const s = await shown(page);
      expect(s.inputMethod).toBe('auto');
      expect(await page.evaluate<string>(`document.getElementById('setting-input-method').selectedOptions[0].textContent.trim()`)).toBe('自動');
      expect(s.fov).toBe('90');
      expect(s.crosshairShape).toBe('dot');
      expect(await page.evaluate<string>(`document.getElementById('setting-crosshair-shape').selectedOptions[0].textContent.trim()`)).toBe('点');
      expect(s.crosshairColor).toBe('#77ccff');
      expect(s.ghost).toBe(true);
      expect(s.sound).toBe(true);
      expect(s.dpi).toBe('800');
      expect(Number(s.sensitivity)).toBe(1.5);
      expect(s.sensitivity).toMatch(/^1\.5/);
      expect(Number(s.adsMultiplier)).toBe(1);
      expect(s.adsMultiplier).toMatch(/^1(\.0+)?$/);
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
    it('FOV 100、色 #ff3366、形 十字、ゴースト OFF', async () => {
      await typeInto(page, 'setting-fov', '100', 'enter');
      await setNative(page, 'setting-crosshair-color', '#ff3366');
      await setNative(page, 'setting-crosshair-shape', 'cross');
      await page.clickSelector('#setting-ghost');
      await pause(100);
      expect((await shown(page)).ghost).toBe(false);

      await reload(page);
      const s = await shown(page);
      expect(s.fov).toBe('100');
      expect(s.crosshairColor).toBe('#ff3366');
      expect(s.crosshairShape).toBe('cross');
      expect(s.ghost).toBe(false);
      // 変えていない項目は既定値のまま。
      expect(s.sound).toBe(true);
      expect(s.dpi).toBe('800');
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
      await pause(300);
      const s = await shown(fresh);
      expect(s).toEqual({
        inputMethod: 'auto',
        fov: '90',
        crosshairColor: '#77ccff',
        crosshairShape: 'dot',
        ghost: true,
        sound: true,
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
      await pause(100);
      expect((await shown(page)).cmPer360).toBe('26.0');
      await typeInto(page, 'setting-ads-multiplier', '0.5', 'enter');
      const s = await shown(page);
      expect(Number(s.adsMultiplier)).toBe(0.5);
      expect(s.cmPer360).toBe('26.0');
      noExceptions(page);
    });
  });
});
