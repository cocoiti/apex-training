// docs/spec/modes.md「フリック」（MODE-47〜MODE-52・MODE-54）と docs/spec/scoring.md「フリックの採点」（SCO-55・SCO-56 の採点）の
// 受け入れテスト。QA が SPEC だけから書いたもの。ブラウザを使わない。
// 公開された入口（登録されたモードの一覧 src/modes/registry の modes、練習モードの共通の型、PracticeSession、入力の元 InputQueue、
// マップの JSON と loadWorld、フリックのモードの結果の形 FlickResult / FlickRecord）だけを使う。
// 的の位置は World の練習の的（world.targets）から読み、照準の向きは SPEC の座標系（ヨー 0・ピッチ 0 が -Z、ヨーが正なら +X、
// ピッチが正なら +Y）からこのファイルで求める。ブラウザで確かめる受け入れ条件は flick-browser-qa.acceptance.test.ts にある。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InputQueue } from '../../src/input/queue';
import type { FlickRecord, FlickResult } from '../../src/modes/aim/flick';
import { modes } from '../../src/modes/registry';
import { PracticeSession } from '../../src/modes/session';
import type { ModeOptionValues, TrainingMode } from '../../src/modes/types';
import type { Vec3 } from '../../src/sim/vec3';
import { loadWorld, type World } from '../../src/sim/world';

const ROOT = resolve(__dirname, '../..');
const DT = 1 / 120;
const DEG = 180 / Math.PI;
const SIN20 = Math.sin((20 * Math.PI) / 180);

/** SPEC の値（modes.md「フリック」）。 */
const RANGES = { near: [3, 8], normal: [8, 14], far: [14, 20] } as const;
const SIZES = { large: 3, medium: 2, small: 1 } as const;
type RangeId = keyof typeof RANGES;
type SizeId = keyof typeof SIZES;

const MAP_JSON = JSON.parse(readFileSync(resolve(ROOT, 'src/data/maps/range.json'), 'utf8')) as {
  boxes: { id: string; kind: string; center: [number, number, number]; size: [number, number, number] }[];
};

function flickMode(): TrainingMode {
  const m = modes.find((x) => x.id === 'flick');
  if (!m) throw new Error(`フリックのモード（id flick）が登録されていない: ${modes.map((x) => x.id).join(', ')}`);
  return m;
}

/** 練習の選択肢の値（選択肢は表示名「出る範囲」「的の大きさ」から探し、値は SPEC の id）。 */
function settingsOf(range: RangeId, size: SizeId): ModeOptionValues {
  const m = flickMode();
  const item = (label: string) => {
    const s = m.options?.find((x) => x.label.ja === label);
    if (!s) throw new Error(`練習の選択肢に「${label}」がない`);
    return s.id;
  };
  return { [item('出る範囲')]: range, [item('的の大きさ')]: size };
}

function newWorld(): World {
  const loaded = loadWorld(MAP_JSON);
  if (!loaded.ok) throw new Error(`マップを読めない: ${JSON.stringify(loaded.errors)}`);
  return loaded.world;
}

/** 目から点への向き（度）。 */
function anglesTo(world: World, point: Vec3): { yaw: number; pitch: number } {
  const eye = world.player.position;
  const dx = point.x - eye.x;
  const dy = point.y - eye.y;
  const dz = point.z - eye.z;
  return { yaw: Math.atan2(dx, -dz) * DEG, pitch: Math.atan2(dy, Math.hypot(dx, dz)) * DEG };
}

interface Run {
  readonly session: PracticeSession<undefined>;
  readonly input: InputQueue;
  readonly world: World;
}

function begin(seed: number, range: RangeId = 'normal', size: SizeId = 'medium'): Run {
  const world = newWorld();
  const input = new InputQueue();
  const session = new PracticeSession({ world, weapon: undefined, mode: flickMode(), input, seed, options: settingsOf(range, size) });
  return { session, input, world };
}

/** 出現している練習の的（1 つのはず）。 */
function visibleTarget(run: Run) {
  const v = run.world.targets.visible;
  expect(v.length, `出現している的の数（時刻 ${run.session.sim.time}）`).toBeLessThanOrEqual(1);
  return v[0];
}

/** 今の照準（度）。 */
const aimNow = (run: Run) => ({ yaw: run.world.player.aim.yaw, pitch: run.world.player.aim.pitch });

/** 時刻 t（ステップの途中）に照準を to へ向ける look を積む。 */
function lookAt(run: Run, t: number, to: { yaw: number; pitch: number }, from = aimNow(run)) {
  run.input.push(t, { type: 'look', yaw: to.yaw - from.yaw, pitch: to.pitch - from.pitch });
}
/** t を含むステップの真ん中の時刻（ステップの境目ちょうどの入力を避ける）。 */
const mid = (t: number) => (Math.floor(t / DT + 1e-6) + 0.5) * DT;
/** 時刻 t を含むステップで fire を押し始め、3 ステップあとに離す（押して離すのを 1 つのステップに収めない）。 */
function pressFire(run: Run, t: number) {
  run.input.push(mid(t), { type: 'fire', pressed: true });
  run.input.push(mid(t) + 3 * DT, { type: 'fire', pressed: false });
}

/** 練習が終わるか、条件が真になるまで 1 ステップずつ進める（上限 limit 秒）。 */
function stepWhile(run: Run, cond: () => boolean, limit = 120) {
  while (!run.session.ended && cond()) {
    if (run.session.sim.time > limit) throw new Error(`${limit} 秒進めても終わらない`);
    run.session.step();
  }
}
function stepUntil(run: Run, t: number) {
  stepWhile(run, () => run.session.sim.time < t - 1e-9);
}

/** 的を 1 つずつ撃って最後まで進め、出現した的の中心の並びと、各的の出現時刻を返す。 */
function shootAll(
  run: Run,
  shoot: (index: number, center: Vec3, appearedAt: number) => { at: number; aim?: { yaw: number; pitch: number } },
) {
  const seen: { id: string; center: Vec3; at: number }[] = [];
  while (!run.session.ended) {
    if (run.session.sim.time > 200) throw new Error('200 秒進めても終わらない');
    run.session.step();
    const t = visibleTarget(run);
    if (t && !seen.some((s) => s.id === t.id && s.center.x === t.center.x && s.center.y === t.center.y && s.center.z === t.center.z)) {
      seen.push({ id: t.id, center: t.center, at: run.session.sim.time });
      const plan = shoot(seen.length - 1, t.center, run.session.sim.time);
      if (plan.aim) lookAt(run, mid(plan.at), plan.aim);
      pressFire(run, plan.at);
    }
  }
  return seen;
}

const records = (run: Run) => (run.session.result!.modeResult as FlickResult).targets;

const status = (run: Run) => run.session.status ?? '';

// ---------------------------------------------------------------------------

describe('フリックのモードの登録', () => {
  it('モードの id は flick・表示名「フリック」・種類 aim で、武器を使わず、出る範囲と的の大きさの練習の設定を持ち、既定は「ふつう」「中」', () => {
    const m = flickMode();
    expect(m.name).toEqual({ ja: 'フリック', en: 'Flick' });
    expect(m.category).toBe('aim');
    expect(m.usesWeapon).toBe(false);
    const range = m.options?.find((s) => s.label.ja === '出る範囲');
    const size = m.options?.find((s) => s.label.ja === '的の大きさ');
    expect(range?.choices.map((c) => [c.id, c.name.ja])).toEqual([
      ['near', '近い'],
      ['normal', 'ふつう'],
      ['far', '遠い'],
    ]);
    expect(size?.choices.map((c) => [c.id, c.name.ja])).toEqual([
      ['large', '大'],
      ['medium', '中'],
      ['small', '小'],
    ]);
    expect(range?.defaultChoice).toBe('normal');
    expect(size?.defaultChoice).toBe('medium');
  });
});

describe('MODE-47: 的が出てから 0.3 秒後に的の中心へ照準を向けて撃つ', () => {
  it('その的の時間が 0.3 秒・命中・ズレ 0 度として記録される', () => {
    const run = begin(1234);
    stepUntil(run, 1 - DT / 2);
    expect(run.world.targets.visible).toHaveLength(0);
    stepUntil(run, 1 + DT / 2);
    const t = visibleTarget(run);
    expect(t, '1 秒のステップで的が出ている').toBeDefined();
    // 出現の時刻 1 秒。0.3 秒後のステップ（終わりが 1.3 秒）の途中で、的の中心へ向けて撃つ。
    const fireAt = 1.3 - DT / 2;
    lookAt(run, fireAt, anglesTo(run.world, t!.center));
    pressFire(run, fireAt);
    stepUntil(run, 1.3 + DT / 2);
    expect(status(run)).toBe('的: 1 / 20');
    expect(run.session.ended, 'まだ終わっていない').toBe(false);
    // 記録は結果に出るので、残りを中心で撃って終える。
    shootAll(run, (_i, _c, at) => ({ at: at + 0.05 }));
    const first = records(run)[0]!;
    expect(first.time).toBeCloseTo(0.3, 9);
    expect(first.hit).toBe(true);
    expect(first.error).toBeCloseTo(0, 6);
  });
});

describe('MODE-48: 見込み角より大きくヨーをずらして撃つ', () => {
  it('その的は外れとして記録され、その的は消えて次の的が出る（撃ち直さない）', () => {
    const run = begin(99, 'normal', 'medium');
    stepUntil(run, 1 + DT / 2);
    const first = visibleTarget(run)!;
    const on = anglesTo(run.world, first.center);
    const fireAt = 1.5 - DT / 2;
    lookAt(run, fireAt, { yaw: on.yaw + SIZES.medium * 1.5, pitch: on.pitch });
    pressFire(run, fireAt);
    stepUntil(run, 1.5 + DT / 2);
    expect(status(run)).toBe('的: 1 / 20');
    const next = visibleTarget(run);
    expect(next, '次の的が出ている').toBeDefined();
    expect(next!.center).not.toEqual(first.center);
    expect(run.world.targets.visible.some((x) => x.center.x === first.center.x && x.center.y === first.center.y)).toBe(false);
    shootAll(run, (_i, _c, at) => ({ at: at + 0.05 }));
    const recs = records(run);
    expect(recs).toHaveLength(20);
    expect(recs[0]!.hit).toBe(false);
    expect(recs[0]!.error).toBeGreaterThan(SIZES.medium);
    expect(run.session.shots[0]!.target).toBeUndefined();
  });
});

describe('MODE-49: 的の位置の並びは種と練習の設定だけで決まる', () => {
  const offsets = (seed: number, variant: 'center' | 'aim') => {
    const run = begin(seed, 'normal', 'medium');
    const seen = shootAll(run, (i, c, at) =>
      variant === 'center'
        ? { at: at + 0.05 + (i % 3) * 0.1 }
        : { at: at + 0.4 + (i % 5) * 0.07, aim: anglesTo(run.world, c) },
    );
    expect(seen).toHaveLength(20);
    return { centers: seen.map((s) => s.center), recs: records(run) };
  };

  it('同じ種で違う入力（撃つ時刻と照準）で最後まで進めると 1〜20 個目の位置の並びが一致し、違う種では一致しない', () => {
    const a = offsets(2024, 'center');
    const b = offsets(2024, 'aim');
    // 入力が違うことの確かめ（a は外れ、b は命中）。
    expect(a.recs.filter((r) => r.hit)).toHaveLength(0);
    expect(b.recs.filter((r) => r.hit).length).toBeGreaterThan(15);
    expect(b.centers).toEqual(a.centers);
    const c = offsets(2025, 'center');
    expect(c.centers).not.toEqual(a.centers);
  });
});

describe('MODE-50: 出る範囲ごとの角度の距離と、壁の正面の範囲', () => {
  const wall = MAP_JSON.boxes.find((b) => b.kind === 'wall')!;
  const front = wall.center[2] + wall.size[2] / 2;
  const nearestBoxFront = Math.max(...MAP_JSON.boxes.map((b) => b.center[2] + b.size[2] / 2));

  for (const range of Object.keys(RANGES) as RangeId[]) {
    it(`「${range}」: 20 個の角度の距離が区間に入り、|Δpitch| ≤ 距離 × sin20°、的は壁の正面の範囲でマップの箱より手前にある`, () => {
      for (const size of Object.keys(SIZES) as SizeId[]) {
        const run = begin(777, range, size);
        const seen = shootAll(run, (_i, _c, at) => ({ at: at + 0.05 }));
        expect(seen).toHaveLength(20);
        const [lo, hi] = RANGES[range];
        let right = 0;
        for (const s of seen) {
          const a = anglesTo(run.world, s.center);
          const d = Math.hypot(a.yaw - run.world.center.yaw, a.pitch - run.world.center.pitch);
          expect(d, `${range}・${size} の角度の距離`).toBeGreaterThanOrEqual(lo - 1e-6);
          expect(d).toBeLessThan(hi + 1e-6);
          expect(Math.abs(a.pitch - run.world.center.pitch)).toBeLessThanOrEqual(d * SIN20 + 1e-6);
          if (a.yaw > 0) right += 1;
          // 的の中心（人形の中心）は壁の正面の範囲にある（撃った的は消えているので、中心で確かめる）。
          expect(s.center.x).toBeGreaterThanOrEqual(wall.center[0] - wall.size[0] / 2);
          expect(s.center.x).toBeLessThanOrEqual(wall.center[0] + wall.size[0] / 2);
          expect(s.center.y).toBeGreaterThanOrEqual(wall.center[1] - wall.size[1] / 2);
          expect(s.center.y).toBeLessThanOrEqual(wall.center[1] + wall.size[1] / 2);
          expect(s.center.z, '壁の正面より手前').toBeGreaterThan(front);
          expect(s.center.z, 'マップの箱より手前').toBeGreaterThan(nearestBoxFront);
        }
        // 右向きと左向きの両方が出る（半々で選ぶ）。
        expect(right).toBeGreaterThan(0);
        expect(right).toBeLessThan(20);
      }
    });
  }
});

describe('MODE-51: 的の大きさごとの命中の境目', () => {
  for (const size of Object.keys(SIZES) as SizeId[]) {
    it(`「${size}」（見込み角 ${SIZES[size]} 度）: 人形の中心から見込み角の半分よりわずかに小さくヨーをずらすと命中（胴の端の内側）、わずかに大きくずらすと外れ（脇の下の空き）`, () => {
      // 人形の部分の箱には奥行き（0.25 × 縮尺）があり、斜めから見るほど脇の下の空きは側面で塞がる。照準の中心に近い「近い」の範囲で、
      // 大きくずらすときは照準の中心の側（的が右なら左）へずらす。
      const run = begin(31337, 'near', size);
      const half = SIZES[size] / 2;
      const plan: boolean[] = [];
      shootAll(run, (i, c, at) => {
        const inside = i % 2 === 0;
        plan.push(inside);
        const on = anglesTo(run.world, c);
        const toCenter = on.yaw > run.world.center.yaw ? -1 : 1;
        const sign = inside && i % 4 === 0 ? -toCenter : toCenter;
        return { at: at + 0.2, aim: { yaw: on.yaw + sign * half * (inside ? 0.95 : 1.08), pitch: on.pitch } };
      });
      const recs = records(run);
      expect(recs).toHaveLength(20);
      expect(recs.map((r) => r.hit)).toEqual(plan);
    });
  }

  it('MODE-62: 人形の胴の幅は 2 × L × tan(見込み角 ÷ 2)（L は目から的の中心までの距離）で、人形の高さは胴の幅に比例する', () => {
    for (const size of Object.keys(SIZES) as SizeId[]) {
      const run = begin(5, 'far', size);
      stepUntil(run, 1 + DT / 2);
      const t = visibleTarget(run)!;
      const eye = run.world.player.position;
      const L = Math.hypot(t.center.x - eye.x, t.center.y - eye.y, t.center.z - eye.z);
      const w = 2 * L * Math.tan((SIZES[size] * Math.PI) / 360);
      const torso = t.parts.find((p) => p.id === 'torso')!;
      expect(torso.size.x).toBeCloseTo(w, 6);
      const top = Math.max(...t.parts.map((p) => p.offset.y + p.size.y / 2));
      const bottom = Math.min(...t.parts.map((p) => p.offset.y - p.size.y / 2));
      expect((top - bottom) / torso.size.x).toBeCloseTo(1.8 / 0.5, 9);
    }
  });
});

describe('MODE-52: リコイルをかけず、撃たないあいだも終わらない', () => {
  it('fire を押し続けても撃たなくてもリコイルのオフセットは 0 のままで、的を撃たずに 10 秒たっても練習は終わらない', () => {
    const run = begin(8);
    run.input.push(1.2, { type: 'fire', pressed: true });
    run.input.push(2.5, { type: 'fire', pressed: false });
    const offsets = new Set<string>();
    stepWhile(run, () => {
      offsets.add(`${run.world.player.recoilOffset.yaw},${run.world.player.recoilOffset.pitch}`);
      return run.session.sim.time < 2.6;
    });
    expect([...offsets]).toEqual(['0,0']);
    expect(status(run)).toBe('的: 1 / 20');
    const lastShotEnd = run.session.sim.time;
    stepWhile(run, () => {
      offsets.add(`${run.world.player.recoilOffset.yaw},${run.world.player.recoilOffset.pitch}`);
      return run.session.sim.time < lastShotEnd + 10.5;
    });
    expect(run.session.ended).toBe(false);
    expect(run.session.result).toBeUndefined();
    expect([...offsets]).toEqual(['0,0']);
    expect(run.world.targets.visible).toHaveLength(1);
    // 押し続けても 2 発目は出ない。
    expect(run.session.shots).toHaveLength(1);
  });
});

describe('MODE-54: 1 個目の的が出る前に撃った弾', () => {
  it('どの的の弾にも数えられず、HUD の表示は「的: 0 / 20」のまま', () => {
    const run = begin(42);
    expect(status(run)).toBe('的: 0 / 20');
    pressFire(run, 0.5);
    pressFire(run, 0.9);
    stepUntil(run, 1 - DT / 2);
    expect(status(run)).toBe('的: 0 / 20');
    stepUntil(run, 1.2);
    expect(status(run)).toBe('的: 0 / 20');
    expect(run.world.targets.visible).toHaveLength(1);
    shootAll(run, (_i, _c, at) => ({ at: at + 0.05 }));
    expect(records(run)).toHaveLength(20);
    // 最初の的の時間は出現から測る（前の弾に引きずられない）。
    expect(records(run)[0]!.time).toBeGreaterThan(0);
    expect(records(run)[0]!.time).toBeLessThan(0.3);
  });
});

// ---------------------------------------------------------------------------

/** 記録から、モードの採点（scoring）で採点する。 */
function score(recs: FlickRecord[]) {
  const m = flickMode();
  expect(m.scoring).toBeDefined();
  const modeResult: FlickResult = { settings: { range: 'normal', size: 'medium' }, offsets: [], targets: recs };
  const s = m.scoring!.score({ shots: [], duration: 30, modeResult });
  const row = (label: string) => {
    const r = s.metrics.find((x) => x.label.includes(label));
    if (!r) throw new Error(`${label} の行がない: ${JSON.stringify(s.metrics)}`);
    return r.value;
  };
  return { s, row };
}

describe('SCO-55: 18/20 命中・時間 0.5 秒・ズレ 0.5 度と 3 度', () => {
  it('命中 1 回あたりの時間 ≈ 0.556 秒、時間の平均 0.500 秒、命中率 90.0%、命中数 18 / 20、ズレの平均 0.75 度', () => {
    const recs: FlickRecord[] = Array.from({ length: 20 }, (_, i) => (i < 18 ? { time: 0.5, hit: true, error: 0.5 } : { time: 0.5, hit: false, error: 3 }));
    const { s, row } = score(recs);
    expect(s.value).toBeCloseTo(10 / 18, 9);
    expect(row('命中 1 回あたりの時間')).toBe('0.556 秒');
    expect(row('時間の平均')).toBe('0.500 秒');
    expect(row('命中率')).toBe('90.0%');
    expect(row('命中数')).toBe('18 / 20');
    expect(row('ズレの平均')).toBe('0.75°');
    expect(s.comments ?? []).toEqual([]);
    expect(flickMode().scoring!.compare.better).toBe('lower');
  });
});

describe('SCO-56: 命中が 0 のとき', () => {
  it('命中 1 回あたりの時間は「なし」（比べる指標の値も求まらない）で、時間の平均・命中率 0.0%・ズレの平均は求まる', () => {
    const recs: FlickRecord[] = Array.from({ length: 20 }, () => ({ time: 0.4, hit: false, error: 2 }));
    const { s, row } = score(recs);
    expect(s.value).toBeNull();
    expect(row('命中 1 回あたりの時間')).toBe('なし');
    expect(row('時間の平均')).toBe('0.400 秒');
    expect(row('命中率')).toBe('0.0%');
    expect(row('命中数')).toBe('0 / 20');
    expect(row('ズレの平均')).toBe('2.00°');
  });

  it('撃った的が 0 のときは、すべての指標が「なし」', () => {
    const { s, row } = score([]);
    expect(s.value).toBeNull();
    for (const label of ['命中 1 回あたりの時間', '時間の平均', '命中率', 'ズレの平均']) expect(row(label), label).toBe('なし');
  });
});
