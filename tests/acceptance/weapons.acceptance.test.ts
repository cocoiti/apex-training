// docs/spec/weapons.md の受け入れ条件（WPN-1 〜 WPN-5、WPN-8 〜 WPN-17）と modes.md の MODE-1 の受け入れテスト。
// 公開された入口（公開関数・クラス、武器とマップの JSON、ビルドのコマンド）だけを使い、実装の内部には依存しない。
// WPN-1・WPN-2・WPN-12 はリポジトリの写しに JSON を足してビルドし、写しの中で武器の一覧を読み込んで確かめる。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import range from '../../src/data/maps/range.json';
import { FixedStepLoop } from '../../src/core/loop';
import { createRandom } from '../../src/core/random';
import { ManualTimeSource } from '../../src/core/time';
import { loadWeapons } from '../../src/data/weapons';
import type { TimedAction } from '../../src/input/actions';
import { inputFromTimedActions } from '../../src/input/queue';
import { Gun } from '../../src/sim/gun';
import { Simulation } from '../../src/sim/simulation';
import { idealCorrection, type WeaponData } from '../../src/sim/weapon';
import { loadWorld, type World } from '../../src/sim/world';
import { fillWeaponSelect } from '../../src/ui/weapon-choices';
import { createFakeSelect, describeSelect } from '../ui/fake-select';

const ROOT = resolve(__dirname, '../..');
const WEAPONS_DIR = join(ROOT, 'src/data/weapons');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';

/** 戻りの時間（SPEC の値。実装の定数には依存しない）。 */
const RECOVERY = 0.5;

// ---------------------------------------------------------------------------
// 共通の道具
// ---------------------------------------------------------------------------

function weaponJson(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `受け入れ-${id}`,
    category: 'AR',
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
    ...extra,
  };
}

function weapon(extra: Partial<WeaponData> = {}): WeaponData {
  const magSize = extra.magSize ?? 30;
  const pattern = Array.from({ length: magSize }, (_, i) => ({ dx: ((i % 3) - 1) * 0.2, dy: 0.4 + i * 0.02 }));
  return {
    id: 'acc',
    name: 'acc',
    category: 'AR',
    version: 'S31-Cipher',
    source: '仮データ',
    rpm: 600,
    magSize,
    pattern,
    randomness: 0,
    ...extra,
  } as WeaponData;
}

/** 正面に大きな壁だけがある World。開始時の照準はヨー 0・ピッチ 0。 */
function wallWorld(): World {
  const result = loadWorld({
    id: 'acceptance',
    name: 'acceptance',
    spawn: { position: [0, 1.6, 0], yaw: 0, pitch: 0 },
    boxes: [{ id: 'wall', kind: 'wall', center: [0, 1.6, -10.1], size: [200, 200, 0.2] }],
  });
  if (!result.ok) throw new Error(`マップを読み込めない: ${JSON.stringify(result.errors)}`);
  return result.world;
}

function rangeWorld(): World {
  const result = loadWorld(range);
  if (!result.ok) throw new Error(`range を読み込めない: ${JSON.stringify(result.errors)}`);
  return result.world;
}

const press = (time: number): TimedAction => ({ time, action: { type: 'fire', pressed: true } });
const release = (time: number): TimedAction => ({ time, action: { type: 'fire', pressed: false } });
const look = (time: number, yaw: number, pitch: number): TimedAction => ({ time, action: { type: 'look', yaw, pitch } });

function play(w: WeaponData, actions: TimedAction[], opts: { world?: World; seed?: number } = {}) {
  const world = opts.world ?? wallWorld();
  const sim = new Simulation(world, inputFromTimedActions(actions));
  const gun = new Gun(w, createRandom(opts.seed ?? 1));
  sim.addStepHook((wd, dt) => gun.step(wd, dt));
  return { sim, gun, world };
}

/** 1〜i 発目の pattern の合計。 */
function cumulative(pattern: readonly { dx: number; dy: number }[]) {
  let yaw = 0;
  let pitch = 0;
  return pattern.map((p) => ({ yaw: (yaw += p.dx), pitch: (pitch += p.dy) }));
}

// ---------------------------------------------------------------------------
// WPN-1 / WPN-2 / WPN-12: リポジトリの写しに JSON を足してビルドし、写しの中で武器の一覧を読み込む
// ---------------------------------------------------------------------------

/** 写しの中で実行する確認用のテスト。既定の一覧（ファイルの集まり）と既定の出力先（コンソール）で読み込み、結果を JSON で出す。 */
const PROBE = `
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it } from 'vitest';
import { loadWeapons } from '../../src/data/weapons';

it('probe', async () => {
  const root = resolve(__dirname, '../..');
  const messages: string[] = [];
  const capture = (orig: (...a: unknown[]) => void) => (...a: unknown[]) => { messages.push(a.map(String).join(' ')); orig(...a); };
  console.error = capture(console.error.bind(console));
  console.warn = capture(console.warn.bind(console));
  const weapons = await loadWeapons({
    fetchJson: (url: string) => Promise.resolve(JSON.parse(readFileSync(resolve(root, url.replace(/^\\/(apex-training\\/)?/, '').replace(/\\?.*$/, '')), 'utf8'))),
  });
  process.stdout.write('PROBE_RESULT ' + JSON.stringify({ ids: weapons.map((w) => w.id), messages }) + '\\n');
});
`;

interface ProbeResult {
  ids: string[];
  messages: string[];
}

function run(command: string, cwd: string) {
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, APEX_ACCEPTANCE_NESTED: '1', CI: '1', FORCE_COLOR: '0' },
  });
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe.skipIf(NESTED)('WPN-1 / WPN-2 / WPN-12: 武器の JSON を足してビルドする', () => {
  let copy = '';
  let build = { status: null as number | null, output: '' };
  let probe: ProbeResult = { ids: [], messages: [] };
  const originalIds = readdirSync(WEAPONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => (JSON.parse(readFileSync(join(WEAPONS_DIR, f), 'utf8')) as { id: string }).id);

  beforeAll(() => {
    copy = mkdtempSync(join(tmpdir(), 'wpn-acc-'));
    for (const entry of ['src', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'eslint.config.js', 'scripts']) {
      if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
    }
    symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), 'dir');
    const dir = join(copy, 'src/data/weapons');
    // WPN-1: 正しい新しい武器
    writeFileSync(join(dir, 'acceptance-new.json'), JSON.stringify(weaponJson('acceptance-new'), null, 2));
    // WPN-2: rpm が欠けた武器
    const noRpm = weaponJson('acceptance-no-rpm');
    delete noRpm.rpm;
    writeFileSync(join(dir, 'acceptance-no-rpm.json'), JSON.stringify(noRpm, null, 2));
    // WPN-12: pattern の要素数（2）が magSize（3）より少ない武器
    writeFileSync(
      join(dir, 'acceptance-short.json'),
      JSON.stringify(weaponJson('acceptance-short', { pattern: [{ dx: 0, dy: 1 }, { dx: 0, dy: 1 }] }), null, 2),
    );
    build = run('npm run build', copy);
    const probeDir = join(copy, 'tests/acceptance-probe');
    mkdirSync(probeDir, { recursive: true });
    writeFileSync(join(probeDir, 'probe.test.ts'), PROBE);
    const r = run('npx vitest run tests/acceptance-probe', copy);
    const line = r.output.split('\n').find((l) => l.startsWith('PROBE_RESULT '));
    if (!line) throw new Error(`写しの中で武器の一覧を読み込めない:\n${r.output.slice(-4000)}`);
    probe = JSON.parse(line.slice('PROBE_RESULT '.length)) as ProbeResult;
  }, 300_000);

  afterAll(() => {
    if (copy) rmSync(copy, { recursive: true, force: true });
  });

  it('JSON を足してもコードを変えずにビルドが成功し、足した JSON が配布物に入る', () => {
    expect(build.status, build.output.slice(-4000)).toBe(0);
    const assets = readdirSync(join(copy, 'dist/assets'));
    expect(assets.some((f) => /^acceptance-new.*\.json$/.test(f)), assets.join(', ')).toBe(true);
  });

  it('WPN-1: 足した武器が武器の一覧に出る', () => {
    expect(probe.ids).toContain('acceptance-new');
  });

  it('WPN-2: rpm が欠けた武器は一覧に出ず、ファイル名と欠けた項目が開発者向けに出力され、ほかの武器は一覧に出る', () => {
    expect(probe.ids).not.toContain('acceptance-no-rpm');
    const message = probe.messages.find((m) => m.includes('acceptance-no-rpm.json'));
    expect(message, probe.messages.join('\n')).toBeDefined();
    expect(message).toMatch(/rpm/);
    for (const id of [...originalIds, 'acceptance-new']) expect(probe.ids).toContain(id);
  });

  it('WPN-12: pattern が magSize より少ない武器は一覧に出ず、ファイル名と pattern の誤りが開発者向けに出力される', () => {
    expect(probe.ids).not.toContain('acceptance-short');
    const message = probe.messages.find((m) => m.includes('acceptance-short.json'));
    expect(message, probe.messages.join('\n')).toBeDefined();
    expect(message).toMatch(/pattern/);
  });
});

// ---------------------------------------------------------------------------
// WPN-3 / MODE-1: MVP の 6 つの武器
// ---------------------------------------------------------------------------

/** リポジトリの武器の JSON を、ファイルから取得したものとして既定の一覧で読み込む。 */
async function loadRepoWeapons(log: (m: string) => void = () => {}) {
  return loadWeapons({
    fetchJson: (url) => {
      const file = url.replace(/^\/(apex-training\/)?/, '').replace(/\?.*$/, '');
      return Promise.resolve(JSON.parse(readFileSync(resolve(ROOT, file), 'utf8')));
    },
    log,
  });
}

const MVP_NAMES = ['R-301', 'R-99', 'フラットライン', 'ボルト', 'スピットファイア', 'L-STAR'];

describe('WPN-3: MVP の武器', () => {
  it('武器の一覧に 6 つの武器が出て、L-STAR 以外の 5 つは source に仮データであることが書かれている', async () => {
    const logs: string[] = [];
    const weapons = await loadRepoWeapons((m) => logs.push(m));
    expect(logs).toEqual([]);
    const names = weapons.map((w) => w.name);
    for (const name of MVP_NAMES) expect(names, names.join(', ')).toContain(name);
    for (const name of MVP_NAMES.filter((n) => n !== 'L-STAR')) {
      const w = weapons.find((x) => x.name === name)!;
      expect(w.source, `${name} の source`).toMatch(/仮/);
    }
  });
});

// ---------------------------------------------------------------------------
// WPN-14 〜 WPN-17: 計測した L-STAR
// ---------------------------------------------------------------------------

interface MeasurementRecord {
  weapon: string;
  version: string;
  conditions: { fovSetting: number };
  video: { gameArea: { width: number; height: number } };
  conversion: { region: { x0: number; y0: number } };
  tolerance: { dx: number; dy: number };
  shots: { angles: { dx: number; dy: number }[]; imageShiftPx: { x: number; y: number }[] }[];
}

const MEASUREMENT = JSON.parse(readFileSync(join(ROOT, 'docs/measurements/lstar.json'), 'utf8')) as MeasurementRecord;

async function repoLstar(): Promise<WeaponData> {
  const w = (await loadRepoWeapons()).find((x) => x.name === 'L-STAR');
  if (!w) throw new Error('武器の一覧に L-STAR がない');
  return w;
}

describe('WPN-14: L-STAR は計測した武器データ', () => {
  it('source に自分で撮影した射撃訓練場の動画からの計測と書かれ、仮データの旨はなく、version に撮影したシーズンが書かれている', async () => {
    const w = await repoLstar();
    expect(w.source).toMatch(/自分で撮影した射撃訓練場の動画からの計測/);
    expect(w.source).not.toMatch(/仮/);
    // シーズンの書き方は他の武器と同じ（例: S31-Cipher）。計測の記録の撮影したシーズンと一致する。
    expect(w.version).toMatch(/^S\d+-\S+$/);
    expect(w.version).toBe(MEASUREMENT.version);
  });
});

describe('WPN-15: L-STAR を randomness 0 で撃つ', () => {
  it('照準を動かさずに magSize 発撃つと、i 発目は 1〜i 発目の pattern の合計の位置に当たり、magSize 発で止まる', async () => {
    const w = { ...(await repoLstar()), randomness: 0 };
    const { sim, gun } = play(w, [press(0)]);
    sim.advance((w.magSize * 60) / w.rpm + 2);
    expect(gun.shots).toHaveLength(w.magSize);
    const expected = cumulative(w.pattern.slice(0, w.magSize));
    gun.shots.forEach((s, i) => {
      expect(s.deviation, `${i + 1} 発目`).not.toBeNull();
      expect(s.deviation!.yaw).toBeCloseTo(expected[i]!.yaw, 6);
      expect(s.deviation!.pitch).toBeCloseTo(expected[i]!.pitch, 6);
    });
  });
});

describe('WPN-16: 計測の記録と L-STAR の pattern', () => {
  it('計測の記録の射撃のうち 1 本は、全発で i 発目の角度と pattern の 1〜i 発目の合計との差が許容差に収まる', async () => {
    const w = await repoLstar();
    expect(MEASUREMENT.weapon).toBe(w.id);
    const expected = cumulative(w.pattern.slice(0, w.magSize));
    const within = MEASUREMENT.shots.filter(
      (shot) =>
        shot.angles.length === w.magSize &&
        shot.angles.every(
          (a, i) =>
            Math.abs(a.dx - expected[i]!.yaw) <= MEASUREMENT.tolerance.dx + 1e-9 &&
            Math.abs(a.dy - expected[i]!.pitch) <= MEASUREMENT.tolerance.dy + 1e-9,
        ),
    );
    expect(within.length).toBeGreaterThanOrEqual(1);
  });

  it('記録の角度は、画面の動き（ピクセル）を FOV の値の Hor+ の換算（4:3 の水平視野角）で角度にしたもの', () => {
    const { width, height } = MEASUREMENT.video.gameArea;
    const { x0, y0 } = MEASUREMENT.conversion.region;
    const rad = (d: number) => (d * Math.PI) / 180;
    const deg = (r: number) => (r * 180) / Math.PI;
    const halfTan = Math.tan(rad(MEASUREMENT.conditions.fovSetting / 2));
    const tanH = halfTan * (width / height) / (4 / 3); // tan(水平視野角 / 2)
    const tanV = halfTan / (4 / 3); // tan(縦の視野角 / 2)
    const yaw = (x: number) => deg(Math.atan((x / (width / 2)) * tanH));
    const pitch = (y: number) => deg(Math.atan((y / (height / 2)) * tanV));
    for (const shot of MEASUREMENT.shots) {
      expect(shot.imageShiftPx).toHaveLength(shot.angles.length);
      shot.angles.forEach((a, i) => {
        const px = shot.imageShiftPx[i]!;
        expect(Math.abs(a.dx - (yaw(x0) - yaw(x0 + px.x)))).toBeLessThanOrEqual(0.001);
        expect(Math.abs(a.dy - (pitch(y0) - pitch(y0 - px.y)))).toBeLessThanOrEqual(0.001);
      });
    }
  });
});

describe('WPN-17: 動画と画像をリポジトリに入れない', () => {
  // 動画は SPEC（weapons.md WPN-17）、画像は overview.md「権利と表記」の拡張子。
  const VIDEO = ['mp4', 'mov', 'mkv', 'webm', 'avi'];
  const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'];

  it.skipIf(!existsSync(join(ROOT, '.git')))('追跡されたファイルに動画と画像の拡張子のファイルがない', () => {
    const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const files = r.stdout.split('\0').filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    const forbidden = new Set([...VIDEO, ...IMAGE]);
    const found = files.filter((f) => forbidden.has(f.split('.').pop()!.toLowerCase()) && f.includes('.'));
    expect(found).toEqual([]);
  });
});

describe('MODE-1: MVP の 6 つの武器（weapons.md）', () => {
  it('modes.md が weapons.md の MVP の 6 つの武器を指し、weapons.md の MVP の武器が 6 つで武器の一覧と一致する', async () => {
    const modes = readFileSync(join(ROOT, 'docs/spec/modes.md'), 'utf8');
    const weaponsMd = readFileSync(join(ROOT, 'docs/spec/weapons.md'), 'utf8');
    expect(modes).toMatch(/\*\*MODE-1\*\*: MVP の 6 つの武器（\[weapons\.md\]\(weapons\.md\)）/);
    expect(modes).not.toMatch(/5 つの MVP の武器/);
    const mvpLine = weaponsMd.split('\n').find((l) => l.includes('の 6 つ。'));
    expect(mvpLine).toBeDefined();
    for (const name of MVP_NAMES) expect(mvpLine).toContain(name);
    const weapons = await loadRepoWeapons();
    expect(weapons).toHaveLength(6);
  });

  it.todo('MVP の 6 つの武器それぞれでパターン観察・ゴースト追従・センター維持を最後まで練習でき、リザルト画面が表示される（練習モードの Issue で満たす）');
});

// ---------------------------------------------------------------------------
// WPN-4 / WPN-5: 発射
// ---------------------------------------------------------------------------

describe('WPN-4: 描画間隔に依らない発射', () => {
  it.each([60, 144])('rpm 600・装弾数 30 で fire を 1 秒押し続けると、1/%d 秒間隔の描画で 10 発撃たれる', (hz) => {
    const { sim, gun } = play(weapon({ rpm: 600, magSize: 30 }), [press(0), release(1)]);
    const time = new ManualTimeSource();
    const loop = new FixedStepLoop({ timeSource: time, update: () => sim.step(), render: () => {} });
    // 1 秒押し、離したあとも 1 秒描画を続ける（離したあとに撃たれないことも含めて確かめる）。
    for (let i = 0; i < hz * 2; i += 1) {
      time.advance(1 / hz);
      loop.frame();
    }
    expect(gun.shots).toHaveLength(10);
  });
});

describe('WPN-5: 装弾数で止まり、押し直すとまた撃てる', () => {
  it('装弾数 28 で押し続けると 28 発で止まり、離して押し直すとまた撃てる', () => {
    const { sim, gun } = play(weapon({ rpm: 600, magSize: 28 }), [press(0), release(5), press(5.5)]);
    sim.advance(5); // 28 発は 2.7 秒で撃ち終わる。押し続けても増えない
    expect(gun.shots).toHaveLength(28);
    sim.advance(0.4); // 離している間も増えない
    expect(gun.shots).toHaveLength(28);
    sim.advance(0.3); // 5.5 秒に押し直す
    expect(gun.shots.length).toBeGreaterThan(28);
  });
});

// ---------------------------------------------------------------------------
// WPN-8 / WPN-9 / WPN-10: リコイルの戻り・ブレ・当たり判定
// ---------------------------------------------------------------------------

describe('WPN-8: 戻りきったあとはリコイルが残らない', () => {
  it('数発撃って離し、0.5 秒より長く待ってから撃つと、1 発目は照準の位置 + pattern[0] に当たる', () => {
    const w = weapon({ magSize: 30 });
    // 0, 0.1, 0.2, 0.3 の 4 発。0.35 に離し、照準を (+1.5, -0.5) に動かし、0.35 + 0.5 + 0.2 秒後に撃つ。
    const restart = 0.35 + RECOVERY + 0.2;
    const { sim, gun, world } = play(w, [press(0), release(0.35), look(0.5, 1.5, -0.5), press(restart), release(restart + 0.05)]);
    sim.advance(restart + 0.5);
    expect(gun.shots).toHaveLength(5);
    expect(world.player.aim.yaw).toBeCloseTo(1.5, 9);
    expect(world.player.aim.pitch).toBeCloseTo(-0.5, 9);
    const first = gun.shots[4]!;
    expect(first.deviation).not.toBeNull();
    expect(first.deviation!.yaw).toBeCloseTo(1.5 + w.pattern[0]!.dx, 6);
    expect(first.deviation!.pitch).toBeCloseTo(-0.5 + w.pattern[0]!.dy, 6);
  });
});

describe('WPN-9: 種付きのブレ', () => {
  it('同じ入力の記録と同じ種で 2 回撃つと弾痕が一致し、randomness 0 との差は水平・垂直とも randomness 以下', () => {
    const r = 0.3;
    const actions = [press(0), look(0.25, 0.4, -0.2), look(0.75, -0.3, -0.6), release(1.5)];
    const shoot = (randomness: number, seed: number) => {
      const { sim, gun } = play(weapon({ magSize: 30, randomness }), actions, { seed });
      sim.advance(2);
      return gun.shots;
    };
    const a = shoot(r, 123);
    const b = shoot(r, 123);
    const base = shoot(0, 123);
    expect(a.length).toBe(15);
    expect(b.map((s) => s.position)).toEqual(a.map((s) => s.position));
    expect(b.map((s) => s.deviation)).toEqual(a.map((s) => s.deviation));
    a.forEach((shot, i) => {
      expect(shot.deviation).not.toBeNull();
      expect(Math.abs(shot.deviation!.yaw - base[i]!.deviation!.yaw)).toBeLessThanOrEqual(r + 1e-9);
      expect(Math.abs(shot.deviation!.pitch - base[i]!.deviation!.pitch)).toBeLessThanOrEqual(r + 1e-9);
    });
    // ブレが実際に加わっている（どれかの発が randomness 0 と違う）
    expect(a.some((s, i) => s.deviation!.yaw !== base[i]!.deviation!.yaw || s.deviation!.pitch !== base[i]!.deviation!.pitch)).toBe(true);
  });
});

describe('WPN-10: 角度のズレの基準', () => {
  it('range で照準を動かさず、randomness 0・pattern がすべて 0 の武器で撃つと、角度のズレは水平・垂直とも 0 度', () => {
    const w = weapon({ magSize: 6, pattern: Array.from({ length: 6 }, () => ({ dx: 0, dy: 0 })) });
    const { sim, gun } = play(w, [press(0)], { world: rangeWorld() });
    sim.advance(1);
    expect(gun.shots).toHaveLength(6);
    for (const shot of gun.shots) {
      expect(shot.position).not.toBeNull();
      expect(shot.deviation!.yaw).toBeCloseTo(0, 9);
      expect(shot.deviation!.pitch).toBeCloseTo(0, 9);
    }
  });
});

describe('WPN-6 との整合（WPN-8・WPN-9 の前提）', () => {
  it('randomness 0 で照準を動かさずに撃つと、i 発目は pattern の合計の位置に当たる', () => {
    const w = weapon({ magSize: 8 });
    const { sim, gun } = play(w, [press(0)]);
    sim.advance(1.5);
    const expected = cumulative(w.pattern);
    expect(gun.shots).toHaveLength(8);
    gun.shots.forEach((s, i) => {
      expect(s.deviation!.yaw).toBeCloseTo(expected[i]!.yaw, 6);
      expect(s.deviation!.pitch).toBeCloseTo(expected[i]!.pitch, 6);
    });
  });
});

// ---------------------------------------------------------------------------
// WPN-11: 理想の補正軌道
// ---------------------------------------------------------------------------

describe('WPN-11: 理想の補正軌道', () => {
  it('pattern が {dx:1,dy:2}・{dx:-0.5,dy:1} のとき、1 発目は (-1, -2)、2 発目は (-0.5, -3)', () => {
    const w = weapon({ magSize: 2, pattern: [{ dx: 1, dy: 2 }, { dx: -0.5, dy: 1 }] });
    const ideal = idealCorrection(w);
    expect(ideal).toHaveLength(2);
    expect(ideal[0]!.yaw).toBeCloseTo(-1, 12);
    expect(ideal[0]!.pitch).toBeCloseTo(-2, 12);
    expect(ideal[1]!.yaw).toBeCloseTo(-0.5, 12);
    expect(ideal[1]!.pitch).toBeCloseTo(-3, 12);
    // 同じ武器データなら常に同じ結果
    expect(idealCorrection(w)).toEqual(ideal);
  });
});

// ---------------------------------------------------------------------------
// WPN-13: トップ画面の武器の選択肢
// ---------------------------------------------------------------------------

describe('WPN-13: トップ画面の武器の選択肢', () => {
  it('トップ画面を開いたとき、武器の一覧のすべての武器が category ごとに分かれて選択肢に出る', async () => {
    const weapons = await loadRepoWeapons();
    expect(weapons).toHaveLength(6);
    const { select, element } = createFakeSelect();
    fillWeaponSelect(select, weapons);
    const groups = describeSelect(element);
    // 分類ごとに 1 つの optgroup があり、label は category
    const categories = [...new Set(weapons.map((w) => w.category))];
    expect(groups.map((g) => g.tag)).toEqual(categories.map(() => 'OPTGROUP'));
    expect(groups.map((g) => g.label).sort()).toEqual([...categories].sort());
    // すべての武器が、自分の category の optgroup に 1 度だけ出る
    const options = groups.flatMap((g) => g.options.map((o) => ({ ...o, category: g.label })));
    expect(options).toHaveLength(weapons.length);
    for (const w of weapons) {
      const found = options.filter((o) => o.value === w.id);
      expect(found, w.id).toHaveLength(1);
      expect(found[0]).toMatchObject({ tag: 'OPTION', text: w.name, category: w.category });
    }
  });
});
