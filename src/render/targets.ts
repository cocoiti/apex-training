import * as THREE from 'three';
import type { Angles } from '../sim/angles';
import type { Box } from '../sim/map';
import { partCenter, type PlatePoint, type PracticeTarget, type TargetPart, type TargetPlate } from '../sim/targets';
import type { Vec3 } from '../sim/vec3';
import { ringMarks, targetFaces, type Point2 } from './environment';
import type { DisplayLayer } from './layer';

/** 練習の的（人型の板）の地の色。壁（灰）・的の板（白に近い色）・リング（暗い色）・弾痕（黄）・ゴースト（緑）と見分けられるマゼンタ。 */
export const PRACTICE_TARGET_COLOR = 0xe040c8;

/**
 * 照準が乗っている練習の的の色（docs/spec/screens.md「3D の表示」）。乗っていないときのマゼンタ・壁・リング・弾痕・ゴースト（緑）と見分けられる水色。
 * 乗っているときに色を変える的（highlightAimed）だけに使う。
 */
export const PRACTICE_TARGET_AIMED_COLOR = 0x30c8ff;

/** 部分の箱の縁の線と、板の輪郭の線の色。地（マゼンタ・水色）と壁（灰）より暗い色。 */
export const PRACTICE_TARGET_EDGE_COLOR = 0x3a1034;

/** 板の正面の区域の線の色。地（マゼンタ・水色）より暗く、輪郭の線より明るい色。見た目だけのもの。 */
export const PRACTICE_TARGET_ZONE_COLOR = 0xa83098;

/** 板の輪郭の太めの線の幅の、板の幅に対する割合。線は輪郭の内側に描き、見た目の輪郭を当たりの輪郭より大きくしない。 */
export const PLATE_OUTLINE_WIDTH_RATIO = 0.045;

/** 板の地の表示物の名前。userData.outline に輪郭の頂点（的の中心からの相対的な位置）を持つ。 */
export const PRACTICE_TARGET_PLATE_NAME = 'practice-target-plate';

/** 板の輪郭の線の表示物の名前。 */
export const PRACTICE_TARGET_OUTLINE_NAME = 'practice-target-outline';

/** 板の区域の線の表示物の名前。userData.zone に区域（中心・幅・高さ）を持つ。 */
export const PRACTICE_TARGET_ZONE_NAME = 'practice-target-zone';

/** 板の正面の上に重ねる線を、正面から目の側へ浮かせる距離（メートル）。リング（0.003〜0.004）と弾痕（0.005）より奥。 */
const PLATE_LIFT = { outline: 0.001, outlineLine: 0.0015, zone: 0.002 } as const;

/** 区域の楕円を分ける数。 */
const ZONE_SEGMENTS = 48;

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
  /** 部分の箱（板では板）の地の材質。全部の部分で 1 つを共有し、乗っているときに色を変える。 */
  readonly material: THREE.MeshBasicMaterial;
  readonly parts: readonly TargetPart[];
  readonly plate: TargetPlate | undefined;
  /** 正面のリングと中心点。描いた的の中心の位置と一緒に持ち、中心が変わったら作り直す。 */
  rings: { readonly group: THREE.Group; readonly center: Vec3 } | undefined;
}

/**
 * 練習の的（docs/spec/screens.md「3D の表示」）を描画の層に置く。シミュレーションの的の状態を読むだけで、書き換えない（ARC-43）。
 * 出現している的だけを、シミュレーションが持つ形（部分の箱と同じ大きさ・位置の箱の組み合わせ、または板の輪郭と同じ形の薄い板）で、
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
      if (shown && !(sameParts(shown.parts, target.parts) && samePlate(shown.plate, target.plate))) {
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

/** 的の形を作る。部分の箱の並びは地の箱と縁の線の組み合わせ、板は薄い板と輪郭の線と区域の線。入れ物の原点が的の中心。 */
function createShown(target: PracticeTarget): Shown {
  const group = new THREE.Group();
  group.name = PRACTICE_TARGET_NAME;
  group.userData.targetId = target.id;
  const material = new THREE.MeshBasicMaterial({ color: PRACTICE_TARGET_COLOR });
  const plate = target.plate ? copyPlate(target.plate) : undefined;
  if (plate) {
    addPlate(group, plate, material);
    return { group, material, parts: [], plate, rings: undefined };
  }
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
  return { group, material, parts: target.parts.map((p) => ({ id: p.id, size: { ...p.size }, offset: { ...p.offset } })), plate: undefined, rings: undefined };
}

/** 輪郭の回る向き（反時計回りなら 1、時計回りなら -1）。 */
function orientation(outline: readonly PlatePoint[]): 1 | -1 {
  let area = 0;
  for (let i = 0; i < outline.length; i += 1) {
    const a = outline[i] as PlatePoint;
    const b = outline[(i + 1) % outline.length] as PlatePoint;
    area += a.x * b.y - b.x * a.y;
  }
  return area >= 0 ? 1 : -1;
}

/**
 * 板を入れ物に足す。正面（+Z）が入れ物の原点の平面にあり、厚みは奥（-Z）の側にとる。
 * 輪郭は、地より暗い太めの線（輪郭の内側の帯）と、輪郭そのものの線で縁取る。区域の線は正面の上の楕円。
 */
function addPlate(group: THREE.Group, plate: TargetPlate, material: THREE.MeshBasicMaterial): void {
  const shape = new THREE.Shape(plate.outline.map((p) => new THREE.Vector2(p.x, p.y)));
  const body = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: plate.thickness, bevelEnabled: false }), material);
  body.name = PRACTICE_TARGET_PLATE_NAME;
  body.userData.outline = plate.outline.map((p) => ({ ...p }));
  body.userData.thickness = plate.thickness;
  body.position.z = -plate.thickness;
  group.add(body);

  const edgeColor = { color: PRACTICE_TARGET_EDGE_COLOR };
  const xs = plate.outline.map((p) => p.x);
  const width = (Math.max(...xs) - Math.min(...xs)) * PLATE_OUTLINE_WIDTH_RATIO;
  const sign = orientation(plate.outline);
  const positions: number[] = [];
  const z = PLATE_LIFT.outline;
  for (let i = 0; i < plate.outline.length; i += 1) {
    const a = plate.outline[i] as PlatePoint;
    const b = plate.outline[(i + 1) % plate.outline.length] as PlatePoint;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length === 0) continue;
    // 辺の内側（反時計回りの輪郭では左）へ線の幅だけずらした帯。
    const nx = (-(b.y - a.y) / length) * sign * width;
    const ny = ((b.x - a.x) / length) * sign * width;
    const quad = [a.x, a.y, b.x, b.y, b.x + nx, b.y + ny, a.x, a.y, b.x + nx, b.y + ny, a.x + nx, a.y + ny];
    for (let k = 0; k < quad.length; k += 2) positions.push(quad[k] as number, quad[k + 1] as number, z);
  }
  const bandGeometry = new THREE.BufferGeometry();
  bandGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const band = new THREE.Mesh(bandGeometry, new THREE.MeshBasicMaterial({ ...edgeColor, side: THREE.DoubleSide }));
  band.name = PRACTICE_TARGET_OUTLINE_NAME;
  group.add(band);
  const line = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(plate.outline.map((p) => new THREE.Vector3(p.x, p.y, PLATE_LIFT.outlineLine))),
    new THREE.LineBasicMaterial(edgeColor),
  );
  line.name = PRACTICE_TARGET_OUTLINE_NAME;
  group.add(line);

  for (const zone of plate.zones ?? []) {
    const points = Array.from({ length: ZONE_SEGMENTS }, (_, i) => {
      const a = (i / ZONE_SEGMENTS) * Math.PI * 2;
      return new THREE.Vector3(zone.center.x + (zone.width / 2) * Math.cos(a), zone.center.y + (zone.height / 2) * Math.sin(a), PLATE_LIFT.zone);
    });
    const ellipse = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: PRACTICE_TARGET_ZONE_COLOR }));
    ellipse.name = PRACTICE_TARGET_ZONE_NAME;
    ellipse.userData.zone = { id: zone.id, center: { ...zone.center }, width: zone.width, height: zone.height };
    group.add(ellipse);
  }
}

/** 的の正面のリングと中心点。部分の箱ごと（板では輪郭の内側）に、目の側を向いた面に壁と的の箱と同じ角度の式で描く。 */
function targetRings(target: PracticeTarget, view: RingView): THREE.Group {
  const group = new THREE.Group();
  group.name = PRACTICE_TARGET_RINGS_NAME;
  group.userData.targetId = target.id;
  if (target.plate) {
    addPlateRings(group, target, target.plate, view);
    return group;
  }
  const boxes: Box[] = target.parts.map((part) => ({ id: `${target.id}-${part.id}`, kind: 'target', center: partCenter(target.center, part), size: part.size }));
  for (const face of targetFaces(view.player.position, view.center, boxes)) group.add(ringMarks(face));
  return group;
}

/**
 * 板の正面にリングと中心点を描く。正面の面を外接する長方形の面として壁と同じ式で描き、輪郭を三角形に分けた片の内側だけに残す。
 * 目の位置から見ると、リングは板の輪郭で途切れずに後ろの壁のリングとつながる。
 */
function addPlateRings(group: THREE.Group, target: PracticeTarget, plate: TargetPlate, view: RingView): void {
  const { center } = target;
  const xs = plate.outline.map((p) => p.x);
  const ys = plate.outline.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // 正面が板の正面の面（center.z）にくる、輪郭を囲む薄い箱。
  const box: Box = {
    id: `${target.id}-plate`,
    kind: 'target',
    center: { x: center.x + (minX + maxX) / 2, y: center.y + (minY + maxY) / 2, z: center.z - plate.thickness / 2 },
    size: { x: maxX - minX, y: maxY - minY, z: plate.thickness },
  };
  const contour = plate.outline.map((p) => new THREE.Vector2(p.x, p.y));
  const pieces = THREE.ShapeUtils.triangulateShape(contour, []).map((tri) =>
    tri.map((i): Point2 => [center.x + (plate.outline[i] as PlatePoint).x, center.y + (plate.outline[i] as PlatePoint).y]),
  );
  for (const face of targetFaces(view.player.position, view.center, [box])) group.add(ringMarks(face, pieces));
}

function copyPlate(plate: TargetPlate): TargetPlate {
  const outline = plate.outline.map((p) => ({ x: p.x, y: p.y }));
  const zones = plate.zones?.map((z) => ({ ...z, center: { ...z.center } }));
  return zones ? { outline, thickness: plate.thickness, zones } : { outline, thickness: plate.thickness };
}

function samePlate(a: TargetPlate | undefined, b: TargetPlate | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const zonesA = a.zones ?? [];
  const zonesB = b.zones ?? [];
  return (
    a.thickness === b.thickness &&
    a.outline.length === b.outline.length &&
    a.outline.every((p, i) => p.x === b.outline[i]?.x && p.y === b.outline[i].y) &&
    zonesA.length === zonesB.length &&
    zonesA.every((z, i) => {
      const w = zonesB[i];
      return w !== undefined && z.id === w.id && z.center.x === w.center.x && z.center.y === w.center.y && z.width === w.width && z.height === w.height;
    })
  );
}

function disposeTree(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments || object instanceof THREE.Line)) return;
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
