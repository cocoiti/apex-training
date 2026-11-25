import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import range from '../../src/data/maps/range.json';
import { GHOST_ANGULAR_RADIUS, GHOST_DISTANCE, GHOST_NAME, GhostMarker } from '../../src/render/ghost';
import { ImpactMarks } from '../../src/render/impacts';
import { ViewScene } from '../../src/render/scene';
import { directionFromAngles } from '../../src/sim/angles';
import { vec3 } from '../../src/sim/vec3';
import { loadWorld, type World } from '../../src/sim/world';

function rangeWorld(): World {
  const result = loadWorld(range);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.world;
}

const eye = vec3(0, 1.6, 0);

describe('ゴーストの表示', () => {
  it('最初は隠れていて、向きを渡すと目からその向きに GHOST_DISTANCE 離れた位置に出る', () => {
    const view = new ViewScene(rangeWorld());
    const ghost = new GhostMarker(view.layer);
    expect(view.layer.group.children.filter((o) => o.name === GHOST_NAME)).toHaveLength(1);
    expect(ghost.visible).toBe(false);
    const angles = { yaw: 3, pitch: -1.5 };
    ghost.update(eye, angles);
    expect(ghost.visible).toBe(true);
    const d = directionFromAngles(angles);
    expect(ghost.mesh.position.x).toBeCloseTo(eye.x + d.x * GHOST_DISTANCE, 9);
    expect(ghost.mesh.position.y).toBeCloseTo(eye.y + d.y * GHOST_DISTANCE, 9);
    expect(ghost.mesh.position.z).toBeCloseTo(eye.z + d.z * GHOST_DISTANCE, 9);
  });

  it('壁と的より手前に置き、深度で隠されない', () => {
    const world = rangeWorld();
    const view = new ViewScene(world);
    const ghost = new GhostMarker(view.layer);
    ghost.update(eye, world.center);
    const nearest = Math.min(...world.boxes.map((b) => Math.abs(b.center.z - b.size.z / 2 - eye.z)));
    expect(GHOST_DISTANCE).toBeLessThan(nearest);
    expect((ghost.mesh.material as THREE.Material).depthTest).toBe(false);
    // 画面の中心から出したレイは、箱より先にゴーストに当たる。
    view.update(world, world.center);
    view.scene.updateMatrixWorld();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(0, 0), view.camera);
    const hits = ray.intersectObjects(view.scene.children, true);
    expect(hits[0]?.object.name).toBe(GHOST_NAME);
  });

  it('見かけの半径は GHOST_ANGULAR_RADIUS 度', () => {
    const ghost = new GhostMarker(new ViewScene(rangeWorld()).layer);
    const geometry = ghost.mesh.geometry as THREE.SphereGeometry;
    expect(THREE.MathUtils.radToDeg(Math.atan(geometry.parameters.radius / GHOST_DISTANCE))).toBeCloseTo(GHOST_ANGULAR_RADIUS, 9);
  });

  it('向きがなければ隠れ、弾痕を消してもゴーストは残る', () => {
    const view = new ViewScene(rangeWorld());
    const ghost = new GhostMarker(view.layer);
    ghost.update(eye, { yaw: 0, pitch: 0 });
    ghost.update(eye, undefined);
    expect(ghost.visible).toBe(false);
    ghost.update(eye, { yaw: 0, pitch: 0 });
    new ImpactMarks(view.layer).clear();
    expect(ghost.visible).toBe(true);
    ghost.hide();
    expect(ghost.visible).toBe(false);
  });
});
