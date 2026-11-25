// docs/spec/overview.md の受け入れ条件（OVR-2・OVR-4・OVR-6）と、「公開」「保存」の振る舞いの受け入れテスト。
// 公開された入口（npm run check:assets、ビルドの結果を /apex-training/ で配信した画面）だけを使い、実装の内部には依存しない。
// 画面の確認はビルドの結果をヘッドレスの Chromium で開いて行う（tests/helpers/browser.ts）。Chromium がなければ飛ばす。
// ARC-13 の clone の中で npm test を実行したときに入れ子で重い確認をしないよう、APEX_ACCEPTANCE_NESTED が立っていたら飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findChromium, launchBrowser, serveStatic, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const SERVER_PORT = 3104;
const DEBUG_PORT = 3105;
const NOTICE = 'この環境では設定と記録を保存できません。練習はそのまま続けられます。';
const UNOFFICIAL = /非公式ファンツール.*EA \/ Respawn.*無関係/;

/** SPEC（overview.md「素材の一覧」）に書かれた、素材の一覧に載っていなければ配布物に含めない拡張子。 */
const FORBIDDEN = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'weba'],
  model: ['glb', 'gltf', 'fbx', 'obj', 'dae', '3ds', 'blend', 'usdz'],
};

const temps: string[] = [];
let dist = '';

function run(command: string, cwd: string) {
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

beforeAll(() => {
  if (NESTED) return;
  const out = mkdtempSync(join(tmpdir(), 'ovr-dist-'));
  temps.push(out);
  const build = run(`npm run build -- --outDir "${out}" --emptyOutDir`, ROOT);
  if (build.status !== 0) throw new Error(`ビルドが失敗した:\n${build.output}`);
  dist = out;
}, 300_000);

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** ビルドの結果の写しを作る。 */
function copyOfDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ovr-copy-'));
  temps.push(dir);
  cpSync(dist, dir, { recursive: true });
  return dir;
}

describe.skipIf(NESTED)('OVR-2: 配布物の検査（npm run check:assets）', () => {
  const checkAssets = (dir: string) => run(`npm run --silent check:assets -- "${dir}"`, ROOT);

  it('ビルドの結果そのものには画像・音声・3D モデルのファイルがなく、検査が成功する', () => {
    const exts = Object.values(FORBIDDEN).flat();
    const found = filesUnder(dist).filter((f) => exts.includes(f.split('.').pop()!.toLowerCase()));
    expect(found).toEqual([]);
    const result = checkAssets(dist);
    expect(result.status, result.output).toBe(0);
  });

  it('引数なしの npm run check:assets は dist/ を調べ、ビルドの結果なら成功し、画像を置くと失敗する', () => {
    // リポジトリの dist/ を書き換えないよう、package.json と scripts/ と素材の一覧と dist/ の写しで実行する。
    const repo = mkdtempSync(join(tmpdir(), 'ovr-repo-'));
    temps.push(repo);
    cpSync(join(ROOT, 'package.json'), join(repo, 'package.json'));
    cpSync(join(ROOT, 'scripts'), join(repo, 'scripts'), { recursive: true });
    cpSync(join(ROOT, 'src/assets/assets.json'), join(repo, 'src/assets/assets.json'));
    cpSync(dist, join(repo, 'dist'), { recursive: true });
    const ok = run('npm run --silent check:assets', repo);
    expect(ok.status, ok.output).toBe(0);

    writeFileSync(join(repo, 'dist/assets/logo.png'), '');
    const ng = run('npm run --silent check:assets', repo);
    expect(ng.status, ng.output).not.toBe(0);
    expect(ng.output).toContain(['assets', 'logo.png'].join(sep === '\\' ? '\\' : '/'));
  });

  for (const [kind, exts] of Object.entries(FORBIDDEN)) {
    it.each(exts)(`${kind}: ビルドの結果に .%s のファイルを置くと、そのパスを示して失敗する`, (ext) => {
      const dir = copyOfDist();
      mkdirSync(join(dir, 'assets/nested'), { recursive: true });
      const file = join(dir, `assets/nested/sample.${ext}`);
      writeFileSync(file, 'x');
      const result = checkAssets(dir);
      expect(result.status, result.output).not.toBe(0);
      // 絶対パスか、ビルドの結果からの相対パスのどちらかでファイルを示す。
      const rel = relative(dir, file).split(sep).join('/');
      expect(result.output.includes(file) || result.output.includes(rel), result.output).toBe(true);
    });
  }

  it('複数のファイルを置くと、それぞれのパスを示して失敗する', () => {
    const dir = copyOfDist();
    writeFileSync(join(dir, 'icon.svg'), '<svg/>');
    writeFileSync(join(dir, 'assets/shot.wav'), '');
    writeFileSync(join(dir, 'assets/gun.glb'), '');
    const result = checkAssets(dir);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain('icon.svg');
    expect(result.output).toContain('shot.wav');
    expect(result.output).toContain('gun.glb');
  });
});

const chromium = findChromium();

describe.skipIf(NESTED || !chromium)('画面（ビルドの結果を /apex-training/ で配信してブラウザで開く）', () => {
  let server: Server | undefined;
  let browser: Browser | undefined;
  const origin = `http://127.0.0.1:${SERVER_PORT}`;
  const url = (hash: string) => `${origin}${BASE}${hash}`;

  beforeAll(async () => {
    server = await serveStatic(dist, BASE, SERVER_PORT);
    browser = await launchBrowser(chromium!, DEBUG_PORT);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((ok) => (server ? server.close(ok) : ok(undefined)));
  });

  /** 表示されている（hidden でなく、大きさがあり、display/visibility で隠れていない）画面の名前の一覧。 */
  const visibleScreens = (page: Page) =>
    page.evaluate<string[]>(`[...document.querySelectorAll('[data-screen]')].filter((el) => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return !el.hidden && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    }).map((el) => el.dataset.screen)`);

  /** 画面に見えている文字。 */
  const visibleText = (page: Page) => page.evaluate<string>('document.body.innerText');

  /** フッターの保存できない表示と非公式の表記の、文字と位置。 */
  const footerState = (page: Page) =>
    page.evaluate<{
      notice: { text: string; visible: boolean; bottom: number; left: number; right: number } | null;
      unofficial: { text: string; top: number; left: number; right: number } | null;
      between: string[];
    }>(`(() => {
      const all = [...document.querySelectorAll('footer *, footer')];
      const notice = all.find((el) => el.children.length === 0 && el.textContent.trim() === ${JSON.stringify(NOTICE)});
      const unofficial = all.find((el) => el.children.length === 0 && /非公式ファンツール/.test(el.textContent));
      const box = (el) => el && el.getBoundingClientRect();
      const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
        return !el.closest('[hidden]') && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
      // 表示と非公式の表記のあいだ（縦方向）に見えている、文字を持つほかの要素。
      const between = [];
      if (notice && unofficial) {
        const nb = box(notice).bottom, ut = box(unofficial).top;
        for (const el of document.querySelectorAll('body *')) {
          if (el === notice || el === unofficial || el.contains(notice) || el.contains(unofficial) || el.children.length > 0) continue;
          if (!visible(el) || !el.textContent.trim()) continue;
          const r = el.getBoundingClientRect();
          if (r.top >= nb - 1 && r.bottom <= ut + 1) between.push(el.textContent.trim());
        }
      }
      return {
        notice: notice ? { text: notice.textContent.trim(), visible: visible(notice), bottom: box(notice).bottom, left: box(notice).left, right: box(notice).right } : null,
        unofficial: unofficial ? { text: unofficial.textContent.trim(), top: box(unofficial).top, left: box(unofficial).left, right: box(unofficial).right } : null,
        between,
      };
    })()`);

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  describe('OVR-6: どの画面にも当たらないハッシュやハッシュなしで開くとトップ画面が表示される', () => {
    it.each(['', '#', '#/', '#/unknown', '#/settings/unknown', '#settings', '#/unknown/deep?x=1', '#/%E3%81%82'])(
      '%j で開くとトップ画面だけが表示される',
      async (hash) => {
        const page = await browser!.newPage();
        await page.goto(url(hash));
        await page.waitFor(`document.querySelector('[data-screen="top"]') && !document.querySelector('[data-screen="top"]').hidden`);
        await pause(200);
        expect(await visibleScreens(page)).toEqual(['top']);
        const text = await visibleText(page);
        expect(text).toContain('開始');
        expect(page.errors).toEqual([]);
      },
      30_000,
    );

    it('設定画面を開いたあとにどの画面にも当たらないハッシュへ変えると、トップ画面に切り替わる', async () => {
      const page = await browser!.newPage();
      await page.goto(url('#/settings'));
      await page.waitFor(`!document.querySelector('[data-screen="settings"]').hidden`);
      expect(await visibleScreens(page)).toEqual(['settings']);
      await page.evaluate(`location.hash = '#/unknown'`);
      await page.waitFor(`!document.querySelector('[data-screen="top"]').hidden`);
      await pause(200);
      expect(await visibleScreens(page)).toEqual(['top']);
      expect(page.errors).toEqual([]);
    }, 30_000);

    it('対照: #/settings を直接開くと設定画面が表示される（トップ画面ではない）', async () => {
      const page = await browser!.newPage();
      await page.goto(url('#/settings'));
      await page.waitFor(`!document.querySelector('[data-screen="settings"]').hidden`);
      expect(await visibleScreens(page)).toEqual(['settings']);
    }, 30_000);
  });

  describe('振る舞い: 3D のキャンバスを画面いっぱいに置き、その上に各画面の HTML を重ねる', () => {
    it.each(['#/', '#/settings', '#/play'])('%s で、キャンバスが画面いっぱいで、画面の HTML がキャンバスより手前にある', async (hash) => {
      const page = await browser!.newPage();
      await page.goto(url(hash));
      await pause(500);
      const state = await page.evaluate<{
        canvases: { x: number; y: number; w: number; h: number }[];
        vw: number;
        vh: number;
        scroll: { w: number; h: number };
        hit: boolean;
      }>(`(() => {
        const canvases = [...document.querySelectorAll('canvas')].map((c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
        // 表示中の画面の中のリンクの中心をヒットテストすると、キャンバスではなくそのリンク（か子孫）が当たる。
        // HUD の文字はクリックをキャンバスへ通すことがある（pointer-events: none）ので、押せるはずのリンクで確かめる。
        const screen = [...document.querySelectorAll('[data-screen]')].find((el) => !el.hidden);
        const target = screen && [...screen.querySelectorAll('a')].find((el) => el.getBoundingClientRect().width > 0);
        let hit = false;
        if (target) { const r = target.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          hit = !!el && el.tagName !== 'CANVAS' && (target === el || target.contains(el) || el.contains(target)); }
        return { canvases, vw: innerWidth, vh: innerHeight, scroll: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }, hit };
      })()`);
      expect(state.canvases.length).toBeGreaterThanOrEqual(1);
      const full = state.canvases.find((c) => Math.abs(c.x) < 1 && Math.abs(c.y) < 1 && Math.abs(c.w - state.vw) < 1 && Math.abs(c.h - state.vh) < 1);
      expect(full, JSON.stringify(state)).toBeDefined();
      expect(state.hit, '画面の HTML がキャンバスの手前にない').toBe(true);
      // 重ねているので、ページが縦横にスクロールしない。
      expect(state.scroll.w).toBeLessThanOrEqual(state.vw);
      expect(state.scroll.h).toBeLessThanOrEqual(state.vh);
    }, 30_000);

    it.each(['#/', '#/settings'])('%s で、フッターの中心をヒットテストするとキャンバスに当たらず、クリックしてもポインターロックがかからない', async (hash) => {
      const page = await browser!.newPage();
      await page.goto(url(hash));
      await pause(500);
      const state = await page.evaluate<{ tag: string | null; inFooter: boolean; x: number; y: number }>(`(() => {
        const footer = document.querySelector('footer');
        const r = footer.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const el = document.elementFromPoint(x, y);
        return { tag: el ? el.tagName : null, inFooter: !!el && footer.contains(el), x, y };
      })()`);
      expect(state.tag, JSON.stringify(state)).not.toBe('CANVAS');
      expect(state.inFooter, JSON.stringify(state)).toBe(true);
      await page.click(state.x, state.y);
      await pause(500);
      expect(await page.evaluate<boolean>('document.pointerLockElement === null')).toBe(true);
    }, 30_000);

    it('ウィンドウの大きさを変えると、キャンバスも画面いっぱいに追従する', async () => {
      const page = await browser!.newPage();
      await page.goto(url('#/'));
      await page.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
      await pause(500);
      const r = await page.evaluate<{ w: number; h: number }>(`(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { w: r.width, h: r.height }; })()`);
      expect(r).toEqual({ w: 900, h: 600 });
    }, 30_000);
  });

  describe('OVR-4: localStorage への書き込みが例外になる環境', () => {
    // 書き込み（setItem）だけが例外になる環境と、localStorage を取り出すこと自体が例外になる環境（保存を拒否した設定など）。
    const environments: Record<string, string> = {
      'setItem が QuotaExceededError になる': `Storage.prototype.setItem = function () { throw new DOMException('quota', 'QuotaExceededError'); };`,
      'localStorage の参照が SecurityError になる': `Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });`,
    };

    for (const [name, init] of Object.entries(environments)) {
      it(`${name}: 開いて練習を始めても止まらず、フッターの非公式の表記のすぐ上に表示が出て、消えない`, async () => {
        const page = await browser!.newPage();
        await page.addInitScript(init);
        await page.goto(url(''));
        await page.waitFor(`!document.querySelector('[data-screen="top"]').hidden`);
        await pause(300);

        // トップ画面が表示され、表示が非公式の表記のすぐ上に出ている。
        expect(await visibleScreens(page)).toEqual(['top']);
        const top = await footerState(page);
        expect(top.notice, JSON.stringify(top)).not.toBeNull();
        expect(top.notice!.visible).toBe(true);
        expect(top.notice!.text).toBe(NOTICE);
        expect(top.unofficial!.text).toMatch(UNOFFICIAL);
        expect(top.notice!.bottom).toBeLessThanOrEqual(top.unofficial!.top + 1);
        expect(top.unofficial!.top - top.notice!.bottom, '表示と非公式の表記が離れている').toBeLessThan(40);
        expect(top.between).toEqual([]);

        // 練習を始める（「開始」を押す）と、プレイ画面になって照準の操作を始められる。
        await page.clickSelector('[data-screen="top"] a[href="#/play"]');
        await page.waitFor(`!document.querySelector('[data-screen="play"]').hidden`);
        await pause(500);
        expect(await visibleScreens(page)).toEqual(['play']);
        await page.click(640, 400);
        await page.waitFor('document.pointerLockElement !== null', 5_000);
        expect(await page.evaluate<string>('document.pointerLockElement.tagName')).toBe('CANVAS');
        for (let i = 0; i < 10; i += 1) await page.moveMouse(640 + i * 5, 400 + i * 2);
        await pause(300);

        const play = await footerState(page);
        expect(play.notice?.visible).toBe(true);
        expect(play.notice?.text).toBe(NOTICE);
        expect(play.notice!.bottom).toBeLessThanOrEqual(play.unofficial!.top + 1);

        // ほかの画面へ移っても、ページを開いている間は表示が消えない。
        await page.evaluate(`document.exitPointerLock()`);
        for (const hash of ['#/settings', '#/settings/pad', '#/', '#/result']) {
          await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
          await pause(300);
          const state = await footerState(page);
          expect(state.notice?.visible, hash).toBe(true);
          expect(state.notice?.text, hash).toBe(NOTICE);
        }
        await pause(1500);
        expect((await footerState(page)).notice?.visible).toBe(true);

        // エラーで止まっていない（捕まらなかった例外がない）。
        expect(page.errors.filter((e) => e.startsWith('exception:')), page.errors.join('\n')).toEqual([]);
      }, 60_000);
    }

    it('対照: localStorage が使える環境では表示が出ない', async () => {
      const page = await browser!.newPage();
      await page.goto(url(''));
      await page.waitFor(`!document.querySelector('[data-screen="top"]').hidden`);
      await pause(300);
      const state = await footerState(page);
      expect(state.notice).toBeNull();
      expect(await visibleText(page)).not.toContain(NOTICE);
      expect(page.errors).toEqual([]);
    }, 30_000);

    it('振る舞い: 起動時に localStorage へ試しに書き込み、それが通れば起動直後は表示が出ない', async () => {
      // 1 回目の書き込みだけを通し、2 回目以降を例外にする。起動後の保存を画面から起こす手段（設定項目）はまだないため、
      // 「起動後の保存で例外になったときの表示」はここでは確かめない。
      const page = await browser!.newPage();
      await page.addInitScript(`(() => {
        const original = Storage.prototype.setItem; let calls = 0;
        window.__setItemCalls = () => calls;
        Storage.prototype.setItem = function (...args) { calls += 1; if (calls > 1) throw new DOMException('quota', 'QuotaExceededError'); return original.apply(this, args); };
      })()`);
      await page.goto(url(''));
      await page.waitFor(`!document.querySelector('[data-screen="top"]').hidden`);
      await pause(300);
      const calls = await page.evaluate<number>('window.__setItemCalls()');
      // 起動時に localStorage へ試しに書き込んでいる。
      expect(calls).toBeGreaterThanOrEqual(1);
      if (calls === 1) {
        expect((await footerState(page)).notice).toBeNull();
      }
      expect(page.errors.filter((e) => e.startsWith('exception:'))).toEqual([]);
    }, 30_000);
  });
});
