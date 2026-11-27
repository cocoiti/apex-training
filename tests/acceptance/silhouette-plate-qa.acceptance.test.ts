// docs/spec/architecture.md「練習の的」「人型の板の的」「照準と的の当たり」（ARC-63〜ARC-66・ARC-74・ARC-75）、
// docs/spec/modes.md の人型の板の受け入れ条件（MODE-51・MODE-59〜MODE-65）、docs/spec/screens.md「3D の表示」の人型の板の描画（UI-136・UI-139）の
// 受け入れテスト（#95）。QA が SPEC だけから書いたもの。ブラウザを使わない（ブラウザで確かめる MODE-58・UI-135・UI-137 は
// humanoid-dummy-browser-qa.acceptance.test.ts、UI-138 は humanoid-dummy-qa.acceptance.test.ts）。
//
// 公開された入口（練習モードの共通の型・PracticeSession・登録されたモードの一覧、練習の的の決め方 PracticeTargetSpec と板 TargetPlate、
// 人型の板 humanoidPlate、World・マップの JSON・武器の JSON、描画の ViewScene・TargetMarks・ImpactMarks、採点の scoreShots）だけを使う。
// 人型の板の輪郭の期待値は SPEC の表（右半分の 8 頂点を下から、左半分は X の符号を変えて上から逆の順）からこのファイルに書く。
// 板の当たり（正面の面と輪郭）と照準の向き（ヨー 0・ピッチ 0 が -Z、ヨーが正なら +X、ピッチが正なら +Y）も、SPEC からこのファイルで求める。
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { TimedAction } from '../../src/input/actions';
import { InputQueue, inputFromTimedActions } from '../../src/input/queue';
import type { FlickResult } from '../../src/modes/aim/flick';
import trackingMode from '../../src/modes/aim/tracking';
import { modes } from '../../src/modes/registry';
import { PracticeSession } from '../../src/modes/session';
import type { ModeContext, ModeOptionValues, TrainingMode } from '../../src/modes/types';
import { IMPACT_NAME, ImpactMarks } from '../../src/render/impacts';
import { ViewScene } from '../../src/render/scene';
import { PRACTICE_TARGET_RINGS_NAME, PRACTICE_TARGET_ZONE_NAME, TargetMarks } from '../../src/render/targets';
import { humanoidPlate } from '../../src/sim/humanoid';
import type { Box } from '../../src/sim/map';
import { scoreShots } from '../../src/sim/scoring';
import type { PlatePoint, PracticeTarget, PracticeTargetOptions, PracticeTargets, PracticeTargetSpec, TargetPart, TargetPlate } from '../../src/sim/targets';
import { vec3, type Vec3 } from '../../src/sim/vec3';
import { parseWeapon, type WeaponData } from '../../src/sim/weapon';
import { createWorld, loadWorld, type World } from '../../src/sim/world';

const ROOT = resolve(__dirname, '../..');
const DT = 1 / 120;
const DEG = 180 / Math.PI;

// SPEC の値 -------------------------------------------------------------------

/** SPEC の表の縮尺 1 の人型の板の右半分の頂点（下から）。 */
const RIGHT_HALF: PlatePoint[] = [
  { x: 0.225, y: -0.3 },
  { x: 0.225, y: 0.1 },
  { x: 0.17, y: 0.17 },
  { x: 0.05, y: 0.2 },
  { x: 0.05, y: 0.25 },
  { x: 0.08, y: 0.28 },
  { x: 0.08, y: 0.42 },
  { x: 0.05, y: 0.45 },
];
/** 縮尺 1 の輪郭の 16 頂点（右半分を下から、左半分を上から）。 */
const SPEC_OUTLINE: PlatePoint[] = [...RIGHT_HALF, ...[...RIGHT_HALF].reverse().map((p) => ({ x: -p.x, y: p.y }))];
const SPEC_WIDTH = 0.45;
const SPEC_HEIGHT = 0.75;
const SPEC_THICKNESS = 0.01;
/** 区域の線（screens.md「3D の表示」）: 縮尺 1 の中心・幅・高さ。 */
const SPEC_ZONES = [
  { name: '頭', cx: 0, cy: 0.35, w: 0.1, h: 0.12 },
  { name: '胴', cx: 0, cy: 0, w: 0.15, h: 0.2 },
];

// 共通の道具 ------------------------------------------------------------------

interface Angles {
  yaw: number;
  pitch: number;
}

function anglesTo(eye: Vec3, point: Vec3): Angles {
  const dx = point.x - eye.x;
  const dy = point.y - eye.y;
  const dz = point.z - eye.z;
  return { yaw: Math.atan2(dx, -dz) * DEG, pitch: Math.atan2(dy, Math.hypot(dx, dz)) * DEG };
}
const dirOf = (a: Angles) => {
  const y = a.yaw / DEG;
  const p = a.pitch / DEG;
  return vec3(Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
};
const add = (a: Vec3, b: Vec3) => vec3(a.x + b.x, a.y + b.y, a.z + b.z);
const rel = (x: number, y: number) => vec3(x, y, 0);

/** 点 (x, y) が多角形の内側か（線の上を含む）。SPEC の定義をこのファイルで計算する。 */
function inPolygon(poly: readonly PlatePoint[], x: number, y: number): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    const within = Math.min(a.x, b.x) - 1e-12 <= x && x <= Math.max(a.x, b.x) + 1e-12 && Math.min(a.y, b.y) - 1e-12 <= y && y <= Math.max(a.y, b.y) + 1e-12;
    if (Math.abs(cross) < 1e-12 && within) return true;
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** SPEC の板の当たり: 目から向き a のレイが、中心 center の板の正面の面（Z = center.z）と交わる点が輪郭の内側か。 */
function rayHitsPlate(eye: Vec3, a: Angles, center: Vec3, plate: TargetPlate): boolean {
  const d = dirOf(a);
  if (Math.abs(d.z) < 1e-12) return false;
  const t = (center.z - eye.z) / d.z;
  if (t <= 0) return false;
  return inPolygon(plate.outline, eye.x + d.x * t - center.x, eye.y + d.y * t - center.y);
}

function expectOutline(plate: TargetPlate | undefined, s: number, label: string) {
  expect(plate, `${label}: 板の的`).toBeDefined();
  expect(plate!.outline, `${label}: 頂点の数`).toHaveLength(16);
  plate!.outline.forEach((p, i) => {
    expect(p.x, `${label}: 頂点 ${i + 1} の X`).toBeCloseTo(SPEC_OUTLINE[i]!.x * s, 9);
    expect(p.y, `${label}: 頂点 ${i + 1} の Y`).toBeCloseTo(SPEC_OUTLINE[i]!.y * s, 9);
  });
  expect(plate!.thickness, `${label}: 厚み`).toBeCloseTo(SPEC_THICKNESS, 12);
}
const plateWidth = (p: TargetPlate) => Math.max(...p.outline.map((v) => v.x)) - Math.min(...p.outline.map((v) => v.x));
const plateHeight = (p: TargetPlate) => Math.max(...p.outline.map((v) => v.y)) - Math.min(...p.outline.map((v) => v.y));
const scaleOf = (t: Pick<PracticeTarget, 'plate'>) => plateWidth(t.plate!) / SPEC_WIDTH;

interface ModeSpec {
  setup?: (c: ModeContext) => void;
}
function qaMode(spec: ModeSpec = {}): TrainingMode {
  return {
    id: 'qa-plate',
    name: { ja: 'QA 板', en: 'QA 板' },
    description: { ja: 'QA の板', en: 'QA の板' },
    icon: 'track',
    category: 'aim',
    order: 1,
    usesWeapon: false,
    setup(c) {
      spec.setup?.(c);
    },
    step() {
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
const qaWorld = () => createWorld({ id: 'qa', name: 'qa', spawn: { position: QA_EYE, aim: { yaw: 0, pitch: 0 } }, boxes: [QA_BACK] });

const look = (t: number, from: Angles, to: Angles): TimedAction => ({ time: t, action: { type: 'look', yaw: to.yaw - from.yaw, pitch: to.pitch - from.pitch } });
const fire = (t: number, pressed: boolean): TimedAction => ({ time: t, action: { type: 'fire', pressed } });

function stepUntil(s: PracticeSession<WeaponData> | PracticeSession<undefined>, t: number) {
  while (s.sim.time < t - 1e-9 && !s.ended) s.step();
}

function rangeWorld(): World {
  const r = loadWorld(JSON.parse(readFileSync(join(ROOT, 'src/data/maps/range.json'), 'utf8')));
  if (!r.ok) throw new Error(`マップが読めない: ${JSON.stringify(r.errors)}`);
  return r.world;
}

/** 照準を固定の的の各点に順に向けたステップの「乗っている」を返す。 */
function aimedAt(center: Vec3, plate: TargetPlate, points: Record<string, Vec3>, seed: number): Record<string, boolean> {
  const names = Object.keys(points);
  const actions: TimedAction[] = [];
  let prev: Angles = { yaw: 0, pitch: 0 };
  names.forEach((n, i) => {
    const to = anglesTo(QA_EYE, add(center, points[n]!));
    actions.push(look(0.1 + i * 0.1 + DT / 2, prev, to));
    prev = to;
  });
  const s = new PracticeSession({
    world: qaWorld(),
    weapon: undefined,
    mode: qaMode({ setup: (c) => c.targets.add({ id: 'p', plate, position: center }) }),
    input: inputFromTimedActions(actions),
    seed,
  });
  const got: Record<string, boolean> = {};
  names.forEach((n, i) => {
    stepUntil(s, 0.1 + i * 0.1 + 0.05);
    got[n] = s.world.targets.isAimed('p');
  });
  return got;
}

// 描画の道具 ------------------------------------------------------------------

const lerp = (a: Vec3, b: Vec3, t: number) => vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

function visibleIn(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
function rootUpdate(o: THREE.Object3D) {
  let r = o;
  while (r.parent) r = r.parent;
  r.updateMatrixWorld(true);
}
/** 表示されている Mesh のワールド座標の頂点。 */
function meshVertices(group: THREE.Object3D): Vec3[][] {
  rootUpdate(group);
  const out: Vec3[][] = [];
  group.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !visibleIn(o)) return;
    const pos = (o.geometry as THREE.BufferGeometry).getAttribute('position');
    const vs: Vec3[] = [];
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      vs.push(vec3(v.x, v.y, v.z));
    }
    out.push(vs);
  });
  return out;
}
/** 表示されているもの（Mesh・Line など）全体のワールド座標の範囲。 */
function drawnBounds(group: THREE.Object3D): THREE.Box3 {
  rootUpdate(group);
  const box = new THREE.Box3();
  group.traverse((o) => {
    if (!visibleIn(o)) return;
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!g?.getAttribute?.('position')) return;
    if (o.name === PRACTICE_TARGET_RINGS_NAME) return;
    box.expandByObject(o, true);
  });
  return box;
}
function namedVisible(group: THREE.Object3D, name: string): THREE.Object3D[] {
  rootUpdate(group);
  const out: THREE.Object3D[] = [];
  group.traverse((o) => {
    if (o.name !== name || !visibleIn(o)) return;
    for (let p = o.parent; p; p = p.parent) if (p.name === name) return;
    out.push(o);
  });
  return out;
}
function hasVisibleGeometry(o: THREE.Object3D): boolean {
  let any = false;
  o.traverse((c) => {
    const g = (c as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (visibleIn(c) && g?.getAttribute?.('position') && g.getAttribute('position').count > 0) any = true;
  });
  return any;
}

/**
 * 描画した板の的の表示が、シミュレーションの板（描画の補間の位置）と一致するか:
 * 表示の Mesh のどれかが、頂点の (X, Y) の集まりが輪郭の頂点の集まりと等しく、Z が正面（中心の Z）から厚みだけ奥までの、押し出した板である。
 * 表示されているもの全体が、輪郭の外接の長方形からはみ出さない。
 */
function expectDrawnPlate(group: THREE.Object3D, target: PracticeTarget, alpha: number, label: string) {
  const c = lerp(target.previousCenter, target.center, alpha);
  const plate = target.plate!;
  const want = plate.outline.map((p) => ({ x: c.x + p.x, y: c.y + p.y }));
  const key = (x: number, y: number) => `${x.toFixed(5)},${y.toFixed(5)}`;
  const wantKeys = new Set(want.map((p) => key(p.x, p.y)));
  const meshes = meshVertices(group);
  const match = meshes.find((vs) => {
    const ks = new Set(vs.map((v) => key(v.x, v.y)));
    return ks.size === wantKeys.size && [...ks].every((k) => wantKeys.has(k));
  });
  const summary = meshes.map((vs) => `${vs.length} 頂点 [${vs.slice(0, 4).map((v) => key(v.x, v.y)).join(' ')} …]`).join(' / ');
  expect(match, `${label}: 輪郭の頂点 ${[...wantKeys].join(' ')} の板のメッシュ（表示: ${summary}）`).toBeDefined();
  const zs = match!.map((v) => v.z);
  expect(Math.max(...zs), `${label}: 板の正面の Z`).toBeCloseTo(c.z, 4);
  expect(Math.max(...zs) - Math.min(...zs), `${label}: 板の厚み`).toBeCloseTo(plate.thickness, 4);
  const b = drawnBounds(group);
  const minX = Math.min(...want.map((p) => p.x));
  const maxX = Math.max(...want.map((p) => p.x));
  const minY = Math.min(...want.map((p) => p.y));
  const maxY = Math.max(...want.map((p) => p.y));
  const tol = 1e-4;
  expect(b.min.x, `${label}: 表示の左端`).toBeGreaterThanOrEqual(minX - tol);
  expect(b.max.x, `${label}: 表示の右端`).toBeLessThanOrEqual(maxX + tol);
  expect(b.min.y, `${label}: 表示の下端`).toBeGreaterThanOrEqual(minY - tol);
  expect(b.max.y, `${label}: 表示の上端`).toBeLessThanOrEqual(maxY + tol);
}

function expectNoRings(group: THREE.Object3D, label: string) {
  const rings = namedVisible(group, PRACTICE_TARGET_RINGS_NAME).filter(hasVisibleGeometry);
  expect(rings, `${label}: 板の正面のリング`).toHaveLength(0);
}

/** 区域の線（楕円）が、縮尺 s の SPEC の位置と大きさで描かれているか。描かれた区域の外接の長方形を返す。 */
function expectZones(group: THREE.Object3D, center: Vec3, s: number, label: string): { cx: number; cy: number; w: number; h: number }[] {
  const zones = namedVisible(group, PRACTICE_TARGET_ZONE_NAME).filter(hasVisibleGeometry);
  const boxes = zones.map((z) => {
    const b = new THREE.Box3().setFromObject(z, true);
    return { cx: (b.min.x + b.max.x) / 2 - center.x, cy: (b.min.y + b.max.y) / 2 - center.y, w: b.max.x - b.min.x, h: b.max.y - b.min.y, z: b.max.z - center.z };
  });
  const info = `${label}: 区域 ${JSON.stringify(boxes.map((b) => [b.cx, b.cy, b.w, b.h, b.z].map((v) => +v.toFixed(4))))}`;
  expect(boxes.length, info).toBe(2);
  const found: { cx: number; cy: number; w: number; h: number }[] = [];
  for (const z of SPEC_ZONES) {
    const b = boxes.find((x) => Math.abs(x.cy - z.cy * s) < 0.03 * s);
    expect(b, `${info}・${z.name}の区域`).toBeDefined();
    expect(Math.abs(b!.cx - z.cx * s), `${info}・${z.name}の中心 X`).toBeLessThan(0.005 * s);
    expect(Math.abs(b!.cy - z.cy * s), `${info}・${z.name}の中心 Y`).toBeLessThan(0.005 * s);
    // 線の太さの分は許す（幅・高さの ±15%）。
    expect(b!.w / (z.w * s), `${info}・${z.name}の幅`).toBeGreaterThan(0.85);
    expect(b!.w / (z.w * s), `${info}・${z.name}の幅`).toBeLessThan(1.15);
    expect(b!.h / (z.h * s), `${info}・${z.name}の高さ`).toBeGreaterThan(0.85);
    expect(b!.h / (z.h * s), `${info}・${z.name}の高さ`).toBeLessThan(1.15);
    // 板の正面の上（目の側へ浮かせた分は許す）。
    expect(Math.abs(b!.z), `${info}・${z.name}は板の正面の上`).toBeLessThan(0.02);
    found.push(b!);
  }
  return found;
}

function namedPositions(view: ViewScene, name: string): Vec3[] {
  view.scene.updateMatrixWorld(true);
  const out: Vec3[] = [];
  view.scene.traverse((o) => {
    if (o.name !== name || !visibleIn(o)) return;
    const w = o.getWorldPosition(new THREE.Vector3());
    out.push(vec3(w.x, w.y, w.z));
  });
  return out;
}

// ---------------------------------------------------------------------------
// architecture.md「人型の板の的」
// ---------------------------------------------------------------------------

describe('ARC-63: 縮尺 1 の人型の板を 10 メートル先に置いたときの「乗っている」', () => {
  it('humanoidPlate(1) の輪郭が SPEC の表の 16 頂点・厚み 0.01 で、輪郭の内側の 4 点では乗っていて、輪郭のすぐ外の 4 点では乗っていない', () => {
    const plate = humanoidPlate(1);
    expectOutline(plate, 1, '縮尺 1');
    expect(plateWidth(plate)).toBeCloseTo(SPEC_WIDTH, 9);
    expect(plateHeight(plate)).toBeCloseTo(SPEC_HEIGHT, 9);
    const center = vec3(0, 1.6, -10);
    const got = aimedAt(
      center,
      plate,
      {
        板の中心: rel(0, 0),
        頭の中心: rel(0, 0.35),
        右肩の内側: rel(0.2, 0.05),
        胴の右下の角の内側: rel(0.21, -0.28),
        頭と肩のあいだの空き: rel(0.13, 0.25),
        胴の右の辺のすぐ外: rel(0.24, 0),
        頭のてっぺんのすぐ上: rel(0, 0.47),
        胴の下端のすぐ下: rel(0, -0.32),
      },
      63,
    );
    expect(got).toEqual({
      板の中心: true,
      頭の中心: true,
      右肩の内側: true,
      胴の右下の角の内側: true,
      頭と肩のあいだの空き: false,
      胴の右の辺のすぐ外: false,
      頭のてっぺんのすぐ上: false,
      胴の下端のすぐ下: false,
    });
  });
});

describe('ARC-64: 縮尺 0.5 の人型の板', () => {
  it('輪郭の各頂点の位置が縮尺 1 の値の 0.5 倍になり、厚みは 0.01 のまま', () => {
    const one = humanoidPlate(1);
    const half = humanoidPlate(0.5);
    expectOutline(one, 1, '縮尺 1');
    expectOutline(half, 0.5, '縮尺 0.5');
    half.outline.forEach((p, i) => {
      expect(p.x).toBeCloseTo(one.outline[i]!.x * 0.5, 12);
      expect(p.y).toBeCloseTo(one.outline[i]!.y * 0.5, 12);
    });
    expect(half.thickness).toBe(one.thickness);
  });

  it('練習に置いた縮尺 0.5 の板も、シミュレーションの的の輪郭が 0.5 倍・厚み 0.01', () => {
    const s = new PracticeSession({
      world: qaWorld(),
      weapon: undefined,
      mode: qaMode({ setup: (c) => c.targets.add({ id: 'half', plate: humanoidPlate(0.5), position: vec3(0, 1.6, -10) }) }),
      input: inputFromTimedActions([]),
      seed: 64,
    });
    s.step();
    const t = s.world.targets.get('half')!;
    expect(t.parts).toHaveLength(0);
    expectOutline(t.plate, 0.5, '練習の的');
  });
});

describe('ARC-65: 弾痕を残す練習の的（部分の箱の並びと板）と残さない練習の的', () => {
  it('弾痕を残す箱の的と板の的に当たった弾は識別子を持ち、当たった点が弾痕として記録・表示される。残さない板の的に当たった弾の弾痕は表示されない', () => {
    const boxCenter = vec3(-1.5, 1.6, -10);
    const plateCenter = vec3(0, 1.6, -10);
    const plainCenter = vec3(1.5, 1.6, -10);
    const parts: TargetPart[] = [
      { id: 'a', size: vec3(0.4, 0.4, 0.2), offset: vec3(0, 0, 0) },
      { id: 'b', size: vec3(0.2, 0.2, 0.2), offset: vec3(0, 0.4, 0) },
    ];
    const aims = [
      anglesTo(QA_EYE, add(boxCenter, rel(0, 0.4))),
      anglesTo(QA_EYE, add(plateCenter, rel(0, 0.35))),
      anglesTo(QA_EYE, plainCenter),
    ];
    const actions: TimedAction[] = [];
    let prev: Angles = { yaw: 0, pitch: 0 };
    aims.forEach((a, i) => {
      actions.push(look(0.1 + i * 0.2, prev, a), fire(0.15 + i * 0.2, true), fire(0.2 + i * 0.2, false));
      prev = a;
    });
    const s = new PracticeSession({
      world: qaWorld(),
      weapon: undefined,
      mode: qaMode({
        setup: (c) => {
          c.targets.add({ id: 'box', parts, position: boxCenter, keepsImpacts: true });
          c.targets.add({ id: 'plate', plate: humanoidPlate(1), position: plateCenter, keepsImpacts: true });
          c.targets.add({ id: 'plain', plate: humanoidPlate(1), position: plainCenter });
        },
      }),
      input: inputFromTimedActions(actions),
      seed: 65,
    });
    stepUntil(s, 0.9);
    expect(s.shots.map((x) => x.target)).toEqual(['box', 'plate', 'plain']);
    const [boxShot, plateShot] = s.shots;
    // 箱の的: 頭の箱の正面（Z = 中心 + 奥行きの半分）との交点。
    const fz = boxCenter.z + 0.1;
    const tb = (fz - QA_EYE.z) / (boxCenter.z - QA_EYE.z);
    const wantBox = vec3(QA_EYE.x + (boxCenter.x - QA_EYE.x) * tb, QA_EYE.y + 0.4 * tb, fz);
    // 板の的: 板の正面の面（Z = 中心）との交点 = 頭の中心。
    const wantPlate = add(plateCenter, rel(0, 0.35));
    for (const [shot, want, name] of [
      [boxShot!, wantBox, '箱'],
      [plateShot!, wantPlate, '板'],
    ] as const) {
      expect(shot.position, `${name}の的の弾痕の位置`).not.toBeNull();
      expect(shot.position!.x, name).toBeCloseTo(want.x, 6);
      expect(shot.position!.y, name).toBeCloseTo(want.y, 6);
      expect(shot.position!.z, name).toBeCloseTo(want.z, 6);
    }
    const view = new ViewScene(s.world);
    new ImpactMarks(view.layer).sync(s.shots, s.world.player.position);
    const marks = namedPositions(view, IMPACT_NAME);
    expect(marks, '表示される弾痕は弾痕を残す 2 つの的に当たった 2 発だけ').toHaveLength(2);
    for (const want of [wantBox, wantPlate]) {
      expect(
        marks.some((m) => Math.abs(m.x - want.x) < 0.01 && Math.abs(m.y - want.y) < 0.01 && Math.abs(m.z - want.z) < 0.02),
        `弾痕 ${JSON.stringify(want)}（表示 ${JSON.stringify(marks)}）`,
      ).toBe(true);
    }
  });
});

describe('ARC-66: シミュレーションの側で形を変えた的の描画', () => {
  /** 部分の箱の的の表示が、部分の箱と同じ範囲のメッシュでできているか。 */
  function expectDrawnParts(group: THREE.Object3D, target: PracticeTarget, alpha: number, label: string) {
    const c = lerp(target.previousCenter, target.center, alpha);
    rootUpdate(group);
    const got: THREE.Box3[] = [];
    group.traverse((o) => {
      if (o instanceof THREE.Mesh && visibleIn(o)) got.push(new THREE.Box3().setFromObject(o));
    });
    const same = (b: THREE.Box3, p: TargetPart) =>
      (['x', 'y', 'z'] as const).every(
        (k) => Math.abs(b.min[k] - (c[k] + p.offset[k] - p.size[k] / 2)) < 1e-6 && Math.abs(b.max[k] - (c[k] + p.offset[k] + p.size[k] / 2)) < 1e-6,
      );
    for (const p of target.parts) expect(got.some((b) => same(b, p)), `${label}: 部分 ${p.id}`).toBe(true);
    expect(got.filter((b) => !target.parts.some((p) => same(b, p))).length, `${label}: 部分の箱でないメッシュ`).toBe(0);
  }

  it('部分の箱の大きさと位置を変えた的と、輪郭の頂点を変えた板の的を描画すると、表示がその形・位置になる', () => {
    const custom: TargetPart[] = [
      { id: 'a', size: vec3(0.3, 0.7, 0.1), offset: vec3(0.5, -0.2, 0) },
      { id: 'b', size: vec3(0.2, 0.2, 0.4), offset: vec3(-0.4, 0.6, 0.1) },
    ];
    // SPEC の人型の板の頭を右にずらし、胴を広げた輪郭。
    const changed: TargetPlate = {
      ...humanoidPlate(1),
      outline: SPEC_OUTLINE.map((p) => (p.y >= 0.25 ? { x: p.x + 0.05, y: p.y + 0.03 } : { x: p.x * 1.3, y: p.y })),
    };
    const star: TargetPlate = {
      outline: [
        { x: 0, y: 0.5 },
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0 },
        { x: 0.1, y: -0.1 },
        { x: 0, y: -0.5 },
        { x: -0.1, y: -0.1 },
        { x: -0.5, y: 0 },
        { x: -0.1, y: 0.1 },
      ],
      thickness: 0.02,
    };
    const s = new PracticeSession({
      world: qaWorld(),
      weapon: undefined,
      mode: qaMode({
        setup: (c) => {
          c.targets.add({ id: 'custom', parts: custom, position: (t) => vec3(-3 + t, 1.6, -10) });
          c.targets.add({ id: 'changed', plate: changed, position: (t) => vec3(0, 1.4 + t, -9) });
          c.targets.add({ id: 'star', plate: star, position: vec3(3, 1.8, -8) });
        },
      }),
      input: inputFromTimedActions([]),
      seed: 66,
    });
    const view = new ViewScene(s.world);
    const marks = new TargetMarks(view.layer);
    stepUntil(s, 0.5);
    expect(s.world.targets.get('changed')!.plate!.outline).toEqual(changed.outline);
    for (const alpha of [0, 0.5, 1]) {
      marks.update(s.world.targets.all, alpha);
      expect(marks.shown).toHaveLength(3);
      for (const t of s.world.targets.all) {
        const c = lerp(t.previousCenter, t.center, alpha);
        const group = marks.shown.find((g) => {
          const b = drawnBounds(g);
          return Math.abs((b.min.x + b.max.x) / 2 - c.x) < 1.2;
        });
        expect(group, `${t.id} の表示`).toBeDefined();
        if (t.plate) expectDrawnPlate(group!, t, alpha, `${t.id}（補間 ${alpha}）`);
        else expectDrawnParts(group!, t, alpha, `${t.id}（補間 ${alpha}）`);
      }
    }
  });
});

describe('ARC-74: 斜め約 20 度から見る人型の板の「乗っている」', () => {
  it('8 メートル先の正面から右に 3 メートルずらした縮尺 1 の板で、輪郭の内側の点では乗っていて、輪郭のすぐ外の点では乗っていない', () => {
    const center = vec3(3, 1.6, -8);
    expect(Math.atan2(3, 8) * DEG).toBeGreaterThan(19);
    const plate = humanoidPlate(1);
    const points = {
      板の中心: rel(0, 0),
      頭の中心: rel(0, 0.35),
      右肩の内側: rel(0.2, 0.05),
      右の空き: rel(0.13, 0.25),
      左の空き: rel(-0.13, 0.25),
      胴の右の辺の外: rel(0.245, 0),
      胴の左の辺の外: rel(-0.245, 0),
    };
    const got = aimedAt(center, plate, points, 74);
    // SPEC の定義（正面の面と輪郭）でこのファイルが計算した当たりとも一致する。
    const predicted = Object.fromEntries(Object.entries(points).map(([k, p]) => [k, rayHitsPlate(QA_EYE, anglesTo(QA_EYE, add(center, p)), center, plate)]));
    const want = { 板の中心: true, 頭の中心: true, 右肩の内側: true, 右の空き: false, 左の空き: false, 胴の右の辺の外: false, 胴の左の辺の外: false };
    expect(predicted).toEqual(want);
    expect(got).toEqual(want);
  });
});

describe('ARC-75: 輪郭の内側の点への向きに撃った弾の当たった点は板の正面の面の上', () => {
  it('撃った弾は板の的に命中し、当たった点の Z が板の中心の Z と等しい（正面から見る板と斜めから見る板）', () => {
    const centers = { 正面: vec3(0, 1.6, -10), 斜め: vec3(3, 1.6, -8) };
    for (const [name, center] of Object.entries(centers)) {
      const points = [rel(0, 0), rel(0, 0.35), rel(0.2, 0.05), rel(-0.21, -0.28)];
      const actions: TimedAction[] = [];
      let prev: Angles = { yaw: 0, pitch: 0 };
      points.forEach((p, i) => {
        const a = anglesTo(QA_EYE, add(center, p));
        actions.push(look(0.1 + i * 0.2, prev, a), fire(0.15 + i * 0.2, true), fire(0.2 + i * 0.2, false));
        prev = a;
      });
      const s = new PracticeSession({
        world: qaWorld(),
        weapon: undefined,
        mode: qaMode({ setup: (c) => c.targets.add({ id: 'p', plate: humanoidPlate(1), position: center, keepsImpacts: true }) }),
        input: inputFromTimedActions(actions),
        seed: 75,
      });
      stepUntil(s, 1.2);
      expect(s.shots, name).toHaveLength(points.length);
      s.shots.forEach((shot, i) => {
        expect(shot.target, `${name} ${i + 1} 発目`).toBe('p');
        expect(shot.position, `${name} ${i + 1} 発目`).not.toBeNull();
        expect(shot.position!.z - center.z, `${name} ${i + 1} 発目の奥行きの差`).toBeCloseTo(0, 6);
        expect(shot.position!.x, `${name} ${i + 1} 発目の X`).toBeCloseTo(center.x + points[i]!.x, 5);
        expect(shot.position!.y, `${name} ${i + 1} 発目の Y`).toBeCloseTo(center.y + points[i]!.y, 5);
      });
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
function trackingCenters(seed: number, mode: TrainingMode = trackingMode): Vec3[] {
  const s = trackingSession(seed, [], mode);
  const out: Vec3[] = [];
  while (!s.ended) {
    s.step();
    out.push({ ...theTarget(s.world).center });
  }
  return out;
}
/** 各ステップの照準を、そのステップの終わりの的の中心から offset ずらした点に向ける入力。 */
function aimAtEach(centers: Vec3[], eye: Vec3, offset: (k: number) => Vec3): TimedAction[] {
  const actions: TimedAction[] = [];
  let cur: Angles = { yaw: 0, pitch: 0 };
  centers.forEach((c, k) => {
    const want = anglesTo(eye, add(c, offset(k)));
    actions.push({ time: k * DT + DT / 2, action: { type: 'look', yaw: want.yaw - cur.yaw, pitch: want.pitch - cur.pitch } });
    cur = want;
  });
  return actions;
}
/** 入力を与えて最後まで進め、各ステップの「乗っている」と的の中心、モードの採点を返す。 */
function runTracking(seed: number, actions: TimedAction[]) {
  const s = trackingSession(seed, actions);
  const aimed: boolean[] = [];
  const centers: Vec3[] = [];
  while (!s.ended) {
    s.step();
    const t = theTarget(s.world);
    aimed.push(s.world.targets.isAimed(t.id));
    centers.push({ ...t.center });
  }
  const r = s.result!;
  const score = trackingMode.scoring!.score({ shots: r.shots, duration: r.duration, modeResult: r.modeResult });
  const row = score.metrics.find((m) => m.label.includes('乗っていた割合'));
  return { aimed, centers, rate: (aimed.filter(Boolean).length / aimed.length) * 100, row: row?.value, score };
}

describe('MODE-59: 追いエイムの人型の板の当たり', () => {
  const SEED = 5901;
  const eye = rangeWorld().player.position;

  it('的は縮尺 1 の人型の板', () => {
    const s = trackingSession(SEED);
    s.step();
    const t = theTarget(s.world);
    expect(t.parts).toHaveLength(0);
    expectOutline(t.plate, 1, '追いエイムの的');
  });

  it('照準を板の胴の中心に向け続けると乗っていた割合が 100%、板の幅（0.45 m）だけ左右にずらし続けると 0%', () => {
    const centers = trackingCenters(SEED);
    const on = runTracking(SEED, aimAtEach(centers, eye, () => rel(0, 0)));
    expect(on.rate).toBe(100);
    expect(on.row).toBe('100.0%');
    for (const dx of [0.45, -0.45, 0.6]) {
      const off = runTracking(SEED, aimAtEach(centers, eye, () => rel(dx, 0)));
      expect(off.rate, `ずらし ${dx} m`).toBe(0);
      expect(off.row, `ずらし ${dx} m`).toBe('0.0%');
    }
  });
});

describe('MODE-60: 的の形は追いエイムの動きに影響しない', () => {
  /** 追いエイムのモードが足す的を、板の中心と同じ位置の 1 つの箱（幅 0.45・高さ 0.75・奥行き 0.2）に差し替えるモード。 */
  function singleBoxTracking(): TrainingMode {
    const wrap = (c: ModeContext): ModeContext => {
      const targets = new Proxy(c.targets, {
        get(real, prop) {
          if (prop === 'add') {
            return (spec: PracticeTargetSpec) => {
              const rest: Record<string, unknown> = { ...spec };
              delete rest.parts;
              delete rest.size;
              delete rest.plate;
              real.add({ ...(rest as unknown as PracticeTargetOptions), size: vec3(0.45, 0.75, 0.2) });
            };
          }
          const v = Reflect.get(real, prop, real) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(real) : v;
        },
      }) as PracticeTargets;
      return new Proxy(c, { get: (real, prop) => (prop === 'targets' ? targets : (Reflect.get(real, prop, real) as unknown)) });
    };
    return { ...trackingMode, setup: (c) => trackingMode.setup(wrap(c)), step: (c, dt) => trackingMode.step(wrap(c), dt) } as TrainingMode;
  }
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

  it('同じ種・同じ速さで、人型の板の的と 1 つの箱の的にした追いエイムを 20 秒進めると、各ステップの的の中心と切り返しの時刻の列が一致する', () => {
    for (const seed of [6001, 6002]) {
      const plate = trackingCenters(seed);
      const box = trackingCenters(seed, singleBoxTracking());
      const s = trackingSession(seed, [], singleBoxTracking());
      s.step();
      expect(theTarget(s.world).plate, '差し替えた的は板でない').toBeUndefined();
      expect(theTarget(s.world).parts).toHaveLength(1);
      expect(plate.length).toBe(Math.round(20 / DT));
      expect(box).toEqual(plate);
      expect(turns(plate).length).toBeGreaterThan(5);
      expect(turns(box)).toEqual(turns(plate));
    }
  });
});

describe('MODE-65: 追いエイムで斜めから見える板の「乗っている」', () => {
  it('的が基準の点から左右に 2 m 以上離れたステップで、輪郭の内側では乗っていて、輪郭のすぐ外では乗っていない', () => {
    const world = rangeWorld();
    const eye = world.player.position;
    const d8 = dirOf(world.player.aim);
    const ref = add(eye, vec3(d8.x * 8, d8.y * 8, d8.z * 8));
    // 開始時の照準の向きに垂直な水平の線の上の、基準の点からの左右の距離（右が正）。
    const right = dirOf({ yaw: world.player.aim.yaw + 90, pitch: 0 });
    const lateral = (c: Vec3) => (c.x - ref.x) * right.x + (c.z - ref.z) * right.z;
    // 左右の両方に 2 m 以上離れるステップを含むように、種を 3 つ使う。
    const seeds = [6501, 6502, 6503];
    const runsBySeed = seeds.map((seed) => {
      const centers = trackingCenters(seed);
      return { seed, centers, far: centers.map((c) => Math.abs(lateral(c)) >= 2) };
    });
    const all = runsBySeed.flatMap((r) => r.centers);
    expect(all.filter((c) => lateral(c) >= 2).length, '基準の点から右に 2 m 以上離れるステップ').toBeGreaterThan(50);
    expect(all.filter((c) => lateral(c) <= -2).length, '基準の点から左に 2 m 以上離れるステップ').toBeGreaterThan(50);
    const cases: [string, Vec3, boolean][] = [
      ['板の中心', rel(0, 0), true],
      ['頭の中心', rel(0, 0.35), true],
      ['右の空き', rel(0.13, 0.25), false],
      ['左の空き', rel(-0.13, 0.25), false],
      ['胴の右の辺から 0.02 外', rel(0.245, 0), false],
      ['胴の左の辺から 0.02 外', rel(-0.245, 0), false],
    ];
    const plate = humanoidPlate(1);
    for (const { seed, centers, far } of runsBySeed) {
      for (const [name, off, want] of cases) {
        const r = runTracking(seed, aimAtEach(centers, eye, () => off));
        expect(r.centers).toEqual(centers);
        const wrong = r.aimed.map((a, k) => ({ a, k })).filter(({ a, k }) => far[k] && a !== want);
        expect(wrong.slice(0, 5).map(({ k }) => `${((k + 1) * DT).toFixed(3)} 秒・左右 ${lateral(centers[k]!).toFixed(2)} m`), `種 ${seed}・${name}`).toEqual([]);
        // SPEC の定義（正面の面と輪郭）での計算とも一致する。
        const predicted = centers.filter((c, k) => far[k] && rayHitsPlate(eye, anglesTo(eye, add(c, off)), c, plate) !== want);
        expect(predicted.length, `種 ${seed}・${name}（SPEC の定義での計算）`).toBe(0);
      }
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
function flickOptions(size: SizeId): ModeOptionValues {
  const o = flickMode().options?.find((x) => x.label.ja === '的の大きさ');
  if (!o) throw new Error('練習の選択肢に「的の大きさ」がない');
  return { [o.id]: size };
}
interface FlickRun {
  session: PracticeSession<undefined>;
  input: InputQueue;
  world: World;
}
function beginFlick(seed: number, size: SizeId): FlickRun {
  const world = rangeWorld();
  const input = new InputQueue();
  const session = new PracticeSession({ world, weapon: undefined, mode: flickMode(), input, seed, options: flickOptions(size) });
  return { session, input, world };
}
const mid = (t: number) => (Math.floor(t / DT + 1e-6) + 0.5) * DT;

/** 出た的を 1 つずつ、plan が返した向きで、的が出てから 0.2 秒後に撃って最後まで進める。出た的の列を返す。 */
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

describe('MODE-51: フリックの的の大きさごとの命中の境目', () => {
  for (const size of Object.keys(SIZES) as SizeId[]) {
    it(`「${size}」（見込み角 ${SIZES[size]} 度）: 板の中心の向きから見込み角の半分の 0.95 倍ヨーをずらすと命中、1.05 倍ずらすと外れ`, () => {
      const run = beginFlick(5100 + SIZES[size], size);
      const eye = run.world.player.position;
      const half = SIZES[size] / 2;
      const plan: { inside: boolean; predicted: boolean }[] = [];
      const seen = shootFlick(run, (i, t) => {
        const inside = i % 2 === 0;
        const sign = Math.floor(i / 2) % 2 === 0 ? 1 : -1;
        const on = anglesTo(eye, t.center);
        const a = { yaw: on.yaw + sign * half * (inside ? 0.95 : 1.05), pitch: on.pitch };
        plan.push({ inside, predicted: rayHitsPlate(eye, a, t.center, t.plate!) });
        return a;
      });
      const recs = flickRecords(run);
      expect(recs).toHaveLength(20);
      for (const t of seen) expectOutline(t.plate, scaleOf(t), `的 ${t.id}`);
      const detail = seen.map((t, i) => `${i + 1}:${plan[i]!.inside ? '内' : '外'}@yaw${anglesTo(eye, t.center).yaw.toFixed(1)}(計算 ${plan[i]!.predicted})`).join(' ');
      expect(plan.map((p) => p.predicted), `SPEC の定義での計算: ${detail}`).toEqual(plan.map((p) => p.inside));
      expect(recs.map((r) => r.hit), detail).toEqual(plan.map((p) => p.inside));
    });
  }
});

describe('MODE-61: フリックの人型の板への命中と外れ', () => {
  it('板の胴の中心へ撃つと命中、頭と肩のあいだの空き（縮尺倍）・右の辺より板の幅の半分以上外へ撃つと外れ', () => {
    const run = beginFlick(6101, 'large');
    const eye = run.world.player.position;
    const kinds = ['torso', 'gap', 'right'] as const;
    const plan: (typeof kinds)[number][] = [];
    const seen = shootFlick(run, (i, t) => {
      const s = scaleOf(t);
      const kind = kinds[i % 3]!;
      plan.push(kind);
      const off = kind === 'torso' ? rel(0, 0) : kind === 'gap' ? rel(0.13 * s, 0.25 * s) : rel((0.225 + 0.225 + 0.01) * s, 0);
      return anglesTo(eye, add(t.center, off));
    });
    const recs = flickRecords(run);
    expect(recs).toHaveLength(20);
    for (const t of seen) expectOutline(t.plate, scaleOf(t), `的 ${t.id}`);
    expect(recs.map((r) => r.hit), plan.join(' ')).toEqual(plan.map((k) => k === 'torso'));
  });
});

describe('MODE-62: フリックの的の大きさと板の縮尺', () => {
  it('同じ出る位置のずれで、板の幅の見込み角が大・中・小で 3・2・1 度、高さ ÷ 幅が 0.75 ÷ 0.45 で、大がいちばん大きく小がいちばん小さい', () => {
    const SEED = 6201;
    const first: Record<string, { plate: TargetPlate; offsets: unknown }> = {};
    for (const size of Object.keys(SIZES) as SizeId[]) {
      const run = beginFlick(SEED, size);
      while (run.world.targets.visible.length === 0) {
        if (run.session.sim.time > 5) throw new Error('的が出ない');
        run.session.step();
      }
      const t = run.world.targets.visible[0]!;
      const eye = run.world.player.position;
      const L = Math.hypot(t.center.x - eye.x, t.center.y - eye.y, t.center.z - eye.z);
      const w = plateWidth(t.plate!);
      expect(2 * Math.atan(w / 2 / L) * DEG, `${size} の板の幅の見込み角`).toBeCloseTo(SIZES[size], 6);
      expectOutline(t.plate, w / SPEC_WIDTH, size);
      shootFlick(run, () => ({ yaw: 0, pitch: 0 }));
      first[size] = { plate: t.plate!, offsets: (run.session.result!.modeResult as FlickResult).offsets };
    }
    expect(first.medium!.offsets).toEqual(first.large!.offsets);
    expect(first.small!.offsets).toEqual(first.large!.offsets);
    for (const size of Object.keys(SIZES)) {
      const p = first[size]!.plate;
      expect(plateHeight(p) / plateWidth(p), `${size} の高さ ÷ 幅`).toBeCloseTo(SPEC_HEIGHT / SPEC_WIDTH, 9);
    }
    expect(plateHeight(first.large!.plate)).toBeGreaterThan(plateHeight(first.medium!.plate));
    expect(plateHeight(first.medium!.plate)).toBeGreaterThan(plateHeight(first.small!.plate));
  });
});

// ---------------------------------------------------------------------------
// modes.md「反復練習」
// ---------------------------------------------------------------------------

function drillMode(): TrainingMode {
  const m = modes.find((x) => x.category === 'recoil');
  if (!m) throw new Error('反復練習のモードが登録されていない');
  return m;
}
function testWeapon(pattern: { dx: number; dy: number }[]): WeaponData {
  const base = JSON.parse(readFileSync(join(ROOT, 'src/data/weapons/r301.json'), 'utf8')) as Record<string, unknown>;
  const r = parseWeapon({ ...base, id: 'qa-plate', name: 'QA 板', randomness: 0, magSize: pattern.length, pattern });
  if (!r.ok) throw new Error(`武器を作れない: ${JSON.stringify(r.errors)}`);
  return r.weapon;
}
function drill(weapon: WeaponData, seed: number) {
  const s = new PracticeSession<WeaponData>({ world: rangeWorld(), weapon, mode: drillMode(), input: inputFromTimedActions([fire(0.01, true)]), seed });
  let guard = 0;
  while (!s.ended && guard < 120 * 30) {
    s.step();
    guard += 1;
  }
  expect(s.ended).toBe(true);
  return s;
}
function drillPlate(s: PracticeSession<WeaponData>): PracticeTarget {
  const v = s.world.targets.all;
  expect(v, '反復練習の練習の的は板 1 枚').toHaveLength(1);
  return v[0]!;
}

describe('MODE-63: randomness 0・pattern すべて 0 の武器で 1 マガジン撃つ', () => {
  it('全弾の弾痕が板の胴の中心（採点の中心）の正面の上に表示され、平均ズレが 0.00° になる', () => {
    const s = drill(testWeapon(Array.from({ length: 20 }, () => ({ dx: 0, dy: 0 }))), 6301);
    const d = drillPlate(s);
    expectOutline(d.plate, 1, '反復練習の板');
    const eye = s.world.player.position;
    const toCenter = anglesTo(eye, d.center);
    expect(toCenter.yaw).toBeCloseTo(s.world.center.yaw, 6);
    expect(toCenter.pitch).toBeCloseTo(s.world.center.pitch, 6);
    expect(Math.hypot(d.center.x - eye.x, d.center.y - eye.y, d.center.z - eye.z)).toBeCloseTo(9.85, 3);
    expect(s.shots).toHaveLength(20);
    for (const shot of s.shots) {
      expect(shot.target, `${shot.shot} 発目は板に当たる`).toBe(d.id);
      expect(shot.position!.x).toBeCloseTo(d.center.x, 6);
      expect(shot.position!.y).toBeCloseTo(d.center.y, 6);
      expect(shot.position!.z).toBeCloseTo(d.center.z, 6);
    }
    const view = new ViewScene(s.world);
    new ImpactMarks(view.layer).sync(s.shots, eye);
    const marks = namedPositions(view, IMPACT_NAME);
    expect(marks).toHaveLength(20);
    for (const m of marks) {
      expect(Math.abs(m.x - d.center.x)).toBeLessThan(1e-3);
      expect(Math.abs(m.y - d.center.y)).toBeLessThan(1e-3);
      expect(m.z).toBeGreaterThanOrEqual(d.center.z - 1e-6);
      expect(m.z).toBeLessThan(d.center.z + 0.02);
    }
    const score = scoreShots(s.shots, s.world);
    expect(score.meanDeviation!.toFixed(2)).toBe('0.00');
  });
});

describe('MODE-64: 上向きの pattern で弾が板の頭より上に出る', () => {
  it('板に当たった弾の弾痕は板の正面に、板より上の弾の弾痕は壁に表示され、角度のズレが弾の向きから求めた値になる', () => {
    const s = drill(testWeapon(Array.from({ length: 16 }, () => ({ dx: 0, dy: 0.5 }))), 6401);
    const d = drillPlate(s);
    const eye = s.world.player.position;
    const top = d.center.y + Math.max(...d.plate!.outline.map((p) => p.y));
    const wall = s.world.boxes.find((b) => b.kind === 'wall')!;
    const wallFront = wall.center.z + wall.size.z / 2;
    const onPlate = s.shots.filter((x) => x.target === d.id);
    const above = s.shots.filter((x) => x.target === undefined);
    expect(onPlate.length, '板に当たった弾').toBeGreaterThan(0);
    expect(above.length, '板より上の弾').toBeGreaterThan(0);
    for (const shot of onPlate) expect(shot.position!.z, `${shot.shot} 発目は板の正面`).toBeCloseTo(d.center.z, 6);
    for (const shot of above) {
      expect(shot.position!.y, `${shot.shot} 発目は板より上`).toBeGreaterThan(top);
      expect(shot.position!.z, `${shot.shot} 発目は壁の正面`).toBeCloseTo(wallFront, 6);
    }
    for (const shot of s.shots) {
      expect(shot.deviation!.yaw).toBeCloseTo(shot.angles.yaw - s.world.center.yaw, 6);
      expect(shot.deviation!.pitch).toBeCloseTo(shot.angles.pitch - s.world.center.pitch, 6);
      expect(anglesTo(eye, shot.position!).pitch).toBeCloseTo(shot.angles.pitch, 6);
    }
    const view = new ViewScene(s.world);
    new ImpactMarks(view.layer).sync(s.shots, eye);
    const marks = namedPositions(view, IMPACT_NAME);
    expect(marks).toHaveLength(s.shots.length);
    expect(marks.filter((m) => Math.abs(m.z - d.center.z) < 0.02).length, '板の正面の上の弾痕').toBe(onPlate.length);
    expect(marks.filter((m) => Math.abs(m.z - wallFront) < 0.02 && m.y > top).length, '壁の上の弾痕').toBe(above.length);
  });
});

// ---------------------------------------------------------------------------
// screens.md「3D の表示」
// ---------------------------------------------------------------------------

describe('UI-136: 追いエイムとフリックの人型の板の描画', () => {
  it('追いエイム: 表示される板の輪郭の頂点がシミュレーションの板の輪郭（補間の位置）に一致し、正面にリングはない', () => {
    const s = trackingSession(13601);
    const view = new ViewScene(s.world);
    const marks = new TargetMarks(view.layer);
    for (const t of [0.3, 1.7, 4.2]) {
      stepUntil(s, t);
      for (const alpha of [0, 0.5]) {
        marks.update(s.world.targets.all, alpha, s.world.targets.aimed, s.world);
        expect(marks.shown).toHaveLength(1);
        expectDrawnPlate(marks.shown[0]!, theTarget(s.world), alpha, `追いエイム ${t} 秒（補間 ${alpha}）`);
        expectNoRings(marks.shown[0]!, `追いエイム ${t} 秒`);
      }
    }
  });

  it('フリック: 出た板の輪郭の頂点がシミュレーションの板の輪郭に一致し、正面にリングはない', () => {
    const run = beginFlick(13602, 'medium');
    const view = new ViewScene(run.world);
    const marks = new TargetMarks(view.layer);
    let checked = 0;
    shootFlick(run, (i, t) => {
      if (i < 5) {
        const live = run.world.targets.visible[0]!;
        expect(live.id).toBe(t.id);
        marks.update(run.world.targets.all, 0.5, run.world.targets.aimed, run.world);
        const shown = marks.shown.filter((g) => visibleIn(g));
        expect(shown).toHaveLength(1);
        expectDrawnPlate(shown[0]!, live, 0.5, `フリック ${i + 1} 個目`);
        expectNoRings(shown[0]!, `フリック ${i + 1} 個目`);
        checked += 1;
      }
      return { yaw: 0, pitch: 0 };
    });
    expect(checked).toBe(5);
  });
});

describe('UI-139: 人型の板の区域の線', () => {
  it('反復練習・追いエイム・フリック（大・中・小）の板の正面に、頭と胴の区域の楕円が縮尺に比例した大きさで描かれる', () => {
    // 反復練習（縮尺 1）。
    const ds = new PracticeSession<WeaponData>({
      world: rangeWorld(),
      weapon: testWeapon([{ dx: 0, dy: 0 }]),
      mode: drillMode(),
      input: inputFromTimedActions([]),
      seed: 13901,
    });
    ds.step();
    const dv = new ViewScene(ds.world);
    const dm = new TargetMarks(dv.layer);
    dm.update(ds.world.targets.all, 1, ds.world.targets.aimed, ds.world);
    expect(dm.shown).toHaveLength(1);
    expectZones(dm.shown[0]!, ds.world.targets.all[0]!.center, 1, '反復練習');

    // 追いエイム（縮尺 1）。
    const ts = trackingSession(13902);
    ts.step();
    const tv = new ViewScene(ts.world);
    const tm = new TargetMarks(tv.layer);
    tm.update(ts.world.targets.all, 1, ts.world.targets.aimed, ts.world);
    const trackingZones = expectZones(tm.shown[0]!, theTarget(ts.world).center, 1, '追いエイム');

    // フリック（縮尺は的の大きさで決まる）。区域の大きさは縮尺 1 の区域の縮尺倍。
    for (const size of Object.keys(SIZES) as SizeId[]) {
      const run = beginFlick(13903, size);
      while (run.world.targets.visible.length === 0) run.session.step();
      const t = run.world.targets.visible[0]!;
      const s = scaleOf(t);
      const v = new ViewScene(run.world);
      const m = new TargetMarks(v.layer);
      m.update(run.world.targets.all, 1, run.world.targets.aimed, run.world);
      const shown = m.shown.filter((g) => visibleIn(g));
      const zones = expectZones(shown[0]!, t.center, s, `フリック ${size}（縮尺 ${s.toFixed(4)}）`);
      zones.forEach((z, i) => {
        expect(z.w / trackingZones[i]!.w, `フリック ${size} の区域 ${i} の幅の比`).toBeCloseTo(s, 1);
        expect(z.h / trackingZones[i]!.h, `フリック ${size} の区域 ${i} の高さの比`).toBeCloseTo(s, 1);
      });
    }
  });

  it('追いエイム: 区域の線の内側と外側（輪郭の内側）のどちらに照準を向け続けても、「乗っている」と採点の結果が同じ', () => {
    const SEED = 13904;
    const eye = rangeWorld().player.position;
    const centers = trackingCenters(SEED);
    // 胴の区域の中心と、胴の区域の外・輪郭の内側の点、頭の区域の外・輪郭の内側の点。
    const points = { 胴の区域の内: rel(0, 0), 胴の区域の外: rel(0.15, -0.2), 頭の区域の外: rel(0.065, 0.3) };
    const runs = Object.fromEntries(Object.entries(points).map(([k, p]) => [k, runTracking(SEED, aimAtEach(centers, eye, () => p))]));
    for (const [k, r] of Object.entries(runs)) {
      expect(r.rate, k).toBe(100);
      expect(r.score, k).toEqual(runs['胴の区域の内']!.score);
    }
  });

  it('フリック: 区域の線の内側と外側（輪郭の内側）のどちらに撃っても命中で、ズレの外の採点の結果が同じ', () => {
    const results: Record<string, { hits: boolean[]; metrics: unknown }> = {};
    const pts = { 区域の内: [0, 0], 区域の外: [0.15, -0.2] } as const;
    for (const [name, [x, y]] of Object.entries(pts)) {
      const run = beginFlick(13905, 'large');
      const eye = run.world.player.position;
      shootFlick(run, (_i, t) => anglesTo(eye, add(t.center, rel(x * scaleOf(t), y * scaleOf(t)))));
      const r = run.session.result!;
      const score = flickMode().scoring!.score({ shots: r.shots, duration: r.duration, modeResult: r.modeResult });
      results[name] = {
        hits: flickRecords(run).map((rec) => rec.hit),
        metrics: score.metrics.filter((m) => !m.label.includes('ズレ')).map((m) => [m.label, m.value]),
      };
    }
    expect(results['区域の内']!.hits.every(Boolean)).toBe(true);
    expect(results['区域の外']!.hits).toEqual(results['区域の内']!.hits);
    expect(results['区域の外']!.metrics).toEqual(results['区域の内']!.metrics);
  });
});
