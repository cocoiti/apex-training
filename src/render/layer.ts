import * as THREE from 'three';

/**
 * シーンに表示物を足し引きする層。弾痕・ゴーストなどはモードがここに足す。
 * 描画だけの層で、シミュレーションの状態は持たず、変えない（docs/spec/architecture.md ARC-17）。
 */
export class DisplayLayer {
  /** シーンに置く入れ物。層の表示物はすべてこの下に入る。 */
  readonly group = new THREE.Group();

  constructor(name = 'layer') {
    this.group.name = name;
  }

  /** 層にある表示物の数。 */
  get size(): number {
    return this.group.children.length;
  }

  add(object: THREE.Object3D): void {
    this.group.add(object);
  }

  remove(object: THREE.Object3D): void {
    this.group.remove(object);
  }

  /** 層を空にする。外した表示物の形と材質は捨てる。 */
  clear(): void {
    for (const object of [...this.group.children]) {
      this.group.remove(object);
      disposeTree(object);
    }
  }
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials: THREE.Material[] = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material.dispose();
  });
}
