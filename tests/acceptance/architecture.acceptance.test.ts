// docs/spec/architecture.md の受け入れ条件（ARC-4 〜 ARC-12）の受け入れテスト。
// 公開された入口（公開関数・クラス、マップの JSON、テストのコマンド）だけを使い、実装の内部には依存しない。
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createRandom } from '../../src/core/random';
import { FixedStepLoop } from '../../src/core/loop';
import { ManualTimeSource } from '../../src/core/time';
import type { TimedAction } from '../../src/input/actions';
import { inputFromTimedActions } from '../../src/input/queue';
import { directionFromAngles } from '../../src/sim/angles';
import { addRecoilOffset, createPlayer, viewAngles } from '../../src/sim/player';
import { Simulation } from '../../src/sim/simulation';
import { vec3 } from '../../src/sim/vec3';
import { loadWorld } from '../../src/sim/world';

const ROOT = resolve(__dirname, '../..');
const RANGE_PATH = join(ROOT, 'src/data/maps/range.json');

function readRange(): Record<string, unknown> {
  return JSON.parse(readFileSync(RANGE_PATH, 'utf8')) as Record<string, unknown>;
}

/** 開始時の照準がヨー 0・ピッチ 0 の、箱のない World を JSON から作る。 */
function worldAtZero() {
  const result = loadWorld({
    id: 'acceptance',
    name: 'acceptance',
    spawn: { position: [0, 1.6, 0], yaw: 0, pitch: 0 },
    boxes: [{ id: 'w', kind: 'wall', center: [0, 0, -20], size: [1, 1, 1] }],
  });
  if (!result.ok) throw new Error(`マップを読み込めない: ${JSON.stringify(result.errors)}`);
  return result.world;
}

describe('ARC-4: src/sim/ に three を import するファイルを足すと ARC-1 のテストが失敗する', () => {
  const copies: string[] = [];
  afterAll(() => {
    for (const dir of copies) rmSync(dir, { recursive: true, force: true });
  });

  /** リポジトリの写しを作り、必要なら src/sim/ にファイルを足して ARC-1 のテストだけを実行する。 */
  function runArc1(extra?: { name: string; source: string }) {
    const copy = mkdtempSync(join(tmpdir(), 'arc4-'));
    copies.push(copy);
    for (const entry of ['src', 'tests', 'package.json', 'tsconfig.json', 'vite.config.ts']) {
      cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
    }
    symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), 'dir');
    if (extra) writeFileSync(join(copy, 'src/sim', extra.name), extra.source);
    return spawnSync('npx', ['vitest', 'run', 'tests/architecture', '-t', 'ARC-1:'], {
      cwd: copy,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    });
  }

  it('足す前は ARC-1 のテストが成功する（対照）', () => {
    const result = runArc1();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 120_000);

  it('three を import するファイルを足すと ARC-1 のテストが失敗する', () => {
    const result = runArc1({
      name: 'acceptance-uses-three.ts',
      source: "import * as THREE from 'three';\nexport const v = new THREE.Vector3();\n",
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/ARC-1/);
    expect(result.stdout + result.stderr).toMatch(/acceptance-uses-three\.ts/);
  }, 120_000);
});

describe('ARC-5 / ARC-6: 固定ステップのループ', () => {
  function makeLoop() {
    const time = new ManualTimeSource();
    let steps = 0;
    const alphas: number[] = [];
    const loop = new FixedStepLoop({
      timeSource: time,
      step: 1 / 120,
      update: () => {
        steps += 1;
      },
      render: (alpha) => alphas.push(alpha),
    });
    return { time, loop, alphas, steps: () => steps };
  }

  it.each([60, 144])('ARC-5: 1/%d 秒間隔の描画で合計 1 秒を与えると 120 ステップ進み、補間の係数は 0 以上 1 未満', (hz) => {
    const { time, loop, alphas, steps } = makeLoop();
    for (let i = 0; i < hz; i += 1) {
      time.advance(1 / hz);
      loop.frame();
    }
    expect(steps()).toBe(120);
    expect(alphas).toHaveLength(hz);
    for (const alpha of alphas) {
      expect(alpha).toBeGreaterThanOrEqual(0);
      expect(alpha).toBeLessThan(1);
    }
  });

  it('ARC-6: 1 回の描画で 1 秒の経過を与えると 30 ステップ（0.25 秒分）進む', () => {
    const { time, loop, steps } = makeLoop();
    time.advance(1);
    loop.frame();
    expect(steps()).toBe(30);
  });
});

describe('ARC-7: 時刻付きの look の列で照準が動く', () => {
  it('ヨー 0・ピッチ 0 から 0.1 秒にヨー +10、0.2 秒にピッチ -5 を流して 0.5 秒進めると、ヨー 10・ピッチ -5', () => {
    const world = worldAtZero();
    expect(world.player.aim).toEqual({ yaw: 0, pitch: 0 });
    const actions: TimedAction[] = [
      { time: 0.1, action: { type: 'look', yaw: 10, pitch: 0 } },
      { time: 0.2, action: { type: 'look', yaw: 0, pitch: -5 } },
    ];
    const sim = new Simulation(world, inputFromTimedActions(actions));
    sim.advance(0.5);
    expect(world.player.aim.yaw).toBeCloseTo(10, 9);
    expect(world.player.aim.pitch).toBeCloseTo(-5, 9);
  });
});

describe('ARC-8: 座標系と角度', () => {
  const expectVec = (v: { x: number; y: number; z: number }, x: number, y: number, z: number) => {
    expect(v.x).toBeCloseTo(x, 9);
    expect(v.y).toBeCloseTo(y, 9);
    expect(v.z).toBeCloseTo(z, 9);
  };

  it('ヨー 0・ピッチ 0 の方向ベクトルは (0, 0, -1)', () => {
    expectVec(directionFromAngles({ yaw: 0, pitch: 0 }), 0, 0, -1);
  });

  it('ヨー 90・ピッチ 0 の方向ベクトルは (1, 0, 0)', () => {
    expectVec(directionFromAngles({ yaw: 90, pitch: 0 }), 1, 0, 0);
  });

  it('ヨー 0・ピッチ 0 からピッチ 90 度の入力を与えるとピッチは 89 度になる', () => {
    const world = worldAtZero();
    const sim = new Simulation(world, inputFromTimedActions([{ time: 0, action: { type: 'look', yaw: 0, pitch: 90 } }]));
    sim.advance(0.1);
    expect(world.player.aim.pitch).toBe(89);
    expect(world.player.aim.yaw).toBeCloseTo(0, 9);
  });
});

describe('ARC-9: リコイルのオフセット', () => {
  it('オフセットにピッチ +2 度を加えると照準の向きのピッチは利用者の照準より 2 度高く、利用者の照準は変わらない', () => {
    const player = createPlayer(vec3(0, 1.6, 0), { yaw: 0, pitch: 0 });
    const before = { ...player.aim };
    addRecoilOffset(player, { yaw: 0, pitch: 2 });
    expect(player.aim).toEqual(before);
    expect(viewAngles(player).pitch).toBeCloseTo(player.aim.pitch + 2, 9);
    expect(viewAngles(player).yaw).toBeCloseTo(player.aim.yaw, 9);
  });
});

describe('ARC-10: 種付きの乱数', () => {
  const take = (seed: number) => {
    const random = createRandom(seed);
    return Array.from({ length: 100 }, () => random.next());
  };

  it('同じ種で作った 2 つの乱数から 100 個ずつ取り出すと列が一致する', () => {
    expect(take(42)).toEqual(take(42));
  });

  it('違う種で作ると列が一致しない', () => {
    expect(take(42)).not.toEqual(take(43));
  });
});

describe('ARC-11 / ARC-12: マップの読み込み', () => {
  it('ARC-11: range の JSON を読み込むと壁が 1 つ・的が 1 つ入り、プレイヤーは開始位置・開始時の照準になる', () => {
    const json = readRange() as {
      id: string;
      spawn: { position: [number, number, number]; yaw: number; pitch: number };
    };
    expect(json.id).toBe('range');
    const result = loadWorld(json);
    if (!result.ok) throw new Error(`読み込めない: ${JSON.stringify(result.errors)}`);
    const { world } = result;
    expect(world.boxes.filter((b) => b.kind === 'wall')).toHaveLength(1);
    expect(world.boxes.filter((b) => b.kind === 'target')).toHaveLength(1);
    const [x, y, z] = json.spawn.position;
    expect(world.player.position).toEqual({ x, y, z });
    expect(world.player.aim.yaw).toBeCloseTo(json.spawn.yaw, 9);
    expect(world.player.aim.pitch).toBeCloseTo(json.spawn.pitch, 9);
  });

  it('ARC-12: kind が "floor" の箱を含むと、その箱の項目を示す読み込みの誤りになり、World は作られない', () => {
    const json = readRange() as { boxes: { kind: string }[] };
    json.boxes[0]!.kind = 'floor';
    const result = loadWorld(json);
    expect(result.ok).toBe(false);
    expect((result as { world?: unknown }).world).toBeUndefined();
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.path.startsWith('boxes[0]') && e.path.includes('kind'))).toBe(true);
  });
});
