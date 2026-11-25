// docs/spec/scoring.md「発の区間ごとのズレ」「苦手な区間」の受け入れテスト（SCO-31〜SCO-38）と、
// docs/spec/screens.md「履歴の画面」「補正のパネル」の苦手な区間の受け入れテスト（UI-64〜UI-68）。
// 公開された入口だけを使う: ビルドの結果を /apex-training/ で配信した画面（トップ・設定・プレイ・リザルト・履歴）、武器の JSON、
// SPEC に書かれた localStorage のキーと値の形。画面はヘッドレスの Chromium で開き（tests/helpers/browser.ts）、マウス（ポインターロック + 左ボタン）で撃つ。
//
// 弾ごとのズレを決めるため、リポジトリの写しの武器データを差し替えてビルドする（ghost-follow-qa・correction-panel-qa と同じ方法）。
// 照準を動かさずに撃つと、i 発目の弾痕は 1〜i 発目の pattern の合計の向きに出る（weapons.md・WPN-10）ので、randomness 0 の武器の
// pattern で各弾のズレを決められる。
// - L-STAR（id lstar・名前・装弾数 28・rpm はそのまま）: randomness 0、pattern は 11 発目に dx +2、16 発目に dx −2、ほかは 0。
//   照準を動かさずに撃ち切ると、11〜15 発目だけ水平のズレ +2 度、ほかの弾のズレ 0 になる（SCO-32・SCO-33・UI-64）。
// - QA-23発: randomness 0・装弾数 23。各弾のズレが違う値になる pattern（SCO-31）。
// - QA-ゼロ: randomness 0・装弾数 28・pattern がすべて 0。全弾のズレが 0（SCO-34・SCO-35・SCO-37 のリザルト）。
// - C.A.R. SMG はそのまま（補正のパネルの理想の線を見る UI-67・UI-68）。
//
// 苦手な区間の行や図の DOM の形は SPEC にないので、見えている文字（innerText）と、要素の位置と色で読む。
// - 履歴の画面の図: 「1〜5」の形の文字を棒の範囲の札とみなし、札の上にある、塗りのある要素を棒とみなす。色は SVG なら fill、HTML なら背景色。
// - 補正のパネル: 理想の線の各区間（k−1 発目 → k 発目）を、その区間を結ぶ線（polyline・line・path）のうち、いちばん後に描かれるものの stroke の色で読む。
//   パネルの座標は、理想の線（[data-series="ideal"]）の点を SPEC の理想の補正軌道に「原点 + s × (ヨー, −ピッチ)」で合わせて求める。
// サーバーと DevTools のポートは OS に選ばせる。待ちは sleep にせず、画面の状態の条件で待つ。
// Chromium がなければ飛ばす。ARC-13 の clone の中で入れ子に実行したときも飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { findChromium, launchBrowser, originOf, serveStatic, waitUntil, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const CX = 640;
const CY = 400;
const chromium = findChromium();

const CENTER = 'センター維持';
const GHOST = '反復練習';
const PATTERN = 'パターン観察';
const HISTORY_PREFIX = 'apex-training:history:';
const historyKey = (input: string, weapon: string, mode: string) => `${HISTORY_PREFIX}${input}:${weapon}:${mode}`;

interface WeaponJson {
  id: string;
  name: string;
  category: string;
  version: string;
  source: string;
  rpm: number;
  magSize: number;
  randomness: number;
  measured?: boolean;
  pattern: { dx: number; dy: number }[];
}
const readWeapon = (id: string) => JSON.parse(readFileSync(join(ROOT, 'src/data/weapons', `${id}.json`), 'utf8')) as WeaponJson;
const LSTAR_ORIG = readWeapon('lstar');
const CAR = readWeapon('car');

/** 写しの L-STAR: 11〜15 発目だけ水平 +2 度、ほかは 0。 */
const LSTAR: WeaponJson = {
  ...LSTAR_ORIG,
  randomness: 0,
  pattern: Array.from({ length: LSTAR_ORIG.magSize }, (_, i) => ({ dx: i === 10 ? 2 : i === 15 ? -2 : 0, dy: 0 })),
};

/** QA-23発: i 発目（1 から）の弾痕の向き（水平, 垂直、度）。各弾で違う値。 */
const POS23: [number, number][] = Array.from({ length: 23 }, (_, k) => {
  const i = k + 1;
  return [Number((0.1 * (((i * 7) % 11) - 5)).toFixed(3)), Number((0.08 * (((i * 5) % 9) - 4)).toFixed(3))];
});
const QA23: WeaponJson = {
  id: 'qa-sections-23',
  name: 'QA-23発',
  category: 'QA',
  version: 'S31-Cipher',
  source: '仮データ（受け入れテスト）',
  measured: true,
  rpm: 600,
  magSize: 23,
  randomness: 0,
  pattern: POS23.map(([h, v], k) => ({ dx: Number((h - (k > 0 ? POS23[k - 1]![0] : 0)).toFixed(3)), dy: Number((v - (k > 0 ? POS23[k - 1]![1] : 0)).toFixed(3)) })),
};
/** pattern の合計（丸めのあと）から求めた i 発目の弾痕の向き。 */
const pos23 = (i: number): [number, number] => {
  let h = 0;
  let v = 0;
  for (let k = 0; k < i; k += 1) {
    h += QA23.pattern[k]!.dx;
    v += QA23.pattern[k]!.dy;
  }
  return [h, v];
};

const ZERO: WeaponJson = {
  id: 'qa-sections-zero',
  name: 'QA-ゼロ',
  category: 'QA',
  version: 'S31-Cipher',
  source: '仮データ（受け入れテスト）',
  measured: true,
  rpm: 600,
  magSize: 28,
  randomness: 0,
  pattern: Array.from({ length: 28 }, () => ({ dx: 0, dy: 0 })),
};

// ---------------------------------------------------------------------------
// 履歴の形（scoring.md「履歴の保存の形」）
// ---------------------------------------------------------------------------

interface Section {
  start: number;
  shots: number;
  meanH: number;
  meanV: number;
  meanError: number;
}
interface Entry {
  at: string;
  meanError: number;
  hitRate: number;
  groupingRadius: number;
  shots: number;
  sections?: unknown;
}
interface Stored {
  version: number;
  entries: Entry[];
}
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
const oldEntry = (n: number, meanError = 1.5): Entry => ({ at: at(n), meanError, hitRate: 50, groupingRadius: 1, shots: 28 });
/** magSize 発の発の区間（1, 6, 11, …）。override で発の区間ごとの値を変える（既定は h 0・v 0・大きさ base）。 */
function sections(magSize: number, base: number, override: Record<number, Partial<Section>> = {}): Section[] {
  const out: Section[] = [];
  for (let start = 1; start <= magSize; start += 5) {
    out.push({ start, shots: Math.min(5, magSize - start + 1), meanH: 0, meanV: 0, meanError: base, ...override[start] });
  }
  return out;
}
const withSections = (n: number, secs: unknown): Entry => ({ ...oldEntry(n), sections: secs });
const stored = (entries: Entry[]) => JSON.stringify({ version: 1, entries });

/** 文字の空白をそろえる（改行やタブを 1 つの空白に、コロンのあとの空白を 1 つに）。 */
const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/\s*[:：]\s*/g, ': ').trim();
const WEAK_RESULT = (s: string) => `この武器の苦手な区間: ${s}`;
const WEAK_HISTORY = (s: string) => `苦手な区間: ${s}`;

// ---------------------------------------------------------------------------
// ページに足すスクリプト
// ---------------------------------------------------------------------------

const PAGE_INIT = `
  window.__vis = (sel) => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    return !!el && !el.closest('[hidden]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0; };
  window.__num = (sel) => { const m = (document.querySelector(sel)?.textContent ?? '').match(/-?\\d+(?:\\.\\d+)?/); return m ? Number(m[0]) : NaN; };
  window.__ammo = () => window.__num('[data-hud="ammo"]');
  window.__time = () => window.__num('[data-hud="time"]');
  window.__pts = (s) => { const n = String(s ?? '').trim().split(/[\\s,]+/).filter(Boolean).map(Number); const out = [];
    for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]); return out; };
  window.__pathPts = (d) => { const out = []; const re = /([MLHVZmlhvz])|(-?\\d*\\.?\\d+(?:e[-+]?\\d+)?)/g; let cmd = 'M'; let nums = []; let cur = [0, 0]; let m;
    const flush = () => { if (cmd === 'M' || cmd === 'L') { for (let i = 0; i + 1 < nums.length; i += 2) { cur = [nums[i], nums[i + 1]]; out.push(cur); } }
      else if (cmd === 'm' || cmd === 'l') { for (let i = 0; i + 1 < nums.length; i += 2) { cur = [cur[0] + nums[i], cur[1] + nums[i + 1]]; out.push(cur); } }
      else if (cmd === 'H') { for (const x of nums) { cur = [x, cur[1]]; out.push(cur); } } else if (cmd === 'V') { for (const y of nums) { cur = [cur[0], y]; out.push(cur); } }
      nums = []; };
    while ((m = re.exec(String(d ?? ''))) !== null) { if (m[1]) { flush(); cmd = m[1]; } else nums.push(Number(m[2])); }
    flush(); return out; };
  // 補正のパネルの線（理想の線の候補）。自分の線・今の照準・次の発の点・向かう先の線は除く。
  window.__panelLines = () => {
    const fig = document.querySelector('.correction-panel');
    const svg = fig?.querySelector('svg');
    if (!svg) return null;
    const skip = (el) => el.closest('[data-series="aim"], [data-series="aim-shots"], [data-panel="aim"], [data-panel="current"], [data-panel="heading"]');
    const lines = [...svg.querySelectorAll('polyline, line, path')].filter((el) => !skip(el) && window.__vis(el)).map((el) => {
      const tag = el.tagName.toLowerCase();
      const pts = tag === 'polyline' ? window.__pts(el.getAttribute('points'))
        : tag === 'line' ? [[el.x1.baseVal.value, el.y1.baseVal.value], [el.x2.baseVal.value, el.y2.baseVal.value]]
        : window.__pathPts(el.getAttribute('d'));
      const cs = getComputedStyle(el);
      return { series: el.closest('[data-series]')?.getAttribute('data-series') ?? null, pts, stroke: cs.stroke, strokeOpacity: cs.strokeOpacity };
    }).filter((l) => l.stroke && l.stroke !== 'none' && l.pts.length >= 2);
    const vb = svg.viewBox?.baseVal;
    // 見えている凡例の、見えている項目の文字だけを読む。
    const legend = [...fig.querySelectorAll('.plot-legend')].filter((el) => window.__vis(el)).map((el) => (el.innerText ?? '').trim()).join('\\n');
    return { visible: window.__vis(fig), viewBox: vb ? [vb.x, vb.y, vb.width, vb.height] : [0, 0, 0, 0], lines,
      ideal: window.__pts(svg.querySelector('[data-series="ideal"]')?.getAttribute('points')), text: fig.innerText ?? '', legend };
  };
  // 履歴の画面の、発の区間ごとのズレの図。
  window.__sectionFigure = () => {
    const screen = document.querySelector('[data-screen="history"]');
    const center = (r) => [r.left + r.width / 2, r.top + r.height / 2];
    const all = [...screen.querySelectorAll('*')].filter((e) => window.__vis(e));
    const labels = all.filter((e) => /^\\d+\\s*〜\\s*\\d+$/.test((e.textContent ?? '').trim()) && ![...e.children].some((c) => (c.textContent ?? '').trim() === (e.textContent ?? '').trim()));
    if (labels.length === 0) return { labels: [], bars: [], marks: [], text: screen.innerText };
    // 札のいちばん近い共通の祖先を図とみなす。
    let fig = labels[0].parentElement;
    while (fig && !labels.every((l) => fig.contains(l))) fig = fig.parentElement;
    const figRect = fig.getBoundingClientRect();
    const colorOf = (e) => { const cs = getComputedStyle(e); return e instanceof SVGElement ? cs.fill : cs.backgroundColor; };
    const transparent = (c) => !c || c === 'none' || c === 'transparent' || /rgba\\([^)]*,\\s*0\\)$/.test(c);
    const shapes = [...fig.querySelectorAll('*')].filter((e) => window.__vis(e) && !labels.includes(e)).filter((e) => {
      const tag = e.tagName.toLowerCase();
      if (e instanceof SVGElement) return ['rect', 'path', 'polygon'].includes(tag);
      return e.children.length === 0 && (e.textContent ?? '').trim() === '';
    }).map((e) => ({ e, r: e.getBoundingClientRect(), color: colorOf(e) }))
      .filter((s) => !transparent(s.color) && s.r.width < figRect.width * 0.5);
    const bars = labels.map((l) => {
      const lr = l.getBoundingClientRect(); const [lx] = center(lr);
      const cands = shapes.filter((s) => s.r.bottom <= lr.top + 2 && Math.abs(center(s.r)[0] - lx) <= Math.max(lr.width, s.r.width));
      cands.sort((a, b) => Math.abs(center(a.r)[0] - lx) - Math.abs(center(b.r)[0] - lx) || b.r.bottom - a.r.bottom);
      const s = cands[0];
      return { label: (l.textContent ?? '').trim().replace(/\\s+/g, ''), x: lx, color: s ? s.color : null, height: s ? s.r.height : null, barX: s ? center(s.r)[0] : null };
    });
    const marks = [...screen.querySelectorAll('*')].filter((e) => window.__vis(e)).filter((e) => {
      const t = (e.textContent ?? '').trim(); return t.includes('苦手') && !t.includes('苦手な区間') && ![...e.children].some((c) => (c.textContent ?? '').includes('苦手'));
    }).map((e) => center(e.getBoundingClientRect())[0]);
    return { labels: bars.map((b) => b.label), bars, marks, text: screen.innerText, figText: fig.innerText ?? fig.textContent ?? '' };
  };
`;

interface PanelLines {
  visible: boolean;
  viewBox: [number, number, number, number];
  lines: { series: string | null; pts: [number, number][]; stroke: string; strokeOpacity: string }[];
  ideal: [number, number][];
  text: string;
  legend: string;
}
interface SectionFigure {
  labels: string[];
  bars: { label: string; x: number; color: string | null; height: number | null; barX: number | null }[];
  marks: number[];
  text: string;
  figText?: string;
}

// ---------------------------------------------------------------------------
// 画面の操作
// ---------------------------------------------------------------------------

async function choose(page: Page, selector: string, label: string) {
  const ok = await page.evaluate<boolean>(`(() => {
    const s = document.querySelector(${JSON.stringify(selector)});
    if (!s) return false;
    const o = [...s.options].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  if (!ok) throw new Error(`${selector} に ${label} の選択肢がない`);
}

async function chooseHistory(page: Page, caption: string, label: string) {
  const ok = await page.evaluate<boolean>(`(() => {
    const screen = document.querySelector('[data-screen="history"]');
    const s = [...screen.querySelectorAll('select')].find((x) => (x.closest('label')?.textContent ?? x.getAttribute('aria-label') ?? '').trim().startsWith(${JSON.stringify(caption)}));
    if (!s) return false;
    const o = [...s.options].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  if (!ok) throw new Error(`履歴の画面の ${caption} に ${label} の選択肢がない`);
  await page.frames(2);
}

async function openHistory(page: Page, weapon: string, mode: string, input = 'マウス') {
  await page.evaluate(`location.hash = '#/history'`);
  await page.waitFor(`window.__vis('[data-screen="history"]') && document.querySelectorAll('[data-screen="history"] select option').length > 0`);
  await page.frames(2);
  await chooseHistory(page, '武器', weapon);
  await chooseHistory(page, 'モード', mode);
  await chooseHistory(page, '入力方式', input);
}

const mouseButton = (page: Page, type: 'mousePressed' | 'mouseReleased') =>
  page.send('Input.dispatchMouseEvent', { type, x: CX, y: CY, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });

async function startPractice(page: Page, weapon: string, mode: string) {
  await page.evaluate(`location.hash = '#/'`);
  await page.waitFor(`window.__vis('[data-screen="top"]') && document.querySelector('#weapon').options.length > 0 && document.querySelector('#mode').options.length > 0`);
  await choose(page, '#weapon', weapon);
  await choose(page, '#mode', mode);
  await page.clickSelector('[data-screen="top"] a[href="#/play"]');
  await page.waitFor(`location.hash === '#/play' && window.__vis('[data-screen="play"]') && window.__ammo() > 0`);
  await page.frames(5);
}

/** 練習を 1 回: 選んで始め、ポインターロックを掛け、照準を動かさずにマウスの左ボタンで撃ち切る。リザルトの文字を返す。 */
async function practice(page: Page, weapon: string, mode: string): Promise<string> {
  await startPractice(page, weapon, mode);
  await waitUntil(() => page.lockPointerBy(() => page.click(CX, CY), 1_000), 'クリックでポインターロックが掛かる', { timeout: 15_000 });
  await page.frames(2);
  await mouseButton(page, 'mousePressed');
  await page.waitFor(`location.hash === '#/result'`, 20_000);
  await mouseButton(page, 'mouseReleased');
  await page.evaluate('document.exitPointerLock()');
  await page.waitFor(`window.__vis('[data-screen="result"]') && document.querySelector('[data-screen="result"]').innerText.trim().length > 0`);
  await page.frames(3);
  return page.evaluate<string>(`document.querySelector('[data-screen="result"]').innerText`);
}

const storedHistory = async (page: Page, key: string): Promise<Stored | null> => {
  const raw = await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(key)})`);
  return raw === null ? null : (JSON.parse(raw) as Stored);
};

// ---------------------------------------------------------------------------
// 補正のパネルの理想の線の色
// ---------------------------------------------------------------------------

type Pt = [number, number];
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function ideal(w: WeaponJson, i: number): Pt {
  let yaw = 0;
  let pitch = 0;
  for (let k = 0; k < i; k += 1) {
    yaw -= w.pattern[k]!.dx;
    pitch -= w.pattern[k]!.dy;
  }
  return [yaw, pitch];
}

/** 理想の線の各区間（k = 1..装弾数: k−1 発目 → k 発目。0 発目は原点）の色。読めない区間は 'missing'、長さがほぼ 0 の区間は null。 */
function segmentColors(p: PanelLines, w: WeaponJson): (string | null)[] {
  // 理想の線の点。[data-series="ideal"] が原点と全発を持たなければ、series に ideal を含む線をつないだもので合わせる。
  let pts = p.ideal;
  if (pts.length !== w.magSize + 1) {
    pts = [];
    for (const l of p.lines.filter((x) => (x.series ?? '').includes('ideal'))) {
      for (const q of l.pts) if (!pts.length || dist(pts[pts.length - 1]!, q) > 1e-6) pts.push(q);
    }
  }
  if (pts.length !== w.magSize + 1) throw new Error(`理想の線の点を読めない（${pts.length} 点）: ${JSON.stringify(p.lines.map((l) => [l.series, l.pts.length]))}`);
  const o = pts[0]!;
  let num = 0;
  let den = 0;
  for (let k = 1; k <= w.magSize; k += 1) {
    const [yaw, pitch] = ideal(w, k);
    num += (pts[k]![0] - o[0]) * yaw + (pts[k]![1] - o[1]) * -pitch;
    den += yaw * yaw + pitch * pitch;
  }
  const s = num / den;
  const toPanel = (d: Pt): Pt => [o[0] + s * d[0], o[1] - s * d[1]];
  const tol = p.viewBox[2] * 0.015;
  const out: (string | null)[] = [];
  for (let k = 1; k <= w.magSize; k += 1) {
    const a = toPanel(ideal(w, k - 1));
    const b = toPanel(ideal(w, k));
    if (dist(a, b) < tol * 2) {
      out.push(null);
      continue;
    }
    let color: string | null = 'missing';
    for (const l of p.lines) {
      for (let i = 0; i + 1 < l.pts.length; i += 1) {
        const [c, d] = [l.pts[i]!, l.pts[i + 1]!];
        if ((dist(a, c) <= tol && dist(b, d) <= tol) || (dist(a, d) <= tol && dist(b, c) <= tol)) color = `${l.stroke}|${l.strokeOpacity}`;
      }
    }
    out.push(color);
  }
  return out;
}

// ---------------------------------------------------------------------------

describe.skipIf(NESTED || !chromium)('苦手な区間（scoring.md・screens.md）', () => {
  const temps: string[] = [];
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';
  let opened: Page[] = [];
  const exceptions = (page: Page) => page.errors.filter((e) => e.startsWith('exception:'));

  /** 新しいタブで localStorage を空にし（seed を入れ）、読み込み直したトップ画面を開く。 */
  async function openFresh(seed: Record<string, string> = {}): Promise<Page> {
    const page = await browser!.newPage();
    opened.push(page);
    await page.addInitScript(PAGE_INIT);
    await page.goto(`${origin}${BASE}#/`);
    await page.evaluate(`(() => { localStorage.clear(); const seed = ${JSON.stringify(seed)}; for (const k in seed) localStorage.setItem(k, seed[k]); window.__beforeReload = true; })()`);
    await page.send('Page.reload', { ignoreCache: false });
    await page.waitFor(`!window.__beforeReload && document.readyState === 'complete' && window.__vis('[data-screen="top"]')`, 15_000);
    return page;
  }

  beforeAll(async () => {
    const work = mkdtempSync(join(tmpdir(), 'weak-sections-qa-'));
    temps.push(work);
    const repo = join(work, 'copy');
    for (const entry of ['src', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'eslint.config.js', 'scripts', 'public']) {
      if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(repo, entry), { recursive: true });
    }
    symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'), 'dir');
    writeFileSync(join(repo, 'src/data/weapons/lstar.json'), JSON.stringify(LSTAR, null, 2));
    writeFileSync(join(repo, 'src/data/weapons/qa-sections-23.json'), JSON.stringify(QA23, null, 2));
    writeFileSync(join(repo, 'src/data/weapons/qa-sections-zero.json'), JSON.stringify(ZERO, null, 2));
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
    for (const p of opened) await p.send('Page.close').catch(() => undefined);
    opened = [];
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((ok) => (server ? server.close(ok) : ok(undefined)));
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  describe('発の区間ごとのズレの保存', () => {
    it('SCO-31: 23 発を採点すると、履歴の 1 件に発の区間が 5 つ（start 1・6・11・16・21）保存され、最後の弾数が 3、各平均がその発の区間の弾から求めた値になる', async () => {
      const page = await openFresh();
      const text = await practice(page, QA23.name, CENTER);
      expect(text).toContain('23');
      const value = await storedHistory(page, historyKey('mouse', QA23.id, 'center'));
      expect(value?.entries).toHaveLength(1);
      const e = value!.entries[0]!;
      expect(e.shots).toBe(23);
      const secs = e.sections as Section[];
      expect(Array.isArray(secs), JSON.stringify(e)).toBe(true);
      expect(secs.map((s) => s.start)).toEqual([1, 6, 11, 16, 21]);
      expect(secs.map((s) => s.shots)).toEqual([5, 5, 5, 5, 3]);
      for (const s of secs) {
        const shots = Array.from({ length: s.shots }, (_, k) => pos23(s.start + k));
        const mh = shots.reduce((a, [h]) => a + h, 0) / shots.length;
        const mv = shots.reduce((a, [, v]) => a + v, 0) / shots.length;
        const me = shots.reduce((a, [h, v]) => a + Math.hypot(h, v), 0) / shots.length;
        expect(Math.abs(s.meanH - mh), `${s.start} 発目からの水平のズレの平均 ${s.meanH} 期待 ${mh}`).toBeLessThanOrEqual(0.01);
        expect(Math.abs(s.meanV - mv), `${s.start} 発目からの垂直のズレの平均 ${s.meanV} 期待 ${mv}`).toBeLessThanOrEqual(0.01);
        expect(Math.abs(s.meanError - me), `${s.start} 発目からのズレの大きさの平均 ${s.meanError} 期待 ${me}`).toBeLessThanOrEqual(0.01);
      }
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  describe('リザルト画面の苦手な区間の行', () => {
    it('SCO-32: マウスで L-STAR とセンター維持を、11〜15 発目だけ水平 +2 度・ほかは 0 で 5 回練習して終えると、5 回目のリザルトに「この武器の苦手な区間: 11〜15 発目、右に外しがち」と表示される', async () => {
      const page = await openFresh();
      let text = '';
      for (let i = 0; i < 5; i += 1) text = await practice(page, LSTAR.name, CENTER);
      expect(norm(text)).toContain(WEAK_RESULT('11〜15 発目、右に外しがち'));
      // 履歴の 1 件ごとの 11〜15 発目の発の区間が +2 度（前提の確かめ）。
      const value = await storedHistory(page, historyKey('mouse', 'lstar', 'center'));
      expect(value?.entries).toHaveLength(5);
      for (const e of value!.entries) {
        const s11 = (e.sections as Section[]).find((s) => s.start === 11)!;
        expect(s11.meanH).toBeCloseTo(2, 2);
      }
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 180_000);

    it('SCO-33: 同じ練習を 4 回だけ終えると、4 回目のリザルトに苦手な区間の行が表示されない', async () => {
      const page = await openFresh();
      const texts: string[] = [];
      for (let i = 0; i < 4; i += 1) texts.push(await practice(page, LSTAR.name, CENTER));
      texts.forEach((t, i) => expect(t, `${i + 1} 回目`).not.toContain('苦手な区間'));
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 180_000);

    it('SCO-34: 1〜5 発目の垂直のズレの平均が +1 度・水平が −1 度でいちばん大きいとき、苦手な区間が「1〜5 発目、上に外しがち（下げ不足）・左に外しがち」になる（履歴の画面）', async () => {
      const entries = Array.from({ length: 5 }, (_, i) => withSections(i, sections(28, 0.2, { 1: { meanH: -1, meanV: 1, meanError: 1.5 } })));
      const page = await openFresh({ [historyKey('mouse', 'lstar', 'center')]: stored(entries) });
      await openHistory(page, LSTAR.name, CENTER);
      const f = await page.evaluate<SectionFigure>('window.__sectionFigure()');
      expect(norm(f.text)).toContain(WEAK_HISTORY('1〜5 発目、上に外しがち（下げ不足）・左に外しがち'));
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('SCO-34: 同じ条件（4 件 + ズレ 0 の今の練習で、1〜5 発目が垂直 +1・水平 −1 度）で、リザルトに「この武器の苦手な区間: 1〜5 発目、上に外しがち（下げ不足）・左に外しがち」と表示される', async () => {
      // 4 件の 1〜5 発目を垂直 +1.25・水平 −1.25 度にし、ズレ 0 の練習を 1 回足すと、5 件の弾数で重み付けした平均が +1・−1 度になる。
      const entries = Array.from({ length: 4 }, (_, i) => withSections(i, sections(28, 0.2, { 1: { meanH: -1.25, meanV: 1.25, meanError: 1.8 } })));
      const page = await openFresh({ [historyKey('mouse', ZERO.id, 'center')]: stored(entries) });
      const text = await practice(page, ZERO.name, CENTER);
      expect(norm(text)).toContain(WEAK_RESULT('1〜5 発目、上に外しがち（下げ不足）・左に外しがち'));
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('SCO-35: 直近 5 件のすべての発の区間でズレの大きさの平均が 0.5 度未満のとき、苦手な区間は「なし」で、リザルトに行が表示されない', async () => {
      // 4 件のすべての発の区間を 0.6 度にし、ズレ 0 の練習を 1 回足すと、5 件の平均は 0.48 度（しきい値未満）。
      const entries = Array.from({ length: 4 }, (_, i) => withSections(i, sections(28, 0.6, { 11: { meanH: 0.6 } })));
      const page = await openFresh({ [historyKey('mouse', ZERO.id, 'center')]: stored(entries) });
      const text = await practice(page, ZERO.name, CENTER);
      expect(text).not.toContain('苦手な区間');
      // 履歴の画面では「苦手な区間: なし」。
      await openHistory(page, ZERO.name, CENTER);
      const f = await page.evaluate<SectionFigure>('window.__sectionFigure()');
      expect(norm(f.text)).toContain(WEAK_HISTORY('なし'));
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('SCO-36: sections を持たない古い形式の件が 10 件ある組で練習を 1 回終えると、リザルトが表示され苦手な区間の行は出ず、履歴は 11 件で古い 10 件はそのまま残る', async () => {
      const key = historyKey('mouse', 'lstar', 'center');
      const seeds = Array.from({ length: 10 }, (_, i) => oldEntry(i, 1 + i / 10));
      const page = await openFresh({ [key]: stored(seeds) });
      const text = await practice(page, LSTAR.name, CENTER);
      expect(text).toContain('平均ズレ');
      expect(text).not.toContain('苦手な区間');
      const value = await storedHistory(page, key);
      expect(value?.entries).toHaveLength(11);
      expect(value!.entries.slice(0, 10)).toEqual(seeds);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    /**
     * SCO-37 の履歴: 古い順に、持つ件（21〜25 発目が 50 度）・持たない件・形の合わない件（start 2）・持つ件 ×n（6〜10 発目が水平 h）・
     * 持たない件・sections が配列でない件を混ぜる。持つ件の新しい順 5 件だけなら 6〜10 発目が苦手になる。
     */
    const mixed = (n: number, h: number, tail: Entry[] = []) => {
      const out: Entry[] = [withSections(0, sections(28, 0.1, { 21: { meanError: 50, meanH: 50 } })), oldEntry(1)];
      out.push(withSections(2, [{ start: 1, shots: 5, meanH: -9, meanV: 0, meanError: 9 }, { start: 2, shots: 5, meanH: 0, meanV: 0, meanError: 0 }]));
      for (let i = 0; i < n; i += 1) {
        out.push(withSections(3 + i * 3, sections(28, 0.1, { 6: { meanH: h, meanError: h } })));
        out.push(oldEntry(4 + i * 3, 9));
        out.push(withSections(5 + i * 3, 'broken'));
      }
      return [...out, ...tail];
    };

    it('SCO-37: sections を持たない件と持つ件が混ざった組で、苦手な区間は持つ件の新しい順 5 件だけから求まる（履歴の画面）', async () => {
      const page = await openFresh({ [historyKey('mouse', 'lstar', 'center')]: stored(mixed(5, 1.5)) });
      await openHistory(page, LSTAR.name, CENTER);
      const f = await page.evaluate<SectionFigure>('window.__sectionFigure()');
      expect(norm(f.text)).toContain(WEAK_HISTORY('6〜10 発目、右に外しがち'));
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('SCO-37: 同じく混ざった組（持つ件 4 件 + 今の練習）で、リザルトの苦手な区間が持つ件の新しい順 5 件だけから求まる', async () => {
      // 4 件の 6〜10 発目を水平 +1.875 度にし、ズレ 0 の練習を足すと 5 件の平均は +1.5 度。
      const page = await openFresh({ [historyKey('mouse', ZERO.id, 'center')]: stored(mixed(4, 1.875)) });
      const text = await practice(page, ZERO.name, CENTER);
      expect(norm(text)).toContain(WEAK_RESULT('6〜10 発目、右に外しがち'));
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('SCO-38: パターン観察で練習を終えると、リザルトに苦手な区間の行が表示されない（同じ武器の採点するモードに苦手な区間があっても）', async () => {
      const weak = stored(Array.from({ length: 5 }, (_, i) => withSections(i, sections(28, 0, { 11: { meanH: 2, meanError: 2 } }))));
      const page = await openFresh({ [historyKey('mouse', 'lstar', 'center')]: weak, [historyKey('mouse', 'lstar', 'ghost')]: weak });
      const text = await practice(page, LSTAR.name, PATTERN);
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).not.toContain('苦手な区間');
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('履歴の画面の発の区間ごとのズレの図', () => {
    const expectWeakBar = (f: SectionFigure, weakLabel: string) => {
      const weak = f.bars.find((b) => b.label === weakLabel);
      expect(weak, JSON.stringify(f.bars)).toBeDefined();
      expect(weak!.color, `${weakLabel} の棒がない: ${JSON.stringify(f.bars)}`).not.toBeNull();
      const others = f.bars.filter((b) => b.label !== weakLabel && b.color !== null);
      for (const b of others) expect(b.color, `${b.label} の棒の色`).not.toBe(weak!.color);
      expect(new Set(others.map((b) => b.color)).size, `ほかの棒の色: ${JSON.stringify(others)}`).toBeLessThanOrEqual(1);
      // 「苦手」の印は苦手な区間の棒にいちばん近い。
      expect(f.marks.length, `「苦手」の印がない: ${f.text}`).toBeGreaterThan(0);
      for (const m of f.marks) {
        const nearest = [...f.bars].sort((a, b) => Math.abs(a.x - m) - Math.abs(b.x - m))[0]!;
        expect(nearest.label, '「苦手」の印の位置').toBe(weakLabel);
      }
    };

    it('UI-64: SCO-32 と同じ練習を 5 回したあと履歴の画面で選ぶと、11〜15 の棒だけが違う色で「苦手」の印が付き、「苦手な区間: 11〜15 発目、右に外しがち」と表示される', async () => {
      const page = await openFresh();
      for (let i = 0; i < 5; i += 1) await practice(page, LSTAR.name, CENTER);
      await openHistory(page, LSTAR.name, CENTER);
      const f = await page.evaluate<SectionFigure>('window.__sectionFigure()');
      expect(norm(f.text)).toContain(WEAK_HISTORY('11〜15 発目、右に外しがち'));
      expect(f.labels).toEqual(['1〜5', '6〜10', '11〜15', '16〜20', '21〜25', '26〜30']);
      expect(f.figText ?? '').toContain('2.00');
      expectWeakBar(f, '11〜15');
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 180_000);

    it('UI-64（補足）: ほかの棒にも長さがある組（保存した 5 件）でも、苦手な区間の棒だけが違う色で描かれ、棒の長さはズレの大きさの平均に比例する', async () => {
      const entries = Array.from({ length: 5 }, (_, i) => withSections(i, sections(CAR.magSize, 0.3, { 11: { meanH: 2, meanError: 2 }, 6: { meanError: 0.6 } })));
      const page = await openFresh({ [historyKey('mouse', CAR.id, 'center')]: stored(entries) });
      await openHistory(page, CAR.name, CENTER);
      const f = await page.evaluate<SectionFigure>('window.__sectionFigure()');
      expect(norm(f.text)).toContain(WEAK_HISTORY('11〜15 発目、右に外しがち'));
      expect(f.figText ?? '').toContain('2.00');
      expect(f.figText ?? '').toContain('0.30');
      expectWeakBar(f, '11〜15');
      const h = (label: string) => f.bars.find((b) => b.label === label)!.height!;
      expect(h('11〜15') / h('1〜5')).toBeCloseTo(2 / 0.3, 0);
      expect(h('6〜10') / h('1〜5')).toBeCloseTo(2, 1);
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('UI-65: 発の区間ごとのズレを持つ件が 4 件の組では、図が描かれず「苦手な区間は、発の区間の記録がある練習を 5 回終えると表示されます（今 4 回）」と表示される', async () => {
      const entries = [oldEntry(0), ...Array.from({ length: 4 }, (_, i) => withSections(1 + i, sections(28, 0.3, { 11: { meanH: 2, meanError: 2 } }))), oldEntry(9)];
      const page = await openFresh({ [historyKey('mouse', 'lstar', 'center')]: stored(entries) });
      await openHistory(page, LSTAR.name, CENTER);
      const f = await page.evaluate<SectionFigure>('window.__sectionFigure()');
      expect(f.labels).toEqual([]);
      expect(norm(f.text)).toContain(norm('苦手な区間は、発の区間の記録がある練習を 5 回終えると表示されます（今 4 回）'));
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it('UI-66: sections を持たない古い形式の件だけの組でも、エラーで止まらずに推移のグラフと一覧にその件が表示され、図は描かれない', async () => {
      const seeds = [oldEntry(0, 1.25), oldEntry(1, 2.5), oldEntry(2, 3.75)];
      const page = await openFresh({ [historyKey('mouse', 'lstar', 'center')]: stored(seeds) });
      await openHistory(page, LSTAR.name, CENTER);
      const state = await page.evaluate<{ rows: string[][]; points: number }>(`(() => {
        const screen = document.querySelector('[data-screen="history"]');
        const table = [...screen.querySelectorAll('table')].find((t) => window.__vis(t));
        const rows = table ? [...table.querySelectorAll('tbody tr')].filter((tr) => window.__vis(tr)).map((tr) => [...tr.cells].map((c) => c.textContent.trim())) : [];
        const points = [...screen.querySelectorAll('svg')].filter((s) => window.__vis(s)).reduce((n, s) => n + s.querySelectorAll('circle').length, 0);
        return { rows, points }; })()`);
      expect(state.rows).toHaveLength(3);
      for (const [i, m] of ['1.25', '2.5', '3.75'].entries()) expect(state.rows[i]!.join(' ')).toContain(m);
      expect(state.points).toBeGreaterThanOrEqual(3);
      const f = await page.evaluate<SectionFigure>('window.__sectionFigure()');
      expect(f.labels).toEqual([]);
      expect(f.text).not.toContain('まだ履歴がありません');
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe('補正のパネルの苦手な区間', () => {
    const weakCar = () => stored(Array.from({ length: 5 }, (_, i) => withSections(i, sections(CAR.magSize, 0.2, { 11: { meanH: 2, meanError: 2 } }))));

    async function readPanel(page: Page): Promise<PanelLines> {
      await page.waitFor(`window.__vis('.correction-panel')`);
      await page.frames(3);
      const p = await page.evaluate<PanelLines | null>('window.__panelLines()');
      if (!p) throw new Error('補正のパネルの svg がない');
      return p;
    }

    async function setPanel(page: Page, on: boolean) {
      await page.evaluate(`location.hash = '#/settings'`);
      await page.waitFor(`window.__vis('[data-screen="settings"]') && !!document.getElementById('setting-correction-panel')`);
      if ((await page.evaluate<boolean>(`document.getElementById('setting-correction-panel').checked`)) !== on) await page.clickSelector('#setting-correction-panel');
      await page.waitFor(`document.getElementById('setting-correction-panel').checked === ${on}`);
      await page.frames(2);
    }

    const expectWeakSegments = (colors: (string | null)[]) => {
      expect(colors, JSON.stringify(colors)).not.toContain('missing');
      // k = 11..15（10→11 発目 … 14→15 発目）が苦手な区間の部分。
      const weak = colors.filter((c, i) => c !== null && i + 1 >= 11 && i + 1 <= 15);
      const rest = colors.filter((c, i) => c !== null && (i + 1 < 11 || i + 1 > 15));
      expect(weak.length).toBeGreaterThan(0);
      expect(new Set(weak).size, `苦手な区間の部分の色: ${JSON.stringify(colors)}`).toBe(1);
      expect(new Set(rest).size, `ほかの部分の色: ${JSON.stringify(colors)}`).toBe(1);
      expect(weak[0]).not.toBe(rest[0]);
    };

    it.each([
      [CENTER, 'center'],
      [GHOST, 'ghost'],
    ])('UI-67: 11〜15 発目が苦手な区間の組で %s を始めると、理想の線の 11〜15 発目の部分が違う色で描かれ、「苦手な区間」の凡例が表示される', async (mode, id) => {
      const page = await openFresh({ [historyKey('mouse', CAR.id, id)]: weakCar() });
      if (mode === CENTER) await setPanel(page, true);
      await startPractice(page, CAR.name, mode);
      const p = await readPanel(page);
      expect(p.visible).toBe(true);
      expectWeakSegments(segmentColors(p, CAR));
      expect(p.text + '\n' + p.legend).toContain('苦手な区間');
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);

    it.each([
      ['履歴がない組', {} as Record<string, string>],
      ['すべての発の区間が 0.5 度未満の 5 件の組', { [historyKey('mouse', CAR.id, 'ghost')]: stored(Array.from({ length: 5 }, (_, i) => withSections(i, sections(CAR.magSize, 0.3)))) }],
      ['発の区間の記録が 4 件の組', { [historyKey('mouse', CAR.id, 'ghost')]: stored(Array.from({ length: 4 }, (_, i) => withSections(i, sections(CAR.magSize, 0.2, { 11: { meanH: 2, meanError: 2 } })))) }],
    ])('UI-68: 苦手な区間が「なし」の組（%s）で反復練習を始めると、理想の線は 1 色で、「苦手な区間」の凡例が表示されない', async (_label, seed) => {
      const page = await openFresh(seed);
      await startPractice(page, CAR.name, GHOST);
      const p = await readPanel(page);
      expect(p.visible).toBe(true);
      const colors = segmentColors(p, CAR);
      expect(colors).not.toContain('missing');
      expect(new Set(colors.filter((c) => c !== null)).size, JSON.stringify(colors)).toBe(1);
      expect(p.text + '\n' + p.legend).not.toContain('苦手な区間');
      expect(exceptions(page), page.errors.join('\n')).toEqual([]);
    }, 60_000);
  });
});
