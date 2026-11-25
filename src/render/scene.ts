import * as THREE from 'three';
import { normalizeYaw, type Angles } from '../sim/angles';
import type { Box } from '../sim/map';
import type { World } from '../sim/world';
import { DEFAULT_FOV, fieldOfView } from './fov';
import { DisplayLayer } from './layer';

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

export interface ViewSceneOptions {
  /** Apex の設定画面の FOV の値。省略すると既定の 90。 */
  fov?: number;
}

/**
 * シーンとカメラ。WebGL に依存しないので、ブラウザなしのテストでカメラと層を確かめられる。
 * World を読むだけで、書き換えない。
 * カメラは Three.js の既定（-Z を向き、Y が上）とシミュレーションの座標系が同じなので、角度をそのまま当てる。
 */
export class ViewScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** モードが表示物を足し引きする層。 */
  readonly layer = new DisplayLayer('mode-layer');
  private fov: number;
  private aspect = 1;

  constructor(world: Readonly<World>, options: ViewSceneOptions = {}) {
    this.fov = options.fov ?? DEFAULT_FOV;
    this.camera = new THREE.PerspectiveCamera(fieldOfView(this.fov, this.aspect).vertical, this.aspect, 0.05, 200);
    this.camera.rotation.order = 'YXZ';
    this.scene.background = new THREE.Color(0x1b1e24);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x333333, 2.5));

    for (const box of world.boxes) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(box.size.x, box.size.y, box.size.z),
        new THREE.MeshLambertMaterial({ color: COLORS[box.kind] }),
      );
      mesh.name = box.id;
      mesh.userData.kind = box.kind;
      mesh.position.set(box.center.x, box.center.y, box.center.z);
      this.scene.add(mesh);
    }
    this.scene.add(this.layer.group);
  }

  /** 今の FOV の値。 */
  get fovValue(): number {
    return this.fov;
  }

  /** FOV の値を変える。視野角は fieldOfView で求める（Three.js のカメラの fov は縦の視野角）。 */
  setFov(fov: number): void {
    this.fov = fov;
    this.updateProjection();
  }

  /** 画面の縦横比（幅 ÷ 高さ）を変える。 */
  setAspect(aspect: number): void {
    this.aspect = aspect;
    this.updateProjection();
  }

  /** カメラをプレイヤーの目の位置に置き、照準の向きに合わせる。 */
  update(world: Readonly<World>, view: Angles): void {
    const { position } = world.player;
    this.camera.position.set(position.x, position.y, position.z);
    // Three.js の Y 軸回りの正の回転は左向きなので、右が正のヨーは符号を反転する。
    this.camera.rotation.set(THREE.MathUtils.degToRad(view.pitch), THREE.MathUtils.degToRad(-view.yaw), 0);
    this.camera.updateMatrixWorld();
  }

  private updateProjection(): void {
    this.camera.aspect = this.aspect;
    this.camera.fov = fieldOfView(this.fov, this.aspect).vertical;
    this.camera.updateProjectionMatrix();
  }
}

/** ViewScene をキャンバスに WebGL で描画する。 */
export class SceneRenderer {
  readonly view: ViewScene;
  private readonly renderer: THREE.WebGLRenderer;

  constructor(canvas: HTMLCanvasElement, world: Readonly<World>, options: ViewSceneOptions = {}) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.view = new ViewScene(world, options);
    this.resize();
  }

  /** キャンバスの表示の大きさに合わせて描画の大きさと縦横比を直す。 */
  resize(): void {
    const { clientWidth, clientHeight } = this.renderer.domElement;
    this.renderer.setSize(clientWidth, clientHeight, false);
    this.view.setAspect(clientWidth / Math.max(clientHeight, 1));
  }

  render(world: Readonly<World>, view: Angles): void {
    this.view.update(world, view);
    this.renderer.render(this.view.scene, this.view.camera);
  }
}
