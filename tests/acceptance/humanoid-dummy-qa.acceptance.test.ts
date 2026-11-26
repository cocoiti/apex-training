// docs/spec/architecture.md「人形の的」「照準と的の当たり」（ARC-63〜ARC-66）、docs/spec/modes.md の人形の的の受け入れ条件
// （MODE-40・MODE-51 の変更、MODE-59〜MODE-64）、docs/spec/screens.md「3D の表示」の人形の描画（UI-136）と配布物（UI-138）の受け入れテスト（#90）。
// QA が SPEC だけから書いたもの。ブラウザを使わない（ブラウザで確かめるものは humanoid-dummy-browser-qa.acceptance.test.ts）。
// 公開された入口（練習モードの共通の型・PracticeSession・登録されたモードの一覧、練習の的の決め方 PracticeTargetSpec と部分の箱 TargetPart、
// 人形の部分の箱 humanoidParts、World・マップの JSON・武器の JSON、描画の ViewScene・TargetMarks・ImpactMarks、採点の scoreShots、
// npm run build・npm run check:assets）だけを使う。
// 人形の部分の箱の期待値は SPEC の表（縮尺 1: 頭 0.25×0.25 (0, +0.4)、胴 0.5×0.55 (0, 0)、腕 0.12×0.6 (±0.35, −0.025)、
// 脚 0.2×1.0 (±0.13, −0.775)、奥行き 0.25）からこのファイルに書く。照準の向きは SPEC の座標系（ヨー 0・ピッチ 0 が -Z、
// ヨーが正なら +X、ピッチが正なら +Y）からこのファイルで求める。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import * as THREE from 'three';
import { afterAll, describe, expect, it } from 'vitest';
import type { TimedAction } from '../../src/input/actions';
import { InputQueue, inputFromTimedActions } from '../../src/input/queue';
import type { FlickResult } from '../../src/modes/aim/flick';
import trackingMode from '../../src/modes/aim/tracking';
import { modes } from '../../src/modes/registry';
import { PracticeSession } from '../../src/modes/session';
import type { ModeContext, ModeOptionValues, TrainingMode } from '../../src/modes/types';
import { IMPACT_NAME, ImpactMarks } from '../../src/render/impacts';
import { ViewScene } from '../../src/render/scene';
import { TargetMarks } from '../../src/render/targets';
import { humanoidParts } from '../../src/sim/humanoid';
import type { Box } from '../../src/sim/map';
import { scoreShots } from '../../src/sim/scoring';
import type { PracticeTarget, PracticeTargetOptions, PracticeTargets, PracticeTargetSpec, TargetPart } from '../../src/sim/targets';
import { vec3, type Vec3 } from '../../src/sim/vec3';
import { parseWeapon, type WeaponData } from '../../src/sim/weapon';
import { createWorld, loadWorld, type World } from '../../src/sim/world';

const ROOT = resolve(__dirname, '../..');
const DT = 1 / 120;
const DEG = 180 / Math.PI;

/** SPEC の表の縮尺 1 の人形の部分の箱（幅・高さ・中心の位置。X が右、Y が上）と奥行き。 */
const SPEC_PARTS: Record<string, { w: number; h: number; x: number; y: number }> = {
  head: { w: 0.25, h: 0.25, x: 0, y: 0.4 },
  torso: { w: 0.5, h: 0.55, x: 0, y: 0 },
  rightArm: { w: 0.12, h: 0.6, x: 0.35, y: -0.025 },
  leftArm: { w: 0.12, h: 0.6, x: -0.35, y: -0.025 },
  rightLeg: { w: 0.2, h: 1.0, x: 0.13, y: -0.775 },
  leftLeg: { w: 0.2, h: 1.0, x: -0.13, y: -0.775 },
};
const SPEC_DEPTH = 0.25;
const SPEC_WIDTH = 0.82;
const SPEC_HEIGHT = 1.8;

// 共通の道具 ------------------------------------------------------------------

interface Angles {
  yaw: number;
  pitch: number;
}

/** 目から点への向き（度）。 */
function anglesTo(eye: Vec3, point: Vec3): Angles {
  const dx = point.x - eye.x;
  const dy = point.y - eye.y;
  const dz = point.z - eye.z;
  return { yaw: Math.atan2(dx, -dz) * DEG, pitch: Math.atan2(dy, Math.hypot(dx, dz)) * DEG };
}

const add = (a: Vec3, b: Vec3) => vec3(a.x + b.x, a.y + b.y, a.z + b.z);

function rangeJson(): unknown {
  return JSON.parse(readFileSync(join(ROOT, 'src/data/maps/range.json'), 'utf8'));
}
function rangeWorld(): World {
  const r = loadWorld(rangeJson());
  if (!r.ok) throw new Error(`マップが読めない: ${JSON.stringify(r.errors)}`);
  return r.world;
}

/** 部分の箱の、的の中心が center のときの軸に平行な範囲。 */
function partBox(center: Vec3, p: TargetPart) {
  const c = add(center, p.offset);
  return {
    min: vec3(c.x - p.size.x / 2, c.y - p.size.y / 2, c.z - p.size.z / 2),
    max: vec3(c.x + p.size.x / 2, c.y + p.size.y / 2, c.z + p.size.z / 2),
  };
}

/** SPEC の当たりの定義を、このファイルで計算する: 目から向き a のレイが、的の部分の箱のどれかに当たるか。 */
function rayHitsParts(eye: Vec3, a: Angles, center: Vec3, parts: readonly TargetPart[]): boolean {
  const y = a.yaw / DEG;
  const p = a.pitch / DEG;
  const d = vec3(Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
  return parts.some((part) => {
    const b = partBox(center, part);
    let t0 = 0;
    let t1 = Infinity;
    for (const k of ['x', 'y', 'z'] as const) {
      if (Math.abs(d[k]) < 1e-12) {
        if (eye[k] < b.min[k] || eye[k] > b.max[k]) return false;
        continue;
      }
      const ta = (b.min[k] - eye[k]) / d[k];
      const tb = (b.max[k] - eye[k]) / d[k];
      t0 = Math.max(t0, Math.min(ta, tb));
      t1 = Math.min(t1, Math.max(ta, tb));
    }
    return t0 <= t1;
  });
}

/** 部分の箱を id で引く。 */
function partOf(parts: readonly TargetPart[], id: string): TargetPart {
  const p = parts.find((x) => x.id === id);
  if (!p) throw new Error(`部分 ${id} がない: ${parts.map((x) => x.id).join(', ')}`);
  return p;
}

/** 人形の縮尺（胴の幅 ÷ 縮尺 1 の胴の幅 0.5）。 */
const scaleOf = (t: Pick<PracticeTarget, 'parts'>) => partOf(t.parts, 'torso').size.x / SPEC_PARTS.torso!.w;

/** 練習の的が SPEC の表の人形（縮尺 s）の 6 つの部分の箱でできているか。 */
function expectHumanoid(parts: readonly TargetPart[], s: number, label = '') {
  expect(parts.map((p) => p.id).sort(), label).toEqual(Object.keys(SPEC_PARTS).sort());
  for (const [id, sp] of Object.entries(SPEC_PARTS)) {
    const p = partOf(parts, id);
    expect(p.size.x, `${label} ${id} の幅`).toBeCloseTo(sp.w * s, 9);
    expect(p.size.y, `${label} ${id} の高さ`).toBeCloseTo(sp.h * s, 9);
    expect(p.size.z, `${label} ${id} の奥行き`).toBeCloseTo(SPEC_DEPTH * s, 9);
    expect(p.offset.x, `${label} ${id} の X`).toBeCloseTo(sp.x * s, 9);
    expect(p.offset.y, `${label} ${id} の Y`).toBeCloseTo(sp.y * s, 9);
    expect(p.offset.z, `${label} ${id} の Z`).toBeCloseTo(0, 9);
  }
}

interface ModeSpec {
  setup?: (c: ModeContext) => void;
  step?: (c: ModeContext) => void;
  usesWeapon?: boolean;
}

/** 武器を使わない、的を置くだけのモード（共通の型だけで作る）。 */
function qaMode(spec: ModeSpec = {}): TrainingMode {
  return {
    id: 'qa-humanoid',
    name: { ja: 'QA 人形', en: 'QA 人形' },
    description: { ja: 'QA の人形', en: 'QA の人形' },
    icon: 'track',
    category: 'aim',
    order: 1,
    usesWeapon: spec.usesWeapon ?? false,
    setup(c) {
      spec.setup?.(c);
    },
    step(c) {
      spec.step?.(c);
      return true;
    },
    result() {
      return {};
    },
    teardown() {},
  };
}

const QA_EYE = vec3(0, 1.6, 0);
const QA_BACK: Box = { id: 'back', kind: 'wall', center: vec3(0, 1.6, -40), size: vec3(300, 300, 0.2) };
function qaWorld(boxes: Box[] = [QA_BACK]): World {
  return createWorld({ id: 'qa', name: 'qa', spawn: { position: QA_EYE, aim: { yaw: 0, pitch: 0 } }, boxes });
}

const look = (t: number, from: Angles, to: Angles): TimedAction => ({ time: t, action: { type: 'look', yaw: to.yaw - from.yaw, pitch: to.pitch - from.pitch } });
const fire = (t: number, pressed: boolean): TimedAction => ({ time: t, action: { type: 'fire', pressed } });

function stepUntil(s: PracticeSession<WeaponData> | PracticeSession<undefined>, t: number) {
  while (s.sim.time < t - 1e-9 && !s.ended) s.step();
}

/** シーンの中の、名前が name のもののワールド座標の位置。 */
function namedPositions(view: ViewScene, name: string): Vec3[] {
  view.scene.updateMatrixWorld(true);
  const out: Vec3[] = [];
  view.scene.traverse((o) => {
    if (o.name !== name) return;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return;
    const w = o.getWorldPosition(new THREE.Vector3());
    out.push(vec3(w.x, w.y, w.z));
  });
  return out;
}

/** 描画した的（TargetMarks.shown の 1 つ）の、表示されているメッシュの軸に平行な範囲。 */
function meshBoxes(group: THREE.Object3D): { min: Vec3; max: Vec3 }[] {
  let root: THREE.Object3D = group;
  while (root.parent) root = root.parent;
  root.updateMatrixWorld(true);
  const out: { min: Vec3; max: Vec3 }[] = [];
  group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return;
    const b = new THREE.Box3().setFromObject(o);
    out.push({ min: vec3(b.min.x, b.min.y, b.min.z), max: vec3(b.max.x, b.max.y, b.max.z) });
  });
  return out;
}

const sameBox = (a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }, tol = 1e-6) =>
  (['x', 'y', 'z'] as const).every((k) => Math.abs(a.min[k] - b.min[k]) <= tol && Math.abs(a.max[k] - b.max[k]) <= tol);

const fmtBox = (b: { min: Vec3; max: Vec3 }) =>
  `[${[b.min.x, b.min.y, b.min.z].map((v) => v.toFixed(4)).join(',')}]-[${[b.max.x, b.max.y, b.max.z].map((v) => v.toFixed(4)).join(',')}]`;

/**
 * 描画した的の表示が、シミュレーションの部分の箱（描画の補間の位置）と一致するか: 部分の箱ごとに同じ範囲のメッシュがあり、
 * 部分の箱と同じ範囲でないメッシュ（リングなど）がない。
 */
function expectDrawnParts(group: THREE.Object3D, target: PracticeTarget, alpha: number, label: string) {
  const c = vec3(
    target.previousCenter.x + (target.center.x - target.previousCenter.x) * alpha,
    target.previousCenter.y + (target.center.y - target.previousCenter.y) * alpha,
    target.previousCenter.z + (target.center.z - target.previousCenter.z) * alpha,
  );
  const want = target.parts.map((p) => partBox(c, p));
  const got = meshBoxes(group);
  for (const [i, w] of want.entries()) {
    expect(got.some((g) => sameBox(g, w)), `${label}: 部分 ${target.parts[i]!.id} ${fmtBox(w)} のメッシュ（表示 ${got.map(fmtBox).join(' ')}）`).toBe(true);
  }
  const extra = got.filter((g) => !want.some((w) => sameBox(g, w)));
  expect(extra.map(fmtBox), `${label}: 部分の箱でないメッシュ`).toEqual([]);
}

// ---------------------------------------------------------------------------
// architecture.md「人形の的」
// ---------------------------------------------------------------------------

describe('ARC-63: 縮尺 1 の人形を 10 メートル先に置いたときの「乗っている」', () => {
  const CENTER = vec3(0, 1.6, -10);
  const cases: { name: string; rel: [number, number]; aimed: boolean }[] = [
    { name: '人形の中心', rel: [0, 0], aimed: true },
    { name: '頭の中心', rel: [0, 0.4], aimed: true },
    { name: '右腕の中心', rel: [0.35, -0.025], aimed: true },
    { name: '右脚の中心', rel: [0.13, -0.775], aimed: true },
    // 胴の右端 0.25 と右腕の左端 0.29 のあいだの中央（高さは胴の中心）。
    { name: '脇の下の空き', rel: [0.27, 0], aimed: false },
    // 左右の脚の内側の端 ±0.03 のあいだの中央（高さは脚の中心）。
    { name: '左右の脚のあいだの中央', rel: [0, -0.775], aimed: false },
    // 頭の右端 0.125 より 0.1 メートル右で、頭の中心と同じ高さ。
    { name: '頭の右の肩より上', rel: [0.225, 0.4], aimed: false },
    // 右腕の外側 0.41 より外。
    { name: '人形の右端より外', rel: [0.5, 0], aimed: false },
  ];

  it('SPEC の表の縮尺 1 の人形の部分の箱（humanoidParts(1)）を置き、各向きに照準を向けたステップの判定が SPEC のとおり', () => {
    const parts = humanoidParts(1);
    expectHumanoid(parts, 1, '縮尺 1');
    const actions: TimedAction[] = [];
    let prev: Angles = { yaw: 0, pitch: 0 };
    cases.forEach((c, i) => {
      const to = anglesTo(QA_EYE, vec3(CENTER.x + c.rel[0], CENTER.y + c.rel[1], CENTER.z));
      actions.push(look(0.1 + i * 0.1 + DT / 2, prev, to));
      prev = to;
    });
    const s = new PracticeSession({
      world: qaWorld(),
      weapon: undefined,
      mode: qaMode({ setup: (c) => c.targets.add({ id: 'h', parts, position: CENTER }) }),
      input: inputFromTimedActions(actions),
      seed: 57,
    });
    const got: Record<string, boolean> = {};
    const want: Record<string, boolean> = {};
    cases.forEach((c, i) => {
      stepUntil(s, 0.1 + i * 0.1 + 0.05);
      got[c.name] = s.world.targets.isAimed('h');
      want[c.name] = c.aimed;
    });
    expect(got).toEqual(want);
  });
});

describe('ARC-64: 縮尺 0.5 の人形', () => {
  it('各部分の箱の大きさと人形の中心からの相対的な位置が、縮尺 1 の値の 0.5 倍になる', () => {
    const one = humanoidParts(1);
    const half = humanoidParts(0.5);
    expectHumanoid(one, 1, '縮尺 1');
    expectHumanoid(half, 0.5, '縮尺 0.5');
    for (const p of one) {
      const q = partOf(half, p.id);
      for (const k of ['x', 'y', 'z'] as const) {
        expect(q.size[k], `${p.id} の大きさ ${k}`).toBeCloseTo(p.size[k] * 0.5, 12);
        expect(q.offset[k], `${p.id} の位置 ${k}`).toBeCloseTo(p.offset[k] * 0.5, 12);
      }
    }
    // 人形の幅 0.82・高さ 1.8（縮尺 1）も 0.5 倍になる。
    const extent = (parts: TargetPart[]) => ({
      w: Math.max(...parts.map((p) => p.offset.x + p.size.x / 2)) - Math.min(...parts.map((p) => p.offset.x - p.size.x / 2)),
      h: Math.max(...parts.map((p) => p.offset.y + p.size.y / 2)) - Math.min(...parts.map((p) => p.offset.y - p.size.y / 2)),
    });
    expect(extent(one).w).toBeCloseTo(SPEC_WIDTH, 9);
    expect(extent(one).h).toBeCloseTo(SPEC_HEIGHT, 9);
    expect(extent(half).w).toBeCloseTo(SPEC_WIDTH / 2, 9);
    expect(extent(half).h).toBeCloseTo(SPEC_HEIGHT / 2, 9);
  });

  it('練習に置いた縮尺 0.5 の人形も、シミュレーションの的の部分の箱が 0.5 倍になる', () => {
    const s = new PracticeSession({
      world: qaWorld(),
      weapon: undefined,
      mode: qaMode({ setup: (c) => c.targets.add({ id: 'half', parts: humanoidParts(0.5), position: vec3(0, 1.6, -10) }) }),
      input: inputFromTimedActions([]),
      seed: 58,
    });
    s.step();
    expectHumanoid(s.world.targets.get('half')!.parts, 0.5, '練習の的');
  });
});

describe('ARC-65: 弾痕を残す練習の的と残さない練習の的', () => {
  it('弾痕を残す的の部分の箱に当たった弾は的の識別子を持ち、当たった点が弾痕の位置として記録されて表示される。残さない的に当たった弾の弾痕は表示されない', () => {
    const keepCenter = vec3(-1, 1.6, -10);
    const plainCenter = vec3(1, 1.6, -10);
    const parts = humanoidParts(1);
    // 弾痕を残す的は頭、残さない的は胴を撃つ。
    const keepAim = anglesTo(QA_EYE, add(keepCenter, vec3(0, 0.4, 0)));
    const plainAim = anglesTo(QA_EYE, plainCenter);
    const s = new PracticeSession({
      world: qaWorld(),
      weapon: undefined,
      mode: qaMode({
        setup: (c) => {
          c.targets.add({ id: 'keep', parts, position: keepCenter, keepsImpacts: true });
          c.targets.add({ id: 'plain', parts, position: plainCenter });
        },
      }),
      input: inputFromTimedActions([
        look(0.1, { yaw: 0, pitch: 0 }, keepAim),
        fire(0.2, true),
        fire(0.25, false),
        look(0.3, keepAim, plainAim),
        fire(0.4, true),
        fire(0.45, false),
      ]),
      seed: 59,
    });
    stepUntil(s, 0.6);
    expect(s.shots).toHaveLength(2);
    const [kept, plain] = s.shots;
    expect(kept!.target).toBe('keep');
    expect(plain!.target).toBe('plain');
    // 当たった点: 目から頭の中心への向きのレイが、頭の箱の正面（Z = 中心 + 奥行きの半分）と交わる点。
    const frontZ = keepCenter.z + SPEC_DEPTH / 2;
    const tHit = (frontZ - QA_EYE.z) / (keepCenter.z - QA_EYE.z);
    const want = vec3(QA_EYE.x + (keepCenter.x - QA_EYE.x) * tHit, QA_EYE.y + 0.4 * tHit, frontZ);
    expect(kept!.position, '弾痕を残す的に当たった弾の弾痕の位置').not.toBeNull();
    expect(kept!.position!.x).toBeCloseTo(want.x, 6);
    expect(kept!.position!.y).toBeCloseTo(want.y, 6);
    expect(kept!.position!.z).toBeCloseTo(want.z, 6);

    const view = new ViewScene(s.world);
    new ImpactMarks(view.layer).sync(s.shots, s.world.player.position);
    const marks = namedPositions(view, IMPACT_NAME);
    expect(marks, '表示される弾痕は弾痕を残す的に当たった 1 発だけ').toHaveLength(1);
    expect(Math.abs(marks[0]!.x - want.x)).toBeLessThan(0.01);
    expect(Math.abs(marks[0]!.y - want.y)).toBeLessThan(0.01);
    expect(Math.abs(marks[0]!.z - want.z)).toBeLessThan(0.02);
  });
});

describe('ARC-66: シミュレーションの側で部分の箱を変えた的の描画', () => {
  it('部分の箱の大きさと位置を変えた的（人形の形でない 3 つの箱と、腕を長くした人形）を描画すると、表示される各部分がその大きさと位置になる', () => {
    const custom: TargetPart[] = [
      { id: 'a', size: vec3(0.3, 0.7, 0.1), offset: vec3(0.5, -0.2, 0) },
      { id: 'b', size: vec3(0.2, 0.2, 0.4), offset: vec3(-0.4, 0.6, 0.1) },
      { id: 'c', size: vec3(1, 0.1, 0.1), offset: vec3(0, -1, 0) },
    ];
    const longArms = humanoidParts(1).map((p) => (p.id.endsWith('Arm') ? { ...p, size: vec3(p.size.x, 0.9, p.size.z), offset: vec3(p.offset.x * 1.2, -0.1, 0) } : p));
    const s = new PracticeSession({
      world: qaWorld(),
      weapon: undefined,
      mode: qaMode({
        setup: (c) => {
          c.targets.add({ id: 'custom', parts: custom, position: (t) => vec3(-2 + t, 1.6, -10) });
          c.targets.add({ id: 'long', parts: longArms, position: vec3(2, 1.4, -9) });
        },
      }),
      input: inputFromTimedActions([]),
      seed: 60,
    });
    const view = new ViewScene(s.world);
    const marks = new TargetMarks(view.layer);
    stepUntil(s, 0.5);
    for (const alpha of [0, 0.5, 1]) {
      marks.update(s.world.targets.all, alpha);
      expect(marks.shown).toHaveLength(2);
      for (const t of s.world.targets.all) {
        // 表示物の中で、その的の中心の近くにあるもの。
        const group = marks.shown.find((g) => meshBoxes(g).some((b) => Math.abs((b.min.x + b.max.x) / 2 - t.center.x) < 1.2));
        expect(group, `${t.id} の表示`).toBeDefined();
        expectDrawnParts(group!, t, alpha, `${t.id}（補間 ${alpha}）`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// modes.md「追いエイム」
// ---------------------------------------------------------------------------

function trackingSession(seed: number, actions: TimedAction[] = [], mode: TrainingMode = trackingMode) {
  return new PracticeSession<undefined>({ world: rangeWorld(), weapon: undefined, mode, input: inputFromTimedActions(actions), seed, options: { speed: 'normal' } });
}

function theTarget(world: World): PracticeTarget {
  expect(world.targets.all, '追いエイムの練習の的は 1 つ').toHaveLength(1);
  return world.targets.all[0]!;
}

/** 照準を動かさずに練習を最後まで進めた、各ステップの終わりの的の中心。 */
function trackingCenters(seed: number, mode: TrainingMode = trackingMode): Vec3[] {
  const s = trackingSession(seed, [], mode);
  const out: Vec3[] = [];
  while (!s.ended) {
    s.step();
    out.push({ ...theTarget(s.world).center });
  }
  return out;
}

/** 各ステップの照準を、そのステップの終わりの的の中心から offset（メートル）ずらした点に向ける入力。 */
function aimAt(centers: Vec3[], eye: Vec3, offset: Vec3, start: Angles = { yaw: 0, pitch: 0 }): TimedAction[] {
  const actions: TimedAction[] = [];
  let cur = start;
  centers.forEach((c, k) => {
    const want = anglesTo(eye, add(c, offset));
    actions.push({ time: k * DT + DT / 2, action: { type: 'look', yaw: want.yaw - cur.yaw, pitch: want.pitch - cur.pitch } });
    cur = want;
  });
  return actions;
}

/** 入力を与えて練習を最後まで進め、乗っていたステップの割合（%）と、モードの採点の「乗っていた割合」の行を返す。 */
function onTargetRate(seed: number, actions: TimedAction[]) {
  const s = trackingSession(seed, actions);
  let aimed = 0;
  let steps = 0;
  const misses: { time: number; offset: number }[] = [];
  while (!s.ended) {
    s.step();
    steps += 1;
    const t = theTarget(s.world);
    if (s.world.targets.isAimed(t.id)) {
      aimed += 1;
      if (misses.length < 5) misses.push({ time: s.sim.time, offset: t.center.x });
    }
  }
  const r = s.result!;
  const score = trackingMode.scoring!.score({ shots: r.shots, duration: r.duration, modeResult: r.modeResult });
  const row = score.metrics.find((m) => m.label.includes('乗っていた割合'));
  return { rate: (aimed / steps) * 100, row: row?.value, value: score.value, aimedSamples: misses };
}

describe('MODE-59: 追いエイムの人形の当たり', () => {
  const SEED = 590;
  const eye = rangeWorld().player.position;

  it('的は縮尺 1 の人形で、的の中心は人形の中心（胴の中心）', () => {
    const s = trackingSession(SEED);
    s.step();
    const t = theTarget(s.world);
    expectHumanoid(t.parts, 1, '追いエイムの的');
  });

  it('各ステップの照準を人形の胴の中心に向け続けたとき、乗っていた割合が 100% になる', () => {
    const centers = trackingCenters(SEED);
    const torso = partOf(humanoidParts(1), 'torso').offset;
    const r = onTargetRate(SEED, aimAt(centers, eye, torso));
    expect(r.rate).toBe(100);
    expect(r.row).toBe('100.0%');
  });

  it('各ステップの照準を人形の中心から人形の幅の半分（0.41 m）より大きく右・左にずらした向きに向け続けたとき、乗っていた割合が 0% になる', () => {
    const centers = trackingCenters(SEED);
    // 人形の部分の箱は奥行き 0.25 m を持ち、的が左右に動いて斜めから見ると腕の外側の側面が見える。幅の半分 0.41 m のすぐ外（0.45 m）では
    // その側面に当たる向きがあるので、側面も含めて人形のどの部分の箱にも当たらないこと（SPEC の箱でこのファイルが計算）を確かめた 0.6 m でずらす。
    const parts = humanoidParts(1);
    for (const dx of [0.6, -0.6]) {
      expect(centers.filter((c) => rayHitsParts(eye, anglesTo(eye, add(c, vec3(dx, 0, 0))), c, parts)).length, `前提: ${dx} m は SPEC の箱に当たらない`).toBe(0);
      const r = onTargetRate(SEED, aimAt(centers, eye, vec3(dx, 0, 0)));
      expect(r.rate, `ずらし ${dx} m（乗っていたステップの例 ${JSON.stringify(r.aimedSamples)}）`).toBe(0);
      expect(r.row).toBe('0.0%');
    }
  });

  it('各ステップの照準を脇の下の空き（胴の端と腕の内側の端のあいだの中央）の向きに向け続けたとき、乗っていた割合が 0% になる', () => {
    const centers = trackingCenters(SEED);
    for (const dx of [0.27, -0.27]) {
      const r = onTargetRate(SEED, aimAt(centers, eye, vec3(dx, 0, 0)));
      // 照合: SPEC の部分の箱でこのファイルが計算した当たり（奥行きを持つ箱を斜めから見ると、空きが側面で塞がる向きがある）。
      const parts = humanoidParts(1);
      const blocked = centers.filter((c) => rayHitsParts(eye, anglesTo(eye, add(c, vec3(dx, 0, 0))), c, parts)).length;
      // 実装の判定は SPEC の部分の箱の当たりと一致する（乗っていたステップの数が、側面に当たるステップの数と同じ）。
      expect(Math.round((r.rate / 100) * centers.length), `脇の下 ${dx} m: 乗っていたステップの数と SPEC の箱で計算した当たりの数`).toBe(blocked);
      expect(r.rate, `脇の下 ${dx} m（SPEC の箱で計算すると ${blocked}/${centers.length} ステップで部分の箱の側面に当たる。乗っていたステップの例 ${JSON.stringify(r.aimedSamples)}）`).toBe(0);
    }
  });
});

describe('MODE-40（変更）: 照準が乗っているあいだの人形の色', () => {
  it('人形の中心に向けているステップでは乗っていないときと違う色で表示され、人形の幅より大きく外したステップでは乗っていないときの色に戻る', () => {
    const SEED = 400;
    const centers = trackingCenters(SEED);
    const eye = rangeWorld().player.position;
    // 0〜1 秒は中心、1〜2 秒は人形の幅（0.82 m）より大きく右に外す、2〜3 秒は中心に戻す。
    const off = (k: number) => k >= 120 && k < 240;
    const actions: TimedAction[] = [];
    let cur: Angles = { yaw: 0, pitch: 0 };
    centers.slice(0, 360).forEach((c, k) => {
      const want = anglesTo(eye, off(k) ? add(c, vec3(1.0, 0, 0)) : c);
      actions.push({ time: k * DT + DT / 2, action: { type: 'look', yaw: want.yaw - cur.yaw, pitch: want.pitch - cur.pitch } });
      cur = want;
    });
    const s = trackingSession(SEED, actions);
    const view = new ViewScene(s.world);
    const marks = new TargetMarks(view.layer);
    const colorOf = () => {
      expect(marks.shown).toHaveLength(1);
      const sig = new Set<string>();
      marks.shown[0]!.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) sig.add((m as THREE.MeshBasicMaterial).color?.getHexString() ?? '-');
      });
      return [...sig].sort().join(',');
    };
    const on: string[] = [];
    const away: string[] = [];
    for (let k = 0; k < 360; k += 1) {
      s.step();
      marks.update(s.world.targets.all, 0.5, s.world.targets.aimed);
      const aimed = s.world.targets.isAimed(theTarget(s.world).id);
      expect(aimed, `ステップ ${k}`).toBe(!off(k));
      (off(k) ? away : on).push(colorOf());
    }
    expect(new Set(on).size).toBe(1);
    expect(new Set(away).size).toBe(1);
    expect(on[0]).not.toBe(away[0]);
  });
});

describe('MODE-60: 的の形は追いエイムの動きに影響しない', () => {
  /** 追いエイムのモードが足す的を、人形の中心と同じ位置の 1 つの箱（幅 0.5・高さ 1.0・奥行き 0.2）に差し替えるモード。 */
  function singleBoxTracking(): TrainingMode {
    const wrap = (c: ModeContext): ModeContext => {
      const targets = new Proxy(c.targets, {
        get(real, prop) {
          if (prop === 'add') {
            return (spec: PracticeTargetSpec) => {
              const rest: Record<string, unknown> = { ...spec };
              delete rest.parts;
              delete rest.size;
              real.add({ ...(rest as unknown as PracticeTargetOptions), size: vec3(0.5, 1.0, 0.2) });
            };
          }
          const v = Reflect.get(real, prop, real) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(real) : v;
        },
      }) as PracticeTargets;
      return new Proxy(c, { get: (real, prop) => (prop === 'targets' ? targets : (Reflect.get(real, prop, real) as unknown)) });
    };
    return {
      ...trackingMode,
      setup: (c) => trackingMode.setup(wrap(c)),
      step: (c, dt) => trackingMode.step(wrap(c), dt),
    } as TrainingMode;
  }

  /** 位置の列から、動く向きが変わったステップの時刻の列。 */
  const turns = (centers: Vec3[]) => {
    const out: number[] = [];
    let dir = 0;
    centers.forEach((c, k) => {
      if (k === 0) return;
      const d = Math.sign(c.x - centers[k - 1]!.x);
      if (dir !== 0 && d !== 0 && d !== dir) out.push((k + 1) * DT);
      if (d !== 0) dir = d;
    });
    return out;
  };

  it('同じ種・同じ速さで、人形の的と 1 つの箱の的にした追いエイムを 20 秒進めると、各ステップの的の中心と切り返しの時刻の列が一致する', () => {
    for (const seed of [600, 601]) {
      const dummy = trackingCenters(seed);
      const box = trackingCenters(seed, singleBoxTracking());
      // 差し替えが効いていること（1 つの箱の的になっている）。
      const s = trackingSession(seed, [], singleBoxTracking());
      s.step();
      expect(theTarget(s.world).parts).toHaveLength(1);
      expect(dummy.length).toBe(Math.round(20 / DT));
      expect(box).toEqual(dummy);
      expect(turns(dummy).length).toBeGreaterThan(5);
      expect(turns(box)).toEqual(turns(dummy));
    }
  });
});

// ---------------------------------------------------------------------------
// modes.md「フリック」
// ---------------------------------------------------------------------------

const SIZES = { large: 3, medium: 2, small: 1 } as const;
type SizeId = keyof typeof SIZES;

function flickMode(): TrainingMode {
  const m = modes.find((x) => x.id === 'flick');
  if (!m) throw new Error('フリックのモード（id flick）が登録されていない');
  return m;
}
function flickOptions(size: SizeId, range?: string): ModeOptionValues {
  const m = flickMode();
  const id = (label: string) => {
    const o = m.options?.find((x) => x.label.ja === label);
    if (!o) throw new Error(`練習の選択肢に「${label}」がない`);
    return o.id;
  };
  return { [id('的の大きさ')]: size, ...(range ? { [id('出る範囲')]: range } : {}) };
}

interface FlickRun {
  session: PracticeSession<undefined>;
  input: InputQueue;
  world: World;
}
function beginFlick(seed: number, size: SizeId, range?: string): FlickRun {
  const world = rangeWorld();
  const input = new InputQueue();
  const session = new PracticeSession({ world, weapon: undefined, mode: flickMode(), input, seed, options: flickOptions(size, range) });
  return { session, input, world };
}
const mid = (t: number) => (Math.floor(t / DT + 1e-6) + 0.5) * DT;

/**
 * 出た的を 1 つずつ、plan が返した向きで撃って最後まで進める。plan(i, 的) の向きへ、的が出てから 0.2 秒後に照準を向けて撃つ。
 * 出た的（撃った時点の的の状態）の列を返す。
 */
function shootFlick(run: FlickRun, plan: (i: number, t: PracticeTarget) => Angles): PracticeTarget[] {
  const seen: PracticeTarget[] = [];
  let aim: Angles = { ...run.world.player.aim };
  while (!run.session.ended) {
    if (run.session.sim.time > 200) throw new Error('200 秒進めても終わらない');
    run.session.step();
    const v = run.world.targets.visible;
    expect(v.length).toBeLessThanOrEqual(1);
    const t = v[0];
    if (t && !seen.some((x) => x.id === t.id && x.center.x === t.center.x && x.center.y === t.center.y)) {
      seen.push({ ...t });
      const to = plan(seen.length - 1, t);
      const at = mid(run.session.sim.time + 0.2);
      run.input.push(at, { type: 'look', yaw: to.yaw - aim.yaw, pitch: to.pitch - aim.pitch });
      aim = to;
      run.input.push(at, { type: 'fire', pressed: true });
      run.input.push(at + 3 * DT, { type: 'fire', pressed: false });
    }
  }
  return seen;
}
const flickRecords = (run: FlickRun) => (run.session.result!.modeResult as FlickResult).targets;

describe('MODE-61: フリックの人形への命中と外れ', () => {
  it('出た人形の胴の中心へ撃つと命中、人形の右端より外・左右の脚のあいだへ撃つと外れとして記録される', () => {
    const run = beginFlick(610, 'large');
    const eye = run.world.player.position;
    const kinds = ['torso', 'right', 'legs'] as const;
    const plan: (typeof kinds)[number][] = [];
    const seen = shootFlick(run, (i, t) => {
      const s = scaleOf(t);
      const kind = kinds[i % 3]!;
      plan.push(kind);
      const torso = partOf(t.parts, 'torso').offset;
      const rel = kind === 'torso' ? torso : kind === 'right' ? vec3((SPEC_WIDTH / 2 + 0.1) * s, 0, 0) : vec3(0, -0.775 * s, 0);
      return anglesTo(eye, add(t.center, rel));
    });
    const recs = flickRecords(run);
    expect(recs).toHaveLength(20);
    for (const t of seen) expectHumanoid(t.parts, scaleOf(t), `的 ${t.id}`);
    const detail = seen.map((t, i) => `${i + 1}:${plan[i]}@yaw${anglesTo(eye, t.center).yaw.toFixed(1)}`).join(' ');
    expect(recs.map((r) => r.hit), detail).toEqual(plan.map((k) => k === 'torso'));
  });
});

describe('MODE-62: フリックの的の大きさと人形の縮尺', () => {
  it('同じ出る位置のずれで、胴の幅の見込み角が大・中・小で 3・2・1 度になり、人形の高さは胴の幅に比例して大がいちばん大きく小がいちばん小さい', () => {
    const SEED = 620;
    const first: Record<string, { center: Vec3; parts: readonly TargetPart[]; offsets: unknown }> = {};
    for (const size of Object.keys(SIZES) as SizeId[]) {
      const run = beginFlick(SEED, size);
      while (run.world.targets.visible.length === 0) {
        if (run.session.sim.time > 5) throw new Error('的が出ない');
        run.session.step();
      }
      const t = run.world.targets.visible[0]!;
      const eye = run.world.player.position;
      const L = Math.hypot(t.center.x - eye.x, t.center.y - eye.y, t.center.z - eye.z);
      const torso = partOf(t.parts, 'torso');
      // 胴の幅 = 2 × L × tan(見込み角 ÷ 2)。
      const angle = 2 * Math.atan(torso.size.x / 2 / L) * DEG;
      expect(angle, `${size} の胴の幅の見込み角`).toBeCloseTo(SIZES[size], 6);
      expectHumanoid(t.parts, scaleOf(t), size);
      // 撃ち切って、出る位置のずれの並びを読む。
      shootFlick(run, () => ({ yaw: 0, pitch: 0 }));
      first[size] = { center: t.center, parts: t.parts, offsets: (run.session.result!.modeResult as FlickResult).offsets };
    }
    // 同じ出る位置のずれ（1〜20 個目の並びが大・中・小で一致）。
    expect(first.medium!.offsets).toEqual(first.large!.offsets);
    expect(first.small!.offsets).toEqual(first.large!.offsets);
    const height = (parts: readonly TargetPart[]) =>
      Math.max(...parts.map((p) => p.offset.y + p.size.y / 2)) - Math.min(...parts.map((p) => p.offset.y - p.size.y / 2));
    for (const size of Object.keys(SIZES) as SizeId[]) {
      const p = first[size]!.parts;
      expect(height(p) / partOf(p, 'torso').size.x, `${size} の高さ ÷ 胴の幅`).toBeCloseTo(SPEC_HEIGHT / SPEC_PARTS.torso!.w, 9);
    }
    expect(height(first.large!.parts)).toBeGreaterThan(height(first.medium!.parts));
    expect(height(first.medium!.parts)).toBeGreaterThan(height(first.small!.parts));
  });
});

describe('MODE-51（変更）: 的の大きさごとの命中の境目（胴の端の内側と脇の下の空き）', () => {
  // 出る範囲は SPEC が決めていないので既定（ふつう）。人形の部分の箱は奥行きを持つので、斜めから見ると脇の下の空きは腕・胴の側面で塞がる。
  // 実装の命中が SPEC の部分の箱でこのファイルが計算した当たりと一致することを先に確かめ、そのあと受け入れ条件の文のとおりかを確かめる。
  for (const size of Object.keys(SIZES) as SizeId[]) {
    it(`「${size}」（見込み角 ${SIZES[size]} 度、出る範囲は既定）: 人形の中心から見込み角の半分よりわずかに小さくヨーをずらすと命中、わずかに大きくずらすと外れ`, () => {
      const run = beginFlick(510 + SIZES[size], size);
      const eye = run.world.player.position;
      const half = SIZES[size] / 2;
      const plan: { inside: boolean; sign: number; predicted: boolean }[] = [];
      const seen = shootFlick(run, (i, t) => {
        const inside = i % 2 === 0;
        // ずらす向きは右と左を交互にする（内側 2 回・外側 2 回ずつで向きが変わる）。
        const sign = Math.floor(i / 2) % 2 === 0 ? 1 : -1;
        const on = anglesTo(eye, t.center);
        const a = { yaw: on.yaw + sign * half * (inside ? 0.95 : 1.05), pitch: on.pitch };
        plan.push({ inside, sign, predicted: rayHitsParts(eye, a, t.center, t.parts) });
        return a;
      });
      const recs = flickRecords(run);
      expect(recs).toHaveLength(20);
      const detail = seen
        .map((t, i) => `${i + 1}:${plan[i]!.inside ? '内' : '外'}${plan[i]!.sign > 0 ? '右' : '左'}@yaw${anglesTo(eye, t.center).yaw.toFixed(1)}(SPEC の箱で計算: ${plan[i]!.predicted ? '当たる' : '当たらない'})`)
        .join(' ');
      // 実装の命中は、SPEC の部分の箱（奥行きを持つ）でこのファイルが計算した当たりと一致する。
      expect(recs.map((r) => r.hit), `SPEC の箱で計算した当たりとの比べ: ${detail}`).toEqual(plan.map((p) => p.predicted));
      expect(recs.map((r) => r.hit), detail).toEqual(plan.map((p) => p.inside));
    });
  }
});

// ---------------------------------------------------------------------------
// modes.md「反復練習」
// ---------------------------------------------------------------------------

function drillMode(): TrainingMode {
  const m = modes.find((x) => x.category === 'recoil');
  if (!m) throw new Error('反復練習のモードが登録されていない');
  return m;
}

/** r301 の JSON を元に、randomness 0 で pattern を与えた武器。 */
function testWeapon(pattern: { dx: number; dy: number }[]): WeaponData {
  const base = JSON.parse(readFileSync(join(ROOT, 'src/data/weapons/r301.json'), 'utf8')) as Record<string, unknown>;
  const r = parseWeapon({ ...base, id: 'qa-dummy', name: 'QA 人形', randomness: 0, magSize: pattern.length, pattern });
  if (!r.ok) throw new Error(`武器を作れない: ${JSON.stringify(r.errors)}`);
  return r.weapon;
}

function drill(weapon: WeaponData, seed: number) {
  const world = rangeWorld();
  const s = new PracticeSession<WeaponData>({ world, weapon, mode: drillMode(), input: inputFromTimedActions([fire(0.01, true)]), seed });
  let guard = 0;
  while (!s.ended && guard < 120 * 30) {
    s.step();
    guard += 1;
  }
  expect(s.ended).toBe(true);
  return s;
}

/** 反復練習の人形（練習のあいだずっと置く 1 体）。 */
function drillDummy(s: PracticeSession<WeaponData>): PracticeTarget {
  const v = s.world.targets.all;
  expect(v, '反復練習の練習の的は人形 1 体').toHaveLength(1);
  return v[0]!;
}

describe('MODE-63: randomness 0・pattern すべて 0 の武器で 1 マガジン撃つ', () => {
  it('全弾の弾痕が人形の胴の中心（採点の中心）の上に表示され、平均ズレが 0.00° になる', () => {
    const w = testWeapon(Array.from({ length: 20 }, () => ({ dx: 0, dy: 0 })));
    const s = drill(w, 630);
    const d = drillDummy(s);
    expectHumanoid(d.parts, 1, '反復練習の人形');
    const eye = s.world.player.position;
    // 採点の中心（開始時の照準）は人形の中心を向く。
    const toCenter = anglesTo(eye, d.center);
    expect(toCenter.yaw).toBeCloseTo(s.world.center.yaw, 6);
    expect(toCenter.pitch).toBeCloseTo(s.world.center.pitch, 6);
    // 人形の中心は目から約 9.7 m 先（後ろの面がマップの箱のいちばん手前の面より 0.05 m 手前）。
    expect(Math.hypot(d.center.x - eye.x, d.center.y - eye.y, d.center.z - eye.z)).toBeCloseTo(9.725, 3);
    const front = d.center.z + SPEC_DEPTH / 2;
    expect(s.shots).toHaveLength(20);
    for (const shot of s.shots) {
      expect(shot.target, `${shot.shot} 発目は人形に当たる`).toBe(d.id);
      expect(shot.position).not.toBeNull();
      expect(shot.position!.x).toBeCloseTo(d.center.x, 6);
      expect(shot.position!.y).toBeCloseTo(d.center.y, 6);
      expect(shot.position!.z).toBeCloseTo(front, 6);
      expect(shot.deviation!.yaw).toBeCloseTo(0, 9);
      expect(shot.deviation!.pitch).toBeCloseTo(0, 9);
    }
    const view = new ViewScene(s.world);
    new ImpactMarks(view.layer).sync(s.shots, eye);
    const marks = namedPositions(view, IMPACT_NAME);
    expect(marks).toHaveLength(20);
    for (const m of marks) {
      expect(Math.abs(m.x - d.center.x)).toBeLessThan(1e-3);
      expect(Math.abs(m.y - d.center.y)).toBeLessThan(1e-3);
      // 人形の正面の上（正面から目の側へ浮かせた分だけ手前）。
      expect(m.z).toBeGreaterThanOrEqual(front - 1e-6);
      expect(m.z).toBeLessThan(front + 0.02);
    }
    const score = scoreShots(s.shots, s.world);
    expect(score.meanDeviation).not.toBeNull();
    expect(score.meanDeviation!.toFixed(2)).toBe('0.00');
  });
});

describe('MODE-64: 上向きの pattern で弾が人形の頭より上に出る', () => {
  it('人形に当たった弾の弾痕は人形の上に、人形より上の弾の弾痕は壁の上に表示され、それぞれの角度のズレが弾の向きから求めた値になる', () => {
    const w = testWeapon(Array.from({ length: 16 }, () => ({ dx: 0, dy: 0.5 })));
    const s = drill(w, 640);
    const d = drillDummy(s);
    const eye = s.world.player.position;
    const front = d.center.z + SPEC_DEPTH / 2;
    const top = d.center.y + Math.max(...d.parts.map((p) => p.offset.y + p.size.y / 2));
    const wall = s.world.boxes.find((b) => b.kind === 'wall')!;
    const wallFront = wall.center.z + wall.size.z / 2;
    const onDummy = s.shots.filter((x) => x.target === d.id);
    const above = s.shots.filter((x) => x.target === undefined);
    expect(onDummy.length, '人形に当たった弾').toBeGreaterThan(0);
    expect(above.length, '人形より上の弾').toBeGreaterThan(0);
    for (const shot of onDummy) {
      expect(shot.position!.z, `${shot.shot} 発目は人形の正面`).toBeCloseTo(front, 6);
    }
    for (const shot of above) {
      expect(shot.position, `${shot.shot} 発目`).not.toBeNull();
      expect(shot.position!.y, `${shot.shot} 発目は人形より上`).toBeGreaterThan(top);
      expect(shot.position!.z, `${shot.shot} 発目は壁の正面`).toBeCloseTo(wallFront, 6);
    }
    for (const shot of s.shots) {
      // 弾の向きから求めたズレ = 弾の向き − 採点の中心。
      expect(shot.deviation!.yaw, `${shot.shot} 発目`).toBeCloseTo(shot.angles.yaw - s.world.center.yaw, 6);
      expect(shot.deviation!.pitch, `${shot.shot} 発目`).toBeCloseTo(shot.angles.pitch - s.world.center.pitch, 6);
      // 弾痕の位置は弾の向きのレイの上にある。
      expect(anglesTo(eye, shot.position!).pitch).toBeCloseTo(shot.angles.pitch, 6);
    }
    const view = new ViewScene(s.world);
    new ImpactMarks(view.layer).sync(s.shots, eye);
    const marks = namedPositions(view, IMPACT_NAME);
    expect(marks).toHaveLength(s.shots.length);
    expect(marks.filter((m) => Math.abs(m.z - front) < 0.02).length, '人形の正面の上の弾痕').toBe(onDummy.length);
    expect(marks.filter((m) => Math.abs(m.z - wallFront) < 0.02 && m.y > top).length, '壁の上の弾痕').toBe(above.length);
  });
});

// ---------------------------------------------------------------------------
// screens.md「3D の表示」
// ---------------------------------------------------------------------------

describe('UI-136: 追いエイムとフリックの人形の描画', () => {
  it('追いエイム: 表示される人形の各部分の箱が、シミュレーションの部分の箱（補間の位置）に一致し、正面にリングはない', () => {
    const s = trackingSession(1360);
    const view = new ViewScene(s.world);
    const marks = new TargetMarks(view.layer);
    for (const t of [0.3, 1.7, 4.2]) {
      stepUntil(s, t);
      for (const alpha of [0, 0.5]) {
        marks.update(s.world.targets.all, alpha, s.world.targets.aimed);
        expect(marks.shown).toHaveLength(1);
        expectDrawnParts(marks.shown[0]!, theTarget(s.world), alpha, `追いエイム ${t} 秒（補間 ${alpha}）`);
      }
    }
  });

  it('フリック: 出た人形の各部分の箱が、シミュレーションの部分の箱に一致し、正面にリングはない', () => {
    const run = beginFlick(1361, 'medium');
    const view = new ViewScene(run.world);
    const marks = new TargetMarks(view.layer);
    let checked = 0;
    shootFlick(run, (i, t) => {
      if (i < 5) {
        const live = run.world.targets.visible[0]!;
        expect(live.id).toBe(t.id);
        marks.update(run.world.targets.all, 0.5);
        expect(marks.shown).toHaveLength(1);
        expectDrawnParts(marks.shown[0]!, live, 0.5, `フリック ${i + 1} 個目`);
        checked += 1;
      }
      return { yaw: 0, pitch: 0 };
    });
    expect(checked).toBe(5);
  });
});

describe('UI-138: 人形のための素材のファイルがない配布物', () => {
  const temps: string[] = [];
  afterAll(() => {
    for (const t of temps) rmSync(t, { recursive: true, force: true });
  });

  it('ビルドの配布物に画像・音声・3D モデルのファイルがなく（人形の見た目はコードで作る）、npm run build のあとの npm run check:assets が成功する', () => {
    const out = mkdtempSync(join(tmpdir(), 'ui138-dist-'));
    temps.push(out);
    const env = { ...process.env, FORCE_COLOR: '0', APEX_ACCEPTANCE_NESTED: '1' };
    const build = spawnSync(`npm run build -- --outDir "${out}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8', env });
    expect(build.status, `${build.stdout}${build.stderr}`).toBe(0);
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
    const MEDIA = /^\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|mp3|wav|ogg|m4a|aac|flac|opus|weba|glb|gltf|fbx|obj|dae|3ds|blend|usdz)$/i;
    const media = walk(out).filter((f) => MEDIA.test(extname(f)));
    // 素材の一覧に載っていないものも、人形の名前のものもない。
    const manifest = JSON.parse(readFileSync(join(ROOT, 'src/assets/assets.json'), 'utf8')) as { path?: string }[];
    expect(media.filter((f) => /dummy|humanoid|mannequin|doll|人形/i.test(f))).toEqual([]);
    expect(manifest.filter((e) => /dummy|humanoid|mannequin|doll|人形/i.test(JSON.stringify(e)))).toEqual([]);
    expect(media.map((f) => f.slice(out.length))).toEqual([]);
    const check = spawnSync(`npm run check:assets -- "${out}"`, { cwd: ROOT, shell: true, encoding: 'utf8', env });
    expect(check.status, `${check.stdout}${check.stderr}`).toBe(0);
  }, 300_000);
});
