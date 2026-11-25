// docs/spec/weapons.md の受け入れ条件（WPN-3・WPN-14・WPN-15・WPN-16・WPN-18・WPN-19・WPN-20。C.A.R. SMG と L-STAR の
// 計測した武器データ）の QA の受け入れテスト（#49）。
// 公開された入口（loadWeapons・Gun・Simulation・loadWorld、武器の JSON、計測の記録の JSON）だけを使い、期待値は SPEC の文から求める。
// 計測の記録の場所は、武器データの source が指している docs/measurements/ の JSON（配布物に入らない場所）。
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

const MVP_NAMES = ['R-301', 'R-99', 'フラットライン', 'ボルト', 'スピットファイア', 'L-STAR', 'C.A.R. SMG'];
/** 計測した武器データ（weapons.md）と、その計測の記録。 */
const MEASURED: { name: string; record: string }[] = [
  { name: 'L-STAR', record: 'docs/measurements/lstar.json' },
  { name: 'C.A.R. SMG', record: 'docs/measurements/car.json' },
];
const MEASURED_NAMES = MEASURED.map((m) => m.name);

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

async function weapon(name: string): Promise<WeaponData> {
  const { weapons } = await repoWeapons();
  const found = weapons.filter((w) => w.name === name);
  expect(found, `${name} が武器の一覧に 1 つだけ出る`).toHaveLength(1);
  return found[0]!;
}

function cumulative(pattern: readonly { dx: number; dy: number }[]) {
  let yaw = 0;
  let pitch = 0;
  return pattern.map((p) => ({ yaw: (yaw += p.dx), pitch: (pitch += p.dy) }));
}

/** 正面 10 m に十分大きな壁がある World（大きな跳ねでも外れない）。 */
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

interface Shot {
  angles: { dx: number; dy: number }[];
  /** 平均から外した射撃の理由（書かれていなければ平均に使った射撃）。 */
  excludedFromAverage?: unknown;
  [k: string]: unknown;
}
interface MeasurementRecord {
  weapon: string;
  version?: string;
  tolerance: { dx: number; dy: number };
  shots: Shot[];
  [k: string]: unknown;
}

const readRecord = (file: string) => JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as MeasurementRecord;
const recordText = (file: string) => readFileSync(join(ROOT, file), 'utf8');

/** 射撃に「平均から外した」と書かれているか。キーの名前に依らず、外した旨の項目を探す。 */
function exclusionOf(shot: Shot): unknown {
  for (const [k, v] of Object.entries(shot)) {
    if (/exclu/i.test(k) && v !== undefined && v !== null && v !== false) return v;
  }
  return undefined;
}
const usedShots = (r: MeasurementRecord) => r.shots.filter((s) => exclusionOf(s) === undefined);

// ---------------------------------------------------------------------------

describe('WPN-3: 武器の一覧に MVP の 7 つが出て、計測した 2 つ以外は仮データ', () => {
  it('7 つの武器が出て、L-STAR と C.A.R. SMG 以外の 5 つの source に仮データと書かれている', async () => {
    const { weapons, logs } = await repoWeapons();
    expect(logs, '読み込みの誤りがない').toEqual([]);
    expect(weapons.map((w) => w.name).sort()).toEqual([...MVP_NAMES].sort());
    for (const name of MVP_NAMES.filter((n) => !MEASURED_NAMES.includes(n))) {
      expect(weapons.find((x) => x.name === name)!.source, `${name} の source`).toMatch(/仮データ/);
    }
  });
});

describe.each(MEASURED)('計測した武器データ: $name', ({ name, record }) => {
  it('WPN-14: source に自分で撮影した射撃訓練場の動画からの計測と書かれ、仮データの旨がなく、version に撮影したシーズンがある', async () => {
    const w = await weapon(name);
    for (const word of ['自分で撮影', '射撃訓練場', '動画', '計測']) expect(w.source, `source に「${word}」`).toContain(word);
    expect(w.source).not.toMatch(/仮データ|仮の/);
    // SPEC の例 `S31-Cipher` の形。撮影日（2026-11-25）は S31。
    expect(w.version).toMatch(/^S\d+(-\S+)?$/);
    expect(w.version).toBe('S31-Cipher');
    const r = readRecord(record);
    if (r.version !== undefined) expect(r.version).toBe(w.version);
  });

  it('WPN-15: randomness 0・照準を動かさずに撃つと、i 発目は 1〜i 発目の pattern の合計に当たり、magSize 発で止まる', async () => {
    const w: WeaponData = { ...(await weapon(name)), randomness: 0 };
    const sim = new Simulation(
      wallWorld(),
      inputFromTimedActions([{ time: 0, action: { type: 'fire', pressed: true } } satisfies TimedAction]),
    );
    const gun = new Gun(w, createRandom(11));
    sim.addStepHook((world, dt) => gun.step(world, dt));
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

  it('WPN-16: 平均に使った射撃のうち 1 本で、全発の角度と pattern の合計との差が許容差に収まる', async () => {
    const w = await weapon(name);
    const r = readRecord(record);
    expect(r.weapon).toBe(w.id);
    expect(r.tolerance.dx).toBeGreaterThan(0);
    expect(r.tolerance.dy).toBeGreaterThan(0);
    const used = usedShots(r);
    expect(used.length).toBeGreaterThanOrEqual(1);
    const sums = cumulative(w.pattern);
    const within = used.map(
      (shot) =>
        shot.angles.length === w.magSize &&
        shot.angles.every(
          (a, i) =>
            Math.abs(a.dx - sums[i]!.yaw) <= r.tolerance.dx + 1e-9 && Math.abs(a.dy - sums[i]!.pitch) <= r.tolerance.dy + 1e-9,
        ),
    );
    expect(within, '平均に使った射撃に、許容差に収まる 1 本がある').toContain(true);
  });

  it('WPN-18: source と計測の記録の両方に、計測時のアタッチメントが「すべて紫（レベル 3）」と書かれ、「アタッチメントなし」とは書かれていない', async () => {
    const w = await weapon(name);
    const text = recordText(record);
    for (const [where, s] of [
      ['source', w.source],
      ['計測の記録', text],
    ] as const) {
      // 計測の記録では撮影の条件の attachments の項目がアタッチメントの記述（下で確かめる）。
      if (where === 'source') expect(s, `${where} にアタッチメントの記述`).toMatch(/アタッチメント/);
      expect(s, `${where} に「すべて紫」`).toMatch(/すべて紫/);
      expect(s, `${where} に「レベル 3」`).toMatch(/レベル ?3/);
      expect(s, `${where} に「アタッチメントなし」がない`).not.toMatch(/アタッチメント(なし|無し)/);
    }
    // 計測の記録の撮影の条件にアタッチメントの項目があり、すべて紫と書かれている。
    const conditions = (readRecord(record).conditions ?? {}) as Record<string, unknown>;
    const attachment = Object.entries(conditions).find(([k]) => /attach/i.test(k))?.[1];
    expect(String(attachment), '撮影の条件のアタッチメント').toMatch(/すべて紫（レベル ?3/);
  });

  it('WPN-19: 平均から外していない射撃だけで各発の増分の平均を計算し直すと pattern と 0.005 度以内で一致し、外した射撃には理由がある', async () => {
    const w = await weapon(name);
    const r = readRecord(record);
    const used = usedShots(r);
    expect(used.length).toBeGreaterThanOrEqual(1);
    for (const shot of used) expect(shot.angles.length, '平均に使った射撃の発数').toBeGreaterThanOrEqual(w.magSize);

    for (let i = 0; i < w.magSize; i += 1) {
      // i+1 発目の角度の増分（1 発目は撃つ前の視点 0 からの増分）
      const inc = used.map((s) => ({
        dx: s.angles[i]!.dx - (i === 0 ? 0 : s.angles[i - 1]!.dx),
        dy: s.angles[i]!.dy - (i === 0 ? 0 : s.angles[i - 1]!.dy),
      }));
      const mean = {
        dx: inc.reduce((a, b) => a + b.dx, 0) / inc.length,
        dy: inc.reduce((a, b) => a + b.dy, 0) / inc.length,
      };
      expect(Math.abs(mean.dx - w.pattern[i]!.dx), `${i + 1} 発目の水平`).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(Math.abs(mean.dy - w.pattern[i]!.dy), `${i + 1} 発目の垂直`).toBeLessThanOrEqual(0.005 + 1e-9);
    }

    for (const shot of r.shots) {
      const reason = exclusionOf(shot);
      if (reason === undefined) continue;
      expect(typeof reason, '外した理由は文章').toBe('string');
      expect((reason as string).trim().length, '外した理由が書かれている').toBeGreaterThan(0);
    }
  });
});

describe('C.A.R. SMG の外した射撃（product-owner: 2 回目の射撃は少しずれたかもしれない）', () => {
  it('計測の記録の射撃は 3 回で、平均から外した射撃には理由が書かれ、平均に使った射撃が残る', () => {
    const r = readRecord('docs/measurements/car.json');
    expect(r.shots).toHaveLength(3);
    const excluded = r.shots.filter((s) => exclusionOf(s) !== undefined);
    for (const s of excluded) expect(String(exclusionOf(s)).trim().length).toBeGreaterThan(0);
    expect(usedShots(r).length).toBeGreaterThanOrEqual(2);
  });
});

describe('WPN-20: C.A.R. SMG は SMG で装弾数 30', () => {
  it('category が SMG、magSize が 30', async () => {
    const w = await weapon('C.A.R. SMG');
    expect(w.category).toBe('SMG');
    expect(w.magSize).toBe(30);
  });
});
