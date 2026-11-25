import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FOV, fieldOfView } from '../../src/render/fov';
import { interpolateAngles, ViewScene } from '../../src/render/scene';
import { directionFromAngles } from '../../src/sim/angles';
import { addRecoilOffset, viewAngles } from '../../src/sim/player';
import { loadWorld, type World } from '../../src/sim/world';
import range from '../../src/data/maps/range.json';

function rangeWorld(): World {
  const result = loadWorld(range);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.world;
}

function cameraDirection(view: ViewScene): THREE.Vector3 {
  return view.camera.getWorldDirection(new THREE.Vector3());
}

describe('カメラ', () => {
  it('照準の向きがヨー 10 度・ピッチ 5 度なら、カメラは右に 10 度・上に 5 度を向き、目の位置にある', () => {
    const world = rangeWorld();
    world.player.aim = { yaw: 10, pitch: 3 };
    addRecoilOffset(world.player, { yaw: 0, pitch: 2 });
    const view = new ViewScene(world);
    view.update(world, viewAngles(world.player));

    const expected = directionFromAngles({ yaw: 10, pitch: 5 });
    const dir = cameraDirection(view);
    expect(dir.x).toBeCloseTo(expected.x, 9);
    expect(dir.y).toBeCloseTo(expected.y, 9);
    expect(dir.z).toBeCloseTo(expected.z, 9);
    expect(dir.x).toBeGreaterThan(0);
    expect(dir.y).toBeGreaterThan(0);
    expect(view.camera.position.toArray()).toEqual([0, 1.6, 0]);
  });

  it('ヨー 170 度から -170 度を係数 0.5 で補間すると、カメラは真後ろ（ヨー 180 度）を向く', () => {
    const world = rangeWorld();
    const view = new ViewScene(world);
    view.update(world, interpolateAngles({ yaw: 170, pitch: 0 }, { yaw: -170, pitch: 0 }, 0.5));
    const dir = cameraDirection(view);
    expect(dir.x).toBeCloseTo(0, 9);
    expect(dir.z).toBeCloseTo(1, 9);
  });

  it('FOV を指定しないと、FOV 90 から求めた縦の視野角になる', () => {
    const view = new ViewScene(rangeWorld());
    view.setAspect(16 / 9);
    expect(view.fovValue).toBe(DEFAULT_FOV);
    expect(view.camera.fov).toBeCloseTo(fieldOfView(90, 16 / 9).vertical, 9);
    expect(view.camera.aspect).toBeCloseTo(16 / 9, 9);
  });

  it('カメラの水平視野角は換算の水平視野角と一致する', () => {
    const view = new ViewScene(rangeWorld(), { fov: 110 });
    view.setAspect(16 / 9);
    const horizontal = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(view.camera.fov / 2)) * view.camera.aspect);
    expect(THREE.MathUtils.radToDeg(horizontal)).toBeCloseTo(fieldOfView(110, 16 / 9).horizontal, 9);
    view.setFov(70);
    expect(view.camera.fov).toBeCloseTo(fieldOfView(70, 16 / 9).vertical, 9);
  });
});

describe('シーン', () => {
  it('マップの壁と的を別の色の箱で置く', () => {
    const view = new ViewScene(rangeWorld());
    const meshes = view.scene.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
    const color = (kind: string) =>
      (meshes.find((m) => m.userData.kind === kind)?.material as THREE.MeshLambertMaterial | undefined)?.color.getHex();
    expect(meshes.map((m) => m.userData.kind).sort()).toEqual(['target', 'wall']);
    expect(color('wall')).not.toBe(color('target'));
  });

  it('開始時の照準のまま画面の中心から出したレイは、最初に的に当たる', () => {
    const world = rangeWorld();
    const view = new ViewScene(world);
    view.setAspect(16 / 9);
    view.update(world, viewAngles(world.player));
    view.scene.updateMatrixWorld();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(0, 0), view.camera);
    const hits = ray.intersectObjects(view.scene.children, true);
    expect(hits[0]?.object.userData.kind).toBe('target');
    expect(hits.some((h) => h.object.userData.kind === 'wall')).toBe(true);
  });
});

describe('描画の層', () => {
  it('足した表示物はシーンに入り、層を空にすると消え、シミュレーションの状態は変わらない', () => {
    const world = rangeWorld();
    const before = structuredClone(world);
    const view = new ViewScene(world);
    const mark = new THREE.Mesh(new THREE.SphereGeometry(0.02), new THREE.MeshBasicMaterial());
    const inScene = () => {
      let found = false;
      view.scene.traverseVisible((o) => {
        if (o === mark) found = true;
      });
      return found;
    };

    view.layer.add(mark);
    expect(inScene()).toBe(true);
    expect(view.layer.size).toBe(1);
    expect(world).toEqual(before);

    view.layer.clear();
    expect(inScene()).toBe(false);
    expect(view.layer.size).toBe(0);
    expect(world).toEqual(before);
  });

  it('1 つずつ外せる', () => {
    const view = new ViewScene(rangeWorld());
    const a = new THREE.Object3D();
    const b = new THREE.Object3D();
    view.layer.add(a);
    view.layer.add(b);
    view.layer.remove(a);
    expect(view.layer.group.children).toEqual([b]);
  });
});
