// docs/spec/weapons.md の受け入れ条件（WPN-1 〜 WPN-5、WPN-8 〜 WPN-23）と modes.md の MODE-1 の受け入れテスト。
// 公開された入口（公開関数・クラス、武器とマップの JSON、ビルドのコマンド）だけを使い、実装の内部には依存しない。
// WPN-1・WPN-2・WPN-12・WPN-21・WPN-22 はリポジトリの写しに JSON を足してビルドし、写しの中で武器の一覧を読み込んで確かめる。
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
    measured: true,
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
    measured: true,
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
// WPN-1 / WPN-2 / WPN-12 / WPN-21 / WPN-22: リポジトリの写しに JSON を足してビルドし、写しの中で武器の一覧を読み込む
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

describe.skipIf(NESTED)('WPN-1 / WPN-2 / WPN-12 / WPN-21 / WPN-22: 武器の JSON を足してビルドする', () => {
  let copy = '';
  let build = { status: null as number | null, output: '' };
  let probe: ProbeResult = { ids: [], messages: [] };
  /** 仮データの武器の JSON の measured を true にしてビルドし直したあとの結果（WPN-21）。 */
  let rebuild = { status: null as number | null, output: '' };
  let reprobe: ProbeResult = { ids: [], messages: [] };
  const originalJson = readdirSync(WEAPONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(WEAPONS_DIR, f), 'utf8')) as { id: string; measured: boolean });
  const originalMeasuredIds = originalJson.filter((w) => w.measured === true).map((w) => w.id);
  const placeholderJson = () => weaponJson('acceptance-placeholder', { measured: false });

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
    // WPN-21: 項目の確認を通る、measured が false の武器
    writeFileSync(join(dir, 'acceptance-placeholder.json'), JSON.stringify(placeholderJson(), null, 2));
    // WPN-22: measured が欠けた武器と、measured が真偽値でない武器
    const noMeasured = weaponJson('acceptance-no-measured');
    delete noMeasured.measured;
    writeFileSync(join(dir, 'acceptance-no-measured.json'), JSON.stringify(noMeasured, null, 2));
    writeFileSync(join(dir, 'acceptance-text-measured.json'), JSON.stringify(weaponJson('acceptance-text-measured', { measured: 'true' }), null, 2));
    build = run('npm run build', copy);
    const probeDir = join(copy, 'tests/acceptance-probe');
    mkdirSync(probeDir, { recursive: true });
    writeFileSync(join(probeDir, 'probe.test.ts'), PROBE);
    const runProbe = (): ProbeResult => {
      const r = run('npx vitest run tests/acceptance-probe', copy);
      const line = r.output.split('\n').find((l) => l.startsWith('PROBE_RESULT '));
      if (!line) throw new Error(`写しの中で武器の一覧を読み込めない:\n${r.output.slice(-4000)}`);
      return JSON.parse(line.slice('PROBE_RESULT '.length)) as ProbeResult;
    };
    probe = runProbe();
    // WPN-21: 同じ JSON の measured だけを true にしてビルドし直す
    writeFileSync(join(dir, 'acceptance-placeholder.json'), JSON.stringify({ ...placeholderJson(), measured: true }, null, 2));
    rebuild = run('npm run build', copy);
    reprobe = runProbe();
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
    for (const id of [...originalMeasuredIds, 'acceptance-new']) expect(probe.ids).toContain(id);
  });

  it('WPN-12: pattern が magSize より少ない武器は一覧に出ず、ファイル名と pattern の誤りが開発者向けに出力される', () => {
    expect(probe.ids).not.toContain('acceptance-short');
    const message = probe.messages.find((m) => m.includes('acceptance-short.json'));
    expect(message, probe.messages.join('\n')).toBeDefined();
    expect(message).toMatch(/pattern/);
  });

  it('WPN-21: measured が false の武器は一覧に出ず、誤りも出力されない。同じ JSON の measured を true にしてビルドすると一覧に出る', () => {
    expect(probe.ids).not.toContain('acceptance-placeholder');
    expect(probe.messages.filter((m) => m.includes('acceptance-placeholder'))).toEqual([]);
    expect(rebuild.status, rebuild.output.slice(-4000)).toBe(0);
    expect(reprobe.ids).toContain('acceptance-placeholder');
    expect(reprobe.messages.filter((m) => m.includes('acceptance-placeholder'))).toEqual([]);
  });

  it('WPN-22: measured が欠けた・真偽値でない武器は一覧に出ず、ファイル名と measured の誤りが開発者向けに出力される', () => {
    for (const id of ['acceptance-no-measured', 'acceptance-text-measured']) {
      expect(probe.ids).not.toContain(id);
      const message = probe.messages.find((m) => m.includes(`${id}.json`));
      expect(message, probe.messages.join('\n')).toBeDefined();
      expect(message).toMatch(/measured/);
    }
  });
});

// ---------------------------------------------------------------------------
// WPN-3 / WPN-20 / WPN-23 / MODE-1: MVP の武器
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

/** 仮データの武器（weapons.md「MVP の武器」）。JSON は残すが、武器の一覧に入れない。 */
const PLACEHOLDERS = [
  { name: 'R-301', file: 'r301.json' },
  { name: 'R-99', file: 'r99.json' },
  { name: 'フラットライン', file: 'flatline.json' },
  { name: 'ボルト', file: 'volt.json' },
  { name: 'スピットファイア', file: 'spitfire.json' },
] as const;
const PLACEHOLDER_NAMES: readonly string[] = PLACEHOLDERS.map((p) => p.name);
/** 計測した武器データの名前と、その計測の記録のファイル（weapons.md「計測した武器データ」）。 */
const MEASURED = [
  { name: 'L-STAR', record: 'docs/measurements/lstar.json' },
  { name: 'C.A.R. SMG', record: 'docs/measurements/car.json' },
] as const;
const MEASURED_NAMES: readonly string[] = MEASURED.map((m) => m.name);

describe('WPN-3: MVP の武器', () => {
  it('武器の一覧（トップ画面の武器の選択肢の元）には L-STAR と C.A.R. SMG の 2 つだけが出て、仮データの 5 つは出ず、誤りも出力されない', async () => {
    const logs: string[] = [];
    const weapons = await loadRepoWeapons((m) => logs.push(m));
    expect(logs).toEqual([]);
    expect(weapons.map((w) => w.name).sort()).toEqual([...MEASURED_NAMES].sort());
    for (const name of PLACEHOLDER_NAMES) expect(weapons.map((w) => w.name)).not.toContain(name);
  });
});

describe('WPN-23: 計測した武器データと仮データの武器の JSON', () => {
  const jsons = readdirSync(WEAPONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((file) => ({ file, json: JSON.parse(readFileSync(join(WEAPONS_DIR, file), 'utf8')) as { id: string; name: string; source: string; measured: unknown } }));

  it('measured が true の JSON には同じ id の計測の記録がある', () => {
    const measured = jsons.filter((j) => j.json.measured === true);
    expect(measured.map((j) => j.json.name).sort()).toEqual([...MEASURED_NAMES].sort());
    for (const { json } of measured) {
      const path = join(ROOT, 'docs/measurements', `${json.id}.json`);
      expect(existsSync(path), path).toBe(true);
      expect((JSON.parse(readFileSync(path, 'utf8')) as { weapon: string }).weapon).toBe(json.id);
    }
  });

  it('measured が false の JSON は R-301・R-99・フラットライン・ボルト・スピットファイアで、source に仮データであることが書かれている', () => {
    const placeholders = jsons.filter((j) => j.json.measured === false);
    expect(placeholders.map((j) => j.file).sort()).toEqual(PLACEHOLDERS.map((p) => p.file).sort());
    expect(placeholders.map((j) => j.json.name).sort()).toEqual([...PLACEHOLDER_NAMES].sort());
    for (const { json } of placeholders) expect(json.source, `${json.name} の source`).toMatch(/仮データ/);
  });
});

describe('WPN-20: C.A.R. SMG の種類と装弾数', () => {
  it('category が SMG で、magSize が 30 である', async () => {
    const w = (await loadRepoWeapons()).find((x) => x.name === 'C.A.R. SMG');
    expect(w).toBeDefined();
    expect(w!.category).toBe('SMG');
    expect(w!.magSize).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// WPN-14 〜 WPN-19: 計測した武器データ（L-STAR・C.A.R. SMG）
// ---------------------------------------------------------------------------

interface MeasurementShot {
  angles: { dx: number; dy: number }[];
  imageShiftPx: { x: number; y: number }[];
  /** 平均から外した射撃の理由。書かれていない射撃が平均に使った射撃。 */
  excludedFromAverage?: string;
}

interface MeasurementRecord {
  weapon: string;
  version: string;
  conditions: { fovSetting: number; attachments: string };
  video: { gameArea: { width: number; height: number } };
  conversion: { region: { x0: number; y0: number } };
  tolerance: { dx: number; dy: number };
  shots: MeasurementShot[];
}

function readRecord(path: string): { text: string; record: MeasurementRecord } {
  const text = readFileSync(join(ROOT, path), 'utf8');
  return { text, record: JSON.parse(text) as MeasurementRecord };
}

async function repoWeapon(name: string): Promise<WeaponData> {
  const w = (await loadRepoWeapons()).find((x) => x.name === name);
  if (!w) throw new Error(`武器の一覧に ${name} がない`);
  return w;
}

const usedShots = (record: MeasurementRecord) => record.shots.filter((s) => s.excludedFromAverage === undefined);

describe.each(MEASURED)('計測した武器データ（$name）', ({ name, record: path }) => {
  const { text, record } = readRecord(path);

  it('WPN-14: source に自分で撮影した射撃訓練場の動画からの計測と書かれ、仮データの旨はなく、version に撮影したシーズンが書かれている', async () => {
    const w = await repoWeapon(name);
    expect(w.source).toMatch(/自分で撮影した射撃訓練場の動画からの計測/);
    expect(w.source).not.toMatch(/仮/);
    // シーズンの書き方は他の武器と同じ（例: S31-Cipher）。計測の記録の撮影したシーズンと一致する。
    expect(w.version).toMatch(/^S\d+-\S+$/);
    expect(w.version).toBe(record.version);
  });

  it('WPN-15: randomness 0 で照準を動かさずに magSize 発撃つと、i 発目は 1〜i 発目の pattern の合計の位置に当たり、magSize 発で止まる', async () => {
    const w = { ...(await repoWeapon(name)), randomness: 0 };
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

  it('WPN-16: 平均に使った射撃のうち 1 本は、全発で i 発目の角度と pattern の 1〜i 発目の合計との差が許容差に収まる', async () => {
    const w = await repoWeapon(name);
    expect(record.weapon).toBe(w.id);
    expect(record.tolerance.dx).toBeGreaterThan(0);
    expect(record.tolerance.dy).toBeGreaterThan(0);
    const expected = cumulative(w.pattern.slice(0, w.magSize));
    const within = usedShots(record).filter(
      (shot) =>
        shot.angles.length === w.magSize &&
        shot.angles.every(
          (a, i) =>
            Math.abs(a.dx - expected[i]!.yaw) <= record.tolerance.dx + 1e-9 &&
            Math.abs(a.dy - expected[i]!.pitch) <= record.tolerance.dy + 1e-9,
        ),
    );
    expect(within.length).toBeGreaterThanOrEqual(1);
  });

  it('記録の角度は、画面の動き（ピクセル）を FOV の値の Hor+ の換算（4:3 の水平視野角）で角度にしたもの', () => {
    const { width, height } = record.video.gameArea;
    const { x0, y0 } = record.conversion.region;
    const rad = (d: number) => (d * Math.PI) / 180;
    const deg = (r: number) => (r * 180) / Math.PI;
    const halfTan = Math.tan(rad(record.conditions.fovSetting / 2));
    const tanH = halfTan * (width / height) / (4 / 3); // tan(水平視野角 / 2)
    const tanV = halfTan / (4 / 3); // tan(縦の視野角 / 2)
    const yaw = (x: number) => deg(Math.atan((x / (width / 2)) * tanH));
    const pitch = (y: number) => deg(Math.atan((y / (height / 2)) * tanV));
    for (const shot of record.shots) {
      expect(shot.imageShiftPx).toHaveLength(shot.angles.length);
      shot.angles.forEach((a, i) => {
        const px = shot.imageShiftPx[i]!;
        expect(Math.abs(a.dx - (yaw(x0) - yaw(x0 + px.x)))).toBeLessThanOrEqual(0.001);
        expect(Math.abs(a.dy - (pitch(y0) - pitch(y0 - px.y)))).toBeLessThanOrEqual(0.001);
      });
    }
  });

  it('WPN-18: source と計測の記録の両方に、計測時のアタッチメントが「すべて紫（レベル 3）」と書かれ、「アタッチメントなし」とは書かれていない', async () => {
    const w = await repoWeapon(name);
    expect(w.source).toMatch(/アタッチメントはすべて紫（レベル 3/);
    expect(record.conditions.attachments).toMatch(/^すべて紫（レベル 3/);
    for (const s of [w.source, text]) {
      expect(s).not.toMatch(/アタッチメントなし/);
      expect(s).not.toMatch(/"attachments": "なし"/);
    }
  });

  it('WPN-19: 平均から外していない射撃だけで各発の角度の増分の平均を計算し直すと pattern と 0.005 度以内で一致し、外した射撃には理由が書かれている', async () => {
    const w = await repoWeapon(name);
    for (const shot of record.shots) {
      if (shot.excludedFromAverage !== undefined) expect(shot.excludedFromAverage.trim(), '外した理由').not.toBe('');
    }
    const used = usedShots(record);
    expect(used.length).toBeGreaterThanOrEqual(1);
    for (const shot of used) expect(shot.angles).toHaveLength(w.magSize);
    // i 発目の角度は 1〜(i-1) 発目の跳ねの合計なので、角度の増分 angles[i] - angles[i-1]（1 発目は angles[0]）が pattern[i] にあたる。
    for (let i = 0; i < w.magSize; i += 1) {
      const inc = used.map((s) => ({
        dx: s.angles[i]!.dx - (i === 0 ? 0 : s.angles[i - 1]!.dx),
        dy: s.angles[i]!.dy - (i === 0 ? 0 : s.angles[i - 1]!.dy),
      }));
      const mean = {
        dx: inc.reduce((a, v) => a + v.dx, 0) / inc.length,
        dy: inc.reduce((a, v) => a + v.dy, 0) / inc.length,
      };
      expect(Math.abs(mean.dx - w.pattern[i]!.dx), `${i + 1} 発目の水平`).toBeLessThanOrEqual(0.005);
      expect(Math.abs(mean.dy - w.pattern[i]!.dy), `${i + 1} 発目の垂直`).toBeLessThanOrEqual(0.005);
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

describe('MODE-1: 武器の一覧の武器（weapons.md）', () => {
  it('modes.md が weapons.md の武器の一覧（L-STAR と C.A.R. SMG）を指し、武器の一覧と一致する', async () => {
    const modes = readFileSync(join(ROOT, 'docs/spec/modes.md'), 'utf8');
    expect(modes).toMatch(/\*\*MODE-1\*\*: 武器の一覧の武器（\[weapons\.md\]\(weapons\.md\)。L-STAR と C\.A\.R\. SMG）/);
    const weapons = await loadRepoWeapons();
    expect(weapons.map((w) => w.name).sort()).toEqual([...MEASURED_NAMES].sort());
  });

  it.todo('武器の一覧の武器それぞれで反復練習・センター維持を最後まで練習でき、リザルト画面が表示される（modes.acceptance.test.ts で確かめる）');
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
    expect(weapons).toHaveLength(MEASURED.length);
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
