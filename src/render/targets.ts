import * as THREE from 'three';
import type { PracticeTarget } from '../sim/targets';
import type { Vec3 } from '../sim/vec3';
import type { DisplayLayer } from './layer';

/** 練習の的の色。壁（灰）・的の板（白に近い色）・リング（暗い色）・弾痕（黄）・ゴースト（緑）と見分けられるマゼンタ。 */
export const PRACTICE_TARGET_COLOR = 0xe040c8;

/**
 * 照準が乗っている練習の的の色（docs/spec/screens.md「3D の表示」）。乗っていないときのマゼンタ・壁・リング・弾痕・ゴースト（緑）と見分けられる水色。
 * 乗っているときに色を変える的（highlightAimed）だけに使う。
 */
export const PRACTICE_TARGET_AIMED_COLOR = 0x30c8ff;

/** 練習の的の表示物の名前。層の中で練習の的を見分けるのに使う。userData.targetId に的の識別子を持つ。 */
export const PRACTICE_TARGET_NAME = 'practice-target';

/** 直前のステップと最後のステップの位置を補間の係数で補間する。 */
export function interpolatePosition(from: Vec3, to: Vec3, alpha: number): Vec3 {
  return { x: from.x + (to.x - from.x) * alpha, y: from.y + (to.y - from.y) * alpha, z: from.z + (to.z - from.z) * alpha };
}

/**
 * 練習の的（docs/spec/screens.md「3D の表示」）を描画の層に置く。シミュレーションの的の状態を読むだけで、書き換えない（ARC-43）。
 * 出現している的だけを、的の箱の大きさで、直前のステップと最後のステップの位置を補間した位置に表示する。
 * シミュレーションからなくなった的の表示物は捨てる。
 */
export class TargetMarks {
  private readonly layer: DisplayLayer;
  private readonly meshes = new Map<string, THREE.Mesh>();

  constructor(layer: DisplayLayer) {
    this.layer = layer;
  }

  /**
   * 描画のたびに呼ぶ。targets はシミュレーションの今の練習の的、alpha は補間の係数（0 以上 1 未満）、
   * aimed は最後のステップで照準が乗っている的の識別子。乗っているときに色を変える的は、乗っているあいだ乗っているときの色にする。
   */
  update(targets: readonly PracticeTarget[], alpha: number, aimed?: string): void {
    const seen = new Set<string>();
    for (const target of targets) {
      seen.add(target.id);
      let mesh = this.meshes.get(target.id);
      // 同じ識別子で大きさの違う的が足し直された（remove のあと add した）ときは、箱を作り直す。
      if (mesh && !sameSize(mesh.userData.targetSize as Vec3, target.size)) {
        this.dispose(target.id, mesh);
        mesh = undefined;
      }
      if (!mesh) {
        mesh = createMesh(target);
        this.meshes.set(target.id, mesh);
        this.layer.add(mesh);
      }
      mesh.visible = target.visible;
      const color = target.highlightAimed && target.id === aimed ? PRACTICE_TARGET_AIMED_COLOR : PRACTICE_TARGET_COLOR;
      const material = mesh.material as THREE.MeshBasicMaterial;
      if (material.color.getHex() !== color) material.color.setHex(color);
      const p = interpolatePosition(target.previousCenter, target.center, alpha);
      mesh.position.set(p.x, p.y, p.z);
    }
    for (const [id, mesh] of this.meshes) {
      if (!seen.has(id)) this.dispose(id, mesh);
    }
  }

  /** 表示している練習の的。テストで見る。 */
  get shown(): readonly THREE.Mesh[] {
    return [...this.meshes.values()].filter((m) => m.visible);
  }

  /** 練習の的をすべて消す。次の練習の始めと練習を打ち切ったときに呼ぶ。 */
  clear(): void {
    for (const [id, mesh] of this.meshes) this.dispose(id, mesh);
  }

  private dispose(id: string, mesh: THREE.Mesh): void {
    this.layer.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    this.meshes.delete(id);
  }
}

function createMesh(target: PracticeTarget): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(target.size.x, target.size.y, target.size.z),
    new THREE.MeshBasicMaterial({ color: PRACTICE_TARGET_COLOR }),
  );
  mesh.name = PRACTICE_TARGET_NAME;
  mesh.userData.targetId = target.id;
  mesh.userData.targetSize = { x: target.size.x, y: target.size.y, z: target.size.z };
  return mesh;
}

function sameSize(a: Vec3, b: Vec3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}
