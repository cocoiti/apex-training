// docs/spec/modes.md「追いエイム」（MODE-37〜MODE-42 のブラウザなしで確かめる部分）と、docs/spec/scoring.md「追いエイムの採点」
// （SCO-45〜SCO-48、SCO-53・SCO-54 の採点の部分）の受け入れテスト。QA が SPEC だけから書いたもの（#73）。
// 公開された入口（src/modes/aim/ のモードのファイル、練習モードの共通の型、PracticeSession、loadWorld とマップの JSON、parseWeapon と武器の JSON、
// 入力の元 inputFromTimedActions、描画の ViewScene・TargetMarks）だけを使い、ブラウザなしで動かす。
// 期待値は SPEC の値（20 秒、基準の点 8 メートル、速さ 1.5・3.0・4.5 m/s、切り返し 0.5〜1.5 秒、範囲 ±3 メートル、的の幅 0.5 メートル、
// 速さの id slow・normal・fast）と SPEC の座標系（ヨー 0・ピッチ 0 が -Z、ヨーが正なら +X、ピッチが正なら +Y）から、このファイルで求める。
// 切り返しの時刻は、各ステップの的の中心の位置の列から求める（動く向きが変わったステップの前後の位置と一定の速さから、反転した時刻を解く）。
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { TimedAction } from '../../src/input/actions';
import { inputFromTimedActions } from '../../src/input/queue';
import trackingRecoilMode from '../../src/modes/aim/tracking-recoil';
import trackingMode from '../../src/modes/aim/tracking';
import { PracticeSession } from '../../src/modes/session';
import type { TrainingMode } from '../../src/modes/types';
import { ViewScene } from '../../src/render/scene';
import { TargetMarks } from '../../src/render/targets';
import type { Vec3 } from '../../src/sim/vec3';
import { parseWeapon, type WeaponData } from '../../src/sim/weapon';
import { loadWorld, type World } from '../../src/sim/world';

const ROOT = resolve(__dirname, '../..');

/** SPEC の値。 */
const DURATION = 20;
const DT = 1 / 120;
const N = Math.round(DURATION / DT);
const DISTANCE = 8;
const RANGE = 3;
const WIDTH = 0.5;
const SPEEDS = { slow: 1.5, normal: 3.0, fast: 4.5 } as const;
type Speed = keyof typeof SPEEDS;
const EPS = 1e-6;

function rangeWorld(): World {
  const r = loadWorld(JSON.parse(readFileSync(join(ROOT, 'src/data/maps/range.json'), 'utf8')));
  if (!r.ok) throw new Error(`マップが読めない: ${JSON.stringify(r.errors)}`);
  return r.world;
}

function weapon(id: string): WeaponData {
  const r = parseWeapon(JSON.parse(readFileSync(join(ROOT, `src/data/weapons/${id}.json`), 'utf8')));
  if (!r.ok) throw new Error(`武器が読めない: ${id}`);
  return r.weapon;
}

interface Angles {
  yaw: number;
  pitch: number;
}

/** 目から点への向き（度）。SPEC の座標系: ヨー 0・ピッチ 0 が -Z、ヨー正が +X、ピッチ正が +Y。 */
function anglesTo(eye: Vec3, point: Vec3): Angles {
  const dx = point.x - eye.x;
  const dy = point.y - eye.y;
  const dz = point.z - eye.z;
  const deg = 180 / Math.PI;
  return { yaw: Math.atan2(dx, -dz) * deg, pitch: Math.atan2(dy, Math.hypot(dx, dz)) * deg };
}

/** 練習の的（追いエイムは 1 つ）。 */
function theTarget(world: World) {
  const all = world.targets.all;
  expect(all, '追いエイムの練習の的は 1 つ').toHaveLength(1);
  return all[0]!;
}

function makeSession(opts: { seed: number; speed?: Speed; mode?: TrainingMode; actions?: TimedAction[]; weapon?: WeaponData }) {
  const mode = opts.mode ?? trackingMode;
  const world = rangeWorld();
  const input = inputFromTimedActions(opts.actions ?? []);
  if (opts.weapon) return new PracticeSession<WeaponData>({ world, weapon: opts.weapon, mode, input, seed: opts.seed, options: { speed: opts.speed ?? 'normal' } });
  return new PracticeSession<undefined>({ world, weapon: undefined, mode, input, seed: opts.seed, options: { speed: opts.speed ?? 'normal' } });
}

interface Motion {
  /** 練習の開始時（setup のあと）の的の中心。 */
  start: Vec3;
  /** 各ステップの終わりの時刻と、的の中心。 */
  steps: { time: number; center: Vec3 }[];
  /** 切り返しの時刻と、動く範囲の端での切り返しか。 */
  reversals: { time: number; edge: boolean }[];
  ended: boolean;
  eye: Vec3;
  baseCenter: Angles;
}

/** 照準を動かさずに練習を最後まで（または seconds 秒まで）進め、的の動きを読む。 */
function motion(seed: number, speed: Speed = 'normal', seconds = DURATION + 1): Motion {
  const s = makeSession({ seed, speed });
  const start = { ...theTarget(s.world).center };
  const steps: { time: number; center: Vec3 }[] = [];
  while (!s.ended && s.sim.time < seconds - 1e-9) {
    s.step();
    steps.push({ time: s.sim.time, center: { ...theTarget(s.world).center } });
  }
  return { start, steps, reversals: reversalsOf(start, steps, SPEEDS[speed]), ended: s.ended, eye: s.world.player.position, baseCenter: s.world.center };
}

/**
 * 位置の列から切り返しの時刻を求める。切り返しのないステップでは、的は一定の速さ v で同じ向きに v·DT 進む。
 * そうならないステップで反転したとして、前後の位置から反転した時刻を解く（1 ステップに 2 回反転することは、間隔が 0.5 秒以上なのでない）。
 */
function reversalsOf(start: Vec3, steps: { time: number; center: Vec3 }[], v: number) {
  const out: { time: number; edge: boolean }[] = [];
  let prevX = start.x;
  let prevT = 0;
  let dir = 0;
  for (const { time, center } of steps) {
    if (dir === 0) {
      dir = Math.sign(center.x - prevX);
      if (dir === 0) throw new Error('最初のステップで的が動かない');
    } else if (Math.abs(center.x - (prevX + dir * v * (time - prevT))) > 1e-9) {
      // prevT に prevX にいて dir の向きに動き、t_r で反転して time に center.x にいる: x = prevX + dir·v·(t_r − prevT) − dir·v·(time − t_r)
      const tr = (center.x - prevX) / (2 * dir * v) + (prevT + time) / 2;
      if (tr < prevT - 1e-9 || tr > time + 1e-9) throw new Error(`時刻 ${time} のステップの動きが一定の速さの 1 回の反転で説明できない`);
      const xr = prevX + dir * v * (tr - prevT);
      out.push({ time: tr, edge: Math.abs(Math.abs(xr - start.x) - RANGE) < 1e-6 });
      dir = -dir;
    }
    prevX = center.x;
    prevT = time;
  }
  return out;
}

/**
 * 照準の入力の列を作る。aimAt(ステップの番号, そのステップの終わりの的の中心) が返した向き（絶対のヨー・ピッチ、度）にそのステップで向ける。
 * 入力はそのステップの中の時刻に置く（ステップ k は時刻 (k, k+1]·DT の入力を取り、終わりの時刻で的の位置を決める）。
 */
function aimActions(m: Motion, aimAt: (k: number, center: Vec3, time: number) => Angles): TimedAction[] {
  const actions: TimedAction[] = [];
  let cur: Angles = { ...m.baseCenter };
  m.steps.forEach(({ center, time }, k) => {
    const want = aimAt(k, center, time);
    if (Math.abs(want.yaw - cur.yaw) > 1e-12 || Math.abs(want.pitch - cur.pitch) > 1e-12) {
      actions.push({ time: k * DT + DT / 2, action: { type: 'look', yaw: want.yaw - cur.yaw, pitch: want.pitch - cur.pitch } });
      cur = want;
    }
  });
  return actions;
}

interface Played {
  rows: Record<string, string>;
  value: number | null;
  aimedSteps: number;
  steps: number;
  session: PracticeSession<WeaponData> | PracticeSession<undefined>;
}

/** 入力を与えて最後まで練習し、モードの採点の結果（リザルト画面の指標の行）を返す。 */
function play(seed: number, actions: TimedAction[], opts: { speed?: Speed; mode?: TrainingMode; weapon?: WeaponData } = {}): Played {
  const s = makeSession({ seed, actions, ...opts });
  const mode = opts.mode ?? trackingMode;
  let aimedSteps = 0;
  let steps = 0;
  while (!s.ended && steps < N + 240) {
    s.step();
    steps += 1;
    if (s.world.targets.isAimed(theTarget(s.world).id)) aimedSteps += 1;
  }
  expect(s.ended, '20 秒で練習が終わる').toBe(true);
  const result = s.result!;
  expect(mode.scoring, '追いエイムはモードの採点を持つ').toBeDefined();
  const score = mode.scoring!.score({ shots: result.shots, duration: result.duration, modeResult: result.modeResult });
  const rows: Record<string, string> = {};
  for (const r of score.metrics) rows[r.label] = r.value;
  return { rows, value: score.value, aimedSteps, steps, session: s };
}

const num = (s: string | undefined) => {
  const m = (s ?? '').match(/-?\d+(?:\.\d+)?/);
  if (!m) throw new Error(`数がない: ${s}`);
  return Number(m[0]);
};
const row = (p: Played, label: string) => {
  const key = Object.keys(p.rows).find((k) => k.includes(label));
  if (!key) throw new Error(`${label} の行がない: ${JSON.stringify(p.rows)}`);
  return p.rows[key]!;
};

const SEEDS = [1, 2, 3, 7, 42, 1234, 99991, 2 ** 31 + 5];

// ---------------------------------------------------------------------------

describe('MODE-37: 同じ種・同じ速さなら同じ動き', () => {
  it('同じ種・同じ速さで 20 秒進めると、各ステップの的の中心の位置と切り返しの時刻の列が 2 回で一致する', () => {
    for (const speed of ['slow', 'normal', 'fast'] as const) {
      const a = motion(42, speed);
      const b = motion(42, speed);
      expect(a.steps.length).toBe(N);
      expect(a.reversals.length, `${speed} で切り返しがある`).toBeGreaterThan(5);
      expect(b.steps).toEqual(a.steps);
      expect(b.reversals).toEqual(a.reversals);
    }
  });

  it('比べ: 違う種では動きが一致しない（読み取りが種で変わることの確かめ）', () => {
    const a = motion(42);
    const c = motion(43);
    expect(c.steps).not.toEqual(a.steps);
  });
});

describe('MODE-38: 速さごとの的の動き', () => {
  it('同じ種で 0.4 秒進めると、遅い・ふつう・速いで基準の点から動いた距離が 0.6・1.2・1.8 メートルになる', () => {
    for (const seed of SEEDS) {
      const moved: Record<string, number> = {};
      for (const speed of ['slow', 'normal', 'fast'] as const) {
        const m = motion(seed, speed, 0.4);
        // 基準の点: 目の位置から開始時の照準の向き（ヨー 0・ピッチ 0 で -Z）に 8 メートル。開始時の的の中心はそこにある。
        const base = { x: m.eye.x, y: m.eye.y, z: m.eye.z - DISTANCE };
        expect(m.baseCenter).toEqual({ yaw: 0, pitch: 0 });
        expect(m.start.x).toBeCloseTo(base.x, 9);
        expect(m.start.y).toBeCloseTo(base.y, 9);
        expect(m.start.z).toBeCloseTo(base.z, 9);
        const last = m.steps.at(-1)!;
        expect(last.time).toBeCloseTo(0.4, 9);
        // 高さと奥行きは変わらない（左右の線の上を動く）。
        expect(last.center.y).toBeCloseTo(base.y, 9);
        expect(last.center.z).toBeCloseTo(base.z, 9);
        moved[speed] = Math.hypot(last.center.x - base.x, last.center.y - base.y, last.center.z - base.z);
      }
      expect(moved.slow, `種 ${seed}`).toBeCloseTo(0.6, 6);
      expect(moved.normal, `種 ${seed}`).toBeCloseTo(1.2, 6);
      expect(moved.fast, `種 ${seed}`).toBeCloseTo(1.8, 6);
      expect(moved.fast!).toBeGreaterThan(moved.slow!);
    }
  });

  it('最初に動く向きは種で決まり、いくつかの種で右と左の両方がある', () => {
    const dirs = new Set(SEEDS.map((seed) => Math.sign(motion(seed, 'normal', 0.1).steps.at(-1)!.center.x)));
    expect([...dirs].sort()).toEqual([-1, 1]);
  });
});

describe('MODE-39: 切り返しの間隔と動く範囲', () => {
  it('20 秒進めると、端に着かずに切り返した間隔はすべて 0.5〜1.5 秒で、的の中心は基準の点から左右に 3 メートルより離れない', () => {
    let free = 0;
    let edges = 0;
    for (const speed of ['slow', 'normal', 'fast'] as const) {
      for (const seed of SEEDS) {
        const m = motion(seed, speed);
        expect(m.ended).toBe(true);
        let prev = 0;
        for (const r of m.reversals) {
          const interval = r.time - prev;
          if (r.edge) edges += 1;
          else {
            free += 1;
            expect(interval, `${speed}・種 ${seed}・時刻 ${r.time}`).toBeGreaterThanOrEqual(0.5 - EPS);
            expect(interval, `${speed}・種 ${seed}・時刻 ${r.time}`).toBeLessThanOrEqual(1.5 + EPS);
          }
          prev = r.time;
        }
        for (const { center } of m.steps) {
          expect(Math.abs(center.x - m.start.x)).toBeLessThanOrEqual(RANGE + EPS);
          expect(center.z).toBeCloseTo(m.start.z, 9);
        }
      }
    }
    expect(free).toBeGreaterThan(100);
    // 速い（4.5 m/s）では 1.5 秒で 6.75 メートル動くので、端での切り返しも起きる（確かめの対象があること）。
    expect(edges).toBeGreaterThan(0);
  });
});

describe('MODE-40: 照準が乗っているあいだの的の色', () => {
  it('的の中心に向けているステップでは乗っていないときと違う色で表示され、的の幅より大きく外したステップでは乗っていないときの色に戻る', () => {
    const m = motion(5);
    const eye = m.eye;
    // 0〜1 秒は中心に向け、1〜2 秒は右に 15 度外し、2〜3 秒は中心に戻す。
    const off = (k: number) => k >= 120 && k < 240;
    const actions = aimActions(m, (k, center) => {
      const on = anglesTo(eye, center);
      return off(k) ? { yaw: on.yaw + 15, pitch: on.pitch } : on;
    });
    const s = makeSession({ seed: 5, actions });
    const view = new ViewScene(s.world);
    const marks = new TargetMarks(view.layer);
    const colorOf = () => {
      const meshes = marks.shown;
      expect(meshes.length).toBe(1);
      const sig: string[] = [];
      meshes[0]!.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mat of mats) {
          const c = (mat as THREE.MeshStandardMaterial).color;
          const e = (mat as THREE.MeshStandardMaterial).emissive;
          sig.push(`${c ? c.getHexString() : '-'}/${e ? e.getHexString() : '-'}`);
        }
      });
      return sig.join(',');
    };
    const on: string[] = [];
    const away: string[] = [];
    for (let k = 0; k < 360; k += 1) {
      s.step();
      const t = theTarget(s.world);
      marks.update(s.world.targets.all, 0.5, s.world.targets.aimed);
      if (off(k)) {
        expect(s.world.targets.isAimed(t.id), `ステップ ${k}`).toBe(false);
        away.push(colorOf());
      } else {
        expect(s.world.targets.isAimed(t.id), `ステップ ${k}`).toBe(true);
        on.push(colorOf());
      }
    }
    expect(new Set(on).size).toBe(1);
    expect(new Set(away).size).toBe(1);
    expect(on[0]).not.toBe(away[0]);
  });
});

describe('MODE-41: 追いエイム（リコイルなし）のリコイルのオフセット', () => {
  it('fire を押し続けても、練習のあいだリコイルのオフセットはヨー 0 度・ピッチ 0 度のまま', () => {
    const s = makeSession({ seed: 3, actions: [{ time: 0.01, action: { type: 'fire', pressed: true } }] });
    const offsets = new Set<string>();
    while (!s.ended) {
      s.step();
      offsets.add(JSON.stringify(s.world.player.recoilOffset));
    }
    expect([...offsets]).toEqual([JSON.stringify({ yaw: 0, pitch: 0 })]);
    expect(s.result!.weapon).toBeUndefined();
    expect(s.result!.duration).toBeCloseTo(DURATION, 6);
  });
});

describe('MODE-42: 追いエイム＋リコイルの撃ち方（ブラウザなし）', () => {
  it('L-STAR で fire を押し続けるとリコイルがかかり、撃ち切っても終わらず撃たない。離すと残弾が装弾数に戻り、押し直すと続けて撃て、20 秒で終わる', () => {
    const lstar = weapon('lstar');
    const s = makeSession({
      seed: 3,
      mode: trackingRecoilMode,
      weapon: lstar,
      actions: [
        { time: 0.01, action: { type: 'fire', pressed: true } },
        { time: 6, action: { type: 'fire', pressed: false } },
        { time: 6.5, action: { type: 'fire', pressed: true } },
        { time: 7, action: { type: 'fire', pressed: false } },
      ],
    }) as PracticeSession<WeaponData>;
    let nonZero = false;
    while (s.sim.time < 5.9) {
      s.step();
      const o = s.world.player.recoilOffset;
      if (o.yaw !== 0 || o.pitch !== 0) nonZero = true;
    }
    expect(nonZero).toBe(true);
    expect(s.ended).toBe(false);
    expect(s.gun.ammo).toBe(0);
    expect(s.shots.length).toBe(lstar.magSize);
    while (s.sim.time < 6.4) s.step();
    expect(s.gun.ammo).toBe(lstar.magSize);
    while (s.sim.time < 6.99) s.step();
    expect(s.shots.length).toBeGreaterThan(lstar.magSize);
    // 戻したあとの最初の弾はパターンの 1 発目。
    expect(s.shots[lstar.magSize]!.patternShot).toBe(1);
    while (!s.ended) s.step();
    expect(s.result!.endReason).not.toBe('empty');
    expect(s.result!.endReason).not.toBe('idle');
    expect(s.result!.duration).toBeCloseTo(DURATION, 6);
  });
});

describe('MODE-43: 追いエイム＋リコイルのゴースト（ブラウザなし）', () => {
  it('L-STAR で撃っているあいだも、ゴーストの向きがない（表示しない）', () => {
    const s = makeSession({ seed: 4, mode: trackingRecoilMode, weapon: weapon('lstar'), actions: [{ time: 0.01, action: { type: 'fire', pressed: true } }] });
    const ghosts = new Set<string>();
    while (s.sim.time < 3) {
      s.step();
      ghosts.add(JSON.stringify(s.ghost ?? null));
    }
    expect(s.shots.length).toBeGreaterThan(0);
    expect([...ghosts]).toEqual(['null']);
  });
});

// ---------------------------------------------------------------------------

describe('SCO-45: 的の中心に向け続けたとき', () => {
  it('乗っていた割合 100%、外していたときのズレ「なし」、乗り直すまでの時間 0 秒', () => {
    for (const seed of [1, 42]) {
      for (const speed of ['slow', 'normal', 'fast'] as const) {
        const m = motion(seed, speed);
        const p = play(seed, aimActions(m, (_k, c) => anglesTo(m.eye, c)), { speed });
        expect(p.aimedSteps, `${speed}・種 ${seed}`).toBe(N);
        expect(row(p, '乗っていた割合')).toBe('100.0%');
        expect(p.value).toBeCloseTo(100, 9);
        expect(row(p, '外していたときのズレ')).toBe('なし');
        expect(num(row(p, '乗り直すまでの時間'))).toBe(0);
        expect(row(p, '乗り直すまでの時間')).toMatch(/^0\.00\s*秒$/);
      }
    }
  });
});

describe('SCO-46: 照準を動かさないとき', () => {
  it('乗っていた割合が 100% より小さく、外していたときのズレが 0 より大きい', () => {
    for (const seed of [1, 42, 7]) {
      const p = play(seed, []);
      expect(p.value!).toBeLessThan(100);
      expect(num(row(p, '乗っていた割合'))).toBeLessThan(100);
      expect(num(row(p, '外していたときのズレ'))).toBeGreaterThan(0);
      expect(row(p, '外していたときのズレ')).toMatch(/^\d+\.\d{2}°$/);
    }
  });
});

describe('SCO-47: 乗っていた割合の求め方', () => {
  it('20 秒の前半 10 秒だけ的の中心に向けると、50% との差が 1 ステップ分以内', () => {
    const m = motion(11);
    // 後半は上に 30 度向ける（的の高さは変わらないので乗らない）。
    const p = play(11, aimActions(m, (k, c) => (k < N / 2 ? anglesTo(m.eye, c) : { yaw: 0, pitch: 30 })));
    expect(Math.abs(p.value! - 50)).toBeLessThanOrEqual(100 / N + 1e-9);
    expect(row(p, '乗っていた割合')).toBe('50.0%');
  });

  it('乗っていたステップの数 ÷ 練習のステップの数 × 100 になる（照準を動かさない練習と、途中で外す練習）', () => {
    for (const seed of [1, 42]) {
      const still = play(seed, []);
      expect(still.steps).toBe(N);
      expect(still.value!).toBeCloseTo((still.aimedSteps / N) * 100, 9);
      expect(row(still, '乗っていた割合')).toBe(`${((still.aimedSteps / N) * 100).toFixed(1)}%`);
      const m = motion(seed);
      const mixed = play(seed, aimActions(m, (k, c) => (Math.floor(k / 90) % 3 === 0 ? { yaw: 0, pitch: 30 } : anglesTo(m.eye, c))));
      expect(mixed.value!).toBeCloseTo((mixed.aimedSteps / N) * 100, 9);
    }
  });
});

describe('SCO-48: 乗り直すまでの時間', () => {
  it('各切り返しのあと 0.3 秒だけ的の幅より大きく外す入力で、乗り直すまでの時間が約 0.3 秒（差が 1 ステップ分以内）', () => {
    // 練習の終わりの 0.5 秒前より後に切り返しがない種を選ぶ。
    let seed = 1;
    let m = motion(seed);
    while (m.reversals.some((r) => r.time > DURATION - 0.5)) {
      seed += 1;
      m = motion(seed);
    }
    const revs = m.reversals.map((r) => r.time);
    expect(revs.length).toBeGreaterThan(5);
    const offAt = (t: number) => revs.some((r) => t > r && t <= r + 0.3 + 1e-9);
    // 外すときは右に 15 度（的の幅 0.5 メートルは 8 メートル先で約 3.6 度）。
    const p = play(seed, aimActions(m, (_k, c, t) => {
      const on = anglesTo(m.eye, c);
      return offAt(t) ? { yaw: on.yaw + 15, pitch: on.pitch } : on;
    }));
    const value = num(row(p, '乗り直すまでの時間'));
    expect(Math.abs(value - 0.3), `${row(p, '乗り直すまでの時間')}（種 ${seed}）`).toBeLessThanOrEqual(DT + 0.005);
    expect(WIDTH).toBeLessThan(DISTANCE * Math.tan((15 * Math.PI) / 180));
  });
});

describe('SCO-53: 追いエイム＋リコイルの命中率と撃った弾数（採点）', () => {
  it('L-STAR で的の中心に向けて fire を押し続けると、撃った弾数と的に当たった弾の割合の命中率が指標に入り、保存の項目に hitRate と shots がある', () => {
    const lstar = weapon('lstar');
    const m = motion(8);
    const actions = [...aimActions(m, (_k, c) => anglesTo(m.eye, c)), { time: 0.01, action: { type: 'fire' as const, pressed: true } }].sort((a, b) => a.time - b.time);
    const p = play(8, actions, { mode: trackingRecoilMode, weapon: lstar });
    const shots = p.session.result!.shots;
    expect(shots.length).toBeGreaterThan(0);
    const hits = shots.filter((s) => s.target !== undefined).length;
    expect(hits).toBeGreaterThan(0);
    expect(num(row(p, '撃った弾数'))).toBe(shots.length);
    expect(num(row(p, '命中率'))).toBeCloseTo((hits / shots.length) * 100, 1);
    const score = trackingRecoilMode.scoring!.score({ shots, duration: p.session.result!.duration, modeResult: p.session.result!.modeResult });
    expect(score.fields?.hitRate).toBeCloseTo((hits / shots.length) * 100, 6);
    expect(score.fields?.shots).toBe(shots.length);
  });
});

describe('SCO-54: 追いエイム（リコイルなし）の fire（採点）', () => {
  it('fire を何度か押しても、押さないときと同じ照準の入力なら乗っていた割合が同じで、命中率と撃った弾数の行がない', () => {
    const m = motion(21);
    const aim = aimActions(m, (k, c) => (Math.floor(k / 100) % 2 === 0 ? anglesTo(m.eye, c) : { yaw: 0, pitch: 0 }));
    const fires: TimedAction[] = [];
    for (let i = 0; i < 8; i += 1) {
      fires.push({ time: 1 + i * 2 + 0.001, action: { type: 'fire', pressed: true } }, { time: 1.3 + i * 2 + 0.001, action: { type: 'fire', pressed: false } });
    }
    const without = play(21, aim);
    const withFire = play(21, [...aim, ...fires].sort((a, b) => a.time - b.time));
    expect(withFire.session.result!.shots.length).toBe(8);
    expect(withFire.value).toBe(without.value);
    expect(withFire.rows).toEqual(without.rows);
    for (const label of ['命中率', '撃った弾数']) expect(Object.keys(withFire.rows).some((k) => k.includes(label)), label).toBe(false);
  });
});
