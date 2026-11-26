import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import range from '../../src/data/maps/range.json';
import { RecordingInput } from '../../src/input/recording';
import { modes } from '../../src/modes/registry';
import { PracticeSession, replayPracticeSession } from '../../src/modes/session';
import {
  CENTER_DOT_ANGLE,
  clipToRect,
  ENVIRONMENT_COLORS,
  floorHeight,
  gridCuts,
  jointPositions,
  panelShade,
  RING_WIDTH,
  ringBands,
  ringRadius,
  ringSpecs,
  type RingBand,
  skyColor,
  targetFaces,
} from '../../src/render/environment';
import { fieldOfView } from '../../src/render/fov';
import { ImpactMarks } from '../../src/render/impacts';
import { TargetMarks } from '../../src/render/targets';
import { interpolateAngles, ViewScene } from '../../src/render/scene';
import { viewAngles } from '../../src/sim/player';
import { DEFAULT_COMMON_SETTINGS } from '../../src/ui/settings';
import type { RecoilStep, WeaponData } from '../../src/sim/weapon';
import { loadWorld, type World } from '../../src/sim/world';

function rangeWorld(): World {
  const result = loadWorld(range);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.world;
}

function zeroWeapon(): WeaponData {
  const pattern: RecoilStep[] = Array.from({ length: 10 }, () => ({ dx: 0, dy: 0 }));
  return { id: 'zero', name: 'ゼロ', category: 'AR', version: 'v', source: '仮データ', rpm: 600, magSize: 10, pattern, randomness: 0, measured: true };
}

function upwardWeapon(): WeaponData {
  const pattern: RecoilStep[] = Array.from({ length: 10 }, () => ({ dx: 0, dy: 0.5 }));
  return { id: 'up', name: '上向き', category: 'AR', version: 'v', source: '仮データ', rpm: 600, magSize: 10, pattern, randomness: 0, measured: true };
}

function recoilWeapon(): WeaponData {
  const pattern: RecoilStep[] = Array.from({ length: 12 }, (_, i) => ({ dx: ((i % 4) - 1.5) * 0.2, dy: 0.4 }));
  return { id: 'r', name: 'リコイル', category: 'AR', version: 'v', source: '仮データ', rpm: 600, magSize: 12, pattern, randomness: 0.3, measured: true };
}

const repeatMode = () => {
  const mode = modes.find((m) => m.id === 'ghost');
  if (!mode) throw new Error('反復練習のモードがない');
  return mode;
};

const byName = (root: THREE.Object3D, name: string) => {
  const found: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.name === name) found.push(o);
  });
  return found;
};

const vertices = (mesh: THREE.Object3D): THREE.Vector3[] => {
  const position = (mesh as THREE.Mesh).geometry.getAttribute('position');
  return Array.from({ length: position.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(position, i));
};

describe('射撃の的', () => {
  it('range では、開始時の照準と的の箱の正面（9.9 m）・壁の正面（10 m）が交わる点を中心にする', () => {
    const world = rangeWorld();
    const faces = targetFaces(world.player.position, world.center, world.boxes);
    const byBox = Object.fromEntries(faces.map((f) => [f.face.box.id, f]));
    expect(Object.keys(byBox).sort()).toEqual(['target', 'wall']);
    expect(byBox.target?.distance).toBeCloseTo(9.9, 9);
    expect(byBox.target?.center.z).toBeCloseTo(-9.9, 9);
    expect(byBox.wall?.distance).toBeCloseTo(10, 9);
    for (const f of faces) {
      expect(f.center.x).toBeCloseTo(0, 9);
      expect(f.center.y).toBeCloseTo(1.6, 9);
    }
  });

  it('照準が右を向いていれば、中心も右にずれる（中心は開始時の照準の向きで決まる）', () => {
    const world = rangeWorld();
    const [face] = targetFaces(world.player.position, { yaw: 5, pitch: 0 }, world.boxes.filter((b) => b.kind === 'wall'));
    expect(face?.center.x).toBeCloseTo(10 * Math.tan((5 * Math.PI) / 180), 9);
    expect(face?.distance).toBeCloseTo(10 / Math.cos((5 * Math.PI) / 180), 9);
  });

  it('角度 θ のリングの暗い線は、半径 D × tan(θ) を挟む輪で、1 度ごとのリングはほかより太い（UI-19）', () => {
    for (const distance of [9.9, 10, 25]) {
      const bands = ringBands(distance).filter((b) => !b.outline && b.angle > 0);
      expect(bands.map((b) => b.angle)).toEqual([0.5, 1, 1.5, 2, 2.5, 3]);
      for (const band of bands) {
        const radius = distance * Math.tan((band.angle * Math.PI) / 180);
        expect(ringRadius(distance, band.angle)).toBeCloseTo(radius, 12);
        expect(band.inner).toBeLessThan(radius);
        expect(band.outer).toBeGreaterThan(radius);
        // 線の幅は 0.2 度未満。
        expect(band.outer - band.inner).toBeLessThan(ringRadius(distance, 0.2));
      }
      const width = (angle: number) => {
        const band = bands.find((b) => b.angle === angle)!;
        return band.outer - band.inner;
      };
      expect(width(1)).toBeGreaterThan(width(0.5));
      expect(width(2)).toBeGreaterThan(width(1.5));
      expect(width(3)).toBeGreaterThan(width(2.5));
      // 中心点は 0.1 度の半径の円。
      expect(ringBands(distance).find((b) => b.name === 'center-dot')?.outer).toBeCloseTo(ringRadius(distance, CENTER_DOT_ANGLE), 12);
    }
    expect(ringSpecs(10).map((r) => r.major)).toEqual([false, true, false, true, false, true]);
  });

  it('壁の正面（10 m）には、開始時の照準の向きとの交点を中心に、どのリングも欠けずに描かれる（UI-19）', () => {
    const view = new ViewScene(rangeWorld());
    const [group] = byName(view.scene, 'target-rings-wall');
    expect(group?.userData.distance).toBeCloseTo(10, 9);
    const [rings] = byName(group!, 'rings');
    const bands = (group!.userData.bands as RingBand[]).filter((b) => !b.outline);
    const ds = vertices(rings!).map((v) => Math.hypot(v.x, v.y - 1.6));
    // どの頂点も、どれかの輪（リングの線か中心点）の内側と外側の間にある。
    for (const d of ds) expect(bands.some((b) => d >= b.inner - 1e-6 && d <= b.outer + 1e-6), `${d}`).toBe(true);
    // どのリングも、内側と外側の縁の頂点がある（壁の面に収まり、切り取られない）。
    for (const band of bands.filter((b) => b.angle > 0)) {
      expect(ds.some((d) => Math.abs(d - band.inner) < 1e-6), `${band.angle} 度の内側`).toBe(true);
      expect(ds.some((d) => Math.abs(d - band.outer) < 1e-6), `${band.angle} 度の外側`).toBe(true);
    }
    // 壁の正面より少し手前（目の側）にあり、弾痕（0.005 m）より奥。
    for (const v of vertices(rings!)) {
      expect(v.z).toBeGreaterThan(-10);
      expect(v.z).toBeLessThan(-10 + 0.005);
    }
  });

  it('的の箱の正面のリングは、9.9 m の半径で描き、箱の縁で切り取る', () => {
    const view = new ViewScene(rangeWorld());
    const [group] = byName(view.scene, 'target-rings-target');
    expect(group?.userData.distance).toBeCloseTo(9.9, 9);
    const [rings] = byName(group!, 'rings');
    const bands = (group!.userData.bands as RingBand[]).filter((b) => !b.outline);
    expect(bands.find((b) => b.angle === 1)?.inner).toBeCloseTo(ringRadius(9.9, 1 - RING_WIDTH.major / 2), 12);
    const vs = vertices(rings!);
    for (const v of vs) {
      expect(Math.abs(v.x)).toBeLessThanOrEqual(0.3 + 1e-6);
      expect(Math.abs(v.y - 1.6)).toBeLessThanOrEqual(0.3 + 1e-6);
      expect(v.z).toBeGreaterThan(-9.9);
      // 縁で切った点は輪の弦の上にあるので、弦のたわみ（半径の 0.12% ほど）だけ内側にずれてよい。
      const d = Math.hypot(v.x, v.y - 1.6);
      expect(bands.some((b) => d >= b.inner * (1 - 2e-3) - 1e-6 && d <= b.outer + 1e-6), `${d}`).toBe(true);
    }
    // 2 度のリング（半径約 0.35 m）は箱（半辺 0.3 m）からはみ出すので、箱の縁で切られた頂点がある。
    expect(vs.some((v) => Math.abs(Math.abs(v.x) - 0.3) < 1e-6)).toBe(true);
    // 3 度のリング（半径約 0.52 m）は箱の四隅（約 0.42 m）より外なので、箱の面には描かれない。
    const three = bands.find((b) => b.angle === 3)!;
    expect(vs.some((v) => Math.hypot(v.x, v.y - 1.6) >= three.inner - 1e-6)).toBe(false);
    // 中心点がある。
    const dot = ringRadius(9.9, CENTER_DOT_ANGLE);
    expect(vs.some((v) => Math.abs(Math.hypot(v.x, v.y - 1.6) - dot) < 1e-6)).toBe(true);
  });

  it('リングと中心点は暗い線と白に近い縁取りで、壁の地とも弾痕の黄とも違う色', () => {
    const view = new ViewScene(rangeWorld());
    const colors = new Set<number>();
    for (const group of byName(view.scene, 'target-rings-target')) {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) colors.add((o.material as THREE.MeshBasicMaterial).color.getHex());
      });
    }
    expect([...colors].sort()).toEqual([ENVIRONMENT_COLORS.ring, ENVIRONMENT_COLORS.ringOutline].sort());
    for (const c of colors) {
      expect(c).not.toBe(ENVIRONMENT_COLORS.wall);
      expect(c).not.toBe(0xffd84a);
    }
  });

  it('的の箱は赤い箱ではなく、リングを描く板の色で表示する（UI-18）', () => {
    const view = new ViewScene(rangeWorld());
    const target = view.scene.children.find((o) => o.userData.kind === 'target') as THREE.Mesh;
    const color = (target.material as THREE.MeshBasicMaterial).color;
    expect(color.getHex()).toBe(ENVIRONMENT_COLORS.board);
    expect(color.getHex()).not.toBe(0xe0533a);
    // 赤みがない（白に近く、赤が緑・青より目立って強くない。元の赤い箱は差が 0.7 ほど）。
    expect(color.r - Math.min(color.g, color.b)).toBeLessThan(0.2);
    expect(Math.min(color.r, color.g, color.b)).toBeGreaterThan(0.5);
  });
});

describe('壁の表面', () => {
  it('目地は起点から 1 メートルごとで、端も含む', () => {
    expect(jointPositions(-6, 6)).toEqual([-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6]);
    expect(jointPositions(0, 2.5)).toEqual([0, 1, 2, 2.5]);
  });

  it('range の壁の正面に、左下の角（x -6, y 0）から 1 メートルごとの目地を描く（UI-18）', () => {
    const view = new ViewScene(rangeWorld());
    const [panels] = byName(view.scene, 'wall-panels-wall-z+');
    expect(panels).toBeDefined();
    const [joints] = byName(panels!, 'joints');
    expect(joints).toBeInstanceOf(THREE.LineSegments);
    expect(joints!.userData.u).toEqual([-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6]);
    expect(joints!.userData.v).toEqual([0, 1, 2, 3, 4, 5]);
    // 線は壁の正面より少し手前（目の側）にある。
    for (const v of vertices(joints!)) {
      expect(v.z).toBeGreaterThan(-10);
      expect(v.z).toBeLessThan(-9.99);
    }
    const [mesh] = byName(panels!, 'panels');
    expect(((mesh as THREE.Mesh).material as THREE.MeshBasicMaterial).vertexColors).toBe(true);
    expect((joints as THREE.LineSegments).material).toHaveProperty('color');
    expect(((joints as THREE.LineSegments).material as THREE.LineBasicMaterial).color.getHex()).toBe(ENVIRONMENT_COLORS.joint);
  });

  it('パネルの明るさは位置ごとにわずかに違い、毎回同じ', () => {
    const shades = Array.from({ length: 12 }, (_, i) => panelShade(i, 2, 0));
    expect(new Set(shades).size).toBeGreaterThan(6);
    for (const s of shades) expect(Math.abs(s - 1)).toBeLessThanOrEqual(0.06);
    expect(panelShade(3, 4, 0)).toBe(panelShade(3, 4, 0));
  });
});

describe('床と空', () => {
  it('床は壁の下端の高さにあり、range では y 0（UI-18）', () => {
    const world = rangeWorld();
    expect(floorHeight(world.boxes)).toBe(0);
    const view = new ViewScene(world);
    const [floor] = byName(view.scene, 'floor');
    expect(floor?.userData.height).toBe(0);
    const [grid] = byName(view.scene, 'floor-grid');
    const xs = new Set(vertices(grid!).map((v) => v.x));
    // 格子の線は 1 メートルごとで、プレイヤーの足元から壁の先まで届く。
    for (const x of [-1, 0, 1, 2]) expect(xs.has(x)).toBe(true);
    const zs = vertices(grid!).map((v) => v.z);
    expect(Math.min(...zs)).toBeLessThan(-10.2);
    expect(Math.max(...zs)).toBeGreaterThan(0);
  });

  it('格子の線は目の位置の近くほど細かく区切る', () => {
    expect(gridCuts(10)).toEqual([-10, -8, -4, -2, -1, 0, 1, 2, 4, 8, 10]);
  });

  it('空は上ほど明るい', () => {
    const lum = (c: THREE.Color) => c.r + c.g + c.b;
    expect(lum(skyColor(1))).toBeGreaterThan(lum(skyColor(0.5)));
    expect(lum(skyColor(0.5))).toBeGreaterThan(lum(skyColor(0)));
    expect(skyColor(-0.5).getHex()).toBe(skyColor(0).getHex());
    const view = new ViewScene(rangeWorld());
    expect(byName(view.scene, 'sky')).toHaveLength(1);
  });

  it('床・空・壁の表面・リングはレイに当たらず、画面の中心のレイは的の箱に、その外は壁に当たる', () => {
    const world = rangeWorld();
    const view = new ViewScene(world);
    view.setAspect(16 / 9);
    view.update(world, viewAngles(world.player));
    view.scene.updateMatrixWorld();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(0, 0), view.camera);
    const hits = ray.intersectObjects(view.scene.children, true);
    const kinds = hits.map((h) => h.object.userData.kind as string);
    expect(kinds[0]).toBe('target');
    expect(kinds).toContain('wall');
    expect(new Set(kinds)).toEqual(new Set(['target', 'wall']));
  });
});

describe('切り取り', () => {
  it('長方形の中の多角形はそのまま、はみ出した部分は縁で切る', () => {
    const rect = { uMin: 0, uMax: 1, vMin: 0, vMax: 1 };
    expect(clipToRect([[0.2, 0.2], [0.8, 0.2], [0.8, 0.8]], rect)).toEqual([[0.2, 0.2], [0.8, 0.2], [0.8, 0.8]]);
    const clipped = clipToRect([[0.5, 0.5], [1.5, 0.5], [1.5, 0.8], [0.5, 0.8]], rect);
    expect(Math.max(...clipped.map((p) => p[0]))).toBe(1);
    expect(clipToRect([[2, 2], [3, 2], [3, 3]], rect)).toEqual([]);
  });
});

describe('見た目と練習の結果', () => {
  it('照準を動かさずに randomness 0・pattern がすべて 0 の武器で撃つと、弾痕は人形の正面の中心点の上にある（UI-20・MODE-63）', () => {
    const world = rangeWorld();
    const view = new ViewScene(world);
    const impacts = new ImpactMarks(view.layer);
    const marks = new TargetMarks(view.layer);
    const input = new RecordingInput(7);
    input.push(0, { type: 'fire', pressed: true });
    const session = new PracticeSession({ world, weapon: zeroWeapon(), mode: repeatMode(), input, seed: input.seed });
    for (let i = 0; i < 120 && session.gun.shots.length < 3; i += 1) session.step();
    impacts.sync(session.gun.shots, world.player.position);
    marks.update(world.targets.all, 0, undefined, world);
    // 反復練習では、開始時の照準の向きのいちばん手前の面は人形の胴の正面。リングと中心点はそこに描く。
    const [group] = byName(view.scene, 'target-rings-dummy-torso');
    const center = group!.userData.center as { x: number; y: number; z: number };
    const dot = ringRadius(group!.userData.distance as number, CENTER_DOT_ANGLE);
    expect(session.gun.shots.length).toBeGreaterThanOrEqual(3);
    for (const shot of session.gun.shots) {
      expect(shot.position).toBeDefined();
      expect(shot.target).toBe('dummy');
      expect(Math.hypot(shot.position!.x - center.x, shot.position!.y - center.y)).toBeLessThan(dot);
      expect(shot.position!.z).toBeCloseTo(center.z, 9);
    }
    // 弾痕の表示物も中心点の上（リングより手前）にある。
    const shown = view.layer.group.children.filter((o) => o.name === 'impact');
    expect(shown).toHaveLength(session.gun.shots.length);
    for (const m of shown) {
      expect(Math.hypot(m.position.x - center.x, m.position.y - center.y)).toBeLessThan(dot);
      expect(m.position.z).toBeGreaterThan(center.z + 0.004);
    }
  });

  it('randomness 0 で上向きの pattern の武器で照準を動かさずに数発撃つと、カメラが上を向き、的の中心は画面上で撃つ前より下に表示される（UI-76）', () => {
    const world = rangeWorld();
    const view = new ViewScene(world);
    view.setAspect(16 / 9);
    const [group] = byName(view.scene, 'target-rings-target');
    const c = group!.userData.center as { x: number; y: number; z: number };
    const screenY = () => {
      view.scene.updateMatrixWorld();
      return new THREE.Vector3(c.x, c.y, c.z).project(view.camera).y;
    };
    view.update(world, viewAngles(world.player));
    const before = screenY();
    expect(before).toBeCloseTo(0, 9);
    const input = new RecordingInput(3);
    input.push(0, { type: 'fire', pressed: true });
    const session = new PracticeSession({ world, weapon: upwardWeapon(), mode: repeatMode(), input, seed: input.seed });
    for (let i = 0; i < 120 && session.gun.shots.length < 4; i += 1) session.step();
    expect(session.gun.shots.length).toBeGreaterThanOrEqual(4);
    // 利用者の照準は動かず、カメラの向きはリコイルのオフセットの分だけ上を向く。
    expect(world.player.aim).toEqual(world.center);
    const angles = viewAngles(world.player);
    expect(angles.pitch).toBeGreaterThan(world.center.pitch);
    view.update(world, angles);
    expect(screenY()).toBeLessThan(before);
    // 画面の中心（クロスヘアの位置）はカメラの向きのまま。
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(view.camera.quaternion);
    expect(THREE.MathUtils.radToDeg(Math.asin(forward.y))).toBeCloseTo(angles.pitch, 9);
  });

  it('クロスヘアは画面の中心に固定され、設定画面に視点の跳ねとカメラの固定を切り替える項目はない（UI-76）', () => {
    const root = resolve(__dirname, '../..');
    const css = readFileSync(resolve(root, 'src/ui/style.css'), 'utf8');
    const rule = /\n\.crosshair \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/position: fixed;/);
    expect(rule).toMatch(/left: 50%;/);
    expect(rule).toMatch(/top: 50%;/);
    const html = readFileSync(resolve(root, 'index.html'), 'utf8');
    const form = /<form id="settings-form"[\s\S]*?<\/form>/.exec(html)?.[0] ?? '';
    expect(form).toContain('setting-fov');
    expect(form).not.toMatch(/視点の跳ね|カメラ|跳ね|リコイルの(表示|見せ方)|固定/);
    expect(Object.keys(DEFAULT_COMMON_SETTINGS).sort()).toEqual(
      ['crosshairColor', 'crosshairShape', 'fov', 'ghost', 'inputMethod', 'patternDisplay', 'sound', 'volume'].sort(),
    );
  });

  it('ads を押している間と離している間で、カメラの視野角は同じ FOV から求めた値のまま（UI-22）', () => {
    const world = rangeWorld();
    const view = new ViewScene(world, { fov: 100 });
    view.setAspect(16 / 9);
    const input = new RecordingInput(1);
    input.push(0.05, { type: 'ads', pressed: true });
    input.push(0.3, { type: 'ads', pressed: false });
    const session = new PracticeSession({ world, weapon: zeroWeapon(), mode: repeatMode(), input, seed: 1 });
    const seen = new Set<boolean>();
    for (let i = 0; i < 30; i += 1) {
      session.step();
      view.update(world, viewAngles(world.player));
      seen.add(world.player.ads);
      expect(view.camera.fov).toBeCloseTo(fieldOfView(100, 16 / 9).vertical, 12);
    }
    expect([...seen].sort()).toEqual([false, true]);
  });

  it('壁・的・床・空を描画しながら記録した練習を再生すると、弾痕の位置と採点結果が一致する（UI-23）', () => {
    const world = rangeWorld();
    const view = new ViewScene(world);
    view.setAspect(16 / 9);
    const impacts = new ImpactMarks(view.layer);
    const input = new RecordingInput(4242);
    input.push(0, { type: 'ads', pressed: true });
    input.push(0.02, { type: 'fire', pressed: true });
    for (let i = 1; i <= 20; i += 1) input.push(0.02 + i * 0.05, { type: 'look', yaw: 0.05, pitch: -0.3 });
    const weapon = recoilWeapon();
    const session = new PracticeSession({ world, weapon, mode: repeatMode(), input, seed: input.seed });
    for (let i = 0; i < 600 && !session.ended; i += 1) {
      const before = session.previousViewAngles;
      session.step();
      impacts.sync(session.gun.shots, world.player.position);
      view.update(world, interpolateAngles(before, viewAngles(world.player), 0.5));
    }
    expect(session.result).toBeDefined();
    const replayed = replayPracticeSession(input.recording(), { world: rangeWorld(), weapon, mode: repeatMode() });
    expect(replayed.result?.shots).toEqual(session.result?.shots);
    expect(replayed.result?.modeResult).toEqual(session.result?.modeResult);
    expect(session.result!.shots.length).toBe(12);
  });
});
