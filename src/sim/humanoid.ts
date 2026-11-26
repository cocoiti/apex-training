import { directionFromAngles, type Angles } from './angles';
import type { Box } from './map';
import type { TargetPart } from './targets';
import { vec3, type Vec3 } from './vec3';
import type { World } from './world';

/**
 * 人形の的（docs/spec/architecture.md「人形の的」）。頭・胴・左右の腕・左右の脚の 6 つの部分の箱でできた、人の形の練習の的。
 * 部分の箱は軸に平行で、位置は人形の中心（胴の箱の中心）からの相対的な位置。縮尺 s の人形は、大きさと位置をすべて s 倍にしたもの。
 * 決定の理由は docs/adr/2026-11-27-humanoid-target-parts.md。
 */

/** 人形の部分の識別子。 */
export type HumanoidPartId = 'head' | 'torso' | 'rightArm' | 'leftArm' | 'rightLeg' | 'leftLeg';

/** 縮尺 1 の部分の奥行き（メートル）。前後の面はすべての部分で同じ平面にそろう。 */
export const HUMANOID_DEPTH = 0.25;

/** 縮尺 1 の胴の幅（メートル）。フリックの的の大きさは、この幅の見込み角で決める。 */
export const HUMANOID_TORSO_WIDTH = 0.5;

/** 縮尺 1 の人形の幅（腕の外側から外側まで）と高さ（脚の下端から頭の上端まで）。メートル。 */
export const HUMANOID_WIDTH = 0.82;
export const HUMANOID_HEIGHT = 1.8;

/** 縮尺 1 の部分の箱（幅・高さと、人形の中心からの位置。X が右、Y が上）。 */
const UNIT_PARTS: readonly { readonly id: HumanoidPartId; readonly width: number; readonly height: number; readonly x: number; readonly y: number }[] = [
  { id: 'head', width: 0.25, height: 0.25, x: 0, y: 0.4 },
  { id: 'torso', width: HUMANOID_TORSO_WIDTH, height: 0.55, x: 0, y: 0 },
  { id: 'rightArm', width: 0.12, height: 0.6, x: 0.35, y: -0.025 },
  { id: 'leftArm', width: 0.12, height: 0.6, x: -0.35, y: -0.025 },
  { id: 'rightLeg', width: 0.2, height: 1.0, x: 0.13, y: -0.775 },
  { id: 'leftLeg', width: 0.2, height: 1.0, x: -0.13, y: -0.775 },
];

/** 縮尺 scale の人形の部分の箱。 */
export function humanoidParts(scale = 1): TargetPart[] {
  return UNIT_PARTS.map((p) => ({
    id: p.id,
    size: vec3(p.width * scale, p.height * scale, HUMANOID_DEPTH * scale),
    offset: vec3(p.x * scale, p.y * scale, 0),
  }));
}

/** マップの箱のいちばん手前の面と、人形の後ろの面のあいだ（メートル）。 */
export const HUMANOID_GAP = 0.05;

/** 置いた人形の中心の位置と縮尺。 */
export interface HumanoidPlacement {
  readonly center: Vec3;
  readonly scale: number;
  /** 目の位置から人形の中心までの距離（メートル）。 */
  readonly distance: number;
}

/** マップの箱のいちばん手前（目の側、+Z）の面の Z。開始時の照準は -Z を向く（src/data/maps/range.json）。 */
function frontZ(boxes: readonly Box[]): number {
  return Math.max(...boxes.map((b) => b.center.z + b.size.z / 2));
}

/**
 * 目の位置から aim の向きのレイの上に、人形の後ろの面がマップの箱のいちばん手前の面より HUMANOID_GAP 手前になるように人形を置く。
 * 縮尺は目の位置から人形の中心までの距離 L の一次式 base + perMeter × L で、奥行きも縮尺で変わるので、L を一次方程式で解く。
 */
function placeOnRay(world: Pick<World, 'boxes' | 'player'>, aim: Angles, base: number, perMeter: number): HumanoidPlacement {
  const eye = world.player.position;
  const dir = directionFromAngles(aim);
  // 中心の Z = 手前の面 + 間 + 奥行きの半分（縮尺倍）= 目の Z + dir.z × L。
  const half = HUMANOID_DEPTH / 2;
  const distance = (frontZ(world.boxes) + HUMANOID_GAP + half * base - eye.z) / (dir.z - half * perMeter);
  const center = vec3(eye.x + dir.x * distance, eye.y + dir.y * distance, eye.z + dir.z * distance);
  return { center, scale: base + perMeter * distance, distance };
}

/** 縮尺 scale の人形を、目の位置から aim の向きのレイの上の、マップの箱より手前に置く（反復練習）。 */
export function placeHumanoid(world: Pick<World, 'boxes' | 'player'>, aim: Angles, scale = 1): HumanoidPlacement {
  return placeOnRay(world, aim, scale, 0);
}

/**
 * 胴の幅の見込み角が torsoAngle（度）になる縮尺の人形を、placeHumanoid と同じ置き方で置く（フリック）。
 * 胴の幅は 2 × L × tan(見込み角 ÷ 2)（L は目の位置から人形の中心まで）なので、縮尺は L に比例する。
 */
export function placeHumanoidSubtending(world: Pick<World, 'boxes' | 'player'>, aim: Angles, torsoAngle: number): HumanoidPlacement {
  const perMeter = (2 * Math.tan((torsoAngle * Math.PI) / 360)) / HUMANOID_TORSO_WIDTH;
  return placeOnRay(world, aim, 0, perMeter);
}
