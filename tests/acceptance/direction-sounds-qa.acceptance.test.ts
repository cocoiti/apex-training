// docs/spec/screens.md「音」（UI-75〜UI-83）、docs/spec/modes.md の MODE-29・MODE-30 の QA の受け入れテスト。
// 公開された入口だけを使う: ビルドの結果を /apex-training/ で配信した画面（トップ・設定・プレイ・リザルト）、index.html の要素
// （#preview-sound・#preview-sound-note・#setting-sound・#setting-volume）、武器の JSON。画面はヘッドレスの Chromium で開く。
//
// 「音を鳴らす処理が呼ばれた」は、ブラウザの Web Audio の入口（OscillatorNode の start）を、ページのスクリプトより先に
// 包んで記録して読む（音はすべて Web Audio でその場で合成する、という SPEC による）。記録するのは、呼ばれた時刻、鳴り始めの時刻
// （start の when を描画の時計に直したもの）、発振器の高さ（frequency に入れた値）と波形（type）、そのあと音が切られたか
// （stop の時刻・disconnect・つないだ先の GainNode の disconnect と cancelScheduledValues・AudioContext の close / suspend）。
// 鳴り始めより前に切られた音は「鳴らない」とみなす。start の when（音の時計の秒）もそのまま記録し、試聴の音の時刻の間隔はこれで比べる。
// 音と発の対応は、HUD の残弾が変わった時刻（MutationObserver）のうち、音を鳴らす処理が呼ばれた時刻に最も近いもので決める。
// 発射の間隔は描画の間隔より十分に長くする（rpm 200 = 0.3 秒、L-STAR は 0.1 秒）。
//
// リポジトリの写しに受け入れテスト用の武器（measured が true、randomness 0）を足してビルドした画面で確かめる。
// - QA-三方向: 28 発。1〜8 発目で照準を下へ、9〜20 発目で左下へ、21〜28 発目で右下へ動かす直線（簡易版の区切りが UI-75 のとおり）。
// - QA-向き-<向き>: 9 つの向きそれぞれの、区切りが 1 本だけの武器（UI-76 の試聴に使う）。
// パッドは Gamepad API（navigator.getGamepads）の形で与え、R2 で撃つ。サーバーと DevTools のポートは OS に選ばせる。
// 画面は render=off（3D を描かない）で開く。試聴は clock=manual で開き、ページの時計を進めて確かめる（実時間で測らない）。
// 待ちは sleep にせず、画面の状態か時計の条件で待つ。Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';
import { oracleSimplePattern } from '../helpers/simple-pattern-oracle';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const chromium = findChromium();

const GHOST = '反復練習';
const CENTER = 'センター維持';
const PREVIEW_LABEL = 'パターンの音を聞く';
const STOP_LABEL = '止める';

interface WeaponJson {
  id: string;
  name: string;
  category: string;
  version: string;
  source: string;
  measured: boolean;
  rpm: number;
  magSize: number;
  randomness: number;
  pattern: { dx: number; dy: number }[];
}
const load = (id: string) => JSON.parse(readFileSync(join(ROOT, 'src/data/weapons', `${id}.json`), 'utf8')) as WeaponJson;
const LSTAR = load('lstar');
const CAR = load('car');

const qa = (id: string, name: string, rpm: number, pattern: { dx: number; dy: number }[]): WeaponJson => ({
  id,
  name,
  category: 'QA',
  version: 'S31-Cipher',
  source: '仮データ（受け入れテスト）',
  measured: true,
  rpm,
  magSize: pattern.length,
  randomness: 0,
  pattern,
});

// 照準を動かす向き（理想の補正軌道の向き）が (ux, uy) なら、リコイルの pattern はその反転。
const step = (ux: number, uy: number) => ({ dx: -ux, dy: -uy });
/** 1〜8 発目は下、9〜20 発目は左下、21〜28 発目は右下へ照準を動かす。 */
const THREE = qa('qa-sound-three', 'QA-三方向', 200, [
  ...Array.from({ length: 8 }, () => step(0, -1)),
  ...Array.from({ length: 12 }, () => step(-1, -1)),
  ...Array.from({ length: 8 }, () => step(1, -1)),
]);
const THREE_LABELS = ['1〜8 発: ↓ 下', '9〜20 発: ↙ 左下', '21〜28 発: ↘ 右下'];

/** SPEC の「音」の表（向き → 高さ・波形）。 */
const TONES: Record<string, { freq: number; type: OscillatorType }> = {
  左上: { freq: 330, type: 'square' },
  上: { freq: 440, type: 'square' },
  右上: { freq: 660, type: 'square' },
  左: { freq: 330, type: 'triangle' },
  動かさない: { freq: 440, type: 'triangle' },
  右: { freq: 660, type: 'triangle' },
  左下: { freq: 330, type: 'sine' },
  下: { freq: 440, type: 'sine' },
  右下: { freq: 660, type: 'sine' },
};
const DIRS: [string, number, number][] = [
  ['上', 0, 1],
  ['右上', 1, 1],
  ['右', 1, 0],
  ['右下', 1, -1],
  ['下', 0, -1],
  ['左下', -1, -1],
  ['左', -1, 0],
  ['左上', -1, 1],
  ['動かさない', 0, 0],
];
const DIR_WEAPONS = DIRS.map(([name, ux, uy], k) =>
  qa(`qa-sound-dir-${k}`, `QA-向き-${name}`, 600, Array.from({ length: 4 }, () => (ux === 0 && uy === 0 ? { dx: 0.01, dy: 0 } : step(ux, uy)))),
);

/** 区切りの言葉の向きの名前（「1〜8 発: ↓ 下」→「下」）。 */
const dirOf = (label: string) => label.replace(/^.*発: \S+ /, '');

// ---------------------------------------------------------------------------

const PAGE_INIT = `
  window.__pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) };
  navigator.getGamepads = () => [{ id: 'acceptance pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard',
    timestamp: performance.now(), axes: window.__pad.axes.slice(), buttons: window.__pad.buttons.map((b) => ({ ...b })), vibrationActuator: null }];
  window.__btn = (i, on) => { window.__pad.buttons[i] = { value: on ? 1 : 0, pressed: on, touched: on }; };
  window.__num = (sel) => { const m = (document.querySelector(sel)?.textContent ?? '').match(/-?\\d+(?:\\.\\d+)?/); return m ? Number(m[0]) : NaN; };
  window.__ammo = () => window.__num('[data-hud="ammo"]');
  window.__time = () => window.__num('[data-hud="time"]');
  window.__inputShown = () => (document.querySelector('[data-hud="input"]')?.textContent ?? '').trim();
  window.__vis = (sel) => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    return !!el && !el.closest('[hidden]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0; };
  window.__interlude = () => window.__vis('#interlude');
  window.__nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  window.__label = () => (document.getElementById('preview-sound')?.textContent ?? '').trim();

  // HUD の残弾と試聴のボタンの表示が変わった時刻。
  window.__ammoLog = [];
  window.__labelLog = [];
  window.__clicks = [];
  const watch = () => {
    let lastAmmo = NaN; let lastLabel = '';
    const check = () => {
      const a = window.__ammo();
      if (!Number.isNaN(a) && a !== lastAmmo) { window.__ammoLog.push({ perf: performance.now(), ammo: a }); }
      lastAmmo = a;
      const l = window.__label();
      if (l !== lastLabel) { window.__labelLog.push({ perf: performance.now(), label: l }); lastLabel = l; }
    };
    new MutationObserver(check).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    check();
    document.addEventListener('click', (e) => { if (e.target instanceof Element && e.target.closest('#preview-sound')) window.__clicks.push(performance.now()); }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();

  // Web Audio の入口を包んで記録する。
  (() => {
    window.__oscs = [];
    window.__ctxs = [];
    if (window.__noAudio) {
      delete window.AudioContext; delete window.webkitAudioContext;
      try { Object.defineProperty(window, 'AudioContext', { value: undefined, configurable: true }); } catch {}
      try { Object.defineProperty(window, 'webkitAudioContext', { value: undefined, configurable: true }); } catch {}
      return;
    }
    if (!window.AudioContext || !window.AudioNode || !window.AudioParam) return;
    const now = () => performance.now();
    const params = new WeakMap();
    const outs = new WeakMap();
    const disc = new WeakMap();
    const logParam = (p, kind, v) => { let a = params.get(p); if (!a) params.set(p, (a = [])); a.push({ kind, v, perf: now() }); };
    const AP = AudioParam.prototype;
    for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime']) {
      const o = AP[m]; if (o) AP[m] = function (v, ...rest) { logParam(this, m, v); return o.call(this, v, ...rest); };
    }
    const oc = AP.cancelScheduledValues;
    AP.cancelScheduledValues = function (...a) { logParam(this, 'cancel', NaN); return oc.apply(this, a); };
    const och = AP.cancelAndHoldAtTime;
    if (och) AP.cancelAndHoldAtTime = function (...a) { logParam(this, 'cancel', NaN); return och.apply(this, a); };
    const vd = Object.getOwnPropertyDescriptor(AP, 'value');
    if (vd && vd.set) Object.defineProperty(AP, 'value', { ...vd, set(v) { logParam(this, 'value', v); vd.set.call(this, v); } });
    const AN = AudioNode.prototype;
    const ocn = AN.connect; const odc = AN.disconnect;
    AN.connect = function (dst, ...rest) { let s = outs.get(this); if (!s) outs.set(this, (s = [])); s.push(dst); return ocn.call(this, dst, ...rest); };
    AN.disconnect = function (...a) { if (!disc.has(this)) disc.set(this, now()); return odc.apply(this, a); };
    const Orig = window.AudioContext;
    const ctxInfo = new WeakMap();
    class Ctx extends Orig {
      constructor(...a) { super(...a); const info = { created: now(), cut: null }; ctxInfo.set(this, info); window.__ctxs.push(info); }
    }
    for (const m of ['close', 'suspend']) {
      const o = Orig.prototype[m];
      Orig.prototype[m] = function (...a) { const info = ctxInfo.get(this); if (info && info.cut === null) info.cut = now(); return o.apply(this, a); };
    }
    const ores = Orig.prototype.resume;
    Orig.prototype.resume = function (...a) { const info = ctxInfo.get(this); if (info) info.cut = null; return ores.apply(this, a); };
    window.AudioContext = Ctx;
    if (window.webkitAudioContext) window.webkitAudioContext = Ctx;
    const SN = (window.AudioScheduledSourceNode ?? OscillatorNode).prototype;
    const ost = SN.start; const osp = SN.stop;
    const lead = (node, when) => Math.max(0, (Number(when) || 0) - node.context.currentTime) * 1000;
    const oscRec = new WeakMap();
    SN.start = function (when, ...rest) {
      if (this instanceof OscillatorNode) {
        const r = { node: this, call: now(), start: now() + lead(this, when), when: Number(when) || 0, stop: null, state: this.context.state, ctx: ctxInfo.get(this.context) ?? null };
        oscRec.set(this, r); window.__oscs.push(r);
      }
      return ost.call(this, when, ...rest);
    };
    SN.stop = function (when, ...rest) {
      const r = oscRec.get(this);
      if (r) { const t = now() + lead(this, when); r.stop = r.stop === null ? t : Math.min(r.stop, t); }
      return osp.call(this, when, ...rest);
    };
    const firstValue = (p) => { const a = (params.get(p) ?? []).find((x) => x.kind === 'value' || x.kind === 'setValueAtTime'); return a ? a.v : p.value; };
    window.__sounds = () => window.__oscs.map((r) => {
      const o = r.node;
      let cut = Infinity;
      const at = (t) => { if (t !== null && t !== undefined && t < cut) cut = t; };
      if (disc.has(o)) at(disc.get(o));
      let peak = 0;
      for (const d of outs.get(o) ?? []) {
        if (d instanceof AudioNode && disc.has(d)) at(disc.get(d));
        if (d instanceof GainNode) {
          for (const x of params.get(d.gain) ?? []) {
            if (x.kind === 'cancel' && x.perf > r.call + 5) at(x.perf);
            if (x.kind !== 'cancel' && Number.isFinite(x.v)) peak = Math.max(peak, x.v);
          }
        }
      }
      if (r.ctx && r.ctx.cut !== null) at(r.ctx.cut);
      // 鳴り終わり（stop）より前に切られたかではなく、鳴り始めより前に切られたかを見る。
      const heard = !(cut <= r.start + 1) && !(r.stop !== null && r.stop <= r.start + 1);
      return { call: r.call, start: r.start, when: r.when, freq: firstValue(o.frequency), type: o.type, heard, peak, state: r.state };
    });
  })();
`;

interface Sound {
  call: number;
  start: number;
  /** start に渡した when（音の時計の秒）。 */
  when: number;
  freq: number;
  type: string;
  heard: boolean;
  peak: number;
  state: string;
}
interface AmmoEvent {
  perf: number;
  ammo: number;
}

const sounds = (page: Page) => page.evaluate<Sound[]>('window.__sounds ? window.__sounds() : []');
const ammoLog = (page: Page) => page.evaluate<AmmoEvent[]>('window.__ammoLog');
const toneName = (s: Pick<Sound, 'freq' | 'type'>) =>
  Object.entries(TONES).find(([, t]) => Math.abs(t.freq - s.freq) < 0.5 && t.type === s.type)?.[0] ?? `?(${s.freq} Hz ${s.type})`;

/** 音ごとに、呼ばれた時刻に最も近い残弾の変化から「その練習で何発目を撃ったときか」を求める。 */
function shotsOfSounds(list: Sound[], log: AmmoEvent[], magSize: number, since = 0) {
  const events = log.filter((e) => e.perf >= since && e.ammo < magSize);
  return list
    .filter((s) => s.call >= since)
    .map((s) => {
      let best: AmmoEvent | undefined;
      for (const e of events) if (!best || Math.abs(e.perf - s.call) < Math.abs(best.perf - s.call)) best = e;
      return { shot: best ? magSize - best.ammo : NaN, dir: toneName(s), gap: best ? Math.abs(best.perf - s.call) : Infinity, sound: s };
    });
}

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

async function setCheck(page: Page, id: string, on: boolean) {
  if ((await page.evaluate<boolean>(`document.getElementById(${JSON.stringify(id)}).checked`)) !== on) await page.clickSelector(`#${id}`);
  await page.waitFor(`document.getElementById(${JSON.stringify(id)}).checked === ${on}`);
}

async function typeAndEnter(page: Page, id: string, text: string) {
  await page.clickSelector(`#${id}`);
  await page.evaluate(`document.getElementById(${JSON.stringify(id)}).select()`);
  await page.send('Input.insertText', { text });
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined });
  }
  await page.waitFor(`document.getElementById(${JSON.stringify(id)}).value === ${JSON.stringify(text)}`);
}

interface Opts {
  sound?: boolean;
  volume?: number;
  panel?: boolean;
  display?: '詳細' | '簡易';
}
async function openSettings(page: Page) {
  await page.evaluate(`location.hash = '#/settings'`);
  await page.waitFor(`window.__vis('[data-screen="settings"]') && document.getElementById('setting-fov').value !== '' && document.getElementById('setting-volume').value !== ''`);
}
async function configure(page: Page, opts: Opts) {
  await openSettings(page);
  await choose(page, '#setting-input-method', 'パッド');
  if (opts.sound !== undefined) await setCheck(page, 'setting-sound', opts.sound);
  if (opts.volume !== undefined) await typeAndEnter(page, 'setting-volume', String(opts.volume));
  if (opts.panel !== undefined) await setCheck(page, 'setting-correction-panel', opts.panel);
  if (opts.display) await choose(page, '#setting-pattern-display', opts.display);
  await page.frames(3);
  await gotoTop(page);
}
async function gotoTop(page: Page) {
  await page.evaluate(`location.hash = '#/'`);
  await page.waitFor(`window.__vis('[data-screen="top"]') && document.querySelector('#weapon').options.length > 0 && document.querySelector('#mode').options.length > 0`);
}

async function start(page: Page, w: WeaponJson, mode: string, count = 1) {
  await gotoTop(page);
  await choose(page, '#weapon', w.name);
  await choose(page, '#mode', mode);
  await choose(page, '#count', count);
  await page.clickSelector('[data-screen="top"] a[href="#/play"]');
  await waitRoundStart(page, w);
}
async function waitRoundStart(page: Page, w: WeaponJson) {
  await page.waitFor(
    `location.hash === '#/play' && window.__vis('[data-screen="play"]') && !window.__interlude() && window.__ammo() === ${w.magSize} && window.__inputShown() !== ''`,
    10_000,
  );
  await page.waitFor('window.__time() >= 0.3', 10_000);
  await page.frames(3);
}

/** R2 を押し続け、残弾が untilAmmo 以下になったら離す。 */
async function padFireUntil(page: Page, untilAmmo: number) {
  await page.evaluate(`(async () => {
    window.__btn(7, true); const t0 = performance.now();
    while (window.__ammo() > ${untilAmmo} && location.hash === '#/play' && !window.__interlude() && performance.now() - t0 < 20000) await window.__nextFrame();
    window.__btn(7, false); })()`);
}
const padFireAll = (page: Page) => padFireUntil(page, 0);
/** 描画の時計（performance.now）で ms たつまで待つ。 */
const elapse = async (page: Page, ms: number) => {
  const until = (await page.evaluate<number>('performance.now()')) + ms;
  await page.waitFor(`performance.now() >= ${until}`, ms + 10_000);
};
async function padTap(page: Page, button: number) {
  await page.evaluate(`window.__btn(${button}, true)`);
  await page.frames(6);
  await page.evaluate(`window.__btn(${button}, false)`);
  await page.frames(3);
}

const resultOf = (page: Page) =>
  page.evaluate<{ summary: string; metrics: string; comments: string; plots: string }>(`(() => ({
    summary: document.getElementById('result-summary')?.innerText ?? '',
    metrics: document.getElementById('result-metrics')?.innerText ?? '',
    comments: document.getElementById('result-comments')?.innerText ?? '',
    plots: document.getElementById('result-plots')?.innerHTML ?? '' }))()`);

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('QA: 補正の向きの音（UI-75〜UI-83・MODE-29・MODE-30）', () => {
  const temps: string[] = [];
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  let opened: Page[] = [];
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));

  async function openFresh(init = '', { manualClock = false }: { manualClock?: boolean } = {}): Promise<Page> {
    const page = await browser!.newPage();
    opened.push(page);
    await page.addInitScript(init + PAGE_INIT);
    await page.goto(appUrl(origin, BASE, '#/', { render: false, manualClock }));
    await page.evaluate('localStorage.clear()');
    await page.evaluate('window.__beforeReload = true');
    await page.send('Page.reload', { ignoreCache: false });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && window.__vis('[data-screen="top"]')`, 15_000);
    return page;
  }
  async function closePage(page: Page) {
    opened = opened.filter((x) => x !== page);
    void page.send('Page.close').catch(() => undefined);
  }

  beforeAll(async () => {
    const work = mkdtempSync(join(tmpdir(), 'direction-sounds-qa-'));
    temps.push(work);
    const repo = join(work, 'copy');
    for (const entry of ['src', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'eslint.config.js', 'scripts', 'public']) {
      if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(repo, entry), { recursive: true });
    }
    symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'), 'dir');
    for (const w of [THREE, ...DIR_WEAPONS]) writeFileSync(join(repo, `src/data/weapons/${w.id}.json`), JSON.stringify(w, null, 2));
    const dist = join(work, 'dist');
    const r = spawnSync(`npm run build -- --outDir "${dist}" --emptyOutDir`, {
      cwd: repo,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, APEX_ACCEPTANCE_NESTED: '1', FORCE_COLOR: '0' },
    });
    if (r.status !== 0) throw new Error(`写しのビルドが失敗した:\n${r.stdout}${r.stderr}`);
    server = await serveStatic(dist, BASE);
    origin = originOf(server);
    browser = await launchBrowser(chromium!);
  }, 300_000);

  afterEach(async () => {
    const pages = opened;
    opened = [];
    // 閉じる知らせの応答を待たない（閉じたタブのソケットは応答しないことがある）。
    for (const p of pages) void p.send('Page.close').catch(() => undefined);
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((ok) => (server ? server.close(ok) : ok(undefined)));
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it('前提: QA-三方向の簡易版の区切りの言葉が UI-75 のとおり、QA-向き-<向き> の区切りが 1 本でその向き', () => {
    expect(oracleSimplePattern(THREE).segments.map((s) => s.label)).toEqual(THREE_LABELS);
    for (const [k, [name]] of DIRS.entries()) {
      const segs = oracleSimplePattern(DIR_WEAPONS[k]!).segments;
      expect(segs.map((s) => dirOf(s.label))).toEqual([name]);
    }
  });

  // -------------------------------------------------------------------------
  describe('練習中の音', () => {
    it('UI-75: 音 ON・音量 50 で QA-三方向を撃ち切ると、1・9・21 発目にこの順で下・左下・右下の音が 1 回ずつ鳴り、ほかの発では鳴らない', async () => {
      const page = await openFresh();
      await configure(page, { sound: true, volume: 50 });
      await start(page, THREE, CENTER);
      const t0 = await page.evaluate<number>('performance.now()');
      await padFireAll(page);
      await page.waitFor(`location.hash === '#/result' && window.__vis('[data-screen="result"]')`, 15_000);
      await page.frames(5);
      const list = (await sounds(page)).filter((s) => s.call >= t0);
      const mapped = shotsOfSounds(list, await ammoLog(page), THREE.magSize, t0);
      expect(mapped.map((m) => [m.shot, m.dir]), JSON.stringify(mapped)).toEqual([
        [1, '下'],
        [9, '左下'],
        [21, '右下'],
      ]);
      for (const m of mapped) {
        expect(m.gap, '音と残弾の変化の時刻が離れている').toBeLessThan(100);
        expect(m.sound.heard).toBe(true);
        expect(m.sound.peak, '音の大きさが 0').toBeGreaterThan(0);
      }
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 90_000);

    it('UI-82: パターンの表示が詳細と簡易で、QA-三方向と L-STAR を撃ち切ったときの音の発と向きが一致する', async () => {
      const page = await openFresh();
      const runs: Record<string, [number, string][]> = {};
      for (const w of [THREE, LSTAR]) {
        for (const display of ['詳細', '簡易'] as const) {
          await configure(page, { display });
          await start(page, w, GHOST);
          const t0 = await page.evaluate<number>('performance.now()');
          await padFireAll(page);
          await page.waitFor(`location.hash === '#/result' && window.__vis('[data-screen="result"]')`, 15_000);
          await page.frames(5);
          const mapped = shotsOfSounds(await sounds(page), await ammoLog(page), w.magSize, t0);
          runs[`${w.id}:${display}`] = mapped.map((m) => [m.shot, m.dir]);
        }
        const o = oracleSimplePattern(w);
        const expected = o.segments.map((s) => [s.from + 1, dirOf(s.label)]);
        expect(runs[`${w.id}:詳細`], `${w.name} 詳細`).toEqual(expected);
        expect(runs[`${w.id}:簡易`], `${w.name} 簡易`).toEqual(runs[`${w.id}:詳細`]);
      }
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 180_000);

    it('UI-81: 12 発撃って離し、0.5 秒より前に押し直すと鳴るのは 21 発目の右下だけ。0.5 秒より長く待って押し直すと 1 発目で下が鳴る', async () => {
      const page = await openFresh();
      await configure(page, {});

      // 戻りの時間より前に押し直す。
      await start(page, THREE, CENTER);
      await padFireUntil(page, THREE.magSize - 12);
      const released = await page.evaluate<number>('performance.now()');
      expect(await page.evaluate<number>('window.__ammo()')).toBe(THREE.magSize - 12);
      await page.frames(3);
      const t1 = await page.evaluate<number>('performance.now()');
      expect(t1 - released, '押し直す前に 0.5 秒たってしまった').toBeLessThan(400);
      await padFireAll(page);
      await page.waitFor(`location.hash === '#/result'`, 15_000);
      await page.frames(3);
      const quick = shotsOfSounds(await sounds(page), await ammoLog(page), THREE.magSize, t1);
      expect(
        quick.map((m) => [m.shot, m.dir]),
        JSON.stringify(quick),
      ).toEqual([[21, '右下']]);

      // 戻りの時間より長く待ってから押し直す（2 秒の終わりの時間より前）。
      await start(page, THREE, CENTER);
      await padFireUntil(page, THREE.magSize - 12);
      const releasedAt = await page.evaluate<number>('window.__time()');
      await page.waitFor(`window.__time() >= ${releasedAt + 0.9}`, 5000);
      expect(await page.evaluate<string>('location.hash')).toBe('#/play');
      const t2 = await page.evaluate<number>('performance.now()');
      await padFireAll(page);
      await page.waitFor(`location.hash === '#/result'`, 15_000);
      await page.frames(3);
      const late = shotsOfSounds(await sounds(page), await ammoLog(page), THREE.magSize, t2);
      // 押し直した 1 発目（通しで 13 発目）で下、パターンの 9 発目（通しで 21 発目）で左下。
      expect(late[0] && [late[0].shot, late[0].dir], JSON.stringify(late)).toEqual([13, '下']);
      expect(late.map((m) => [m.shot, m.dir])).toEqual([
        [13, '下'],
        [21, '左下'],
      ]);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 120_000);

    it('UI-77: 音を OFF（または音量を 0）にして撃ち切ると、音を鳴らす処理は 1 回も呼ばれず、「パターンの音を聞く」は押せない', async () => {
      for (const [opts, note] of [
        [{ sound: false }, '設定で音が OFF です'],
        [{ sound: true, volume: 0 }, '設定の音量が 0 です'],
      ] as const) {
        const page = await openFresh();
        await configure(page, opts);
        const btn = await page.evaluate<{ disabled: boolean; note: string; noteVisible: boolean }>(`(() => ({
          disabled: document.getElementById('preview-sound').disabled || document.getElementById('preview-sound').getAttribute('aria-disabled') === 'true',
          note: (document.getElementById('preview-sound-note')?.textContent ?? '').trim(),
          noteVisible: window.__vis('#preview-sound-note') }))()`);
        expect(btn.disabled, JSON.stringify(opts)).toBe(true);
        expect(btn.noteVisible).toBe(true);
        expect(btn.note).toContain(note);
        // 押しても試聴は始まらない。
        await page.clickSelector('#preview-sound');
        await elapse(page, 400);
        expect(await page.evaluate<string>('window.__label()')).toBe(PREVIEW_LABEL);

        await start(page, THREE, CENTER);
        await padFireAll(page);
        await page.waitFor(`location.hash === '#/result' && window.__vis('[data-screen="result"]')`, 15_000);
        await page.frames(5);
        expect(await sounds(page), JSON.stringify(opts)).toEqual([]);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
        await closePage(page);
      }
    }, 120_000);

    it('UI-80: 同じ入力で音 ON と OFF の練習のリザルト（計算し直し）の弾痕と採点が一致し、計算し直しでは音が鳴らない', async () => {
      const outcomes: Awaited<ReturnType<typeof resultOf>>[] = [];
      for (const sound of [true, false]) {
        const page = await openFresh();
        await configure(page, { sound });
        await start(page, THREE, CENTER);
        await padFireAll(page);
        const ended = await page.evaluate<number>('performance.now()');
        await page.waitFor(`location.hash === '#/result' && window.__vis('[data-screen="result"]')`, 15_000);
        await page.frames(10);
        const list = await sounds(page);
        // 練習中に鳴ったのは区切りの最初の 3 発だけで、撃ち切ったあと（リザルトのための計算し直し）では呼ばれない。
        expect(list.length).toBe(sound ? 3 : 0);
        expect(list.filter((s) => s.call > ended + 50)).toEqual([]);
        outcomes.push(await resultOf(page));
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
        await closePage(page);
      }
      expect(outcomes[0]!.metrics.length).toBeGreaterThan(0);
      expect(outcomes[1]).toEqual(outcomes[0]);
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  describe('試聴', () => {
    async function preview(page: Page, w: WeaponJson) {
      await gotoTop(page);
      await choose(page, '#weapon', w.name);
      await page.waitFor(`window.__label() === ${JSON.stringify(PREVIEW_LABEL)} && !document.getElementById('preview-sound').disabled`);
      const before = await page.evaluate<number>('window.__clicks.length');
      await page.clickSelector('#preview-sound');
      await page.waitFor(`window.__clicks.length > ${before}`);
      return page.evaluate<number>(`window.__clicks[${before}]`);
    }

    it('UI-76: 9 つの向きの音の高さと波形が表のとおりで、どの 2 つの向きでも高さと波形の組が異なる', async () => {
      const page = await openFresh('', { manualClock: true });
      const heard: Record<string, { freq: number; type: string }> = {};
      for (const [k, [name]] of DIRS.entries()) {
        const w = DIR_WEAPONS[k]!;
        const clicked = await preview(page, w);
        await page.waitFor(`window.__oscs.some((r) => r.call >= ${clicked})`, 5000);
        await page.waitFor(`window.__label() === ${JSON.stringify(PREVIEW_LABEL)}`, 5000);
        const list = (await sounds(page)).filter((s) => s.call >= clicked);
        expect(list.length, `${name} の試聴の音の数`).toBe(1);
        heard[name] = { freq: list[0]!.freq, type: list[0]!.type };
        expect(heard[name], name).toEqual({ freq: TONES[name]!.freq, type: TONES[name]!.type });
        expect(list[0]!.heard).toBe(true);
      }
      const keys = Object.values(heard).map((t) => `${Math.round(t.freq)}:${t.type}`);
      expect(new Set(keys).size).toBe(9);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 120_000);

    /** 試聴を始め、最初の区切りの音（押した直後の描画で予約する）が予約されるまで待つ。押した時刻を返す。 */
    async function startPreview(page: Page, w: WeaponJson) {
      const clicked = await preview(page, w);
      await page.waitFor(`window.__label() === ${JSON.stringify(STOP_LABEL)}`, 2000);
      await page.waitFor(`window.__oscs.some((r) => r.call >= ${clicked})`, 5000);
      return clicked;
    }
    const callsSince = async (page: Page, since: number) => (await sounds(page)).filter((s) => s.call >= since);

    it('UI-78: L-STAR の試聴で、区切りの順に向きの音が（最初の発 − 1）× 発射間隔の時刻に 1 回ずつ鳴り、最後の音のあとに表示が戻る', async () => {
      const page = await openFresh('', { manualClock: true });
      const o = oracleSimplePattern(LSTAR);
      const interval = 60 / LSTAR.rpm;
      const clicked = await startPreview(page, LSTAR);
      const lastAt = o.segments.at(-1)!.from * interval;
      // 最後の区切りの時刻の少し前までは「止める」のまま。
      await page.advanceClock(lastAt - 0.05);
      expect(await page.evaluate<string>('window.__label()')).toBe(STOP_LABEL);
      await page.advanceClockUntil(`window.__label() === ${JSON.stringify(PREVIEW_LABEL)}`, { limit: 0.2 });
      await page.advanceClock(1);
      const list = (await callsSince(page, clicked)).filter((s) => s.heard);
      expect(list.map(toneName)).toEqual(o.segments.map((s) => dirOf(s.label)));
      // 音の時刻は、最初の音（押した時点）からの音の時計の経過で比べる。
      const times = list.map((s) => (s.when - list[0]!.when) * 1000);
      const expected = o.segments.map((s) => s.from * interval * 1000);
      for (const [k, t] of times.entries()) {
        expect(Math.abs(t - expected[k]!), `区切り ${k + 1} の音の時刻 ${t.toFixed(1)} ms（期待 ${expected[k]!.toFixed(1)} ms）`).toBeLessThanOrEqual(1);
      }
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('UI-78: 試聴の途中で「止める」を押すと、それより後の音は鳴らず、表示が戻る', async () => {
      const page = await openFresh('', { manualClock: true });
      const o = oracleSimplePattern(LSTAR);
      expect(o.segments.length).toBeGreaterThanOrEqual(2);
      const interval = 60 / LSTAR.rpm;
      const clicked = await startPreview(page, LSTAR);
      // 最初の音のあと、2 つ目の区切りの時刻の前に止める。
      await page.advanceClock(0.1);
      expect(0.1).toBeLessThan(o.segments[1]!.from * interval);
      expect((await callsSince(page, clicked)).map(toneName)).toEqual([dirOf(o.segments[0]!.label)]);
      await page.clickSelector('#preview-sound');
      const stopped = await page.evaluate<number>('window.__clicks.at(-1)');
      await page.waitFor(`window.__label() === ${JSON.stringify(PREVIEW_LABEL)}`, 2000);
      await page.advanceClock(o.segments.at(-1)!.from * interval + 1);
      const list = await callsSince(page, clicked);
      expect(list.filter((s) => s.heard).map(toneName)).toEqual([dirOf(o.segments[0]!.label)]);
      expect(list.filter((s) => s.call > stopped)).toEqual([]);
      expect(await page.evaluate<string>('window.__label()')).toBe(PREVIEW_LABEL);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('UI-79: 試聴のあいだに武器を C.A.R. SMG に変えると、L-STAR の残りの音は鳴らず、試聴が止まる', async () => {
      const page = await openFresh('', { manualClock: true });
      const o = oracleSimplePattern(LSTAR);
      const interval = 60 / LSTAR.rpm;
      const clicked = await startPreview(page, LSTAR);
      await page.advanceClock(0.1);
      expect(0.1).toBeLessThan(o.segments[1]!.from * interval);
      const changed = await page.evaluate<number>('performance.now()');
      await choose(page, '#weapon', CAR.name);
      await page.waitFor(`window.__label() === ${JSON.stringify(PREVIEW_LABEL)}`, 2000);
      await page.advanceClock(o.segments.at(-1)!.from * interval + 1);
      const list = await callsSince(page, clicked);
      expect(list.filter((s) => s.call > changed), JSON.stringify(list)).toEqual([]);
      expect(list.filter((s) => s.heard).map(toneName)).toEqual([dirOf(o.segments[0]!.label)]);
      expect(await page.evaluate<string>('window.__label()')).toBe(PREVIEW_LABEL);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('UI-83: 音が出せないとき', () => {
    it('Web Audio が使えない環境で、撃ち切っても試聴を始めても、エラーで止まらずに練習と画面が続く', async () => {
      const page = await openFresh('window.__noAudio = true;');
      expect(await page.evaluate<string>('typeof window.AudioContext')).toBe('undefined');
      await configure(page, {});
      await page.clickSelector('#preview-sound');
      await page.frames(10);
      await gotoTop(page);
      await start(page, THREE, CENTER);
      await padFireAll(page);
      await page.waitFor(`location.hash === '#/result' && window.__vis('[data-screen="result"]')`, 15_000);
      expect((await resultOf(page)).metrics.length).toBeGreaterThan(0);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      expect(page.errors, page.errors.join('\n')).toEqual([]);
    }, 90_000);

    it('ページを開いてから一度もクリック・キー・パッドのボタンを押していない状態で、試聴を始めても撃ってもエラーで止まらない', async () => {
      const page = await openFresh();
      // 利用者の操作を使わず（スクリプトから）試聴を始め、練習を始める。
      await page.evaluate(`document.getElementById('preview-sound').click()`);
      await page.frames(20);
      await page.evaluate(`document.getElementById('preview-sound').click()`);
      await page.frames(5);
      await choose(page, '#weapon', THREE.name);
      await choose(page, '#mode', CENTER);
      await choose(page, '#count', 1);
      await page.evaluate(`document.querySelector('[data-screen="top"] a[href="#/play"]').click()`);
      await waitRoundStart(page, THREE);
      // パッドのボタンを押す前に、1 発目（鳴らすべき発）の前までの状態が続いている。
      expect(await page.evaluate<string>('location.hash')).toBe('#/play');
      await padFireAll(page);
      await page.waitFor(`location.hash === '#/result' && window.__vis('[data-screen="result"]')`, 15_000);
      expect((await resultOf(page)).metrics.length).toBeGreaterThan(0);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      expect(page.errors, page.errors.join('\n')).toEqual([]);
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  describe('MODE-29・MODE-30: モードと始め直し', () => {
    const firstSound = async (page: Page, since: number) => {
      await page.waitFor(`window.__oscs.some((r) => r.call >= ${since})`, 5000).catch(() => undefined);
      return shotsOfSounds(await sounds(page), await ammoLog(page), THREE.magSize, since).map((m) => [m.shot, m.dir]);
    };

    for (const [mode, panel] of [
      [GHOST, true],
      [CENTER, true],
      [CENTER, false],
    ] as const) {
      it(`MODE-29: ${mode}（補正のパネル ${panel ? 'ON' : 'OFF'}）で 1 発目を撃つと、最初の区切りの下の音が 1 回鳴る`, async () => {
        const page = await openFresh();
        await configure(page, { panel });
        await start(page, THREE, mode);
        const t0 = await page.evaluate<number>('performance.now()');
        await padFireUntil(page, THREE.magSize - 3);
        await page.frames(5);
        expect(await firstSound(page, t0)).toEqual([[1, '下']]);
        expect(exceptions(page), page.errors.join('\n')).toEqual([]);
      }, 60_000);
    }

    it('MODE-30: やり直しのあとに撃ち始めると、1 発目で下の音が鳴る', async () => {
      const page = await openFresh();
      await configure(page, {});
      await start(page, THREE, CENTER);
      await padFireUntil(page, THREE.magSize - 3);
      // 戻りの時間がたつ前にやり直す（パッドの A）。
      await padTap(page, 0);
      await page.waitFor(`window.__ammo() === ${THREE.magSize} && location.hash === '#/play'`, 3000);
      const t0 = await page.evaluate<number>('performance.now()');
      await padFireUntil(page, THREE.magSize - 3);
      await page.frames(5);
      expect(await firstSound(page, t0)).toEqual([[1, '下']]);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('MODE-30: 連続練習（回数 5）の次の回で撃ち始めると、1 発目で下の音が鳴る', async () => {
      const page = await openFresh();
      await configure(page, {});
      await start(page, THREE, CENTER, 5);
      await padFireUntil(page, THREE.magSize - 3);
      // 2 秒撃たずに回を終え、短いリザルトで「次へ」（パッドの A）。
      await page.waitFor('window.__interlude()', 6000);
      await padTap(page, 0);
      await waitRoundStart(page, THREE);
      const t0 = await page.evaluate<number>('performance.now()');
      await padFireUntil(page, THREE.magSize - 3);
      await page.frames(5);
      expect(await firstSound(page, t0)).toEqual([[1, '下']]);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });
});
