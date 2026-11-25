import { describe, expect, it } from 'vitest';
import range from '../../src/data/maps/range.json';
import { directionFromAngles } from '../../src/sim/angles';
import { parseMap } from '../../src/sim/map';
import { loadWorld } from '../../src/sim/world';

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe('マップの読み込み', () => {
  it('ARC-11: range を読み込むと壁が 1 つと的が 1 つ入り、プレイヤーは開始位置・開始時の照準になる', () => {
    const result = loadWorld(range);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const { world } = result;
    expect(world.mapId).toBe('range');
    expect(world.boxes.filter((b) => b.kind === 'wall')).toHaveLength(1);
    expect(world.boxes.filter((b) => b.kind === 'target')).toHaveLength(1);
    expect(world.boxes).toHaveLength(2);
    expect(world.player.position).toEqual({ x: range.spawn.position[0], y: range.spawn.position[1], z: range.spawn.position[2] });
    expect(world.player.aim).toEqual({ yaw: range.spawn.yaw, pitch: range.spawn.pitch });
  });

  it('range は正面 10 メートルに壁があり、その手前に的があり、開始時の照準は的の中心を向く', () => {
    const result = loadWorld(range);
    if (!result.ok) throw new Error('読み込めない');
    const { player, boxes } = result.world;
    const wall = boxes.find((b) => b.kind === 'wall')!;
    const target = boxes.find((b) => b.kind === 'target')!;
    expect(player.position.z - (wall.center.z + wall.size.z / 2)).toBeCloseTo(10, 9);
    expect(target.center.z).toBeGreaterThan(wall.center.z + wall.size.z / 2);

    const dir = directionFromAngles(player.aim);
    const toTarget = {
      x: target.center.x - player.position.x,
      y: target.center.y - player.position.y,
      z: target.center.z - player.position.z,
    };
    const length = Math.hypot(toTarget.x, toTarget.y, toTarget.z);
    expect(dir.x).toBeCloseTo(toTarget.x / length, 9);
    expect(dir.y).toBeCloseTo(toTarget.y / length, 9);
    expect(dir.z).toBeCloseTo(toTarget.z / length, 9);
  });

  it('ARC-12: kind が "floor" の箱を含むと、その箱の項目を示す読み込みの誤りになり、World は作られない', () => {
    const json = clone(range);
    (json.boxes[1] as { kind: string }).kind = 'floor';
    const result = loadWorld(json);
    expect(result.ok).toBe(false);
    expect('world' in result).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe('boxes[1].kind');
  });

  it.each([
    ['必須の項目がない', (j: Record<string, unknown>) => delete j.name, 'name'],
    ['spawn がない', (j: Record<string, unknown>) => delete j.spawn, 'spawn'],
    ['型が違う', (j: Record<string, unknown>) => (j.id = 1), 'id'],
    ['位置が数 3 つでない', (j: Record<string, unknown>) => ((j.spawn as Record<string, unknown>).position = [0, 1]), 'spawn.position'],
    ['ヨーが数でない', (j: Record<string, unknown>) => ((j.spawn as Record<string, unknown>).yaw = '0'), 'spawn.yaw'],
    ['boxes が配列でない', (j: Record<string, unknown>) => (j.boxes = {}), 'boxes'],
    ['size が 0 以下', (j: Record<string, unknown>) => (((j.boxes as Record<string, unknown>[])[0]!).size = [1, 0, 1]), 'boxes[0].size'],
    ['size が負', (j: Record<string, unknown>) => (((j.boxes as Record<string, unknown>[])[0]!).size = [1, 1, -1]), 'boxes[0].size'],
    ['箱の id が重複', (j: Record<string, unknown>) => (((j.boxes as Record<string, unknown>[])[1]!).id = 'wall'), 'boxes[1].id'],
    ['箱の center がない', (j: Record<string, unknown>) => delete ((j.boxes as Record<string, unknown>[])[0]!).center, 'boxes[0].center'],
  ])('%s は読み込みの誤りになる', (_label, mutate, path) => {
    const json = clone(range) as unknown as Record<string, unknown>;
    mutate(json);
    const result = parseMap(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path)).toEqual([path]);
  });

  it('オブジェクトでない JSON は読み込みの誤りになる', () => {
    expect(parseMap([]).ok).toBe(false);
    expect(parseMap(null).ok).toBe(false);
  });

  it('誤りが複数あればすべて返す', () => {
    const json = clone(range) as unknown as Record<string, unknown>;
    delete json.id;
    ((json.boxes as Record<string, unknown>[])[0]!).kind = 'floor';
    const result = parseMap(json);
    if (result.ok) throw new Error('誤りにならない');
    expect(result.errors.map((e) => e.path)).toEqual(['id', 'boxes[0].kind']);
  });
});
