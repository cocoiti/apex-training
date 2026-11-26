import * as THREE from 'three';
import { directionFromAngles, type Angles } from '../sim/angles';
import type { Box } from '../sim/map';
import type { Vec3 } from '../sim/vec3';

// 壁の表面・射撃の的・床・空の見た目（docs/spec/screens.md「3D の表示」）。描画だけのもので、当たり判定と採点には使わない。
// 表示物はレイキャストの対象から外し、マップの箱（壁・的の箱）だけがレイに当たるようにする。
// 壁のパネル・床・空・リング（と scene.ts の箱）は光の計算をしない材質（MeshBasicMaterial）で、決めた色のまま描く。
// 画面の多くを覆うので、描画を軽くする。

/** 的のリングの角度（度）。中心から 0.5 度ごとに 0.5〜3.0 度。 */
export const RING_ANGLES: readonly number[] = [0.5, 1, 1.5, 2, 2.5, 3];

/** 的の中心点の半径（度）。 */
export const CENTER_DOT_ANGLE = 0.1;

/** リングの暗い線の幅（度）。1 度ごとの太いリングと、それ以外の細いリング。 */
export const RING_WIDTH = { major: 0.18, minor: 0.1 } as const;

/** リングと中心点の縁取りの幅（度、線の片側）。 */
export const RING_OUTLINE = 0.05;

/** パネルの目地の間隔・床の格子の間隔（メートル）。 */
export const PANEL_SIZE = 1;

export const ENVIRONMENT_COLORS = {
  /** 壁の地の色（中間の明るさの灰色、画面に出る色）。パネルごとにこれから少し明るさを変える。 */
  wall: 0x74787f,
  /** 目地の線。地より暗い。 */
  joint: 0x3a3e44,
  /** 的の箱（薄い板）の色。壁より明るく、弾痕の黄とも見分けられる白に近い色。 */
  board: 0xd8d4c8,
  /** リングと中心点の暗い線。 */
  ring: 0x1d2025,
  /** リングと中心点の縁取り（白に近い色）。 */
  ringOutline: 0xf0f0ea,
  floor: 0x25292e,
  floorGrid: 0x41474f,
  /** 空の地平の色と天頂の色。上ほど明るい。 */
  skyHorizon: 0x56687c,
  skyZenith: 0xb4cde8,
} as const;

/** パネルごとの明るさの変化の幅（地の色に掛ける倍率の ±）。 */
const PANEL_SHADE = 0.06;

/** 面から目の側へ浮かせる距離（メートル）。弾痕（0.005）より奥に、面より手前に重ねる。 */
const LIFT = { panel: 0.001, joint: 0.002, outline: 0.003, ring: 0.004 } as const;

/** 床の広さ（目の位置の周りの一辺、メートル）。カメラの遠い面（200 m）より内側に収める。 */
const FLOOR_EXTENT = 200;

/** 床の格子の線を引く広さ（目の位置の周りの一辺、メートル）。遠くの線は画素より細かく詰まるだけなので、近くだけに引く。 */
const GRID_EXTENT = 60;

/** 空の球の半径（メートル）。床とカメラの遠い面より内側。 */
const SKY_RADIUS = 150;

/** 円を分ける数。リングは画面で直径 60 px ほどなので、これで十分に滑らか。 */
const ARC_SEGMENTS = 64;

type Axis = 'x' | 'y' | 'z';

/** 面の上の 2 つの軸（u は横、v は縦）。目地は u・v の小さい側の角（左下）を起点にする。 */
const FACE_AXES: Record<Axis, readonly [Axis, Axis]> = { x: ['z', 'y'], y: ['x', 'z'], z: ['x', 'y'] };

/** 箱の 1 つの面。normal の軸に垂直で、sign の向き（外向き）を向く。 */
export interface BoxFace {
  readonly box: Box;
  readonly normal: Axis;
  readonly sign: 1 | -1;
  /** 面の平面の座標（normal の軸の値）。 */
  readonly plane: number;
  readonly u: Axis;
  readonly v: Axis;
  readonly uMin: number;
  readonly uMax: number;
  readonly vMin: number;
  readonly vMax: number;
}

/** 照準の向きと交わる面の、的のリングの置き方。 */
export interface TargetFace {
  readonly face: BoxFace;
  /** 照準の向きと面が交わる点（リングの中心）。 */
  readonly center: Vec3;
  /** 目の位置から中心までの距離 D（メートル）。 */
  readonly distance: number;
}

/** リング 1 本の置き方。 */
export interface RingSpec {
  /** 中心からの角度（度）。 */
  readonly angle: number;
  /** 面の上の半径 D × tan(θ)（メートル）。 */
  readonly radius: number;
  /** 1 度ごとの太いリングか。 */
  readonly major: boolean;
}

/**
 * 面が目の位置の側を向いているか（目が面の外側にあるか）。プレイヤーは開始の位置から動かないので、
 * 目の側を向いていない面は見えることがなく、パネルを描かない。
 */
export function facesEye(face: BoxFace, eye: Vec3): boolean {
  return (eye[face.normal] - face.plane) * face.sign > 0;
}

/** 箱の 6 つの面。 */
export function boxFaces(box: Box): BoxFace[] {
  const faces: BoxFace[] = [];
  for (const normal of ['x', 'y', 'z'] as const) {
    const [u, v] = FACE_AXES[normal];
    for (const sign of [1, -1] as const) {
      faces.push({
        box,
        normal,
        sign,
        plane: box.center[normal] + (sign * box.size[normal]) / 2,
        u,
        v,
        uMin: box.center[u] - box.size[u] / 2,
        uMax: box.center[u] + box.size[u] / 2,
        vMin: box.center[v] - box.size[v] / 2,
        vMax: box.center[v] + box.size[v] / 2,
      });
    }
  }
  return faces;
}

/**
 * 目の位置から照準の向き（マップの開始時の照準）に見た、リングを描く面と中心。
 * 箱ごとに、照準の向きにいちばん沿う軸の、目の側を向いた面の平面と照準の向きが交わる点を中心にする。
 * 中心が面の外でも、面に入るリングの部分は描く（的の箱の外に出たリングは壁の面に続く）。
 */
export function targetFaces(eye: Vec3, aim: Angles, boxes: readonly Box[]): TargetFace[] {
  const dir = directionFromAngles(aim);
  const normal = (['x', 'y', 'z'] as const).reduce((a, b) => (Math.abs(dir[b]) > Math.abs(dir[a]) ? b : a));
  const sign = dir[normal] > 0 ? -1 : 1;
  const result: TargetFace[] = [];
  for (const box of boxes) {
    const face = boxFaces(box).find((f) => f.normal === normal && f.sign === sign);
    if (!face) continue;
    // 目が面の外側にあり、面が目より前にあるときだけ。
    if (!facesEye(face, eye)) continue;
    const t = (face.plane - eye[normal]) / dir[normal];
    if (!(t > 0)) continue;
    const center = { x: eye.x + dir.x * t, y: eye.y + dir.y * t, z: eye.z + dir.z * t };
    result.push({ face, center, distance: t });
  }
  return result;
}

/** 距離 D の面に描くリングの半径（D × tan(θ)）。 */
export function ringRadius(distance: number, angle: number): number {
  return distance * Math.tan(THREE.MathUtils.degToRad(angle));
}

/** 距離 D の面に描くリング。 */
export function ringSpecs(distance: number): RingSpec[] {
  return RING_ANGLES.map((angle) => ({ angle, radius: ringRadius(distance, angle), major: Number.isInteger(angle) }));
}

type Point2 = readonly [number, number];

/** 凸な多角形を面の長方形で切り取る（Sutherland–Hodgman）。 */
export function clipToRect(polygon: readonly Point2[], face: Pick<BoxFace, 'uMin' | 'uMax' | 'vMin' | 'vMax'>): Point2[] {
  // 長方形の 4 辺の内側までの符号付きの距離（内側が正）。
  const edges: ((p: Point2) => number)[] = [
    (p) => p[0] - face.uMin,
    (p) => face.uMax - p[0],
    (p) => p[1] - face.vMin,
    (p) => face.vMax - p[1],
  ];
  let out: Point2[] = [...polygon];
  for (const inside of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i += 1) {
      const a = input[i] as Point2;
      const b = input[(i + 1) % input.length] as Point2;
      const da = inside(a);
      const db = inside(b);
      if (da >= 0) out.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    if (out.length === 0) break;
  }
  return out;
}

/** 面の上の 2 次元の点（u, v）を、面から lift だけ浮かせた 3 次元の点にする。 */
function toWorld(face: BoxFace, [u, v]: Point2, lift: number): THREE.Vector3 {
  const p = new THREE.Vector3();
  p[face.normal] = face.plane + face.sign * lift;
  p[face.u] = u;
  p[face.v] = v;
  return p;
}

/** 凸な多角形を扇に分けて三角形の頂点の列にする。 */
function fan(face: BoxFace, polygon: readonly Point2[], lift: number, out: number[]): void {
  const first = polygon[0];
  if (!first || polygon.length < 3) return;
  for (let i = 1; i + 1 < polygon.length; i += 1) {
    for (const p of [first, polygon[i] as Point2, polygon[i + 1] as Point2]) out.push(...toWorld(face, p, lift).toArray());
  }
}

/** 三角形の頂点の列から形を作る。材質は両面を描くので、三角形の向きは揃えない。 */
function trianglesGeometry(positions: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** 表示物をレイキャストの対象から外す。 */
function decoration<T extends THREE.Object3D>(object: T, name: string, kind: string): T {
  object.name = name;
  object.userData.kind = kind;
  object.raycast = () => {};
  return object;
}

/** 中心 (cu, cv)・半径 inner〜outer の輪を面で切り取った三角形の頂点の列。 */
function annulus(face: BoxFace, cu: number, cv: number, inner: number, outer: number, lift: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < ARC_SEGMENTS; i += 1) {
    const a0 = (i / ARC_SEGMENTS) * Math.PI * 2;
    const a1 = ((i + 1) / ARC_SEGMENTS) * Math.PI * 2;
    const at = (r: number, a: number): Point2 => [cu + r * Math.cos(a), cv + r * Math.sin(a)];
    fan(face, clipToRect([at(inner, a0), at(outer, a0), at(outer, a1), at(inner, a1)], face), lift, out);
  }
  return out;
}

/** 中心 (cu, cv)・半径 r の塗りつぶした円を面で切り取った三角形の頂点の列。 */
function disc(face: BoxFace, cu: number, cv: number, r: number, lift: number): number[] {
  const polygon = Array.from({ length: ARC_SEGMENTS }, (_, i): Point2 => {
    const a = (i / ARC_SEGMENTS) * Math.PI * 2;
    return [cu + r * Math.cos(a), cv + r * Math.sin(a)];
  });
  const out: number[] = [];
  fan(face, clipToRect(polygon, face), lift, out);
  return out;
}

/** 的の面に描く輪（リングの線と縁取り、中心点）の 1 つ。半径はメートル。中心点は inner が 0。 */
export interface RingBand {
  readonly name: string;
  /** 中心からの角度（度）。中心点は 0。 */
  readonly angle: number;
  readonly inner: number;
  readonly outer: number;
  /** 白に近い縁取り（暗い線の下に敷く）か。 */
  readonly outline: boolean;
}

/**
 * 距離 D の面に描く輪。角度 θ のリングの暗い線は角度 θ ± 線の幅の半分の間、縁取りはその両側に RING_OUTLINE ずつ広げた間。
 * 中心点は 0.1 度の半径の円で、縁取りは RING_OUTLINE だけ大きい円。
 */
export function ringBands(distance: number): RingBand[] {
  const r = (angle: number) => ringRadius(distance, angle);
  const bands: RingBand[] = [];
  for (const ring of ringSpecs(distance)) {
    const half = (ring.major ? RING_WIDTH.major : RING_WIDTH.minor) / 2;
    const { angle } = ring;
    bands.push({ name: `ring-outline-${angle}`, angle, inner: r(angle - half - RING_OUTLINE), outer: r(angle + half + RING_OUTLINE), outline: true });
    bands.push({ name: `ring-${angle}`, angle, inner: r(angle - half), outer: r(angle + half), outline: false });
  }
  bands.push({ name: 'center-dot-outline', angle: 0, inner: 0, outer: r(CENTER_DOT_ANGLE + RING_OUTLINE), outline: true });
  bands.push({ name: 'center-dot', angle: 0, inner: 0, outer: r(CENTER_DOT_ANGLE), outline: false });
  return bands;
}

/**
 * 1 つの面に的のリングと中心点を描く。暗い線の下に、少し太い白に近い縁取りを敷く。
 * 描画を軽くするため、縁取りと暗い線をそれぞれ 1 つの形にまとめる。
 */
export function ringMarks(target: TargetFace): THREE.Group {
  const { face, center, distance } = target;
  const cu = center[face.u];
  const cv = center[face.v];
  const group = decoration(new THREE.Group(), `target-rings-${face.box.id}`, 'target-rings');
  group.userData.distance = distance;
  group.userData.center = { ...center };
  const bands = ringBands(distance);
  group.userData.bands = bands;
  for (const outline of [true, false]) {
    const lift = outline ? LIFT.outline : LIFT.ring;
    const positions: number[] = [];
    for (const band of bands.filter((b) => b.outline === outline)) {
      positions.push(...(band.inner > 0 ? annulus(face, cu, cv, band.inner, band.outer, lift) : disc(face, cu, cv, band.outer, lift)));
    }
    if (positions.length === 0) continue;
    const color = outline ? ENVIRONMENT_COLORS.ringOutline : ENVIRONMENT_COLORS.ring;
    const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    group.add(decoration(new THREE.Mesh(trianglesGeometry(positions), material), outline ? 'ring-outlines' : 'rings', 'target-ring'));
  }
  return group;
}

/** 目地の位置。起点 min から 1 メートルごと（端の max も含む）。 */
export function jointPositions(min: number, max: number): number[] {
  const out: number[] = [];
  for (let p = min; p < max - 1e-9; p += PANEL_SIZE) out.push(p);
  out.push(max);
  return out;
}

/** パネルの明るさの倍率。位置から決まる（毎回同じ見た目にする）。 */
export function panelShade(i: number, j: number, seed: number): number {
  let h = (Math.imul(i + 0x9e37, 0x85ebca6b) ^ Math.imul(j + 0x7f4a, 0xc2b2ae35) ^ Math.imul(seed + 1, 0x27d4eb2f)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  return 1 + PANEL_SHADE * (((h >>> 8) / 0xffffff) * 2 - 1);
}

/** 壁の箱の 1 つの面に、パネル（明るさを少しずつ変えた 1 メートル四方）と目地を描く。 */
function wallPanels(face: BoxFace, seed: number): THREE.Group {
  const group = decoration(new THREE.Group(), `wall-panels-${face.box.id}-${face.normal}${face.sign > 0 ? '+' : '-'}`, 'wall-panels');
  const us = jointPositions(face.uMin, face.uMax);
  const vs = jointPositions(face.vMin, face.vMax);
  const positions: number[] = [];
  const colors: number[] = [];
  const base = new THREE.Color(ENVIRONMENT_COLORS.wall);
  for (let i = 0; i + 1 < us.length; i += 1) {
    for (let j = 0; j + 1 < vs.length; j += 1) {
      const [u0, u1, v0, v1] = [us[i], us[i + 1], vs[j], vs[j + 1]] as [number, number, number, number];
      const before = positions.length;
      fan(face, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], LIFT.panel, positions);
      const color = base.clone().multiplyScalar(panelShade(i, j, seed));
      for (let k = before; k < positions.length; k += 3) colors.push(color.r, color.g, color.b);
    }
  }
  const geometry = trianglesGeometry(positions);
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  group.add(
    decoration(
      new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })),
      'panels',
      'wall-panels',
    ),
  );

  const lines: number[] = [];
  for (const u of us) lines.push(...toWorld(face, [u, face.vMin], LIFT.joint).toArray(), ...toWorld(face, [u, face.vMax], LIFT.joint).toArray());
  for (const v of vs) lines.push(...toWorld(face, [face.uMin, v], LIFT.joint).toArray(), ...toWorld(face, [face.uMax, v], LIFT.joint).toArray());
  const jointGeometry = new THREE.BufferGeometry();
  jointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  const joints = decoration(
    new THREE.LineSegments(jointGeometry, new THREE.LineBasicMaterial({ color: ENVIRONMENT_COLORS.joint })),
    'joints',
    'wall-joints',
  );
  joints.userData.u = us;
  joints.userData.v = vs;
  group.add(joints);
  return group;
}

/** 床の高さ。壁の下端（壁がなければ箱の下端、箱もなければ 0）。 */
export function floorHeight(boxes: readonly Box[]): number {
  const walls = boxes.filter((b) => b.kind === 'wall');
  const source = walls.length > 0 ? walls : boxes;
  if (source.length === 0) return 0;
  return Math.min(...source.map((b) => b.center.y - b.size.y / 2));
}

/** 床の格子の線を区切る位置（目の位置からの距離、-half〜half）。目の位置から 1, 2, 4, … メートルで区切る。 */
export function gridCuts(half: number): number[] {
  const side: number[] = [];
  for (let d = 1; d < half; d *= 2) side.push(d);
  side.push(half);
  return [...side.map((d) => -d).reverse(), 0, ...side];
}

/** 目の位置の周りに、1 メートルごとの格子の線を引いた水平な床を置く。 */
function floor(eye: Vec3, height: number): THREE.Group {
  const group = decoration(new THREE.Group(), 'floor', 'floor');
  group.userData.height = height;
  const cx = Math.round(eye.x);
  const cz = Math.round(eye.z);
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(FLOOR_EXTENT, FLOOR_EXTENT),
    new THREE.MeshBasicMaterial({ color: ENVIRONMENT_COLORS.floor }),
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.set(cx, height, cz);
  group.add(decoration(plane, 'floor-plane', 'floor'));

  const lines: number[] = [];
  const y = height + LIFT.joint;
  // 線は目の位置の近くほど短い線分に分ける（区切りは目の位置から 1, 2, 4, … メートル）。カメラの後ろへ抜ける長い線分は、
  // 描画の環境によっては丸ごと欠けるため。1 メートルごとに分けるより線分の数がずっと少なく、描画が重くならない。
  const gridHalf = GRID_EXTENT / 2;
  const cuts = gridCuts(gridHalf);
  for (let k = -gridHalf; k <= gridHalf; k += PANEL_SIZE) {
    for (let i = 0; i + 1 < cuts.length; i += 1) {
      const [a, b] = [cuts[i], cuts[i + 1]] as [number, number];
      lines.push(cx + k, y, cz + a, cx + k, y, cz + b);
      lines.push(cx + a, y, cz + k, cx + b, y, cz + k);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  group.add(
    decoration(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: ENVIRONMENT_COLORS.floorGrid })), 'floor-grid', 'floor'),
  );
  return group;
}

/** 空の色。地平（とそれより下）から天頂へ、上ほど明るくなる。up は上向きの成分（-1〜1）。 */
export function skyColor(up: number): THREE.Color {
  const t = Math.min(Math.max(up, 0), 1);
  return new THREE.Color(ENVIRONMENT_COLORS.skyHorizon).lerp(new THREE.Color(ENVIRONMENT_COLORS.skyZenith), Math.sqrt(t));
}

/**
 * 目の位置を中心とした、内側に空のグラデーションを描いた球。床（四隅でも約 141 m）より遠いので、ほかのものの後に
 * 奥行きを比べて描き、壁や床に隠れる画素は塗らない（描画を軽くする）。
 */
function sky(eye: Vec3): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(SKY_RADIUS, 32, 16);
  const position = geometry.getAttribute('position');
  const colors: number[] = [];
  for (let i = 0; i < position.count; i += 1) {
    const c = skyColor(position.getY(i) / SKY_RADIUS);
    colors.push(c.r, c.g, c.b);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false }),
  );
  mesh.position.set(eye.x, eye.y, eye.z);
  mesh.renderOrder = 1;
  return decoration(mesh, 'sky', 'sky');
}

/** 環境を作るのに読む World の部分。 */
export interface EnvironmentSource {
  readonly boxes: readonly Box[];
  /** マップの開始時の照準（採点の中心）。的のリングの中心の向き。 */
  readonly center: Angles;
  readonly player: { readonly position: Vec3 };
}

/** 壁の表面・的のリング・床・空をまとめた表示物を作る。World は読むだけで、書き換えない。 */
export function createEnvironment(world: EnvironmentSource): THREE.Group {
  const group = new THREE.Group();
  group.name = 'environment';
  const eye = world.player.position;
  group.add(sky(eye));
  group.add(floor(eye, floorHeight(world.boxes)));
  world.boxes.forEach((box, index) => {
    if (box.kind !== 'wall') return;
    for (const face of boxFaces(box).filter((f) => facesEye(f, eye))) group.add(wallPanels(face, index));
  });
  for (const target of targetFaces(eye, world.center, world.boxes)) group.add(ringMarks(target));
  return group;
}
