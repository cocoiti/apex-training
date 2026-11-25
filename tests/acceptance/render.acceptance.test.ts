// docs/spec/screens.md（UI-5・UI-7・UI-8）と docs/spec/architecture.md（ARC-15 〜 ARC-17）の受け入れ条件の受け入れテスト（ブラウザなし）。
// 公開された入口（公開関数・クラス、マップの JSON）だけを使い、実装の内部には依存しない。
// 画面での確認（UI-6・UI-8 の画面・UI-9）は tests/acceptance/screens.acceptance.test.ts。
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { TimedAction } from '../../src/input/actions';
import { inputFromTimedActions } from '../../src/input/queue';
import { DEFAULT_FOV, fieldOfView, projectAngleOffset } from '../../src/render/fov';
import { interpolateAngles, ViewScene } from '../../src/render/scene';
import { directionFromAngles } from '../../src/sim/angles';
import { addRecoilOffset, viewAngles } from '../../src/sim/player';
import { Simulation } from '../../src/sim/simulation';
import { loadWorld, type World } from '../../src/sim/world';

const ROOT = resolve(__dirname, '../..');
const deg = (rad: number) => (rad * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;

function rangeWorld(): World {
  const result = loadWorld(JSON.parse(readFileSync(join(ROOT, 'src/data/maps/range.json'), 'utf8')));
  if (!result.ok) throw new Error(`range を読み込めない: ${JSON.stringify(result.errors)}`);
  return result.world;
}

/** カメラの向きをヨー・ピッチ（度、ヨーは右・ピッチは上が正）で返す。 */
function cameraAngles(camera: THREE.Camera) {
  const d = camera.getWorldDirection(new THREE.Vector3());
  return { yaw: deg(Math.atan2(d.x, -d.z)), pitch: deg(Math.asin(d.y)), dir: d };
}

/** カメラの右方向（傾き＝ロールがなければ水平）。 */
function cameraRight(camera: THREE.Camera) {
  camera.updateMatrixWorld(true);
  return new THREE.Vector3(1, 0, 0).transformDirection(camera.matrixWorld);
}

/** シーンで実際に見える（自身と祖先がすべて visible で、シーンにつながっている）か。 */
function visibleInScene(scene: THREE.Scene, object: THREE.Object3D): boolean {
  let found = false;
  scene.traverseVisible((o) => {
    if (o === object) found = true;
  });
  return found;
}

/** シミュレーションの状態の写し（比べるため）。 */
const snapshot = (world: World) => JSON.parse(JSON.stringify(world)) as unknown;

describe('UI-5: 同じ角度のズレは FOV が広いほど画面の中心に近い', () => {
  it.each([
    [1280, 720],
    [1920, 1080],
    [1024, 768],
    [800, 800],
  ])('%d x %d で水平 2 度のズレを FOV 70 と FOV 110 で換算すると、FOV 110 のほうが中心に近い', (w, h) => {
    const narrow = projectAngleOffset({ yaw: 2, pitch: 0 }, 70, w, h);
    const wide = projectAngleOffset({ yaw: 2, pitch: 0 }, 110, w, h);
    // 右のズレは右（x が正）に出て、縦には動かない。
    expect(narrow.x).toBeGreaterThan(0);
    expect(wide.x).toBeGreaterThan(0);
    expect(Math.abs(narrow.y)).toBeLessThan(1e-9);
    expect(Math.abs(wide.y)).toBeLessThan(1e-9);
    expect(Math.hypot(wide.x, wide.y)).toBeLessThan(Math.hypot(narrow.x, narrow.y));
    // SPEC の式: 幅の半分 × tan(θ) ÷ tan(水平視野角 / 2)
    for (const [fov, p] of [[70, narrow], [110, wide]] as const) {
      const hfov = fieldOfView(fov, w / h).horizontal;
      expect(p.x).toBeCloseTo(((w / 2) * Math.tan(rad(2))) / Math.tan(rad(hfov / 2)), 6);
    }
  });

  it('左のズレは左に、同じ大きさで出る（左右対称）', () => {
    const right = projectAngleOffset({ yaw: 2, pitch: 0 }, 110, 1280, 720);
    const left = projectAngleOffset({ yaw: -2, pitch: 0 }, 110, 1280, 720);
    expect(left.x).toBeCloseTo(-right.x, 9);
  });
});

describe('UI-7: FOV の値から視野角への換算', () => {
  it('FOV 90・16:9 で水平視野角は約 106.3 度、縦の視野角は約 73.7 度', () => {
    const v = fieldOfView(90, 16 / 9);
    expect(v.horizontal).toBeCloseTo(106.26, 1);
    expect(v.vertical).toBeCloseTo(73.74, 1);
    expect(Math.round(v.horizontal * 10) / 10).toBe(106.3);
    expect(Math.round(v.vertical * 10) / 10).toBe(73.7);
  });

  it('FOV 90・4:3 で水平視野角は 90 度（縦は同じく約 73.7 度）', () => {
    const v = fieldOfView(90, 4 / 3);
    expect(v.horizontal).toBeCloseTo(90, 9);
    expect(v.vertical).toBeCloseTo(73.74, 1);
  });

  it('縦の視野角は縦横比によらない', () => {
    const base = fieldOfView(90, 4 / 3).vertical;
    for (const aspect of [1, 16 / 10, 16 / 9, 21 / 9]) expect(fieldOfView(90, aspect).vertical).toBeCloseTo(base, 9);
  });
});

describe('UI-8: FOV を指定しないで 3D の表示を始めると FOV 90 から求めた視野角で描画される', () => {
  it('FOV の既定の値は 90', () => {
    expect(DEFAULT_FOV).toBe(90);
  });

  it.each([16 / 9, 4 / 3, 1280 / 800])('FOV を指定しない ViewScene のカメラは、縦横比 %f で FOV 90 から求めた縦・水平の視野角になる', (aspect) => {
    const view = new ViewScene(rangeWorld());
    view.setAspect(aspect);
    const expected = fieldOfView(90, aspect);
    // Three.js のカメラの fov は縦の視野角。
    expect(view.camera.fov).toBeCloseTo(expected.vertical, 6);
    expect(view.camera.aspect).toBeCloseTo(aspect, 9);
    const horizontal = deg(2 * Math.atan(Math.tan(rad(view.camera.fov / 2)) * view.camera.aspect));
    expect(horizontal).toBeCloseTo(expected.horizontal, 6);
  });

  it('対照: FOV 110 を指定すると FOV 90 とは違う視野角になる', () => {
    const view = new ViewScene(rangeWorld(), { fov: 110 });
    view.setAspect(16 / 9);
    expect(view.camera.fov).toBeCloseTo(fieldOfView(110, 16 / 9).vertical, 6);
    expect(view.camera.fov).not.toBeCloseTo(fieldOfView(90, 16 / 9).vertical, 1);
  });
});

describe('ARC-15: カメラはプレイヤーの目の位置に置かれ、照準の向きを向く', () => {
  it('look の入力でシミュレーションの照準をヨー 10・ピッチ 5 にして描画すると、カメラは右に 10 度・上に 5 度を向き、目の位置にある', () => {
    const world = rangeWorld();
    const actions: TimedAction[] = [{ time: 0, action: { type: 'look', yaw: 10, pitch: 5 } }];
    const sim = new Simulation(world, inputFromTimedActions(actions));
    sim.advance(0.1);
    const view = viewAngles(world.player);
    expect(view.yaw).toBeCloseTo(10, 9);
    expect(view.pitch).toBeCloseTo(5, 9);

    const scene = new ViewScene(world);
    scene.update(world, view);
    const cam = cameraAngles(scene.camera);
    expect(cam.yaw).toBeCloseTo(10, 6);
    expect(cam.pitch).toBeCloseTo(5, 6);
    // 右（+X）と上（+Y）、前（-Z）に向く。
    expect(cam.dir.x).toBeGreaterThan(0);
    expect(cam.dir.y).toBeGreaterThan(0);
    expect(cam.dir.z).toBeLessThan(0);
    const expected = directionFromAngles({ yaw: 10, pitch: 5 });
    expect(cam.dir.x).toBeCloseTo(expected.x, 6);
    expect(cam.dir.y).toBeCloseTo(expected.y, 6);
    expect(cam.dir.z).toBeCloseTo(expected.z, 6);
    // 傾いていない（右方向が水平）。
    expect(cameraRight(scene.camera).y).toBeCloseTo(0, 6);
    // 位置はプレイヤーの目の位置（range の開始位置 0, 1.6, 0）。
    expect(scene.camera.position.x).toBeCloseTo(world.player.position.x, 9);
    expect(scene.camera.position.y).toBeCloseTo(world.player.position.y, 9);
    expect(scene.camera.position.z).toBeCloseTo(world.player.position.z, 9);
    expect(world.player.position).toEqual({ x: 0, y: 1.6, z: 0 });
  });

  it('照準の向きは利用者の照準 + リコイルのオフセット（ヨー 10・ピッチ 3 + オフセットのピッチ 2 で上に 5 度）', () => {
    const world = rangeWorld();
    const sim = new Simulation(world, inputFromTimedActions([{ time: 0, action: { type: 'look', yaw: 10, pitch: 3 } }]));
    sim.advance(0.1);
    addRecoilOffset(world.player, { yaw: 0, pitch: 2 });
    const scene = new ViewScene(world);
    scene.update(world, viewAngles(world.player));
    const cam = cameraAngles(scene.camera);
    expect(cam.yaw).toBeCloseTo(10, 6);
    expect(cam.pitch).toBeCloseTo(5, 6);
  });

  it('プレイヤーの目の位置が違うマップでは、カメラもその位置に置かれる', () => {
    const result = loadWorld({
      id: 'eye',
      name: 'eye',
      spawn: { position: [3, 2.2, -4], yaw: 0, pitch: 0 },
      boxes: [{ id: 'w', kind: 'wall', center: [0, 0, -20], size: [1, 1, 1] }],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const scene = new ViewScene(result.world);
    scene.update(result.world, { yaw: 10, pitch: 5 });
    expect(scene.camera.position.toArray()).toEqual([3, 2.2, -4]);
  });
});

describe('ARC-16: カメラの向きの補間はヨーの近い側を回る', () => {
  it('直前ヨー 170・最後ヨー -170 を係数 0.5 で補間して描画すると、カメラのヨーは 180 度（真後ろ）', () => {
    const world = rangeWorld();
    const view = interpolateAngles({ yaw: 170, pitch: 0 }, { yaw: -170, pitch: 0 }, 0.5);
    // 180 と -180 は同じ向き。
    expect(Math.abs(view.yaw)).toBeCloseTo(180, 9);
    expect(view.pitch).toBeCloseTo(0, 9);
    const scene = new ViewScene(world);
    scene.update(world, view);
    const cam = cameraAngles(scene.camera);
    expect(Math.abs(cam.yaw)).toBeCloseTo(180, 6);
    // 真後ろ（+Z）を向く。遠い側を回ると 0 度（-Z）になる。
    expect(cam.dir.z).toBeCloseTo(1, 6);
    expect(cam.dir.x).toBeCloseTo(0, 6);
  });

  it('同じ組で係数 0.25 なら 175 度、0.75 なら -175 度（近い側を回る途中）', () => {
    const wrap = (y: number) => ((((y + 180) % 360) + 360) % 360) - 180;
    expect(wrap(interpolateAngles({ yaw: 170, pitch: 0 }, { yaw: -170, pitch: 0 }, 0.25).yaw)).toBeCloseTo(175, 9);
    expect(wrap(interpolateAngles({ yaw: 170, pitch: 0 }, { yaw: -170, pitch: 0 }, 0.75).yaw)).toBeCloseTo(-175, 9);
  });

  it('シミュレーションのステップの照準（170 → -170）から補間しても同じ', () => {
    const world = rangeWorld();
    const actions: TimedAction[] = [
      { time: 0, action: { type: 'look', yaw: 170, pitch: 0 } },
      { time: 0.05, action: { type: 'look', yaw: 20, pitch: 0 } },
    ];
    const sim = new Simulation(world, inputFromTimedActions(actions));
    sim.advance(0.04);
    const before = viewAngles(world.player);
    expect(before.yaw).toBeCloseTo(170, 9);
    sim.advance(0.02);
    const after = viewAngles(world.player);
    expect(after.yaw).toBeCloseTo(-170, 9);
    const scene = new ViewScene(world);
    scene.update(world, interpolateAngles(before, after, 0.5));
    expect(Math.abs(cameraAngles(scene.camera).yaw)).toBeCloseTo(180, 6);
  });
});

describe('ARC-17: 描画の層', () => {
  it('層に表示物を 1 つ足すとシーンに表示され、空にすると消え、シミュレーションの状態は変わらない', () => {
    const world = rangeWorld();
    const sim = new Simulation(world, inputFromTimedActions([{ time: 0.05, action: { type: 'look', yaw: 3, pitch: 1 } }]));
    sim.advance(0.1);
    const view = new ViewScene(world);
    view.update(world, viewAngles(world.player));
    const initial = snapshot(world);

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial({ color: 0x00ff00 }));
    expect(visibleInScene(view.scene, mesh)).toBe(false);
    view.layer.add(mesh);
    view.update(world, viewAngles(world.player));
    expect(visibleInScene(view.scene, mesh)).toBe(true);
    expect(snapshot(world)).toEqual(initial);

    view.layer.clear();
    view.update(world, viewAngles(world.player));
    expect(visibleInScene(view.scene, mesh)).toBe(false);
    expect(snapshot(world)).toEqual(initial);
  });

  it('層を操作しながら進めたシミュレーションは、層を操作しないものと同じ結果になる', () => {
    const actions: TimedAction[] = [
      { time: 0.05, action: { type: 'look', yaw: 4, pitch: -2 } },
      { time: 0.2, action: { type: 'look', yaw: -1, pitch: 3 } },
    ];
    const plain = rangeWorld();
    const plainSim = new Simulation(plain, inputFromTimedActions(actions));
    const layered = rangeWorld();
    const layeredSim = new Simulation(layered, inputFromTimedActions(actions));
    const view = new ViewScene(layered);
    for (let i = 0; i < 30; i += 1) {
      plainSim.advance(1 / 60);
      layeredSim.advance(1 / 60);
      if (i % 3 === 0) view.layer.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial()));
      if (i % 7 === 0) view.layer.clear();
      view.update(layered, viewAngles(layered.player));
      expect(snapshot(layered)).toEqual(snapshot(plain));
    }
  });
});
