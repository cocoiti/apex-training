import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { inputFromTimedActions } from '../../src/input/queue';
import { PracticeSession } from '../../src/modes/session';
import { ViewScene } from '../../src/render/scene';
import { interpolatePosition, PRACTICE_TARGET_AIMED_COLOR, PRACTICE_TARGET_COLOR, PRACTICE_TARGET_NAME, TargetMarks } from '../../src/render/targets';
import { IMPACT_COLOR } from '../../src/render/impacts';
import { GHOST_COLOR } from '../../src/render/ghost';
import { ENVIRONMENT_COLORS } from '../../src/render/environment';
import { vec3 } from '../../src/sim/vec3';
import { createWorld, type World } from '../../src/sim/world';
import { aimMode, TARGET_SIZE } from '../helpers/aim-modes';

function world(): World {
  return createWorld({
    id: 'test',
    name: 'test',
    spawn: { position: vec3(0, 1.6, 0), aim: { yaw: 0, pitch: 0 } },
    boxes: [{ id: 'wall', kind: 'wall', center: vec3(0, 1.6, -20), size: vec3(50, 50, 0.2) }],
  });
}

const meshes = (view: ViewScene) => view.layer.group.children.filter((o): o is THREE.Mesh => o.name === PRACTICE_TARGET_NAME);

describe('練習の的の表示', () => {
  it('UI-98: 出現 1 秒・消える 2 秒の的は、0.5 秒・1.5 秒・2.5 秒に描画したうち 1.5 秒のときだけ表示されている', () => {
    const w = world();
    w.targets.add({ id: 'pop', size: TARGET_SIZE, position: vec3(0, 1.6, -10), appearAt: 1, disappearAt: 2 });
    const session = new PracticeSession({ world: w, weapon: undefined, mode: aimMode(), input: inputFromTimedActions([]), seed: 1 });
    const view = new ViewScene(w);
    const marks = new TargetMarks(view.layer);
    const shown: boolean[] = [];
    for (const until of [0.5, 1.5, 2.5]) {
      while (session.sim.time < until - 1e-9) session.step();
      marks.update(w.targets.all, 0);
      shown.push(meshes(view).some((m) => m.visible));
    }
    expect(shown).toEqual([false, true, false]);
  });

  it('的の箱の大きさで、直前のステップと最後のステップの位置を補間した位置に置く', () => {
    const w = world();
    w.targets.add({ id: 'slide', size: vec3(0.5, 2, 0.3), position: (t) => vec3(2 * t, 1.6, -10) });
    const session = new PracticeSession({ world: w, weapon: undefined, mode: aimMode(), input: inputFromTimedActions([]), seed: 1 });
    session.step();
    session.step();
    const view = new ViewScene(w);
    const marks = new TargetMarks(view.layer);
    marks.update(w.targets.all, 0.5);
    const [mesh] = meshes(view);
    const target = w.targets.get('slide')!;
    expect(mesh!.position.x).toBeCloseTo((target.previousCenter.x + target.center.x) / 2, 12);
    expect(mesh!.userData.targetId).toBe('slide');
    const params = (mesh!.geometry as THREE.BoxGeometry).parameters;
    expect([params.width, params.height, params.depth]).toEqual([0.5, 2, 0.3]);
  });

  it('シミュレーションからなくなった的の表示物は捨て、clear で全部消す', () => {
    const w = world();
    w.targets.add({ id: 'a', size: TARGET_SIZE, position: vec3(0, 1.6, -10) });
    w.targets.add({ id: 'b', size: TARGET_SIZE, position: vec3(1, 1.6, -10) });
    w.targets.update(1 / 120);
    const view = new ViewScene(w);
    const marks = new TargetMarks(view.layer);
    marks.update(w.targets.all, 0);
    expect(marks.shown).toHaveLength(2);
    w.targets.remove('a');
    marks.update(w.targets.all, 0);
    expect(meshes(view).map((m) => m.userData.targetId)).toEqual(['b']);
    marks.clear();
    expect(meshes(view)).toEqual([]);
  });

  it('同じ識別子の的を大きさを変えて足し直すと、表示の箱も新しい大きさで作り直す', () => {
    const w = world();
    w.targets.add({ id: 't', size: vec3(1, 1, 1), position: vec3(0, 1.6, -10) });
    w.targets.update(1 / 120);
    const view = new ViewScene(w);
    const marks = new TargetMarks(view.layer);
    marks.update(w.targets.all, 0);
    w.targets.remove('t');
    w.targets.add({ id: 't', size: vec3(0.4, 0.6, 0.2), position: vec3(1, 1.6, -10) });
    w.targets.update(1 / 120);
    marks.update(w.targets.all, 0);
    const shown = meshes(view);
    expect(shown).toHaveLength(1);
    const params = (shown[0]!.geometry as THREE.BoxGeometry).parameters;
    expect([params.width, params.height, params.depth]).toEqual([0.4, 0.6, 0.2]);
  });

  it('ARC-43: 練習の的を描画しても、シミュレーションの的の位置・出現と照準の当たりは描画しないときと変わらない', () => {
    const run = (draw: boolean) => {
      const w = world();
      const mode = aimMode({
        targets: (context) => {
          context.targets.add({ id: 'mover', size: TARGET_SIZE, position: (t) => vec3(Math.sin(t * 2) * 2, 1.6, -10), appearAt: 0.3, disappearAt: 1.2 });
        },
      });
      const session = new PracticeSession({
        world: w,
        weapon: undefined,
        mode,
        input: inputFromTimedActions([{ time: 0.4, action: { type: 'look', yaw: 3, pitch: 0 } }]),
        seed: 1,
      });
      const view = new ViewScene(w);
      const marks = new TargetMarks(view.layer);
      const states: string[] = [];
      for (let i = 0; i < 180; i += 1) {
        session.step();
        if (draw) {
          marks.update(w.targets.all, 0.3);
          view.update(w, w.player.aim);
        }
        states.push(JSON.stringify({ targets: w.targets.all, aimed: w.targets.aimed ?? null }));
      }
      return states;
    };
    expect(run(true)).toEqual(run(false));
  });

  it('色は壁・的の板・リング・弾痕・ゴーストと違い、乗っているときの色は乗っていないときの色とも違う', () => {
    const others = [ENVIRONMENT_COLORS.wall, ENVIRONMENT_COLORS.board, ENVIRONMENT_COLORS.ring, IMPACT_COLOR, GHOST_COLOR];
    expect(others).not.toContain(PRACTICE_TARGET_COLOR);
    expect([...others, PRACTICE_TARGET_COLOR]).not.toContain(PRACTICE_TARGET_AIMED_COLOR);
  });

  it('MODE-40: 乗っているときに色を変える的は、照準が乗っているあいだ乗っているときの色にし、外すと乗っていないときの色に戻す', () => {
    const w = world();
    w.targets.add({ id: 'track', size: TARGET_SIZE, position: vec3(0, 1.6, -10), highlightAimed: true });
    w.targets.add({ id: 'plain', size: TARGET_SIZE, position: vec3(3, 1.6, -10) });
    w.targets.update(1 / 120);
    const view = new ViewScene(w);
    const marks = new TargetMarks(view.layer);
    const color = (id: string) => (meshes(view).find((m) => m.userData.targetId === id)!.material as THREE.MeshBasicMaterial).color.getHex();
    marks.update(w.targets.all, 0, 'track');
    expect(color('track')).toBe(PRACTICE_TARGET_AIMED_COLOR);
    marks.update(w.targets.all, 0, undefined);
    expect(color('track')).toBe(PRACTICE_TARGET_COLOR);
    // 色を変えない的は、乗っていても同じ色。
    marks.update(w.targets.all, 0, 'plain');
    expect(color('plain')).toBe(PRACTICE_TARGET_COLOR);
    expect(color('track')).toBe(PRACTICE_TARGET_COLOR);
  });

  it('位置の補間', () => {
    expect(interpolatePosition(vec3(0, 0, 0), vec3(2, 4, -6), 0.25)).toEqual({ x: 0.5, y: 1, z: -1.5 });
  });
});
