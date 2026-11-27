import { directionFromAngles, type Angles } from './angles';
import type { Box } from './map';
import type { PlatePoint, PlateZone, TargetPlate } from './targets';
import { vec3, type Vec3 } from './vec3';
import type { World } from './world';

/**
 * 人型の板の的（docs/spec/architecture.md「人型の板の的」）。射撃訓練の人型の的のような、頭と肩・胴の輪郭を持つ人の上半身の形の平らな板。
 * 輪郭の位置は板の中心（胴の中心）からの相対的な位置（X が右、Y が上）。縮尺 s の板は、輪郭の頂点の位置をすべて s 倍にしたもの（厚みは変えない）。
 * 決定の理由は docs/adr/2026-11-27-humanoid-silhouette-plate.md。
 */

/** 縮尺 1 の輪郭の右半分の頂点（下から。docs/spec/architecture.md「人型の板の的」の表）。 */
const RIGHT_HALF: readonly PlatePoint[] = [
  { x: 0.225, y: -0.3 },
  { x: 0.225, y: 0.1 },
  { x: 0.17, y: 0.17 },
  { x: 0.05, y: 0.2 },
  { x: 0.05, y: 0.25 },
  { x: 0.08, y: 0.28 },
  { x: 0.08, y: 0.42 },
  { x: 0.05, y: 0.45 },
];

/** 縮尺 1 の輪郭の 16 個の頂点。右半分を下から、続けて左半分（X の符号を変えたもの）を上から並べる。 */
export const HUMANOID_OUTLINE: readonly PlatePoint[] = [...RIGHT_HALF, ...[...RIGHT_HALF].reverse().map((p) => ({ x: -p.x, y: p.y }))];

/** 縮尺 1 の板の幅（肩の外側から外側まで）と高さ（胴の下端から頭のてっぺんまで）。メートル。フリックの的の大きさは幅の見込み角で決める。 */
export const HUMANOID_WIDTH = 0.45;
export const HUMANOID_HEIGHT = 0.75;

/** 板の厚み（メートル）。縮尺によらない。 */
export const HUMANOID_THICKNESS = 0.01;

/** 縮尺 1 の区域の線（docs/spec/screens.md「3D の表示」）。頭の中心と胴の中心（板の中心）のまわりの楕円。見た目だけのもの。 */
const UNIT_ZONES: readonly PlateZone[] = [
  { id: 'head', center: { x: 0, y: 0.35 }, width: 0.1, height: 0.12 },
  { id: 'torso', center: { x: 0, y: 0 }, width: 0.15, height: 0.2 },
];

/** 縮尺 scale の人型の板。 */
export function humanoidPlate(scale = 1): TargetPlate {
  return {
    outline: HUMANOID_OUTLINE.map((p) => ({ x: p.x * scale, y: p.y * scale })),
    thickness: HUMANOID_THICKNESS,
    zones: UNIT_ZONES.map((z) => ({ id: z.id, center: { x: z.center.x * scale, y: z.center.y * scale }, width: z.width * scale, height: z.height * scale })),
  };
}

/** マップの箱のいちばん手前の面と、板の正面の面のあいだ（メートル）。 */
export const HUMANOID_GAP = 0.05;

/** 置いた板の中心の位置と縮尺。 */
export interface HumanoidPlacement {
  readonly center: Vec3;
  readonly scale: number;
  /** 目の位置から板の中心までの距離（メートル）。 */
  readonly distance: number;
}

/** マップの箱のいちばん手前（目の側、+Z）の面の Z。開始時の照準は -Z を向く（src/data/maps/range.json）。 */
function frontZ(boxes: readonly Box[]): number {
  return Math.max(...boxes.map((b) => b.center.z + b.size.z / 2));
}

/**
 * 目の位置から aim の向きのレイの上に、板の正面の面（板の中心を通る）がマップの箱のいちばん手前の面より HUMANOID_GAP 手前になるように置く。
 * 縮尺は目の位置から板の中心までの距離 L の一次式 base + perMeter × L。
 */
function placeOnRay(world: Pick<World, 'boxes' | 'player'>, aim: Angles, base: number, perMeter: number): HumanoidPlacement {
  const eye = world.player.position;
  const dir = directionFromAngles(aim);
  // 中心の Z = 手前の面 + 間 = 目の Z + dir.z × L。
  const z = frontZ(world.boxes) + HUMANOID_GAP;
  const distance = (z - eye.z) / dir.z;
  const center = vec3(eye.x + dir.x * distance, eye.y + dir.y * distance, z);
  return { center, scale: base + perMeter * distance, distance };
}

/** 縮尺 scale の人型の板を、目の位置から aim の向きのレイの上の、マップの箱より手前に置く（反復練習）。 */
export function placeHumanoid(world: Pick<World, 'boxes' | 'player'>, aim: Angles, scale = 1): HumanoidPlacement {
  return placeOnRay(world, aim, scale, 0);
}

/**
 * 板の幅の見込み角が widthAngle（度）になる縮尺の人型の板を、placeHumanoid と同じ置き方で置く（フリック）。
 * 板の幅は 2 × L × tan(見込み角 ÷ 2)（L は目の位置から板の中心まで）なので、縮尺は L に比例する。
 */
export function placeHumanoidSubtending(world: Pick<World, 'boxes' | 'player'>, aim: Angles, widthAngle: number): HumanoidPlacement {
  const perMeter = (2 * Math.tan((widthAngle * Math.PI) / 360)) / HUMANOID_WIDTH;
  return placeOnRay(world, aim, 0, perMeter);
}
