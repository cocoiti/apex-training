import * as THREE from 'three';
import { normalizeYaw, type Angles } from '../sim/angles';
import type { Box } from '../sim/map';
import type { World } from '../sim/world';

const COLORS: Record<Box['kind'], number> = {
  wall: 0x5a6270,
  target: 0xe0533a,
};

/** 2 つの照準の向きの間を補間する。ヨーは近い側を回る。 */
export function interpolateAngles(from: Angles, to: Angles, alpha: number): Angles {
  const yawDelta = normalizeYaw(to.yaw - from.yaw);
  return {
    yaw: normalizeYaw(from.yaw + yawDelta * alpha),
    pitch: from.pitch + (to.pitch - from.pitch) * alpha,
  };
}

/**
 * Three.js のシーン。World を読むだけで、書き換えない。
 * カメラは Three.js の既定（-Z を向き、Y が上）とシミュレーションの座標系が同じなので、角度をそのまま当てる。
 */
export class SceneRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;

  constructor(canvas: HTMLCanvasElement, world: Readonly<World>) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 200);
    this.camera.rotation.order = 'YXZ';
    this.scene.background = new THREE.Color(0x1b1e24);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x333333, 2.5));

    for (const box of world.boxes) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(box.size.x, box.size.y, box.size.z),
        new THREE.MeshLambertMaterial({ color: COLORS[box.kind] }),
      );
      mesh.position.set(box.center.x, box.center.y, box.center.z);
      this.scene.add(mesh);
    }
    this.resize();
  }

  resize(): void {
    const { clientWidth, clientHeight } = this.renderer.domElement;
    this.renderer.setSize(clientWidth, clientHeight, false);
    this.camera.aspect = clientWidth / Math.max(clientHeight, 1);
    this.camera.updateProjectionMatrix();
  }

  render(world: Readonly<World>, view: Angles): void {
    const { position } = world.player;
    this.camera.position.set(position.x, position.y, position.z);
    // Three.js の Y 軸回りの正の回転は左向きなので、右が正のヨーは符号を反転する。
    this.camera.rotation.set(THREE.MathUtils.degToRad(view.pitch), THREE.MathUtils.degToRad(-view.yaw), 0);
    this.renderer.render(this.scene, this.camera);
  }
}
