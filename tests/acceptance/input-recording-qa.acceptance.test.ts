// docs/spec/input.md の INP-4〜INP-8 と docs/spec/architecture.md の ARC-2・ARC-3 の QA の受け入れテスト。
// 公開された入口（RecordingInput・replayInput・createSeed・createPractice・practiceOutcome・replayRecording・aimTrajectory・
// 固定ステップのループ・武器とマップの JSON・ビルドした画面）だけを使い、実装の内部には依存しない。
// INP-8 の画面の確認はビルドの結果をヘッドレスの Chromium で開いて行う（tests/helpers/browser.ts）。Chromium がなければ飛ばす。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_FIXED_STEP, FixedStepLoop } from '../../src/core/loop';
import { ManualTimeSource } from '../../src/core/time';
import type { Action, TimedAction } from '../../src/input/actions';
import { createSeed, RecordingInput, replayInput, type InputRecording } from '../../src/input/recording';
import { parseMap, type MapData } from '../../src/sim/map';
import { createPractice, practiceOutcome, replayRecording, type Practice } from '../../src/sim/practice';
import { aimTrajectory } from '../../src/sim/trajectory';
import { parseWeapon, type WeaponData } from '../../src/sim/weapon';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const WEAPON_DIR = join(ROOT, 'src/data/weapons');
const TARGET_RADIUS = 1;

function rangeMap(): MapData {
  const result = parseMap(JSON.parse(readFileSync(join(ROOT, 'src/data/maps/range.json'), 'utf8')));
  if (!result.ok) throw new Error(`range を読み込めない: ${JSON.stringify(result.errors)}`);
  return result.map;
}

/** src/data/weapons/ の JSON のうち、randomness が 0 でない武器。 */
function randomWeapons(): [string, WeaponData][] {
  return readdirSync(WEAPON_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f): [string, WeaponData] => {
      const result = parseWeapon(JSON.parse(readFileSync(join(WEAPON_DIR, f), 'utf8')));
      if (!result.ok) throw new Error(`${f} を読み込めない: ${JSON.stringify(result.errors)}`);
      return [f, result.weapon];
    })
    .filter(([, w]) => w.randomness !== 0);
}

/** 利用者の操作の予定（描画の時計の時刻と、そのとき出るアクション）。 */
function userPlan(): { at: number; action: Action }[] {
  const plan: { at: number; action: Action }[] = [
    { at: 0.02, action: { type: 'ads', pressed: true } },
    { at: 0.08, action: { type: 'fire', pressed: true } },
    { at: 0.9, action: { type: 'ads', pressed: false } },
    { at: 1.1, action: { type: 'ads', pressed: true } },
    { at: 1.9, action: { type: 'fire', pressed: false } },
  ];
  // 撃ちながら下と左右へ引く（マウスの移動のように細かく、不規則な間隔で）。
  for (let i = 0; i < 70; i += 1) {
    plan.push({ at: 0.1 + i * 0.0243, action: { type: 'look', yaw: Math.sin(i * 0.7) * 0.08, pitch: -0.09 - (i % 3) * 0.01 } });
  }
  return plan.sort((a, b) => a.at - b.at);
}

/**
 * 練習を模す。RecordingInput に、hz の描画間隔で回るループの時計の時刻でアクションを積み、ループでシミュレーションを進める。
 * 積んだアクションと時刻も返す。
 */
function practise(weapon: WeaponData, seed: number, hz: number, seconds = 3) {
  const map = rangeMap();
  const input = new RecordingInput(seed);
  const practice = createPractice({ map, weapon, input, seed: input.seed });
  const time = new ManualTimeSource();
  const loop = new FixedStepLoop({ timeSource: time, update: () => practice.sim.step(), render: () => {} });
  const plan = userPlan();
  const pushed: TimedAction[] = [];
  for (let f = 0; f < Math.round(seconds * hz); f += 1) {
    time.advance(1 / hz);
    while (plan.length > 0 && plan[0]!.at <= time.now()) {
      const { action } = plan.shift()!;
      const at = loop.currentTime();
      input.push(at, action);
      pushed.push({ time: at, action });
    }
    loop.frame();
  }
  return { map, practice, recording: input.recording(), pushed };
}

/** 記録を、hz の描画間隔で回るループで再生する。 */
function replayWithLoop(recording: InputRecording, weapon: WeaponData, hz: number, seconds = 3): Practice {
  const practice = createPractice({ map: rangeMap(), weapon, input: replayInput(recording), seed: recording.seed });
  const time = new ManualTimeSource();
  const loop = new FixedStepLoop({ timeSource: time, update: () => practice.sim.step(), render: () => {} });
  for (let f = 0; f < Math.round(seconds * hz); f += 1) {
    time.advance(1 / hz);
    loop.frame();
  }
  return practice;
}

const positionsOf = (shots: readonly { position: unknown }[]) => shots.map((s) => s.position);

describe('前提: randomness が 0 でない武器がある', () => {
  it('src/data/weapons/ に randomness が 0 でない武器が 1 つ以上ある', () => {
    expect(randomWeapons().length).toBeGreaterThan(0);
  });
});

describe.each(randomWeapons())('入力の記録と再生（%s）', (_file, weapon) => {
  it('INP-4: 練習の記録を同じ武器・マップで再生すると、弾痕の位置と採点結果が元の練習と一致する', () => {
    for (const seed of [1, 31337, 0xffffffff]) {
      const { map, practice, recording } = practise(weapon, seed, 60);
      const original = practiceOutcome(practice, TARGET_RADIUS);
      expect(original.shots.length).toBeGreaterThan(5);
      expect(original.shots.some((s) => s.position !== null)).toBe(true);

      const replayed = replayRecording(recording, { map, weapon, targetRadius: TARGET_RADIUS });
      expect(replayed.shots).toHaveLength(original.shots.length);
      expect(positionsOf(replayed.shots)).toEqual(positionsOf(original.shots));
      expect(replayed.score).toEqual(original.score);

      // 記録を時刻の順に流す入力の元をループで回しても同じになる。
      const looped = replayWithLoop(recording, weapon, 60);
      expect(positionsOf(looped.gun.shots)).toEqual(positionsOf(original.shots));
      expect(practiceOutcome(looped, TARGET_RADIUS).score).toEqual(original.score);
    }
  });

  it('INP-5: 同じ記録の種だけを変えて再生すると、弾痕の位置が元の練習と一致しない', () => {
    const { map, practice, recording } = practise(weapon, 4242, 60);
    const original = positionsOf(practice.gun.shots);
    for (const seed of [4243, 0, 123456789]) {
      const changed: InputRecording = { seed, actions: recording.actions };
      const replayed = replayRecording(changed, { map, weapon, targetRadius: TARGET_RADIUS });
      // 入力は同じなので撃った数は同じで、ブレだけが変わる。
      expect(replayed.shots).toHaveLength(original.length);
      expect(positionsOf(replayed.shots)).not.toEqual(original);
    }
  });

  it('ARC-2: 同じ記録を 60Hz 相当と 144Hz 相当の描画間隔で与えると、弾痕の位置と採点結果が一致する', () => {
    const { recording } = practise(weapon, 2718, 75);
    const at60 = replayWithLoop(recording, weapon, 60);
    const at144 = replayWithLoop(recording, weapon, 144);
    expect(at60.gun.shots.length).toBeGreaterThan(5);
    expect(positionsOf(at144.gun.shots)).toEqual(positionsOf(at60.gun.shots));
    expect(practiceOutcome(at144, TARGET_RADIUS).score).toEqual(practiceOutcome(at60, TARGET_RADIUS).score);
  });

  it('ARC-2（補足）: 60Hz と 144Hz で練習した結果を、それぞれの記録の再生で再現できる', () => {
    for (const hz of [60, 144]) {
      const { map, practice, recording } = practise(weapon, 99, hz);
      const replayed = replayRecording(recording, { map, weapon, targetRadius: TARGET_RADIUS });
      expect(positionsOf(replayed.shots)).toEqual(positionsOf(practice.gun.shots));
      expect(replayed.score).toEqual(practiceOutcome(practice, TARGET_RADIUS).score);
    }
  });
});

describe('INP-6: 練習の記録の actions と seed', () => {
  const weapon = randomWeapons()[0]![1];

  it('look・fire・ads を積んで練習すると、actions は積んだアクションと時刻を積んだ順にすべて含む', () => {
    const { recording, pushed } = practise(weapon, 777, 60);
    const types = new Set(pushed.map((p) => p.action.type));
    expect(types).toEqual(new Set(['look', 'fire', 'ads']));
    expect(recording.actions).toHaveLength(pushed.length);
    expect(recording.actions.map((a) => ({ time: a.time, action: a.action }))).toEqual(pushed);
  });

  it('同じ時刻に積んだアクションや、時刻が前後して積んだアクションも、積んだ順のまま記録される', () => {
    const input = new RecordingInput(5);
    const pushed: TimedAction[] = [
      { time: 0.1, action: { type: 'fire', pressed: true } },
      { time: 0.1, action: { type: 'look', yaw: 1, pitch: -1 } },
      { time: 0.1, action: { type: 'ads', pressed: true } },
      { time: 0.3, action: { type: 'look', yaw: -2, pitch: 0.5 } },
      { time: 0.25, action: { type: 'fire', pressed: false } },
    ];
    for (const { time, action } of pushed) input.push(time, action);
    expect(input.recording().actions.map((a) => ({ time: a.time, action: a.action }))).toEqual(pushed);
  });

  it('記録の項目は SPEC の形（seed、actions[].time、actions[].action の type と yaw・pitch または pressed）になっている', () => {
    const { recording } = practise(weapon, 2 ** 31 + 7, 60);
    expect(Number.isInteger(recording.seed)).toBe(true);
    expect(recording.seed).toBe(2 ** 31 + 7);
    for (const { time, action } of recording.actions) {
      expect(time).toBeGreaterThanOrEqual(0);
      if (action.type === 'look') {
        expect(typeof action.yaw).toBe('number');
        expect(typeof action.pitch).toBe('number');
      } else {
        expect(['fire', 'ads']).toContain(action.type);
        expect(typeof action.pressed).toBe('boolean');
      }
    }
  });

  it('記録の seed はその練習の乱数の種で、その種で再生すると同じブレになり、別の種では違うブレになる', () => {
    const seed = 8080;
    const { map, practice, recording } = practise(weapon, seed, 60);
    expect(recording.seed).toBe(seed);
    expect(practice.seed).toBe(seed);
    const same = replayRecording({ seed: recording.seed, actions: recording.actions }, { map, weapon, targetRadius: TARGET_RADIUS });
    expect(same.shots).toEqual(practice.gun.shots);
    const other = replayRecording({ seed: seed + 1, actions: recording.actions }, { map, weapon, targetRadius: TARGET_RADIUS });
    expect(positionsOf(other.shots)).not.toEqual(positionsOf(practice.gun.shots));
  });

  it('練習の開始時に決める種は 0 以上 2³² 未満の整数で、練習ごとに変わる', () => {
    const seeds = Array.from({ length: 20 }, () => createSeed());
    for (const s of seeds) {
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(2 ** 32);
    }
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });
});

describe('INP-7: 照準の軌道', () => {
  const recording: InputRecording = {
    seed: 3,
    actions: [
      { time: 0.1, action: { type: 'look', yaw: 10, pitch: 0 } },
      { time: 0.2, action: { type: 'look', yaw: 0, pitch: -5 } },
    ],
  };

  it('最初の点は時刻 0・ヨー 0・ピッチ 0、0.15 秒の前後はヨー 10・ピッチ 0、最後はヨー 10・ピッチ -5', () => {
    const points = aimTrajectory(recording, { yaw: 0, pitch: 0 });
    expect(points.length).toBeGreaterThan(2);
    expect(points[0]).toEqual({ time: 0, yaw: 0, pitch: 0 });

    const before = [...points].reverse().find((p) => p.time <= 0.15)!;
    const after = points.find((p) => p.time > 0.15)!;
    expect(before.time).toBeGreaterThan(0.1);
    expect(after.time).toBeLessThan(0.2);
    for (const p of [before, after]) {
      expect(p.yaw).toBeCloseTo(10, 9);
      expect(p.pitch).toBeCloseTo(0, 9);
    }

    const last = points.at(-1)!;
    expect(last.yaw).toBeCloseTo(10, 9);
    expect(last.pitch).toBeCloseTo(-5, 9);
    // 最後の点は 0.2 秒の look を消費したステップの終わり。
    expect(last.time).toBeGreaterThan(0.2 - 1e-9);
    expect(last.time).toBeLessThanOrEqual(0.2 + DEFAULT_FIXED_STEP + 1e-9);
  });

  it('点の時刻は固定ステップ（既定 1/120 秒）の間隔で増える', () => {
    const points = aimTrajectory(recording, { yaw: 0, pitch: 0 });
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]!.time - points[i - 1]!.time).toBeCloseTo(DEFAULT_FIXED_STEP, 9);
    }
  });

  it('0.1 秒より前はヨー 0・ピッチ 0 のまま（look を早めに反映しない）', () => {
    const points = aimTrajectory(recording, { yaw: 0, pitch: 0 });
    for (const p of points.filter((q) => q.time < 0.1 - 1e-9)) {
      expect(p.yaw).toBe(0);
      expect(p.pitch).toBe(0);
    }
  });
});

describe('ARC-3: ブラウザなしで、入力の記録だけから発射・弾痕・採点まで', () => {
  it('ブラウザの API がない環境で、アクションの列と種だけを与えて弾痕と採点結果が求まる', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    const [, weapon] = randomWeapons()[0]!;
    const recording: InputRecording = {
      seed: 20261125,
      actions: [
        { time: 0.05, action: { type: 'fire', pressed: true } },
        { time: 0.3, action: { type: 'look', yaw: 0.1, pitch: -0.8 } },
        { time: 0.6, action: { type: 'look', yaw: -0.1, pitch: -0.8 } },
        { time: 0.9, action: { type: 'fire', pressed: false } },
      ],
    };
    const result = replayRecording(recording, { map: rangeMap(), weapon, targetRadius: TARGET_RADIUS });
    expect(result.shots.length).toBeGreaterThan(3);
    expect(result.shots.every((s) => s.position !== null)).toBe(true);
    expect(result.score.shots).toBe(result.shots.length);
    expect(result.score.meanDeviation).not.toBeNull();
    expect(result.score.hitRate).not.toBeNull();

    // もう一度実行しても同じ結果になる（記録だけで決まる）。
    const again = replayRecording(recording, { map: rangeMap(), weapon, targetRadius: TARGET_RADIUS });
    expect(again.shots).toEqual(result.shots);
    expect(again.score).toEqual(result.score);
  });
});

// ---- INP-8: 画面で確かめる ----

const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const BASE = '/apex-training/';
const chromium = findChromium();

/** 保存・コピー・外部への送信の API の呼び出しを記録する（ページのスクリプトより先に実行する）。 */
const SPY = `
(() => {
  const calls = [];
  window.__exfil = calls;
  const wrap = (obj, name, label, filter) => {
    if (!obj || typeof obj[name] !== 'function') return;
    const orig = obj[name];
    obj[name] = function (...args) {
      if (!filter || filter.apply(this, args)) calls.push(label);
      return orig.apply(this, args);
    };
  };
  if (navigator.clipboard) {
    wrap(navigator.clipboard, 'writeText', 'clipboard.writeText');
    wrap(navigator.clipboard, 'write', 'clipboard.write');
  }
  wrap(document, 'execCommand', 'execCommand', (cmd) => /copy|cut/i.test(String(cmd)));
  wrap(navigator, 'sendBeacon', 'sendBeacon');
  wrap(URL, 'createObjectURL', 'createObjectURL');
  wrap(window, 'showSaveFilePicker', 'showSaveFilePicker');
  wrap(window, 'fetch', 'fetch(send)', (input, init) => {
    const method = (init && init.method) || (input && input.method) || 'GET';
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    return method.toUpperCase() !== 'GET' || url.origin !== location.origin;
  });
  wrap(XMLHttpRequest.prototype, 'send', 'xhr.send');
  const OrigWS = window.WebSocket;
  window.WebSocket = function (...args) { calls.push('WebSocket'); return new OrigWS(...args); };
  wrap(HTMLAnchorElement.prototype, 'click', 'anchor.download', function () { return this.hasAttribute('download'); });
  document.addEventListener('copy', () => calls.push('copy-event'), true);
})();
`;

/** 画面（section）の中の操作できる要素を調べる。 */
const CONTROLS = (screen: string) => `(() => {
  const s = document.querySelector('[data-screen="${screen}"]');
  if (!s) return null;
  const els = [...s.querySelectorAll('a, button, input, select, textarea, form, [download], [contenteditable], [role="button"], [role="link"], [onclick]')];
  return els.map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: (el.textContent || el.getAttribute('value') || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim(),
    href: el.getAttribute('href'),
    download: el.hasAttribute('download'),
    action: el.getAttribute('action'),
  }));
})()`;

const FORBIDDEN_WORDS = /保存|コピー|送信|書き出|エクスポート|ダウンロード|共有|アップロード|export|copy|save|send|share|download|upload/i;

function expectNoExportControls(controls: { tag: string; text: string; href: string | null; download: boolean; action: string | null }[]) {
  for (const c of controls) {
    expect(c.tag, JSON.stringify(c)).not.toBe('form');
    expect(c.download, JSON.stringify(c)).toBe(false);
    expect(c.text, JSON.stringify(c)).not.toMatch(FORBIDDEN_WORDS);
    // リンクはアプリの中の画面の切替だけ（外部への URL・データの URL を持たない）。
    if (c.href !== null) expect(c.href, JSON.stringify(c)).toMatch(/^#\//);
  }
}

describe.skipIf(NESTED || !chromium)('INP-8: 練習とリザルトの画面に、入力の記録を外に出す操作がない', () => {
  const temps: string[] = [];
  let server: Server | undefined;
  let browser: Browser | undefined;
  let origin = '';

  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), 'inp8-dist-'));
    temps.push(out);
    const build = spawnSync(`npm run build -- --outDir "${out}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`ビルドが失敗した:\n${build.stdout}${build.stderr}`);
    server = await serveStatic(out, BASE);
    origin = originOf(server);
    browser = await launchBrowser(chromium!);
  }, 180_000);

  // テストが終わるたびに開いたタブを閉じ、裏で描画し続けるタブを残さない。

  afterEach(async () => {

    await browser?.closePages();

  });


  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it('練習中とリザルトで、保存・コピー・送信の操作がなく、練習しても保存・コピー・送信の API が呼ばれない', async () => {
    const page = await browser!.newPage();
    await page.addInitScript(SPY);
    await page.goto(appUrl(origin, BASE, '', { render: false }));
    await page.waitFor(`document.querySelector('[data-screen="top"]') && !document.querySelector('[data-screen="top"]').hidden`);
    await page.clickSelector('[data-screen="top"] a[href="#/play"]');
    await page.waitFor(`!document.querySelector('[data-screen="play"]').hidden`);
    await page.frames(5);

    // 練習の画面の操作。
    const play = await page.evaluate<Parameters<typeof expectNoExportControls>[0] | null>(CONTROLS('play'));
    expect(play).not.toBeNull();
    expectNoExportControls(play!);

    // 撃ちながら照準を動かし、コピーや保存のキー操作もしてみる。
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 400, button: 'left', clickCount: 1 });
    for (let i = 0; i < 20; i += 1) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640 + (i % 3), y: 400 + i, button: 'left' });
      await page.frames(1);
    }
    for (const key of ['c', 's']) {
      for (const modifiers of [2, 4]) {
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: `Key${key.toUpperCase()}`, modifiers });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: `Key${key.toUpperCase()}`, modifiers });
      }
    }
    // 押したまま何度も描画される（練習が進む）まで待つ。
    await page.frames(90);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 420, button: 'left', clickCount: 1 });
    // 練習の終わり（撃ち切り・離したあとの一定時間）でリザルトになるなら、それを待つ。
    try {
      await page.waitFor(`!document.querySelector('[data-screen="result"]').hidden`, 6000);
    } catch {
      // リザルトへの遷移はこの条件の対象外。なっていなくても、リザルトの画面の中身は下で調べる。
    }

    const result = await page.evaluate<Parameters<typeof expectNoExportControls>[0] | null>(CONTROLS('result'));
    expect(result).not.toBeNull();
    expectNoExportControls(result!);

    const calls = await page.evaluate<string[]>('window.__exfil');
    expect(calls).toEqual([]);
    expect(page.errors).toEqual([]);

    // 対照: 記録の仕組みが働いていること（呼べば記録される）。
    await page.evaluate(`URL.createObjectURL(new Blob(['x'])); navigator.sendBeacon('/x', 'y'); true`);
    expect(await page.evaluate<string[]>('window.__exfil')).toEqual(['createObjectURL', 'sendBeacon']);
  }, 60_000);
});
