// docs/spec/architecture.md「練習の的」「照準と的の当たり」「武器を使わない練習」「決まった結果」の受け入れテスト（ARC-36〜ARC-43）と、
// docs/spec/screens.md「3D の表示」の練習の的の表示の受け入れテスト（UI-98）。QA が SPEC だけから書いたもの。
// 公開された入口（練習モードの共通の型、PracticeSession・replayPracticeSession、World・マップの形、入力の記録、固定ステップのループ、
// 描画の ViewScene・TargetMarks・ImpactMarks）だけを使い、ブラウザなしで動かす。
// 照準の向きは SPEC の座標系（ヨー 0・ピッチ 0 が -Z、ヨーが正なら +X、ピッチが正なら +Y）から、このファイルで求める。
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FixedStepLoop } from '../../src/core/loop';
import { ManualTimeSource } from '../../src/core/time';
import type { TimedAction } from '../../src/input/actions';
import { inputFromTimedActions, type InputSource } from '../../src/input/queue';
import { RecordingInput, replayInput, type InputRecording } from '../../src/input/recording';
import { PracticeSession, replayPracticeSession } from '../../src/modes/session';
import type { ModeContext, TrainingMode } from '../../src/modes/types';
import { IMPACT_NAME, ImpactMarks } from '../../src/render/impacts';
import { ViewScene } from '../../src/render/scene';
import { TargetMarks } from '../../src/render/targets';
import type { Box } from '../../src/sim/map';
import { vec3, type Vec3 } from '../../src/sim/vec3';
import { createWorld, type World } from '../../src/sim/world';

const EYE = vec3(0, 1.6, 0);
const SIZE = vec3(1, 1, 0.2);
const DT = 1 / 120;
const BACK: Box = { id: 'back', kind: 'wall', center: vec3(0, 1.6, -40), size: vec3(300, 300, 0.2) };

function makeWorld(boxes: Box[] = [BACK]): World {
  return createWorld({ id: 'qa', name: 'qa', spawn: { position: EYE, aim: { yaw: 0, pitch: 0 } }, boxes });
}

/** 目から点への向き（度）。SPEC の座標系: ヨー 0・ピッチ 0 が -Z、ヨー正が +X、ピッチ正が +Y。 */
function anglesTo(point: Vec3): { yaw: number; pitch: number } {
  const dx = point.x - EYE.x;
  const dy = point.y - EYE.y;
  const dz = point.z - EYE.z;
  const deg = 180 / Math.PI;
  return { yaw: Math.atan2(dx, -dz) * deg, pitch: Math.atan2(dy, Math.hypot(dx, dz)) * deg };
}

interface ModeSpec {
  setup?: (c: ModeContext) => void;
  step?: (c: ModeContext) => void;
  usesWeapon?: boolean;
  timeLimit?: number;
}

/** 武器を使わない aim のモード（共通の型だけで作る）。 */
function mode(spec: ModeSpec = {}): TrainingMode {
  return {
    id: 'qa-aim',
    name: 'QA エイム',
    description: 'QA のエイム',
    icon: 'track',
    category: 'aim',
    order: 1,
    usesWeapon: spec.usesWeapon ?? false,
    ...(spec.timeLimit === undefined ? {} : { timeLimit: spec.timeLimit }),
    setup(c) {
      spec.setup?.(c);
    },
    step(c) {
      spec.step?.(c);
      return true;
    },
    result() {
      return {};
    },
    teardown() {},
  };
}

function session(m: TrainingMode, input: InputSource, w: World = makeWorld(), seed = 1) {
  return new PracticeSession({ world: w, weapon: undefined, mode: m, input, seed });
}

/** 照準を from から to へ向ける look（時刻 t）。 */
const look = (t: number, from: { yaw: number; pitch: number }, to: { yaw: number; pitch: number }): TimedAction => ({
  time: t,
  action: { type: 'look', yaw: to.yaw - from.yaw, pitch: to.pitch - from.pitch },
});
const fire = (t: number, pressed: boolean): TimedAction => ({ time: t, action: { type: 'fire', pressed } });

/** 固定ステップの時刻で t 秒まで進める。 */
function stepUntil(s: PracticeSession<undefined>, t: number) {
  while (s.sim.time < t - 1e-9 && !s.ended) s.step();
}

describe('ARC-36: 動く的の位置は固定ステップの時刻だけで決まる', () => {
  const moving = () => mode({ setup: (c) => c.targets.add({ id: 'm', size: SIZE, position: (t) => vec3(2 * t, 1.6, -10) }) });

  it('毎秒 2 メートルで +X へ動く的は、1 秒進めると中心の X が開始時（X 0）より 2 メートル動いている', () => {
    const s = session(moving(), inputFromTimedActions([]));
    for (let i = 0; i < 120; i += 1) s.step();
    expect(s.sim.time).toBeCloseTo(1, 9);
    const t = s.world.targets.get('m');
    expect(t).toBeDefined();
    expect(t!.center.x - 0).toBeCloseTo(2, 6);
    expect(t!.center.y).toBeCloseTo(1.6, 9);
    expect(t!.center.z).toBeCloseTo(-10, 9);
  });

  it('同じ練習に 1/60 秒間隔と 1/144 秒間隔の描画で合計 1 秒を与えると、的の位置が一致する', () => {
    const run = (interval: number, frames: number) => {
      const s = session(moving(), inputFromTimedActions([]));
      const time = new ManualTimeSource();
      const loop = new FixedStepLoop({ timeSource: time, update: () => s.step(), render: () => {} });
      for (let f = 0; f < frames; f += 1) {
        time.advance(interval);
        loop.frame();
      }
      return { steps: s.sim.stepCount, center: s.world.targets.get('m')!.center };
    };
    const a = run(1 / 60, 60);
    const b = run(1 / 144, 144);
    expect(a.steps).toBe(120);
    expect(b.steps).toBe(120);
    expect(b.center).toEqual(a.center);
    expect(a.center.x).toBeCloseTo(2, 6);
  });
});

describe('ARC-37: 乱数で出現の位置と時刻を決める的は、種だけで決まる', () => {
  /** 0.5 秒ごとに、乱数で X と出現までの遅れを決めた的を 1 つ足す（モードのステップごとの処理で足す）。 */
  const randomMode = () => {
    let next = 0;
    let n = 0;
    return mode({
      setup: () => {
        next = 0;
        n = 0;
      },
      step: (c) => {
        if (c.time < next) return;
        next += 0.5;
        const x = c.random.next() * 8 - 4;
        const y = 1 + c.random.next() * 2;
        const delay = c.random.next() * 0.4;
        n += 1;
        c.targets.add({ id: `r${n}`, size: SIZE, position: vec3(x, y, -12), appearAt: c.time + delay, disappearAt: c.time + delay + 0.6 });
      },
    });
  };
  const input = (): TimedAction[] => [look(0.3, { yaw: 0, pitch: 0 }, { yaw: 5, pitch: 1 }), fire(1, true), fire(1.1, false), look(2, { yaw: 5, pitch: 1 }, { yaw: -3, pitch: 0 })];

  /** 5 秒進め、出現した的（初めて出現したステップ）ごとの位置と出現の時刻の列を返す。 */
  function appearances(seed: number) {
    const s = session(randomMode(), inputFromTimedActions(input()), makeWorld(), seed);
    const seen = new Map<string, { time: number; center: Vec3 }>();
    for (let i = 0; i < 600; i += 1) {
      s.step();
      for (const t of s.world.targets.visible) if (!seen.has(t.id)) seen.set(t.id, { time: s.sim.time, center: t.center });
    }
    return [...seen.values()];
  }

  it('同じ種・同じ入力で 2 回 5 秒進めると列が一致し、違う種では一致しない', () => {
    const a = appearances(42);
    const b = appearances(42);
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(b).toEqual(a);
    const c = appearances(43);
    expect(c).not.toEqual(a);
  });
});

describe('ARC-38: 照準が的に「乗っている」の判定', () => {
  const always = vec3(3, 1.6, -10);
  const pop = vec3(-3, 1.6, -10);

  it('出現している的の中心に向けたステップでは乗っていて、的の幅より大きくヨーをずらしたステップでは乗っていない', () => {
    const on = anglesTo(always);
    const off = { yaw: on.yaw + 15, pitch: on.pitch };
    const s = session(
      mode({ setup: (c) => c.targets.add({ id: 'a', size: SIZE, position: always }) }),
      inputFromTimedActions([look(0.1, { yaw: 0, pitch: 0 }, on), look(0.5, on, off)]),
    );
    stepUntil(s, 0.3);
    expect(s.world.targets.aimed).toBe('a');
    expect(s.world.targets.isAimed('a')).toBe(true);
    stepUntil(s, 0.7);
    expect(s.world.targets.aimed).toBeUndefined();
    expect(s.world.targets.isAimed('a')).toBe(false);
  });

  it('出現の時刻（1 秒）より前と消える時刻（2 秒）より後のステップでは、的の位置に向けても乗っていない', () => {
    const on = anglesTo(pop);
    const s = session(
      mode({ setup: (c) => c.targets.add({ id: 'p', size: SIZE, position: pop, appearAt: 1, disappearAt: 2 }) }),
      inputFromTimedActions([look(0, { yaw: 0, pitch: 0 }, on)]),
    );
    const result: Record<string, boolean> = {};
    for (const t of [0.5, 0.95, 1.5, 1.95, 2.05, 2.5]) {
      stepUntil(s, t);
      result[String(t)] = s.world.targets.isAimed('p');
    }
    expect(result).toEqual({ '0.5': false, '0.95': false, '1.5': true, '1.95': true, '2.05': false, '2.5': false });
  });
});

describe('ARC-39: 的と目のあいだに壁があるとき', () => {
  it('的の中心に向けても乗っておらず、その向きで撃った弾は壁に当たって命中にならない', () => {
    const center = vec3(0, 1.6, -10);
    const wall: Box = { id: 'between', kind: 'wall', center: vec3(0, 1.6, -5), size: vec3(4, 4, 0.2) };
    const s = session(
      mode({ setup: (c) => c.targets.add({ id: 't', size: SIZE, position: center }) }),
      inputFromTimedActions([look(0, { yaw: 0, pitch: 0 }, anglesTo(center)), fire(0.2, true), fire(0.3, false)]),
      makeWorld([wall, BACK]),
    );
    stepUntil(s, 0.15);
    expect(s.world.targets.visible.map((t) => t.id)).toEqual(['t']);
    expect(s.world.targets.aimed).toBeUndefined();
    stepUntil(s, 0.5);
    expect(s.shots).toHaveLength(1);
    expect(s.shots[0]!.target).toBeUndefined();
    // 壁の手前の面（Z = -4.9）に当たっている。
    expect(s.shots[0]!.position).not.toBeNull();
    expect(s.shots[0]!.position!.z).toBeCloseTo(-4.9, 3);
  });
});

describe('ARC-40: 動いている的に撃った弾', () => {
  it('動いている的の中心に向けて撃つと、弾の記録に的の識別子が入って命中になり、その弾の弾痕は表示されない', () => {
    const at = (t: number) => vec3(-2 + 2 * t, 1.6, -10);
    const fireAt = 0.5 + DT / 2; // 0.5 秒から始まるステップの中（そのステップの終わりは 0.5 + 1/120 秒）
    const aim = anglesTo(at(0.5 + DT));
    const s = session(
      mode({ setup: (c) => c.targets.add({ id: 'mover', size: SIZE, position: at }) }),
      inputFromTimedActions([look(fireAt, { yaw: 0, pitch: 0 }, aim), fire(fireAt, true), fire(0.7, false)]),
    );
    stepUntil(s, 0.8);
    expect(s.world.targets.get('mover')!.center.x).not.toBeCloseTo(at(0).x, 3);
    expect(s.shots).toHaveLength(1);
    expect(s.shots[0]!.target).toBe('mover');

    const view = new ViewScene(s.world);
    const impacts = new ImpactMarks(view.layer);
    impacts.sync(s.shots, EYE);
    const marks: THREE.Object3D[] = [];
    view.scene.traverse((o) => {
      if (o.name === IMPACT_NAME) marks.push(o);
    });
    expect(marks).toHaveLength(0);
  });

  it('比べ: 同じ練習で的を外して壁に当てた弾は、弾痕が表示される（数え方の確かめ）', () => {
    const s = session(mode(), inputFromTimedActions([fire(0.1, true), fire(0.2, false)]));
    stepUntil(s, 0.3);
    expect(s.shots).toHaveLength(1);
    expect(s.shots[0]!.target).toBeUndefined();
    const view = new ViewScene(s.world);
    new ImpactMarks(view.layer).sync(s.shots, EYE);
    const marks: THREE.Object3D[] = [];
    view.scene.traverse((o) => {
      if (o.name === IMPACT_NAME) marks.push(o);
    });
    expect(marks).toHaveLength(1);
  });
});

describe('ARC-41: 武器を使わない練習の撃ち方', () => {
  it('fire を 1 秒押し続けても弾は 1 発で、練習のあいだリコイルのオフセットはヨー 0・ピッチ 0 のまま', () => {
    const s = session(mode(), inputFromTimedActions([fire(0.05, true), fire(1.05, false)]));
    const offsets = new Set<string>();
    for (let i = 0; i < 180; i += 1) {
      s.step();
      offsets.add(`${s.world.player.recoilOffset.yaw},${s.world.player.recoilOffset.pitch}`);
    }
    expect(s.shots).toHaveLength(1);
    expect([...offsets]).toEqual(['0,0']);
  });

  it('fire を 3 回押し直すと 3 発になる', () => {
    const s = session(mode(), inputFromTimedActions([fire(0.1, true), fire(0.2, false), fire(0.3, true), fire(0.4, false), fire(0.5, true), fire(0.6, false)]));
    stepUntil(s, 1);
    expect(s.shots).toHaveLength(3);
    expect(s.world.player.recoilOffset).toEqual({ yaw: 0, pitch: 0 });
  });
});

/** 動く的・出てくる的・乱数で位置を決める的を置くモード（ARC-42・ARC-43）。制限時間 4 秒。 */
function busyMode(): TrainingMode {
  let next = 0;
  let n = 0;
  return mode({
    timeLimit: 4,
    setup: (c) => {
      next = 0.5;
      n = 0;
      c.targets.add({ id: 'sweep', size: SIZE, position: (t) => vec3(-4 + 2 * t, 1.6, -10) });
      c.targets.add({ id: 'pop', size: SIZE, position: vec3(0, 2.2, -8), appearAt: 1, disappearAt: 2.5 });
    },
    step: (c) => {
      if (c.time < next) return;
      next += 0.7;
      n += 1;
      c.targets.add({ id: `r${n}`, size: SIZE, position: vec3(c.random.next() * 6 - 3, 1.2 + c.random.next(), -9), appearAt: c.time, disappearAt: c.time + 0.5 });
    },
  });
}

interface Snapshot {
  time: number;
  targets: { id: string; center: Vec3; visible: boolean }[];
  aimed: string | undefined;
}
const snapshot = (s: PracticeSession<undefined>): Snapshot => ({
  time: s.sim.time,
  targets: s.world.targets.all.map((t) => ({ id: t.id, center: { ...t.center }, visible: t.visible })),
  aimed: s.world.targets.aimed,
});

/** 照準を左右に振りながら撃つ入力（時刻付き）。 */
function sweepActions(): TimedAction[] {
  const out: TimedAction[] = [];
  let prev = { yaw: 0, pitch: 0 };
  for (let i = 1; i <= 35; i += 1) {
    const to = { yaw: -20 + ((i * 7) % 40), pitch: (i % 5) - 2 };
    out.push(look(i * 0.1, prev, to));
    prev = to;
    if (i % 4 === 0) out.push(fire(i * 0.1 + 0.01, true), fire(i * 0.1 + 0.05, false));
  }
  return out;
}

describe('ARC-42: 練習の的を置いた練習の入力の記録を再生する', () => {
  it('再生したときの各ステップの的の位置・出現・乗っているの判定が、記録したときと一致する', () => {
    const recorder = new RecordingInput(2024);
    for (const a of sweepActions()) recorder.push(a.time, a.action);
    const original = session(busyMode(), recorder, makeWorld(), recorder.seed);
    const recorded: Snapshot[] = [];
    while (!original.ended) {
      original.step();
      recorded.push(snapshot(original));
    }
    expect(original.result).toBeDefined();
    expect(recorded.some((r) => r.aimed !== undefined)).toBe(true);
    expect(recorded.some((r) => r.targets.some((t) => !t.visible))).toBe(true);
    const recording: InputRecording = recorder.recording();

    const replay = session(busyMode(), replayInput(recording), makeWorld(), recording.seed);
    const replayed: Snapshot[] = [];
    while (!replay.ended) {
      replay.step();
      replayed.push(snapshot(replay));
    }
    expect(replayed).toEqual(recorded);

    // 公開された再生の入口でも、終わりの状態と弾の記録が一致する。
    const r = replayPracticeSession<undefined>(recording, { world: makeWorld(), weapon: undefined, mode: busyMode() });
    expect(snapshot(r)).toEqual(recorded.at(-1));
    expect(r.shots).toEqual(original.shots);
  });
});

describe('ARC-43: 描画はシミュレーションの的と当たりを変えない', () => {
  it('練習の的を描画したときと描画しないときで、各ステップの的の位置・出現と照準の当たりが一致する', () => {
    const plain = session(busyMode(), inputFromTimedActions(sweepActions()));
    const drawn = session(busyMode(), inputFromTimedActions(sweepActions()));
    const view = new ViewScene(drawn.world);
    const marks = new TargetMarks(view.layer);
    const a: Snapshot[] = [];
    const b: Snapshot[] = [];
    let shownMax = 0;
    while (!plain.ended) {
      plain.step();
      a.push(snapshot(plain));
    }
    while (!drawn.ended) {
      drawn.step();
      // 1 ステップに 2 回描画する（補間の係数 0 と 0.5）。
      marks.update(drawn.world.targets.all, 0);
      marks.update(drawn.world.targets.all, 0.5);
      shownMax = Math.max(shownMax, marks.shown.length);
      b.push(snapshot(drawn));
    }
    expect(shownMax).toBeGreaterThan(0);
    expect(b).toEqual(a);
    expect(drawn.shots).toEqual(plain.shots);
  });
});

describe('UI-98: 出現 1 秒・消える 2 秒の的の表示', () => {
  it('0.5 秒・1.5 秒・2.5 秒に描画したシーンのうち、1.5 秒のときだけその的が表示されている', () => {
    const center = vec3(1, 1.8, -10);
    const s = session(
      mode({ setup: (c) => c.targets.add({ id: 'pop', size: SIZE, position: center, appearAt: 1, disappearAt: 2 }) }),
      inputFromTimedActions([]),
    );
    const view = new ViewScene(s.world);
    const marks = new TargetMarks(view.layer);
    /** シーンの中で、祖先まで表示されていて、的の中心の位置にあるメッシュの数。 */
    const shownAtCenter = () => {
      view.scene.updateMatrixWorld(true);
      let count = 0;
      view.scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        let p: THREE.Object3D | null = o;
        while (p) {
          if (!p.visible) return;
          p = p.parent;
        }
        const w = o.getWorldPosition(new THREE.Vector3());
        if (w.distanceTo(new THREE.Vector3(center.x, center.y, center.z)) < 1e-6) count += 1;
      });
      return count;
    };
    const shown: boolean[] = [];
    for (const t of [0.5, 1.5, 2.5]) {
      stepUntil(s, t);
      marks.update(s.world.targets.all, 0.5);
      shown.push(shownAtCenter() > 0);
    }
    expect(shown).toEqual([false, true, false]);
  });
});
