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
  PRACTICE_TARGET_PART_NAME,
  PRACTICE_TARGET_RINGS_NAME,
  TargetMarks,
} from '../../src/render/targets';
import { IMPACT_COLOR } from '../../src/render/impacts';
import { GHOST_COLOR } from '../../src/render/ghost';
import { ENVIRONMENT_COLORS, ringRadius } from '../../src/render/environment';
import { humanoidParts } from '../../src/sim/humanoid';
import { partCenter, type TargetPart } from '../../src/sim/targets';
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

/** 部分の箱の表示物の色。 */
const partColor = (group: THREE.Object3D) => (partMeshes(group)[0]!.material as THREE.MeshBasicMaterial).color.getHex();

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
    // 人形に足し直すと、6 つの部分の箱で作り直す。
    w.targets.remove('t');
    w.targets.add({ id: 't', parts: humanoidParts(1), position: vec3(1, 1.6, -10) });
    w.targets.update(2 / 120);
    marks.update(w.targets.all, 0);
    expect(partMeshes(meshes(view)[0]!)).toHaveLength(6);
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

  it('ARC-60・UI-136: シミュレーションの側で部分の箱の大きさと位置を変えた的は、表示の各部分もその大きさと位置（補間した中心からの位置）になる', () => {
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

  it('UI-136: 人形の 6 つの部分の箱は、人形の部分の箱（頭・胴・左右の腕・左右の脚）の大きさと位置で表示し、縁を地より暗い線で描く', () => {
    const w = world();
    w.targets.add({ id: 'dummy', parts: humanoidParts(0.5), position: vec3(1, 1.6, -8) });
    w.targets.update(1 / 120);
    const view = new ViewScene(w);
    const marks = new TargetMarks(view.layer);
    marks.update(w.targets.all, 0, undefined, w);
    const shown = partMeshes(meshes(view)[0]!);
    expect(shown.map((m) => m.userData.partId)).toEqual(['head', 'torso', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg']);
    shown.forEach((mesh, i) => {
      const p = humanoidParts(0.5)[i]!;
      expect(boxSize(mesh)).toEqual([p.size.x, p.size.y, p.size.z]);
      expect(mesh.position.toArray()).toEqual([p.offset.x, p.offset.y, p.offset.z]);
      const edges = mesh.children.find((c): c is THREE.LineSegments => c instanceof THREE.LineSegments)!;
      expect((edges.material as THREE.LineBasicMaterial).color.getHex()).toBe(PRACTICE_TARGET_EDGE_COLOR);
    });
  });

  it('UI-135: リングを描く的（反復練習の人形）は、正面に壁と同じ角度の式でリングと中心点を描き、中心点は開始時の照準の向きにある', () => {
    const w = world();
    // 開始時の照準（ヨー 0・ピッチ 0）のレイの上に人形の中心を置く。
    w.targets.add({ id: 'dummy', parts: humanoidParts(1), position: vec3(0, 1.6, -9.725), rings: true, keepsImpacts: true });
    w.targets.update(1 / 120);
    const view = new ViewScene(w);
    const marks = new TargetMarks(view.layer);
    marks.update(w.targets.all, 0, undefined, w);
    const [rings] = view.layer.group.children.filter((o) => o.name === PRACTICE_TARGET_RINGS_NAME);
    expect(rings).toBeDefined();
    const faces = rings!.children;
    // 照準の向きの中心は胴の正面にあり、頭・腕・脚の正面にもリングの続きを同じ中心と距離で描く。
    expect(faces.map((f) => f.name).sort()).toEqual(
      ['dummy-head', 'dummy-leftArm', 'dummy-leftLeg', 'dummy-rightArm', 'dummy-rightLeg', 'dummy-torso'].map((id) => `target-rings-${id}`).sort(),
    );
    for (const face of faces) {
      const c = face.userData.center as { x: number; y: number; z: number };
      expect([c.x, c.y]).toEqual([0, 1.6]);
      expect(c.z).toBeCloseTo(-9.725 + 0.125, 12);
      expect(face.userData.distance).toBeCloseTo(9.6, 12);
      const bands = face.userData.bands as { name: string; outer: number }[];
      expect(bands.find((b) => b.name === 'ring-1')!.outer).toBeCloseTo(ringRadius(9.6, 1 + 0.09), 12);
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
