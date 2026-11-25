// docs/spec/weapons.md の受け入れ条件（WPN-3、WPN-14〜WPN-17。L-STAR）の QA の受け入れテスト。
// 公開された入口（loadWeapons・Gun・Simulation・loadWorld、武器の JSON、計測の記録の JSON、git の追跡ファイル）だけを使い、
// 期待値は SPEC の文から求める。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRandom } from '../../src/core/random';
import { loadWeapons } from '../../src/data/weapons';
import type { TimedAction } from '../../src/input/actions';
import { inputFromTimedActions } from '../../src/input/queue';
import { Gun } from '../../src/sim/gun';
import { Simulation } from '../../src/sim/simulation';
import type { WeaponData } from '../../src/sim/weapon';
import { loadWorld, type World } from '../../src/sim/world';

const ROOT = resolve(__dirname, '../..');
/** 計測の記録（配布物に入らない場所。L-STAR の source が指している場所）。 */
const MEASUREMENT = join(ROOT, 'docs/measurements/lstar.json');

/** 仮データの武器（weapons.md「MVP の武器」）。武器の一覧に出ない。 */
const PLACEHOLDER_NAMES = ['R-301', 'R-99', 'フラットライン', 'ボルト', 'スピットファイア'];
/** 計測した武器データ（weapons.md）。source に仮データと書かない。 */
const MEASURED_NAMES = ['L-STAR', 'C.A.R. SMG'];

/** リポジトリの武器の JSON を、ブラウザと同じ公開の読み込み口（loadWeapons）で読む。 */
async function repoWeapons(): Promise<{ weapons: WeaponData[]; logs: string[] }> {
  const logs: string[] = [];
  const weapons = await loadWeapons({
    fetchJson: (url) => {
      const file = url.replace(/^\/(apex-training\/)?/, '').replace(/\?.*$/, '');
      return Promise.resolve(JSON.parse(readFileSync(resolve(ROOT, file), 'utf8')));
    },
    log: (m) => logs.push(m),
  });
  return { weapons: [...weapons], logs };
}

async function lstar(): Promise<WeaponData> {
  const { weapons } = await repoWeapons();
  const found = weapons.filter((w) => w.name === 'L-STAR');
  expect(found, 'L-STAR が武器の一覧に 1 つだけ出る').toHaveLength(1);
  return found[0]!;
}

function cumulative(pattern: readonly { dx: number; dy: number }[]) {
  let yaw = 0;
  let pitch = 0;
  return pattern.map((p) => ({ yaw: (yaw += p.dx), pitch: (pitch += p.dy) }));
}

/** 正面 10 m に十分大きな壁がある World（L-STAR の 25 度を超える跳ねでも外れない）。 */
function wallWorld(): World {
  const result = loadWorld({
    id: 'qa-wall',
    name: 'qa-wall',
    spawn: { position: [0, 1.6, 0], yaw: 0, pitch: 0 },
    boxes: [{ id: 'wall', kind: 'wall', center: [0, 1.6, -10.1], size: [400, 400, 0.2] }],
  });
  if (!result.ok) throw new Error(`マップを読み込めない: ${JSON.stringify(result.errors)}`);
  return result.world;
}

interface MeasurementRecord {
  weapon: string;
  version?: string;
  tolerance: { dx: number; dy: number };
  shots: { angles: { dx: number; dy: number }[] }[];
}

function measurement(): MeasurementRecord {
  return JSON.parse(readFileSync(MEASUREMENT, 'utf8')) as MeasurementRecord;
}

// ---------------------------------------------------------------------------

describe('WPN-3: 武器の一覧は計測した 2 つだけ', () => {
  it('武器の一覧に L-STAR と C.A.R. SMG の 2 つだけが出て、R-301・R-99・フラットライン・ボルト・スピットファイアは出ない', async () => {
    const { weapons, logs } = await repoWeapons();
    expect(logs, '読み込みの誤りがない').toEqual([]);
    const names = weapons.map((w) => w.name);
    expect([...names].sort()).toEqual([...MEASURED_NAMES].sort());
    for (const name of PLACEHOLDER_NAMES) expect(names).not.toContain(name);
  });
});

describe('WPN-14: L-STAR は自分で撮影した動画からの計測', () => {
  it('source に射撃訓練場の動画からの計測と書かれ、仮データの旨がなく、version に撮影したシーズンがある', async () => {
    const w = await lstar();
    expect(w.source).toMatch(/自分で撮影/);
    expect(w.source).toMatch(/射撃訓練場/);
    expect(w.source).toMatch(/動画/);
    expect(w.source).toMatch(/計測/);
    expect(w.source).not.toMatch(/仮/);
    // シーズン: SPEC の例 `S31-Cipher` の形（S + 番号、続けて名前）。撮影時（2026-11-25）は S31。
    expect(w.version).toMatch(/^S\d+(-\S+)?$/);
    expect(w.version).toBe(measurement().version ?? w.version);
  });
});

describe('WPN-15: L-STAR を randomness 0 で照準を動かさずに撃つ', () => {
  it('i 発目は 1〜i 発目の pattern の合計の位置に当たり、magSize 発で止まる', async () => {
    const base = await lstar();
    const w: WeaponData = { ...base, randomness: 0 };
    const sim = new Simulation(
      wallWorld(),
      inputFromTimedActions([{ time: 0, action: { type: 'fire', pressed: true } } satisfies TimedAction]),
    );
    const gun = new Gun(w, createRandom(7));
    sim.addStepHook((world, dt) => gun.step(world, dt));
    // magSize 発に要る時間の 2 倍以上、押し続ける
    sim.advance(((w.magSize * 60) / w.rpm) * 2 + 1);

    expect(gun.shots).toHaveLength(w.magSize);
    const expected = cumulative(w.pattern.slice(0, w.magSize));
    gun.shots.forEach((s, i) => {
      expect(s.shot).toBe(i + 1);
      expect(s.deviation, `${i + 1} 発目が壁に当たる`).not.toBeNull();
      expect(s.deviation!.yaw, `${i + 1} 発目の水平`).toBeCloseTo(expected[i]!.yaw, 6);
      expect(s.deviation!.pitch, `${i + 1} 発目の垂直`).toBeCloseTo(expected[i]!.pitch, 6);
    });
  });
});

describe('WPN-16: 計測の記録と L-STAR の pattern', () => {
  it('計測の記録の射撃の 1 本で、各発の角度と pattern の合計の差が許容差に収まる', async () => {
    const w = await lstar();
    const record = measurement();
    expect(record.weapon).toBe(w.id);
    expect(record.tolerance.dx).toBeGreaterThan(0);
    expect(record.tolerance.dy).toBeGreaterThan(0);
    expect(record.shots.length).toBeGreaterThanOrEqual(1);

    const sums = cumulative(w.pattern);
    const within = record.shots.map((shot) => {
      // 計測の記録の 1 本の発数は、過熱するまで撃った発数 = magSize（weapons.md）
      if (shot.angles.length !== w.magSize) return false;
      return shot.angles.every(
        (a, i) =>
          Math.abs(a.dx - sums[i]!.yaw) <= record.tolerance.dx + 1e-9 &&
          Math.abs(a.dy - sums[i]!.pitch) <= record.tolerance.dy + 1e-9,
      );
    });
    expect(within, '許容差に収まる射撃が 1 本以上ある').toContain(true);
  });
});

describe('WPN-17: 動画と画像をリポジトリに入れない', () => {
  it('追跡されたファイルに動画・画像の拡張子のファイルがない', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    const video = ['mp4', 'mov', 'mkv', 'webm', 'avi'];
    // overview.md「権利と表記」の画像の拡張子
    const image = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'];
    const pattern = new RegExp(`\\.(${[...video, ...image].join('|')})$`, 'i');
    expect(files.filter((f) => pattern.test(f))).toEqual([]);
  });
});
