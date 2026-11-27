import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { inputFromTimedActions } from '../../src/input/queue';
import { PracticeSession } from '../../src/modes/session';
import { ViewScene } from '../../src/render/scene';
import {
  interpolatePosition,
  PRACTICE_TARGET_AIMED_COLOR,
  PRACTICE_TARGET_COLOR,
  PRACTICE_TARGET_EDGE_COLOR,
  PRACTICE_TARGET_NAME,
  PRACTICE_TARGET_OUTLINE_NAME,
  PRACTICE_TARGET_PART_NAME,
  PRACTICE_TARGET_PLATE_NAME,
  PRACTICE_TARGET_RINGS_NAME,
  PRACTICE_TARGET_ZONE_COLOR,
  PRACTICE_TARGET_ZONE_NAME,
  TargetMarks,
} from '../../src/render/targets';
import { IMPACT_COLOR } from '../../src/render/impacts';
import { GHOST_COLOR } from '../../src/render/ghost';
import { ENVIRONMENT_COLORS, ringRadius } from '../../src/render/environment';
import { directionFromAngles } from '../../src/sim/angles';
import { anglesToPoint, raycastScene } from '../../src/sim/hit';
import { HUMANOID_OUTLINE, humanoidPlate } from '../../src/sim/humanoid';
import { insideOutline, partCenter, type TargetPart } from '../../src/sim/targets';
import { vec3 } from '../../src/sim/vec3';
import { createWorld, type World } from '../../src/sim/world';
import { aimMode, TARGET_SIZE } from '../helpers/aim-modes';

function world(): World {
  return createWorld({
    id: 'test',
    name: 'test',
    spawn: { position: vec3(0, 1.6, 0), aim: { yaw: 0, pitch: 0 } },
    boxes: [{ id: 'wall', kind: 'wall', center: vec3(0, 1.6, -20), size: vec3(50, 50, 0.2) }],
  });
}

const meshes = (view: ViewScene) => view.layer.group.children.filter((o): o is THREE.Group => o.name === PRACTICE_TARGET_NAME);

/** 表示している的の部分の箱。 */
const partMeshes = (group: THREE.Object3D) => group.children.filter((o): o is THREE.Mesh => o.name === PRACTICE_TARGET_PART_NAME);

/** 部分の箱の表示物の大きさ（幅・高さ・奥行き）。 */
const boxSize = (mesh: THREE.Mesh) => {
  const params = (mesh.geometry as THREE.BoxGeometry).parameters;
  return [params.width, params.height, params.depth];
};

/** 部分の箱（板では板）の表示物の地の色。 */
const partColor = (group: THREE.Object3D) =>
  ((partMeshes(group)[0] ?? plateMesh(group)!).material as THREE.MeshBasicMaterial).color.getHex();

/** 表示している板。 */
const plateMesh = (group: THREE.Object3D) => group.children.find((o): o is THREE.Mesh => o.name === PRACTICE_TARGET_PLATE_NAME);

/** 表示している板の区域の線。 */
const zoneLines = (group: THREE.Object3D) => group.children.filter((o): o is THREE.LineLoop => o.name === PRACTICE_TARGET_ZONE_NAME);

describe('練習の的の表示', () => {
  it('UI-98: 出現 1 秒・消える 2 秒の的は、0.5 秒・1.5 秒・2.5 秒に描画したうち 1.5 秒のときだけ表示されている', () => {
    const w = world();
    w.targets.add({ id: 'pop', size: TARGET_SIZE, position: vec3(0, 1.6, -10), appearAt: 1, disappearAt: 2 });
    const session = new PracticeSession({ world: w, weapon: undefined, mode: aimMode(), input: inputFromTimedActions([]), seed: 1 });
    const view = new ViewScene(w);
    const marks = new TargetMarks(view.layer);
    const shown: boolean[] = [];
    for (const until of [0.5, 1.5, 2.5]) {
      while (session.sim.time < until - 1e-9) session.step();
      marks.update(w.targets.all, 0);
      shown.push(meshes(view).some((m) => m.visible));
    }
    expect(shown).toEqual([false, true, false]);
  });

  it('的の箱の大きさで、直前のステップと最後のステップの位置を補間した位置に置く', () => {
    const w = world();
    w.targets.add({ id: 'slide', size: vec3(0.5, 2, 0.3), position: (t) => vec3(2 * t, 1.6, -10) });
    const session = new PracticeSession({ world: w, weapon: undefined, mode: aimMode(), input: inputFromTimedActions([]), seed: 1 });
    session.step();
    session.step();
    const view = new ViewScene(w);
    const marks = new TargetMarks(view.layer);
    marks.update(w.targets.all, 0.5);
    const [mesh] = meshes(view);
    const target = w.targets.get('slide')!;
    expect(mesh!.position.x).toBeCloseTo((target.previousCenter.x + target.center.x) / 2, 12);
    expect(mesh!.userData.targetId).toBe('slide');
    const [box] = partMeshes(mesh!);
    expect(boxSize(box!)).toEqual([0.5, 2, 0.3]);
    expect(box!.position.toArray()).toEqual([0, 0, 0]);
  });

  it('シミュレーションからなくなった的の表示物は捨て、clear で全部消す', () => {
    const w = world();
    w.targets.add({ id: 'a', size: TARGET_SIZE, position: vec3(0, 1.6, -10) });
    w.targets.add({ id: 'b', size: TARGET_SIZE, position: vec3(1, 1.6, -10) });
    w.targets.update(1 / 120);
    const view = new ViewScene(w);
    const marks = new TargetMarks(view.layer);
    marks.update(w.targets.all, 0);
    expect(marks.shown).toHaveLength(2);
    w.targets.remove('a');
    marks.update(w.targets.all, 0);
    expect(meshes(view).map((m) => m.userData.targetId)).toEqual(['b']);
    marks.clear();
    expect(meshes(view)).toEqual([]);
  });

  it('同じ識別子の的を大きさを変えて足し直すと、表示の箱も新しい大きさで作り直す', () => {
    const w = world();
    w.targets.add({ id: 't', size: vec3(1, 1, 1), position: vec3(0, 1.6, -10) });
    w.targets.update(1 / 120);
    const view = new ViewScene(w);
    const marks = new TargetMarks(view.layer);
    marks.update(w.targets.all, 0);
    w.targets.remove('t');
    w.targets.add({ id: 't', size: vec3(0.4, 0.6, 0.2), position: vec3(1, 1.6, -10) });
    w.targets.update(1 / 120);
    marks.update(w.targets.all, 0);
    const shown = meshes(view);
    expect(shown).toHaveLength(1);
    expect(partMeshes(shown[0]!).map(boxSize)).toEqual([[0.4, 0.6, 0.2]]);
    // 人型の板に足し直すと、板で作り直す。
    w.targets.remove('t');
    w.targets.add({ id: 't', plate: humanoidPlate(1), position: vec3(1, 1.6, -10) });
    w.targets.update(2 / 120);
    marks.update(w.targets.all, 0);
    expect(partMeshes(meshes(view)[0]!)).toHaveLength(0);
    expect(plateMesh(meshes(view)[0]!)).toBeDefined();
    // 縮尺の違う板に足し直すと、その輪郭で作り直す。
    w.targets.remove('t');
    w.targets.add({ id: 't', plate: humanoidPlate(0.5), position: vec3(1, 1.6, -10) });
    w.targets.update(3 / 120);
    marks.update(w.targets.all, 0);
    expect(meshes(view)).toHaveLength(1);
    expect(plateMesh(meshes(view)[0]!)!.userData.outline).toEqual(humanoidPlate(0.5).outline);
  });

  it('ARC-43: 練習の的を描画しても、シミュレーションの的の位置・出現と照準の当たりは描画しないときと変わらない', () => {
    const run = (draw: boolean) => {
      const w = world();
      const mode = aimMode({
        targets: (context) => {
          context.targets.add({ id: 'mover', size: TARGET_SIZE, position: (t) => vec3(Math.sin(t * 2) * 2, 1.6, -10), appearAt: 0.3, disappearAt: 1.2 });
        },
      });
      const session = new PracticeSession({
        world: w,
        weapon: undefined,
        mode,
        input: inputFromTimedActions([{ time: 0.4, action: { type: 'look', yaw: 3, pitch: 0 } }]),
        seed: 1,
      });
      const view = new ViewScene(w);
      const marks = new TargetMarks(view.layer);
      const states: string[] = [];
      for (let i = 0; i < 180; i += 1) {
        session.step();
        if (draw) {
          marks.update(w.targets.all, 0.3);
          view.update(w, w.player.aim);
        }
        states.push(JSON.stringify({ targets: w.targets.all, aimed: w.targets.aimed ?? null }));
      }
      return states;
    };
    expect(run(true)).toEqual(run(false));
  });

  it('UI-137: 色は壁・床・空・的の板・リング・弾痕・ゴーストと違い、乗っているときの色は乗っていないときの色とも違い、縁の線は地より暗い', () => {
    const others = [
      ENVIRONMENT_COLORS.wall,
      ENVIRONMENT_COLORS.joint,
      ENVIRONMENT_COLORS.floor,
      ENVIRONMENT_COLORS.floorGrid,
      ENVIRONMENT_COLORS.skyHorizon,
      ENVIRONMENT_COLORS.skyZenith,
      ENVIRONMENT_COLORS.board,
      ENVIRONMENT_COLORS.ring,
      ENVIRONMENT_COLORS.ringOutline,
      IMPACT_COLOR,
      GHOST_COLOR,
    ];
    expect(others).not.toContain(PRACTICE_TARGET_COLOR);
    expect([...others, PRACTICE_TARGET_COLOR]).not.toContain(PRACTICE_TARGET_AIMED_COLOR);
    const luminance = (hex: number) => new THREE.Color(hex).getHSL({ h: 0, s: 0, l: 0 }).l;
    expect(luminance(PRACTICE_TARGET_EDGE_COLOR)).toBeLessThan(luminance(PRACTICE_TARGET_COLOR));
    expect(luminance(PRACTICE_TARGET_EDGE_COLOR)).toBeLessThan(luminance(PRACTICE_TARGET_AIMED_COLOR));
    // 輪郭の線は地とも壁とも違う。区域の線は地より暗く、地・壁・輪郭の線と違う。
    expect([PRACTICE_TARGET_COLOR, PRACTICE_TARGET_AIMED_COLOR, ENVIRONMENT_COLORS.wall]).not.toContain(PRACTICE_TARGET_EDGE_COLOR);
    expect([PRACTICE_TARGET_COLOR, PRACTICE_TARGET_AIMED_COLOR, ENVIRONMENT_COLORS.wall, PRACTICE_TARGET_EDGE_COLOR]).not.toContain(PRACTICE_TARGET_ZONE_COLOR);
    expect(luminance(PRACTICE_TARGET_ZONE_COLOR)).toBeLessThan(luminance(PRACTICE_TARGET_COLOR));
    expect(luminance(PRACTICE_TARGET_ZONE_COLOR)).toBeLessThan(luminance(PRACTICE_TARGET_AIMED_COLOR));
  });

  it('MODE-40: 乗っているときに色を変える的は、照準が乗っているあいだ乗っているときの色にし、外すと乗っていないときの色に戻す', () => {
    const w = world();
    w.targets.add({ id: 'track', size: TARGET_SIZE, position: vec3(0, 1.6, -10), highlightAimed: true });
    w.targets.add({ id: 'plain', size: TARGET_SIZE, position: vec3(3, 1.6, -10) });
    w.targets.update(1 / 120);
    const view = new ViewScene(w);
    const marks = new TargetMarks(view.layer);
    const color = (id: string) => partColor(meshes(view).find((m) => m.userData.targetId === id)!);
    marks.update(w.targets.all, 0, 'track');
    expect(color('track')).toBe(PRACTICE_TARGET_AIMED_COLOR);
    marks.update(w.targets.all, 0, undefined);
    expect(color('track')).toBe(PRACTICE_TARGET_COLOR);
    // 色を変えない的は、乗っていても同じ色。
    marks.update(w.targets.all, 0, 'plain');
    expect(color('plain')).toBe(PRACTICE_TARGET_COLOR);
    expect(color('track')).toBe(PRACTICE_TARGET_COLOR);
  });

  it('MODE-40: 人型の板の的は、乗っているあいだ板の地を乗っているときの色にし、輪郭の線と区域の線の色は変えない', () => {
    const w = world();
    w.targets.add({ id: 'track', plate: humanoidPlate(1), position: vec3(0, 1.6, -8), highlightAimed: true });
    w.targets.update(1 / 120);
    const view = new ViewScene(w);
    const marks = new TargetMarks(view.layer);
    marks.update(w.targets.all, 0, 'track');
    const [group] = meshes(view);
    expect(partColor(group!)).toBe(PRACTICE_TARGET_AIMED_COLOR);
    const outline = group!.children.filter((o) => o.name === PRACTICE_TARGET_OUTLINE_NAME);
    expect(outline.length).toBeGreaterThan(0);
    for (const o of outline) expect(((o as THREE.Mesh).material as THREE.MeshBasicMaterial).color.getHex()).toBe(PRACTICE_TARGET_EDGE_COLOR);
    for (const z of zoneLines(group!)) expect((z.material as THREE.LineBasicMaterial).color.getHex()).toBe(PRACTICE_TARGET_ZONE_COLOR);
    marks.update(w.targets.all, 0, undefined);
    expect(partColor(group!)).toBe(PRACTICE_TARGET_COLOR);
  });

  it('ARC-66・UI-136: シミュレーションの側で部分の箱の大きさと位置を変えた的は、表示の各部分もその大きさと位置（補間した中心からの位置）になる', () => {
    const w = world();
    const parts: TargetPart[] = [
      { id: 'a', size: vec3(0.3, 0.2, 0.1), offset: vec3(0.5, -0.25, 0) },
      { id: 'b', size: vec3(0.7, 0.4, 0.15), offset: vec3(-0.2, 0.6, 0.05) },
    ];
    w.targets.add({ id: 'custom', parts, position: (t) => vec3(3 * t, 1.6, -10) });
    w.targets.update(1 / 120);
    w.targets.update(2 / 120);
    const view = new ViewScene(w);
    const marks = new TargetMarks(view.layer);
    marks.update(w.targets.all, 0.25, undefined, w);
    const target = w.targets.get('custom')!;
    const [group] = meshes(view);
    group!.updateMatrixWorld(true);
    const center = interpolatePosition(target.previousCenter, target.center, 0.25);
    const shown = partMeshes(group!);
    expect(shown.map((m) => m.userData.partId)).toEqual(['a', 'b']);
    shown.forEach((mesh, i) => {
      const p = parts[i]!;
      expect(boxSize(mesh)).toEqual([p.size.x, p.size.y, p.size.z]);
      const at = mesh.getWorldPosition(new THREE.Vector3());
      const want = partCenter(center, p);
      expect(at.x).toBeCloseTo(want.x, 12);
      expect(at.y).toBeCloseTo(want.y, 12);
      expect(at.z).toBeCloseTo(want.z, 12);
    });
    // リングを描かない的の正面にはリングがない。
    expect(view.layer.group.children.filter((o) => o.name === PRACTICE_TARGET_RINGS_NAME)).toEqual([]);
  });

  it('ARC-66・UI-136: シミュレーションの側で板の輪郭の頂点を変えた的は、表示の板もその輪郭（補間した中心からの位置）になり、正面が中心の平面で厚みは奥にとる', () => {
    const w = world();
    const outline = [
      { x: -0.3, y: -0.2 },
      { x: 0.4, y: -0.25 },
      { x: 0.1, y: 0.5 },
    ];
    w.targets.add({ id: 'tri', plate: { outline, thickness: 0.02 }, position: (t) => vec3(3 * t, 1.6, -10) });
    w.targets.update(1 / 120);
    w.targets.update(2 / 120);
    const view = new ViewScene(w);
    const marks = new TargetMarks(view.layer);
    marks.update(w.targets.all, 0.25, undefined, w);
    const target = w.targets.get('tri')!;
    const [group] = meshes(view);
    group!.updateMatrixWorld(true);
    const center = interpolatePosition(target.previousCenter, target.center, 0.25);
    const plate = plateMesh(group!)!;
    expect(plate.userData.outline).toEqual(outline);
    expect(partMeshes(group!)).toEqual([]);
    // 表示の形の頂点は、輪郭の頂点を補間した中心に置いた位置で、Z は正面（中心）から奥へ厚みまで。
    plate.geometry.computeBoundingBox();
    const box = plate.geometry.boundingBox!.clone().applyMatrix4(plate.matrixWorld);
    expect(box.min.x).toBeCloseTo(center.x - 0.3, 6);
    expect(box.max.x).toBeCloseTo(center.x + 0.4, 6);
    expect(box.min.y).toBeCloseTo(center.y - 0.25, 6);
    expect(box.max.y).toBeCloseTo(center.y + 0.5, 6);
    expect(box.max.z).toBeCloseTo(center.z, 6);
    expect(box.min.z).toBeCloseTo(center.z - 0.02, 6);
    const position = plate.geometry.getAttribute('position');
    const front = new Set<string>();
    for (let i = 0; i < position.count; i += 1) {
      const v = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(plate.matrixWorld);
      if (Math.abs(v.z - center.z) < 1e-6) front.add(`${(v.x - center.x).toFixed(6)},${(v.y - center.y).toFixed(6)}`);
    }
    expect([...front].sort()).toEqual(outline.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).sort());
    // 区域を持たない板には区域の線がなく、リングを描かない的の正面にはリングがない。
    expect(zoneLines(group!)).toEqual([]);
    expect(view.layer.group.children.filter((o) => o.name === PRACTICE_TARGET_RINGS_NAME)).toEqual([]);
  });

  it('UI-136: 人型の板は輪郭の頂点の位置で表示し、輪郭を地より暗い線（内側の太めの帯と輪郭の線）で縁取る。帯は輪郭の外に出ない', () => {
    const w = world();
    w.targets.add({ id: 'dummy', plate: humanoidPlate(0.5), position: vec3(1, 1.6, -8) });
    w.targets.update(1 / 120);
    const view = new ViewScene(w);
    const marks = new TargetMarks(view.layer);
    marks.update(w.targets.all, 0, undefined, w);
    const [group] = meshes(view);
    const outline = plateMesh(group!)!.userData.outline as { x: number; y: number }[];
    outline.forEach((p, i) => {
      expect(p.x).toBeCloseTo(HUMANOID_OUTLINE[i]!.x * 0.5, 12);
      expect(p.y).toBeCloseTo(HUMANOID_OUTLINE[i]!.y * 0.5, 12);
    });
    const lines = group!.children.filter((o) => o.name === PRACTICE_TARGET_OUTLINE_NAME);
    const band = lines.find((o): o is THREE.Mesh => o instanceof THREE.Mesh)!;
    const loop = lines.find((o): o is THREE.LineLoop => o instanceof THREE.LineLoop)!;
    expect((band.material as THREE.MeshBasicMaterial).color.getHex()).toBe(PRACTICE_TARGET_EDGE_COLOR);
    expect((loop.material as THREE.LineBasicMaterial).color.getHex()).toBe(PRACTICE_TARGET_EDGE_COLOR);
    // 帯の三角形の重心は輪郭の内側（見た目の輪郭を当たりの輪郭より大きくしない）。
    const position = band.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i += 3) {
      const cx = (position.getX(i) + position.getX(i + 1) + position.getX(i + 2)) / 3;
      const cy = (position.getY(i) + position.getY(i + 1) + position.getY(i + 2)) / 3;
      expect(insideOutline(outline, cx, cy)).toBe(true);
    }
    const loopPosition = loop.geometry.getAttribute('position');
    expect(loopPosition.count).toBe(outline.length);
  });

  it('UI-139: 人型の板の正面に、頭の中心と胴の中心のまわりの区域の楕円を縮尺に比例した大きさで描く。区域の線は当たりを変えない', () => {
    for (const scale of [1, 0.5]) {
      const w = world();
      w.targets.add({ id: 'dummy', plate: humanoidPlate(scale), position: vec3(0, 1.6, -8) });
      w.targets.update(1 / 120);
      const view = new ViewScene(w);
      const marks = new TargetMarks(view.layer);
      marks.update(w.targets.all, 0, undefined, w);
      const zones = zoneLines(meshes(view)[0]!);
      expect(zones.map((z) => z.userData.zone)).toEqual([
        { id: 'head', center: { x: 0, y: 0.35 * scale }, width: 0.1 * scale, height: 0.12 * scale },
        { id: 'torso', center: { x: 0, y: 0 }, width: 0.15 * scale, height: 0.2 * scale },
      ]);
      // 楕円の点は区域の中心から幅・高さの半分の楕円の上にあり、板の正面より手前に浮かせてある。
      for (const z of zones) {
        const { center, width, height } = z.userData.zone as { center: { x: number; y: number }; width: number; height: number };
        const position = z.geometry.getAttribute('position');
        for (let i = 0; i < position.count; i += 1) {
          const u = (position.getX(i) - center.x) / (width / 2);
          const v = (position.getY(i) - center.y) / (height / 2);
          expect(u * u + v * v).toBeCloseTo(1, 5);
          expect(position.getZ(i)).toBeGreaterThan(0);
        }
      }
      // 区域の線の内側と外側（輪郭の内側）のどちらに向けても、板に当たる。
      const target = w.targets.get('dummy')!;
      const eye = w.player.position;
      for (const [x, y] of [[0, 0], [0.1, 0], [0, 0.35], [0.07, 0.35]] as const) {
        const point = vec3(x * scale, 1.6 + y * scale, -8);
        expect(raycastScene(eye, directionFromAngles(anglesToPoint(eye, point)), w.boxes, [target])?.target?.id).toBe('dummy');
      }
    }
  });

  it('UI-135: リングを描く的（反復練習の人型の板）は、正面に壁と同じ角度の式でリングと中心点を描き、輪郭の内側だけに残す。中心点は開始時の照準の向きにある', () => {
    const w = world();
    // 開始時の照準（ヨー 0・ピッチ 0）のレイの上に板の中心を置く。
    w.targets.add({ id: 'dummy', plate: humanoidPlate(1), position: vec3(0, 1.6, -9.85), rings: true, keepsImpacts: true });
    w.targets.update(1 / 120);
    const view = new ViewScene(w);
    const marks = new TargetMarks(view.layer);
    marks.update(w.targets.all, 0, undefined, w);
    const [rings] = view.layer.group.children.filter((o) => o.name === PRACTICE_TARGET_RINGS_NAME);
    expect(rings).toBeDefined();
    const faces = rings!.children;
    expect(faces.map((f) => f.name)).toEqual(['target-rings-dummy-plate']);
    for (const face of faces) {
      const c = face.userData.center as { x: number; y: number; z: number };
      expect(c.x).toBeCloseTo(0, 12);
      expect(c.y).toBeCloseTo(1.6, 12);
      expect(c.z).toBeCloseTo(-9.85, 12);
      expect(face.userData.distance).toBeCloseTo(9.85, 12);
      const bands = face.userData.bands as { name: string; outer: number }[];
      expect(bands.find((b) => b.name === 'ring-1')!.outer).toBeCloseTo(ringRadius(9.85, 1 + 0.09), 12);
      // リングの三角形は板の輪郭の内側だけにある（輪郭の外は後ろの壁のリングが見える）。
      face.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const position = o.geometry.getAttribute('position');
        expect(position.count).toBeGreaterThan(0);
        for (let i = 0; i < position.count; i += 3) {
          const cx = (position.getX(i) + position.getX(i + 1) + position.getX(i + 2)) / 3;
          const cy = (position.getY(i) + position.getY(i + 1) + position.getY(i + 2)) / 3 - 1.6;
          expect(insideOutline(HUMANOID_OUTLINE, cx, cy)).toBe(true);
        }
      });
    }
    // リングを描く向きがなければ（ringView を渡さない）描かない。
    marks.update(w.targets.all, 0);
    expect(view.layer.group.children.filter((o) => o.name === PRACTICE_TARGET_RINGS_NAME)).toEqual([]);
    marks.update(w.targets.all, 0, undefined, w);
    marks.clear();
    expect(view.layer.group.children).toEqual([]);
  });

  it('位置の補間', () => {
    expect(interpolatePosition(vec3(0, 0, 0), vec3(2, 4, -6), 0.25)).toEqual({ x: 0.5, y: 1, z: -1.5 });
  });
});
