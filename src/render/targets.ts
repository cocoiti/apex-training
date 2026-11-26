import * as THREE from 'three';
import type { Angles } from '../sim/angles';
import type { Box } from '../sim/map';
import { partCenter, type PracticeTarget, type TargetPart } from '../sim/targets';
import type { Vec3 } from '../sim/vec3';
import { ringMarks, targetFaces } from './environment';
import type { DisplayLayer } from './layer';

/** 練習の的（人形）の色。壁（灰）・的の板（白に近い色）・リング（暗い色）・弾痕（黄）・ゴースト（緑）と見分けられるマゼンタ。 */
export const PRACTICE_TARGET_COLOR = 0xe040c8;

/**
 * 照準が乗っている練習の的の色（docs/spec/screens.md「3D の表示」）。乗っていないときのマゼンタ・壁・リング・弾痕・ゴースト（緑）と見分けられる水色。
 * 乗っているときに色を変える的（highlightAimed）だけに使う。
 */
export const PRACTICE_TARGET_AIMED_COLOR = 0x30c8ff;

/** 部分の箱の縁の線の色。隣り合う部分の境目が分かるよう、地（マゼンタ・水色）より暗い色。 */
export const PRACTICE_TARGET_EDGE_COLOR = 0x3a1034;

/** 練習の的の表示物の名前。層の中で練習の的を見分けるのに使う。userData.targetId に的の識別子を持つ。 */
export const PRACTICE_TARGET_NAME = 'practice-target';

/** 練習の的の部分の箱の表示物の名前。userData.partId に部分の識別子を持つ。 */
export const PRACTICE_TARGET_PART_NAME = 'practice-target-part';

/** 練習の的の正面に描くリングと中心点の表示物の名前。userData.targetId に的の識別子を持つ。 */
export const PRACTICE_TARGET_RINGS_NAME = 'practice-target-rings';

/** 練習の的のリングの置き方を決めるもの（目の位置と、マップの開始時の照準）。 */
export interface RingView {
  readonly center: Angles;
  readonly player: { readonly position: Vec3 };
}

/** 直前のステップと最後のステップの位置を補間の係数で補間する。 */
export function interpolatePosition(from: Vec3, to: Vec3, alpha: number): Vec3 {
  return { x: from.x + (to.x - from.x) * alpha, y: from.y + (to.y - from.y) * alpha, z: from.z + (to.z - from.z) * alpha };
}

interface Shown {
  readonly group: THREE.Group;
  /** 部分の箱の地の材質。全部の部分で 1 つを共有し、乗っているときに色を変える。 */
  readonly material: THREE.MeshBasicMaterial;
  readonly parts: readonly TargetPart[];
  /** 正面のリングと中心点。描いた的の中心の位置と一緒に持ち、中心が変わったら作り直す。 */
  rings: { readonly group: THREE.Group; readonly center: Vec3 } | undefined;
}

/**
 * 練習の的（docs/spec/screens.md「3D の表示」）を描画の層に置く。シミュレーションの的の状態を読むだけで、書き換えない（ARC-43）。
 * 出現している的だけを、シミュレーションが持つ部分の箱（人形では頭・胴・腕・脚）と同じ大きさ・位置の箱の組み合わせで、
 * 直前のステップと最後のステップの位置を補間した位置に表示する。シミュレーションからなくなった的の表示物は捨てる。
 * 正面にリングを描く的（rings）は、壁と的の箱と同じ角度の式でリングと中心点を描く。
 */
export class TargetMarks {
  private readonly layer: DisplayLayer;
  private readonly shownTargets = new Map<string, Shown>();

  constructor(layer: DisplayLayer) {
    this.layer = layer;
  }

  /**
   * 描画のたびに呼ぶ。targets はシミュレーションの今の練習の的、alpha は補間の係数（0 以上 1 未満）、
   * aimed は最後のステップで照準が乗っている的の識別子。乗っているときに色を変える的は、乗っているあいだ乗っているときの色にする。
   * ringView はリングの置き方（目の位置とマップの開始時の照準）。省くとリングを描かない。
   */
  update(targets: readonly PracticeTarget[], alpha: number, aimed?: string, ringView?: RingView): void {
    const seen = new Set<string>();
    for (const target of targets) {
      seen.add(target.id);
      let shown = this.shownTargets.get(target.id);
      // 同じ識別子で形の違う的が足し直された（remove のあと add した）ときは、箱を作り直す。
      if (shown && !sameParts(shown.parts, target.parts)) {
        this.dispose(target.id, shown);
        shown = undefined;
      }
      if (!shown) {
        shown = createShown(target);
        this.shownTargets.set(target.id, shown);
        this.layer.add(shown.group);
      }
      shown.group.visible = target.visible;
      const color = target.highlightAimed && target.id === aimed ? PRACTICE_TARGET_AIMED_COLOR : PRACTICE_TARGET_COLOR;
      if (shown.material.color.getHex() !== color) shown.material.color.setHex(color);
      const p = interpolatePosition(target.previousCenter, target.center, alpha);
      shown.group.position.set(p.x, p.y, p.z);
      this.updateRings(target, shown, ringView);
    }
    for (const [id, shown] of this.shownTargets) {
      if (!seen.has(id)) this.dispose(id, shown);
    }
  }

  /** 表示している練習の的（部分の箱をまとめた入れ物）。テストで見る。 */
  get shown(): readonly THREE.Group[] {
    return [...this.shownTargets.values()].filter((s) => s.group.visible).map((s) => s.group);
  }

  /** 練習の的をすべて消す。次の練習の始めと練習を打ち切ったときに呼ぶ。 */
  clear(): void {
    for (const [id, shown] of this.shownTargets) this.dispose(id, shown);
  }

  /** リングを描く的に、最後のステップの中心の位置でリングと中心点を描く。中心が変わったら作り直す。 */
  private updateRings(target: PracticeTarget, shown: Shown, ringView: RingView | undefined): void {
    const wanted = target.rings && ringView !== undefined;
    if (shown.rings && (!wanted || !sameVec(shown.rings.center, target.center))) {
      this.layer.remove(shown.rings.group);
      disposeTree(shown.rings.group);
      shown.rings = undefined;
    }
    if (wanted && !shown.rings) {
      const group = targetRings(target, ringView);
      shown.rings = { group, center: target.center };
      this.layer.add(group);
    }
    if (shown.rings) shown.rings.group.visible = target.visible;
  }

  private dispose(id: string, shown: Shown): void {
    this.layer.remove(shown.group);
    disposeTree(shown.group);
    if (shown.rings) {
      this.layer.remove(shown.rings.group);
      disposeTree(shown.rings.group);
    }
    this.shownTargets.delete(id);
  }
}

/** 的の部分の箱を、地の箱と縁の線の組み合わせで作る。入れ物の原点が的の中心。 */
function createShown(target: PracticeTarget): Shown {
  const group = new THREE.Group();
  group.name = PRACTICE_TARGET_NAME;
  group.userData.targetId = target.id;
  const material = new THREE.MeshBasicMaterial({ color: PRACTICE_TARGET_COLOR });
  const edgeMaterial = new THREE.LineBasicMaterial({ color: PRACTICE_TARGET_EDGE_COLOR });
  for (const part of target.parts) {
    const geometry = new THREE.BoxGeometry(part.size.x, part.size.y, part.size.z);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = PRACTICE_TARGET_PART_NAME;
    mesh.userData.partId = part.id;
    mesh.position.set(part.offset.x, part.offset.y, part.offset.z);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edgeMaterial);
    edges.name = 'practice-target-edges';
    mesh.add(edges);
    group.add(mesh);
  }
  return { group, material, parts: target.parts.map((p) => ({ id: p.id, size: { ...p.size }, offset: { ...p.offset } })), rings: undefined };
}

/** 的の正面のリングと中心点。部分の箱ごとに、目の側を向いた面に壁と的の箱と同じ角度の式で描く。 */
function targetRings(target: PracticeTarget, view: RingView): THREE.Group {
  const group = new THREE.Group();
  group.name = PRACTICE_TARGET_RINGS_NAME;
  group.userData.targetId = target.id;
  const boxes: Box[] = target.parts.map((part) => ({ id: `${target.id}-${part.id}`, kind: 'target', center: partCenter(target.center, part), size: part.size }));
  for (const face of targetFaces(view.player.position, view.center, boxes)) group.add(ringMarks(face));
  return group;
}

function disposeTree(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  for (const material of materials) material.dispose();
}

function sameVec(a: Vec3, b: Vec3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function sameParts(a: readonly TargetPart[], b: readonly TargetPart[]): boolean {
  return a.length === b.length && a.every((p, i) => p.id === b[i]?.id && sameVec(p.size, b[i].size) && sameVec(p.offset, b[i].offset));
}
