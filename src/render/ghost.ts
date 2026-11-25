import * as THREE from 'three';
import { directionFromAngles, type Angles } from '../sim/angles';
import type { Vec3 } from '../sim/vec3';
import type { DisplayLayer } from './layer';

/** 目からゴーストまでの距離（メートル）。射撃場の的（約 9.9 メートル）と壁より手前に置く。 */
export const GHOST_DISTANCE = 5;

/** ゴーストの見かけの半径（度）。距離によらず画面上で同じ大きさに見えるよう、角度で決める。 */
export const GHOST_ANGULAR_RADIUS = 0.3;

/** ゴーストの色。壁（灰）・的（赤）・弾痕（黄）・既定のクロスヘア（水色）と見分けられる緑。 */
export const GHOST_COLOR = 0x5dff7a;

/** ゴーストの表示物の名前。層の中でゴーストを見分けるのに使う。 */
export const GHOST_NAME = 'ghost';

/** 箱と弾痕より後に描き、深度で隠されないようにする順。 */
const GHOST_RENDER_ORDER = 10;

/**
 * ゴースト（docs/spec/modes.md「反復練習」）を描画の層に置く。向きを受け取って表示するだけで、シミュレーションの状態は持たず、変えない。
 * 練習ごとに 1 つを使い回し、表示しないときは隠す。
 */
export class GhostMarker {
  readonly mesh: THREE.Mesh;

  constructor(layer: DisplayLayer) {
    const radius = GHOST_DISTANCE * Math.tan(THREE.MathUtils.degToRad(GHOST_ANGULAR_RADIUS));
    // 壁と的の手前に表示する。深度の判定を外して、弾痕や箱に重なっても欠けないようにする。
    const material = new THREE.MeshBasicMaterial({ color: GHOST_COLOR, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), material);
    this.mesh.name = GHOST_NAME;
    this.mesh.renderOrder = GHOST_RENDER_ORDER;
    this.mesh.visible = false;
    layer.add(this.mesh);
  }

  get visible(): boolean {
    return this.mesh.visible;
  }

  /** 目の位置から angles の向きに GHOST_DISTANCE 離れた位置にゴーストを表示する。angles がなければ隠す。 */
  update(eye: Vec3, angles: Angles | undefined): void {
    if (!angles) {
      this.hide();
      return;
    }
    const d = directionFromAngles(angles);
    this.mesh.position.set(eye.x + d.x * GHOST_DISTANCE, eye.y + d.y * GHOST_DISTANCE, eye.z + d.z * GHOST_DISTANCE);
    this.mesh.visible = true;
  }

  hide(): void {
    this.mesh.visible = false;
  }
}
