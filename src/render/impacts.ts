import * as THREE from 'three';
import type { ShotRecord } from '../sim/gun';
import type { Vec3 } from '../sim/vec3';
import type { DisplayLayer } from './layer';

/** 弾痕の半径（メートル）。 */
export const IMPACT_RADIUS = 0.025;

/** 弾痕を箱の面から目の側へ浮かせる距離（メートル）。面と同じ深さで描いてちらつかないようにする。 */
export const IMPACT_LIFT = 0.005;

/** 弾痕の色。壁（灰）とも的（赤）とも見分けられる黄。 */
export const IMPACT_COLOR = 0xffd84a;

/** 弾痕の表示物の名前。層の中で弾痕を見分けるのに使う。 */
export const IMPACT_NAME = 'impact';

/**
 * 弾痕を描画の層に足す（docs/spec/modes.md「共通」）。シミュレーションの弾の記録を読むだけで、書き換えない。
 * 一度足した弾痕は clear するまで残る。どの箱にも当たらなかった弾（位置なし）は表示しない。
 */
export class ImpactMarks {
  private readonly layer: DisplayLayer;
  /** 表示した弾の数（弾の記録の先頭から、外れも含めて）。 */
  private synced = 0;

  constructor(layer: DisplayLayer) {
    this.layer = layer;
  }

  /** 弾の記録のうち、まだ表示していない弾の弾痕を足す。eye は目の位置で、弾痕をその向きに向ける。 */
  sync(shots: readonly ShotRecord[], eye: Vec3): void {
    for (; this.synced < shots.length; this.synced += 1) {
      const position = shots[this.synced]?.position;
      if (position) this.layer.add(createMark(position, eye));
    }
  }

  /** 弾痕をすべて消す。次の練習の始めに呼ぶ。 */
  clear(): void {
    for (const object of this.layer.group.children.filter((o) => o.name === IMPACT_NAME)) {
      this.layer.remove(object);
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        (object.material as THREE.Material).dispose();
      }
    }
    this.synced = 0;
  }
}

function createMark(position: Vec3, eye: Vec3): THREE.Mesh {
  const mark = new THREE.Mesh(
    new THREE.CircleGeometry(IMPACT_RADIUS, 12),
    new THREE.MeshBasicMaterial({ color: IMPACT_COLOR }),
  );
  mark.name = IMPACT_NAME;
  const toEye = new THREE.Vector3(eye.x - position.x, eye.y - position.y, eye.z - position.z).normalize();
  mark.position.set(position.x, position.y, position.z).addScaledVector(toEye, IMPACT_LIFT);
  // 円は +Z を向くので、目の位置へ向ける。
  mark.lookAt(eye.x, eye.y, eye.z);
  return mark;
}
