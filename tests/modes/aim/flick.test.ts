// フリック（docs/spec/modes.md「フリック」、docs/spec/scoring.md「フリックの採点」）を、ブラウザなしで PracticeSession から確かめる。
import { describe, expect, it } from 'vitest';
import range from '../../../src/data/maps/range.json';
import type { Action } from '../../../src/input/actions';
import { InputQueue } from '../../../src/input/queue';
import { RecordingInput } from '../../../src/input/recording';
import flick, { FLICK_SCORING, FLICK_SIZES, flickDummy, flickOffsets, type FlickRecord, type FlickResult } from '../../../src/modes/aim/flick';
import { modes } from '../../../src/modes/registry';
import { PracticeSession, replayPracticeSession } from '../../../src/modes/session';
import { createRandom } from '../../../src/core/random';
import { normalizeYaw, type Angles } from '../../../src/sim/angles';
import { anglesToPoint } from '../../../src/sim/hit';
import { parseMap } from '../../../src/sim/map';
import { HUMANOID_HEIGHT, HUMANOID_WIDTH, humanoidPlate } from '../../../src/sim/humanoid';
import type { PracticeTarget } from '../../../src/sim/targets';
import { vec3, type Vec3 } from '../../../src/sim/vec3';
import { createWorld, type World } from '../../../src/sim/world';

const parsed = parseMap(range);
if (!parsed.ok) throw new Error('射撃場のマップを読めない');
const MAP = parsed.map;
const rangeWorld = (): World => createWorld(MAP);

type Session = PracticeSession<undefined>;

interface Driver {
  readonly session: Session;
  readonly input: { push(time: number, action: Action): void };
}

/** 出る範囲と的の大きさ（省くと既定の値）。 */
interface FlickChoice {
  readonly range?: string;
  readonly size?: string;
}

/** 出る範囲と的の大きさを、練習の選択肢の値（選択肢の id → 値の id）にする。 */
const optionsOf = (choice: FlickChoice) => ({ 'flick-range': choice.range, 'flick-size': choice.size });

function start(choice: FlickChoice = {}, seed = 1, input: InputQueue | RecordingInput = new InputQueue()): Driver {
  const session = new PracticeSession({ world: rangeWorld(), weapon: undefined, mode: flick, input, seed, options: optionsOf(choice) });
  return { session, input };
}

/** sim の時刻が until になるまで進める。 */
function stepUntil({ session }: Driver, until: number): void {
  while (session.sim.time < until - 1e-9 && !session.ended) session.step();
}

/** 今の的（出ていなくても足してある的）。 */
const currentTarget = ({ session }: Driver): PracticeTarget | undefined => session.world.targets.all[0];

/** 的の中心の向き（ヨー・ピッチ、度）。 */
const targetAngles = (d: Driver, target: PracticeTarget): Angles => anglesToPoint(d.session.world.player.position, target.center);

/**
 * 次のステップで照準を to に向けて fire を押し、その次のステップで離す。撃ったステップの終わりの時刻を返す。
 */
function shootAt(d: Driver, to: Angles): number {
  const { session, input } = d;
  const now = session.sim.time;
  const aim = session.world.player.aim;
  input.push(now, { type: 'look', yaw: normalizeYaw(to.yaw - aim.yaw), pitch: to.pitch - aim.pitch });
  input.push(now, { type: 'fire', pressed: true });
  session.step();
  const shotEnd = session.sim.time;
  input.push(session.sim.time, { type: 'fire', pressed: false });
  if (!session.ended) session.step();
  return shotEnd;
}

/** 今の的が出るまで進める。 */
function waitVisible(d: Driver): PracticeTarget {
  for (let i = 0; i < 10_000; i += 1) {
    const target = currentTarget(d);
    if (target?.visible) return target;
    d.session.step();
  }
  throw new Error('的が出ない');
}

/** 20 個の的を、出てから delay 秒後に、的の中心から yawOffset 度ずらして撃つ。撃った的を出た順に返す。 */
function playThrough(d: Driver, delay = 0.2, yawOffset = 0): PracticeTarget[] {
  const seen: PracticeTarget[] = [];
  while (!d.session.ended) {
    const target = waitVisible(d);
    seen.push(target);
    stepUntil(d, d.session.sim.time + delay - d.session.sim.dt);
    const angles = targetAngles(d, target);
    shootAt(d, { yaw: angles.yaw + yawOffset, pitch: angles.pitch });
  }
  return seen;
}

const modeResult = (d: Driver) => d.session.result!.modeResult as FlickResult;

/** 人型の板の輪郭を囲む範囲（メートル）。Z は正面の面（板の中心の Z）。 */
function bounds(target: PracticeTarget): { min: Vec3; max: Vec3 } {
  const outline = target.plate!.outline;
  const xs = outline.map((p) => target.center.x + p.x);
  const ys = outline.map((p) => target.center.y + p.y);
  return { min: vec3(Math.min(...xs), Math.min(...ys), target.center.z), max: vec3(Math.max(...xs), Math.max(...ys), target.center.z) };
}

/** 人型の板の幅（メートル）。 */
const widthOf = (target: PracticeTarget) => bounds(target).max.x - bounds(target).min.x;

/** 目の位置から的の中心までの距離。 */
const distanceTo = (d: Driver, target: PracticeTarget) => {
  const eye = d.session.world.player.position;
  return Math.hypot(target.center.x - eye.x, target.center.y - eye.y, target.center.z - eye.z);
};

/** 照準の中心（マップの開始時の照準）からの角度の距離と、ずれ。 */
function offsetOf(d: Driver, target: PracticeTarget): { distance: number; yaw: number; pitch: number } {
  const angles = targetAngles(d, target);
  const { center } = d.session.world;
  const yaw = normalizeYaw(angles.yaw - center.yaw);
  const pitch = angles.pitch - center.pitch;
  return { distance: Math.hypot(yaw, pitch), yaw, pitch };
}

describe('フリックの練習の流れ', () => {
  it('MODE-27: フリックは登録されたモードで、反復練習・追いエイム・追いエイム＋リコイルのあとに並ぶ', () => {
    expect(modes.map((m) => m.id)).toEqual(['ghost', 'tracking', 'tracking-recoil', 'flick']);
  });

  it('MODE-46: 開始から 1 秒後に的が 1 つ出て「的: 0 / 20」。当てると次の的が出て「的: 1 / 20」、20 個目を撃つと練習が終わる', () => {
    const d = start();
    expect(d.session.status).toBe('的: 0 / 20');
    stepUntil(d, 1);
    expect(currentTarget(d)?.visible).toBe(false);
    d.session.step();
    const first = currentTarget(d)!;
    expect(first.visible).toBe(true);
    expect(first.appearAt).toBe(1);
    expect(d.session.gun).toBeUndefined();

    shootAt(d, targetAngles(d, first));
    expect(d.session.status).toBe('的: 1 / 20');
    expect(d.session.world.targets.get(first.id)).toBeUndefined();
    expect(d.session.world.targets.all).toHaveLength(1);
    expect(currentTarget(d)!.id).not.toBe(first.id);

    playThrough(d);
    expect(d.session.ended).toBe(true);
    expect(d.session.result!.endReason).toBe('mode');
    expect(d.session.status).toBe('的: 20 / 20');
    expect(modeResult(d).targets).toHaveLength(20);
    expect(modeResult(d).targets.every((r) => r.hit)).toBe(true);
  });

  it('MODE-47: 的が出てから 0.3 秒後のステップで中心へ向けて撃つと、時間 0.3 秒・命中・ズレ 0 度として記録される', () => {
    const d = start();
    const target = waitVisible(d);
    stepUntil(d, target.appearAt + 0.3 - d.session.sim.dt);
    const end = shootAt(d, targetAngles(d, target));
    expect(end).toBeCloseTo(1.3, 9);
    playThrough(d);
    const record = modeResult(d).targets[0]!;
    expect(record.time).toBeCloseTo(0.3, 9);
    expect(record.hit).toBe(true);
    expect(record.error).toBeCloseTo(0, 6);
  });

  it('MODE-48: 見込み角より大きくヨーをずらして撃つと外れとして記録され、その的は消えて次の的が出る（撃ち直さない）', () => {
    const d = start({ size: 'medium' });
    const target = waitVisible(d);
    const angles = targetAngles(d, target);
    shootAt(d, { yaw: angles.yaw + FLICK_SIZES.medium.angle * 1.5, pitch: angles.pitch });
    expect(d.session.status).toBe('的: 1 / 20');
    expect(d.session.world.targets.get(target.id)).toBeUndefined();
    const next = waitVisible(d);
    expect(next.id).not.toBe(target.id);
    playThrough(d);
    const [first] = modeResult(d).targets;
    expect(first!.hit).toBe(false);
    expect(first!.error).toBeCloseTo(3, 6);
    // 外れた弾は壁（マップの箱）に当たって弾痕を残し、練習の的の命中にならない。
    expect(d.session.shots[0]!.target).toBeUndefined();
    expect(d.session.shots[0]!.position).not.toBeNull();
  });

  it('MODE-49: 同じ種・同じ設定なら入力が違っても 1〜20 個目の位置の並びが一致し、違う種では一致しない', () => {
    const settings = { range: 'normal', size: 'medium' };
    const a = start(settings, 7);
    const centersA = playThrough(a, 0.2, 0).map((t) => t.center);
    const b = start(settings, 7);
    const centersB = playThrough(b, 0.55, 4).map((t) => t.center);
    expect(centersB).toEqual(centersA);
    expect(modeResult(b).offsets).toEqual(modeResult(a).offsets);
    expect(modeResult(a).targets.every((r) => r.hit)).toBe(true);
    expect(modeResult(b).targets.every((r) => !r.hit)).toBe(true);

    const c = start(settings, 8);
    const centersC = playThrough(c).map((t) => t.center);
    expect(centersC).not.toEqual(centersA);
  });

  it.each([
    ['near', 3, 8],
    ['normal', 8, 14],
    ['far', 14, 20],
  ])('MODE-50: 出る範囲 %s の 20 個の的は、角度の距離が %d 度以上 %d 度未満で、|Δpitch| ≤ 距離 × sin20°、壁の正面の範囲に収まる', (rangeId, min, max) => {
    const wall = MAP.boxes.find((b) => b.id === 'wall')!;
    for (const seed of [1, 2, 3, 42]) {
      const d = start({ range: rangeId, size: 'large' }, seed);
      const targets = playThrough(d);
      expect(targets).toHaveLength(20);
      for (const target of targets) {
        const { distance, pitch } = offsetOf(d, target);
        expect(distance).toBeGreaterThanOrEqual(min - 1e-9);
        expect(distance).toBeLessThan(max);
        expect(Math.abs(pitch)).toBeLessThanOrEqual(distance * Math.sin((20 * Math.PI) / 180) + 1e-9);
        // 板の左右の端と頭のてっぺんは壁の正面の範囲に収まる（下端は床より下に出てもよい）。
        const box = bounds(target);
        expect(box.min.x).toBeGreaterThanOrEqual(wall.center.x - wall.size.x / 2);
        expect(box.max.x).toBeLessThanOrEqual(wall.center.x + wall.size.x / 2);
        expect(box.max.y).toBeLessThanOrEqual(wall.center.y + wall.size.y / 2);
        // 板の正面の面は、壁と的の箱のいちばん手前の面より 0.05 メートル手前。
        const front = Math.max(...MAP.boxes.map((b) => b.center.z + b.size.z / 2));
        expect(box.min.z).toBeCloseTo(front + 0.05, 9);
      }
    }
  });

  it('MODE-50: ずれの向きは右向きと左向きの両方に出る', () => {
    const offsets = flickOffsets(createRandom(3), 'normal', 200);
    const right = offsets.filter((o) => o.yaw > 0).length;
    expect(right).toBeGreaterThan(60);
    expect(right).toBeLessThan(140);
  });

  // 板は回転しないので、斜めから見ると左右の辺の見込みは cos(斜めの角度) 倍に縮む。出る範囲「近い」（8 度未満）なら 0.99 倍より大きい。
  it.each(Object.keys(FLICK_SIZES))('MODE-51: 的の大きさ %s で、板の中心から見込み角の半分よりわずかに小さくずらすと命中（胴の左右の辺の内側）、わずかに大きくずらすと外れ（辺の外側）', (size) => {
    const half = FLICK_SIZES[size as keyof typeof FLICK_SIZES].angle / 2;
    for (const seed of [5, 6, 7]) {
      for (const [factor, inward, hit] of [
        [0.95, true, true],
        [0.95, false, true],
        [1.05, true, false],
        [1.05, false, false],
      ] as const) {
        const d = start({ range: 'near', size }, seed);
        const target = waitVisible(d);
        const angles = targetAngles(d, target);
        const side = (offsetOf(d, target).yaw > 0 ? 1 : -1) * (inward ? -1 : 1);
        shootAt(d, { yaw: angles.yaw + side * half * factor, pitch: angles.pitch });
        playThrough(d);
        expect([seed, factor, inward, modeResult(d).targets[0]!.hit]).toEqual([seed, factor, inward, hit]);
      }
    }
  });

  it.each(Object.keys(FLICK_SIZES))('MODE-62: 的の大きさ %s で、板の幅の見込み角が見込み角になり（幅 = 2 × L × tan(見込み角 ÷ 2)）、板の高さは幅に比例する（0.75 ÷ 0.45）', (size) => {
    const angle = FLICK_SIZES[size as keyof typeof FLICK_SIZES].angle;
    const world = rangeWorld();
    const dummy = flickDummy(world, { yaw: 10, pitch: 2 }, size as keyof typeof FLICK_SIZES);
    const eye = world.player.position;
    const distance = Math.hypot(dummy.center.x - eye.x, dummy.center.y - eye.y, dummy.center.z - eye.z);
    expect(dummy.distance).toBeCloseTo(distance, 12);
    const xs = humanoidPlate(dummy.scale).outline.map((p) => p.x);
    const width = Math.max(...xs) - Math.min(...xs);
    expect(width).toBeCloseTo(HUMANOID_WIDTH * dummy.scale, 12);
    expect(width).toBeCloseTo(2 * distance * Math.tan((angle * Math.PI) / 360), 12);
    expect(2 * Math.atan(width / 2 / distance) * (180 / Math.PI)).toBeCloseTo(angle, 9);
    expect(HUMANOID_HEIGHT * dummy.scale).toBeCloseTo((width / 0.45) * 0.75, 12);
    // 板の中心は照準の中心 + ずれの向き、正面の面はマップの箱のいちばん手前の面より 0.05 メートル手前。
    const seen = anglesToPoint(eye, dummy.center);
    expect(seen.yaw).toBeCloseTo(10, 9);
    expect(seen.pitch).toBeCloseTo(2, 9);
    const front = Math.max(...MAP.boxes.map((b) => b.center.z + b.size.z / 2));
    expect(dummy.center.z).toBeCloseTo(front + 0.05, 12);
  });

  it('MODE-62: 同じずれなら、大・中・小の順に板が小さくなる', () => {
    const world = rangeWorld();
    const scales = (['large', 'medium', 'small'] as const).map((size) => flickDummy(world, { yaw: -6, pitch: 1 }, size).scale);
    expect(scales[0]).toBeGreaterThan(scales[1]!);
    expect(scales[1]).toBeGreaterThan(scales[2]!);
  });

  it('MODE-61: 出た板の胴の中心を撃つと命中、頭と肩のあいだの空き（縮尺倍）か右の辺より幅の半分以上外を撃つと外れ', () => {
    for (const seed of [5, 6, 7]) {
      for (const [where, hit] of [
        ['torso', true],
        ['right', false],
        ['gap', false],
      ] as const) {
        const d = start({ range: 'near', size: 'large' }, seed);
        const target = waitVisible(d);
        const eye = d.session.world.player.position;
        const box = bounds(target);
        const half = (box.max.x - box.min.x) / 2;
        const scale = widthOf(target) / HUMANOID_WIDTH;
        const c = target.center;
        const point = where === 'torso' ? c : where === 'right' ? vec3(box.max.x + half, c.y, c.z) : vec3(c.x + 0.13 * scale, c.y + 0.25 * scale, c.z);
        shootAt(d, anglesToPoint(eye, point));
        playThrough(d);
        expect([seed, where, modeResult(d).targets[0]!.hit]).toEqual([seed, where, hit]);
        expect(d.session.shots[0]!.target === target.id).toBe(hit);
      }
    }
  });

  it('MODE-52: fire を押し続けても撃たなくてもリコイルのオフセットは 0 のままで、撃たずに 10 秒たっても終わらない', () => {
    const d = start();
    d.input.push(0.5, { type: 'fire', pressed: true });
    d.input.push(3, { type: 'fire', pressed: false });
    const offsets = new Set<string>();
    while (d.session.sim.time < 11 - 1e-9) {
      d.session.step();
      const { yaw, pitch } = d.session.world.player.recoilOffset;
      offsets.add(`${yaw},${pitch}`);
    }
    expect(offsets).toEqual(new Set(['0,0']));
    expect(d.session.ended).toBe(false);
    expect(d.session.shots).toHaveLength(1);
  });

  it('MODE-54: 1 個目の的が出る前に撃った弾はどの的の弾にも数えず、「的: 0 / 20」のまま', () => {
    const d = start();
    stepUntil(d, 0.5);
    shootAt(d, d.session.world.center);
    expect(d.session.shots).toHaveLength(1);
    expect(d.session.status).toBe('的: 0 / 20');
    const target = waitVisible(d);
    expect(d.session.status).toBe('的: 0 / 20');
    shootAt(d, targetAngles(d, target));
    expect(d.session.status).toBe('的: 1 / 20');
    playThrough(d);
    expect(d.session.shots).toHaveLength(21);
    expect(modeResult(d).targets).toHaveLength(20);
  });

  it('MODE-55: 出る範囲「遠い」・的の大きさ「小」で始めると、的の距離は 14 度以上 20 度未満で見込み角は 1 度。結果に練習の設定が入る', () => {
    const d = start({ range: 'far', size: 'small' }, 11);
    const targets = playThrough(d);
    for (const target of targets) {
      const { distance } = offsetOf(d, target);
      expect(distance).toBeGreaterThanOrEqual(14);
      expect(distance).toBeLessThan(20);
      expect(widthOf(target)).toBeCloseTo(2 * distanceTo(d, target) * Math.tan((0.5 * Math.PI) / 180), 12);
    }
    expect(d.session.result!.options.map((o) => [o.optionId, o.id, o.label.ja, o.name.ja])).toEqual([
      ['flick-range', 'far', '出る範囲', '遠い'],
      ['flick-size', 'small', '的の大きさ', '小'],
    ]);
    expect(modeResult(d).settings).toEqual({ range: 'far', size: 'small' });
  });

  it('練習の選択肢を省くと「ふつう」「中」で始まる', () => {
    const d = start();
    expect(d.session.options.map((o) => o.choice.id)).toEqual(['normal', 'medium']);
  });

  it('入力の記録を再生すると、同じ的の記録になる', () => {
    const recorded = new RecordingInput(99);
    const d = start({ range: 'far', size: 'large' }, recorded.seed, recorded);
    playThrough(d, 0.25, 0.3);
    const replay = replayPracticeSession(recorded.recording(), { world: rangeWorld(), weapon: undefined, mode: flick, options: optionsOf({ range: 'far', size: 'large' }) });
    expect(replay.result!.modeResult).toEqual(d.session.result!.modeResult);
  });
});

describe('フリックの採点', () => {
  const records = (hits: number, total: number, time: number, hitError: number, missError: number): FlickRecord[] =>
    Array.from({ length: total }, (_, i) => ({ time, hit: i < hits, error: i < hits ? hitError : missError }));
  const score = (targets: readonly FlickRecord[]) => FLICK_SCORING.score({ shots: [], duration: 30, modeResult: { targets } });

  it('SCO-55: 18 / 20 命中・時間がすべて 0.5 秒・ズレ 0.5 度と 3 度なら、0.556 秒・0.500 秒・90.0%・18 / 20・0.75°', () => {
    const scored = score(records(18, 20, 0.5, 0.5, 3));
    expect(scored.value).toBeCloseTo(10 / 18, 12);
    expect(scored.metrics).toEqual([
      { label: '命中 1 回あたりの時間', value: '0.556 秒' },
      { label: '時間の平均', value: '0.500 秒' },
      { label: '命中率', value: '90.0%' },
      { label: '命中数', value: '18 / 20' },
      { label: 'ズレの平均', value: '0.75°' },
    ]);
    expect(scored.fields).toEqual({ meanTime: 0.5, hitRate: 90, hits: 18, targets: 20, meanError: 0.75 });
    expect(scored.share).toBe('命中 1 回あたりの時間: 0.556 秒 / 命中率: 90.0%');
  });

  it('SCO-56: 1 個も命中しないと命中 1 回あたりの時間は「なし」で、時間の平均・命中率（0.0%）・ズレの平均は求まる', () => {
    const scored = score(records(0, 20, 0.4, 0, 2));
    expect(scored.value).toBeNull();
    expect(scored.metrics.map((m) => m.value)).toEqual(['なし', '0.400 秒', '0.0%', '0 / 20', '2.00°']);
    expect(scored.share).toBe('命中 1 回あたりの時間: なし / 命中率: 0.0%');
  });

  it('撃った的が 0 のとき（打ち切られた結果など）はすべての指標が「なし」', () => {
    const scored = score([]);
    expect(scored.value).toBeNull();
    expect(scored.metrics.map((m) => m.value)).toEqual(['なし', 'なし', 'なし', 'なし', 'なし']);
    expect(FLICK_SCORING.score({ shots: [], duration: 1, modeResult: { targets: 'broken' } }).value).toBeNull();
  });

  it('SCO-59: 命中 1 回あたりの時間は小さいほど良く、0 より大きい有限の数だけがとりうる値', () => {
    const { compare } = FLICK_SCORING;
    expect(compare.id).toBe('timePerHit');
    expect(compare.better).toBe('lower');
    expect(compare.valid?.(0.5)).toBe(true);
    expect(compare.valid?.(0)).toBe(false);
    expect(compare.format(0.6)).toBe('0.600 秒');
    expect(FLICK_SCORING.columns?.map((c) => c.label)).toEqual(['時間の平均', '命中率', 'ズレの平均']);
  });
});
