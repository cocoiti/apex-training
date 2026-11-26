import type { Random } from '../../core/random';
import { addAngles, directionFromAngles, normalizeYaw, type Angles } from '../../sim/angles';
import { anglesToPoint } from '../../sim/hit';
import type { Box } from '../../sim/map';
import { vec3, type Vec3 } from '../../sim/vec3';
import type { World } from '../../sim/world';
import { t } from '../../ui/i18n';
import type { CompareMetric, MetricSpec, ModeContext, ModeOption, ModeOptionValues, ModeScore, ModeScoring, ScoringInput, TrainingMode } from '../types';

/**
 * フリック（docs/spec/modes.md「フリック」）。壁の上のランダムな位置に的が 1 つずつ出て、照準を素早く合わせて 1 発撃つことを繰り返す。
 * 武器を使わないモードで、的の位置の並びは練習の始めに種付きの乱数と練習の選択肢の値だけから決める。
 * 採点は docs/spec/scoring.md「フリックの採点」。決定の理由は docs/adr/2026-11-26-flick-targets-planned-at-setup.md。
 */

/** 1 回の練習の的の数。 */
export const FLICK_TARGET_COUNT = 20;

/** 1 個目の的の出現の時刻（練習の開始からの秒）。 */
export const FLICK_FIRST_APPEAR = 1;

/** ずれの向きの、水平からの上下の幅（度）。 */
export const FLICK_DIRECTION_SPREAD = 20;

/** 出る範囲（照準の中心からの角度の距離、度。min 以上 max 未満）。 */
export const FLICK_RANGES = {
  near: { name: { ja: '近い', en: 'Near' }, min: 3, max: 8 },
  normal: { name: { ja: 'ふつう', en: 'Normal' }, min: 8, max: 14 },
  far: { name: { ja: '遠い', en: 'Far' }, min: 14, max: 20 },
} as const;

/** 的の大きさ（見込み角、度。幅と高さ）。 */
export const FLICK_SIZES = {
  large: { name: { ja: '大', en: 'Large' }, angle: 3 },
  medium: { name: { ja: '中', en: 'Medium' }, angle: 2 },
  small: { name: { ja: '小', en: 'Small' }, angle: 1 },
} as const;

export type FlickRange = keyof typeof FLICK_RANGES;
export type FlickSize = keyof typeof FLICK_SIZES;

/** 出る範囲の選択肢。開いたときは「ふつう」。 */
export const FLICK_RANGE_OPTION: ModeOption = {
  id: 'flick-range',
  label: { ja: '出る範囲', en: 'Spawn range' },
  choices: (Object.keys(FLICK_RANGES) as FlickRange[]).map((id) => ({ id, name: FLICK_RANGES[id].name })),
  defaultChoice: 'normal',
};

/** 的の大きさの選択肢。開いたときは「中」。 */
export const FLICK_SIZE_OPTION: ModeOption = {
  id: 'flick-size',
  label: { ja: '的の大きさ', en: 'Target size' },
  choices: (Object.keys(FLICK_SIZES) as FlickSize[]).map((id) => ({ id, name: FLICK_SIZES[id].name })),
  defaultChoice: 'medium',
};

/** 練習の選択肢（出る範囲、的の大きさの順。保存のキーにもこの順に値の id を足す）。 */
export const FLICK_OPTIONS: readonly ModeOption[] = [FLICK_RANGE_OPTION, FLICK_SIZE_OPTION];

/** 的の板の奥行き（メートル）。 */
const PLATE_DEPTH = 0.02;
/** マップの箱のいちばん手前の面と、的の板の奥の面のあいだ（メートル）。 */
const PLATE_GAP = 0.05;

/** 練習の選択肢の値から出る範囲と的の大きさを読む。選べない値は既定の値。 */
export function flickSettings(values: ModeOptionValues): { readonly range: FlickRange; readonly size: FlickSize } {
  const rangeId = values[FLICK_RANGE_OPTION.id];
  const sizeId = values[FLICK_SIZE_OPTION.id];
  const range = rangeId !== undefined && rangeId in FLICK_RANGES ? (rangeId as FlickRange) : 'normal';
  const size = sizeId !== undefined && sizeId in FLICK_SIZES ? (sizeId as FlickSize) : 'medium';
  return { range, size };
}

/**
 * 1 回の練習の的の出る位置の並び（照準の中心からのずれ Δyaw・Δpitch、度）。角度の距離を出る範囲の区間から一様に、
 * ずれの向きを水平から上下 FLICK_DIRECTION_SPREAD 度以内（右向きと左向きを半々）で一様に選ぶ。乱数だけから決まる。
 */
export function flickOffsets(random: Random, range: FlickRange, count: number = FLICK_TARGET_COUNT): Angles[] {
  const { min, max } = FLICK_RANGES[range];
  const offsets: Angles[] = [];
  for (let i = 0; i < count; i += 1) {
    const distance = min + (max - min) * random.next();
    const tilt = (random.next() * 2 - 1) * FLICK_DIRECTION_SPREAD * (Math.PI / 180);
    const side = random.next() < 0.5 ? 1 : -1;
    offsets.push({ yaw: side * distance * Math.cos(tilt), pitch: distance * Math.sin(tilt) });
  }
  return offsets;
}

/** マップの箱のいちばん手前（目の側、+Z）の面の Z。開始時の照準は -Z を向く（src/data/maps/range.json）。 */
function frontZ(boxes: readonly Box[]): number {
  return Math.max(...boxes.map((b) => b.center.z + b.size.z / 2));
}

/**
 * 照準の中心からのずれ offset の向きに置く的の板の中心と大きさ。目の位置からその向きのレイ上で、マップの箱（壁と的の箱）の
 * いちばん手前の面より手前に、壁の正面と平行な正方形の板として置く。幅と高さは 2 × L × tan(見込み角 ÷ 2)（L は目から的の中心まで）。
 */
export function flickPlate(world: Pick<World, 'boxes' | 'center' | 'player'>, offset: Angles, size: FlickSize): { readonly center: Vec3; readonly size: Vec3 } {
  const eye = world.player.position;
  const dir = directionFromAngles(addAngles(world.center, offset));
  const plateZ = frontZ(world.boxes) + PLATE_GAP + PLATE_DEPTH / 2;
  const t = (plateZ - eye.z) / dir.z;
  const center = vec3(eye.x + dir.x * t, eye.y + dir.y * t, plateZ);
  const distance = Math.hypot(center.x - eye.x, center.y - eye.y, center.z - eye.z);
  const width = 2 * distance * Math.tan((FLICK_SIZES[size].angle * Math.PI) / 360);
  return { center, size: vec3(width, width, PLATE_DEPTH) };
}

/** 撃った的 1 つの記録（docs/spec/modes.md「フリック」）。 */
export interface FlickRecord {
  /** その的を撃ったステップの終わりの時刻 − 出現の時刻（秒）。 */
  readonly time: number;
  /** その的に当たったか。 */
  readonly hit: boolean;
  /** 撃ったときの照準の向きと、目の位置から的の中心への向きの角度の距離（度）。 */
  readonly error: number;
}

/** フリックのモードの結果（採点に渡す）。 */
export interface FlickResult extends Record<string, unknown> {
  readonly settings: { readonly range: FlickRange; readonly size: FlickSize };
  /** 1〜20 個目の的の出る位置（照準の中心からのずれ、度）。撃ったかによらず、練習の始めに決めた並び。 */
  readonly offsets: readonly Angles[];
  /** 撃った的の記録。撃った順。 */
  readonly targets: readonly FlickRecord[];
}

interface FlickState {
  readonly offsets: readonly Angles[];
  readonly size: FlickSize;
  readonly records: FlickRecord[];
  /** 調べ終えた弾の数。 */
  seenShots: number;
  /** 今出ている（または出る前の）的の識別子と出現の時刻。撃ち終えたら undefined。 */
  current: { readonly id: string; readonly index: number; readonly appearAt: number } | undefined;
}

/** 練習ごとの状態。モードのオブジェクトは使い回すので、練習の context ごとに持つ。 */
const states = new WeakMap<ModeContext, FlickState>();

function stateOf(context: ModeContext): FlickState {
  const state = states.get(context);
  if (!state) throw new Error('flick practice state is missing (called before setup)');
  return state;
}

const targetId = (index: number) => `flick-${index + 1}`;

function placeTarget(context: ModeContext, state: FlickState, index: number, appearAt: number): void {
  const offset = state.offsets[index];
  if (!offset) return;
  const plate = flickPlate(context.world, offset, state.size);
  const id = targetId(index);
  context.targets.add({ id, size: plate.size, position: plate.center, appearAt });
  state.current = { id, index, appearAt };
}

/** 2 つの向きの角度の距離（水平と垂直の差の √(h² + v²)、度）。 */
function angularDistance(a: Angles, b: Angles): number {
  return Math.hypot(normalizeYaw(a.yaw - b.yaw), a.pitch - b.pitch);
}

const seconds = (value: number) => t('unit.secondsValue', { value: value.toFixed(3) });

/** 命中 1 回あたりの時間（秒）。比べる指標で、小さいほど良い。0 より大きい有限の数。 */
export const TIME_PER_HIT_METRIC: CompareMetric = {
  id: 'timePerHit',
  get label() {
    return t('metric.timePerHit');
  },
  get unit() {
    return t('unit.seconds');
  },
  better: 'lower',
  get averageLabel() {
    return t('metric.timePerHitAverage');
  },
  format: seconds,
  valid: (value) => value > 0,
};

const MEAN_TIME: MetricSpec = {
  id: 'meanTime',
  get label() {
    return t('metric.meanTime');
  },
  get unit() {
    return t('unit.seconds');
  },
  format: seconds,
};
const HIT_RATE: MetricSpec = {
  id: 'hitRate',
  get label() {
    return t('metric.hitRate');
  },
  unit: '%',
  format: (value) => `${value.toFixed(1)}%`,
};
const MEAN_ERROR: MetricSpec = {
  id: 'meanError',
  get label() {
    return t('metric.meanOffset');
  },
  unit: '°',
  format: (value) => `${value.toFixed(2)}°`,
};

function isRecordList(value: unknown): value is FlickRecord[] {
  return (
    Array.isArray(value) &&
    value.every(
      (r: unknown) =>
        typeof r === 'object' &&
        r !== null &&
        Number.isFinite((r as FlickRecord).time) &&
        typeof (r as FlickRecord).hit === 'boolean' &&
        Number.isFinite((r as FlickRecord).error),
    )
  );
}

/** フリックの指標（docs/spec/scoring.md「フリックの採点」）。撃った的の数が 0 のときはすべて null。 */
export interface FlickScore {
  readonly timePerHit: number | null;
  readonly meanTime: number | null;
  readonly hitRate: number | null;
  readonly hits: number;
  readonly targets: number;
  readonly meanError: number | null;
}

/** 撃った的の記録から指標を求める。命中が 0 のときは命中 1 回あたりの時間だけが null。 */
export function scoreFlick(records: readonly FlickRecord[]): FlickScore {
  const n = records.length;
  const hits = records.filter((r) => r.hit).length;
  if (n === 0) return { timePerHit: null, meanTime: null, hitRate: null, hits: 0, targets: 0, meanError: null };
  const totalTime = records.reduce((sum, r) => sum + r.time, 0);
  return {
    timePerHit: hits === 0 ? null : totalTime / hits,
    meanTime: totalTime / n,
    hitRate: (hits / n) * 100,
    hits,
    targets: n,
    meanError: records.reduce((sum, r) => sum + r.error, 0) / n,
  };
}

const orNone = (spec: Pick<MetricSpec, 'format'>, value: number | null) => (value === null ? t('none') : spec.format(value));

/** フリックの採点。記録（モードの結果の targets）だけから決める。 */
export const FLICK_SCORING: ModeScoring = {
  compare: TIME_PER_HIT_METRIC,
  columns: [MEAN_TIME, HIT_RATE, MEAN_ERROR],
  score({ modeResult }: ScoringInput): ModeScore {
    const records = isRecordList(modeResult.targets) ? modeResult.targets : [];
    const s = scoreFlick(records);
    const rate = orNone(HIT_RATE, s.hitRate);
    return {
      value: s.timePerHit,
      metrics: [
        { label: TIME_PER_HIT_METRIC.label, value: orNone(TIME_PER_HIT_METRIC, s.timePerHit) },
        { label: MEAN_TIME.label, value: orNone(MEAN_TIME, s.meanTime) },
        { label: HIT_RATE.label, value: rate },
        { label: t('metric.hits'), value: s.targets === 0 ? t('none') : `${s.hits} / ${s.targets}` },
        { label: MEAN_ERROR.label, value: orNone(MEAN_ERROR, s.meanError) },
      ],
      fields: { meanTime: s.meanTime ?? 0, hitRate: s.hitRate ?? 0, hits: s.hits, targets: s.targets, meanError: s.meanError ?? 0 },
      share: `${TIME_PER_HIT_METRIC.label}: ${orNone(TIME_PER_HIT_METRIC, s.timePerHit)} / ${HIT_RATE.label}: ${rate}`,
    };
  },
};

const flick: TrainingMode<FlickResult> = {
  id: 'flick',
  name: { ja: 'フリック', en: 'Flick' },
  description: { ja: 'ランダムに出る的へ素早く照準を合わせて撃つ', en: 'Snap to targets that appear at random spots and shoot fast' },
  icon: 'flick',
  category: 'aim',
  // 反復練習（20）・追いエイム（30）・追いエイム＋リコイル（40）のあとに並ぶ（docs/spec/modes.md「モードの登録」）。
  order: 50,
  usesWeapon: false,
  scoring: FLICK_SCORING,
  options: FLICK_OPTIONS,

  setup(context) {
    const { range, size } = flickSettings(context.options);
    const state: FlickState = { offsets: flickOffsets(context.random, range), size, records: [], seenShots: 0, current: undefined };
    states.set(context, state);
    placeTarget(context, state, 0, FLICK_FIRST_APPEAR);
  },

  step(context) {
    const state = stateOf(context);
    const { shots, targets, world } = context;
    for (; state.seenShots < shots.length; state.seenShots += 1) {
      const shot = shots[state.seenShots];
      const current = state.current;
      // 1 個目の的が出る前の弾は、どの的の弾にも数えない。
      if (!shot || !current || !targets.get(current.id)?.visible) continue;
      const target = targets.get(current.id);
      if (!target) continue;
      state.records.push({
        time: context.time - current.appearAt,
        hit: shot.target === current.id,
        error: angularDistance(shot.angles, anglesToPoint(world.player.position, target.center)),
      });
      // 当たっても外れても、その的は消え、次の的がこのステップの終わりの時刻を出現の時刻として出る。
      targets.remove(current.id);
      state.current = undefined;
      placeTarget(context, state, current.index + 1, context.time);
    }
    return state.records.length < FLICK_TARGET_COUNT;
  },

  result(context) {
    const state = stateOf(context);
    return { settings: flickSettings(context.options), offsets: state.offsets, targets: [...state.records] };
  },

  // 状態は context と一緒に捨てられる（WeakMap）。終わったあとの HUD の表示（20 / 20）にも使うので、ここでは消さない。
  teardown() {},

  status(context) {
    const state = states.get(context);
    return state ? t('mode.flickTargets', { done: state.records.length, total: FLICK_TARGET_COUNT }) : undefined;
  },
};

export default flick;
