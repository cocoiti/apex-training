import { humanoidParts } from '../sim/humanoid';
import { viewAngles } from '../sim/player';
import {
  angleToPoint,
  createTrackingMotion,
  scoreTracking,
  TRACKING_DURATION,
  TRACKING_SPEEDS,
  trackingHitRate,
  type TrackingMotion,
  type TrackingSpeedId,
  type TrackingStep,
} from '../sim/tracking';
import { t } from '../ui/i18n';
import type { CompareMetric, Localized, MetricSpec, ModeOption, ModeResult, ModeScoring, ScoreRow, TrainingMode } from './types';

/**
 * 追いエイム（docs/spec/modes.md「追いエイム」）の 2 つのモード（リコイルなし・あり）の共通の作り。
 * モードのファイル（src/modes/aim/tracking.ts・tracking-recoil.ts）が createTrackingMode で作って default で export する。
 * このファイルは src/modes/<category>/ の外に置き、モードの一覧（src/modes/registry.ts）には入らない。
 */

/** 練習の的の識別子。 */
export const TRACKING_TARGET_ID = 'tracking';

/** 速さの選択肢（docs/spec/modes.md「追いエイム」）。2 つのモードで同じものを使い、トップ画面と履歴の画面で選んだ値を共有する。 */
export const SPEED_OPTION: ModeOption = {
  id: 'speed',
  label: { ja: '速さ', en: 'Speed' },
  choices: [
    { id: 'slow', name: { ja: '遅い', en: 'Slow' } },
    { id: 'normal', name: { ja: 'ふつう', en: 'Normal' } },
    { id: 'fast', name: { ja: '速い', en: 'Fast' } },
  ],
  defaultChoice: 'normal',
};

/** 乗っていた割合（%、0〜100）。大きいほど良い比べる指標。 */
export const ON_TARGET_RATE_METRIC: CompareMetric = {
  id: 'onTargetRate',
  get label() {
    return t('metric.onTargetRate');
  },
  unit: '%',
  better: 'higher',
  get averageLabel() {
    return t('metric.onTargetRateAverage');
  },
  format: (value) => `${value.toFixed(1)}%`,
  valid: (value) => value >= 0 && value <= 100,
};

export const OFF_TARGET_ERROR_METRIC: MetricSpec = {
  id: 'offTargetError',
  get label() {
    return t('metric.offTargetError');
  },
  unit: '°',
  format: (value) => `${value.toFixed(2)}°`,
};
export const REACQUIRE_TIME_METRIC: MetricSpec = {
  id: 'reacquireTime',
  get label() {
    return t('metric.reacquireTime');
  },
  get unit() {
    return t('unit.seconds');
  },
  format: (value) => t('unit.secondsValue', { value: value.toFixed(2) }),
};
export const TRACKING_HIT_RATE_METRIC: MetricSpec = {
  id: 'hitRate',
  get label() {
    return t('metric.hitRate');
  },
  unit: '%',
  format: (value) => `${value.toFixed(1)}%`,
};
export const TRACKING_SHOTS_METRIC: MetricSpec = {
  id: 'shots',
  get label() {
    return t('metric.shots');
  },
  unit: '',
  format: (value) => String(Math.round(value)),
};

/** 追いエイムのモードの結果。採点に渡す。 */
export interface TrackingResult extends ModeResult {
  /** 練習の各ステップの記録。ステップの順。 */
  readonly steps: readonly TrackingStep[];
  /** 練習中の切り返しの時刻（秒）。時刻の順。 */
  readonly reversals: readonly number[];
  /** 固定ステップの長さ（秒）。 */
  readonly dt: number;
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** 結果から、採点に使う記録を取り出す。形が合わないときは空の記録。 */
function trackingRecord(result: ModeResult): TrackingResult {
  const steps = Array.isArray(result.steps) ? (result.steps as TrackingStep[]) : [];
  const reversals = Array.isArray(result.reversals) ? (result.reversals as unknown[]).filter(isNumber) : [];
  const dt = isNumber(result.dt) && result.dt > 0 ? result.dt : 1;
  return { steps, reversals, dt };
}

const row = (metric: MetricSpec, value: number | null): ScoreRow => ({ label: metric.label, value: value === null ? t('none') : metric.format(value) });

/** 追いエイムの採点（docs/spec/scoring.md「追いエイムの採点」）。withShots はリコイルありのモードで、命中率と撃った弾数を足す。 */
export function trackingScoring(withShots: boolean): ModeScoring {
  return {
    compare: ON_TARGET_RATE_METRIC,
    columns: [OFF_TARGET_ERROR_METRIC, REACQUIRE_TIME_METRIC, ...(withShots ? [TRACKING_HIT_RATE_METRIC, TRACKING_SHOTS_METRIC] : [])],
    score: ({ shots, modeResult }) => {
      const record = trackingRecord(modeResult);
      const score = scoreTracking(record.steps, record.reversals, record.dt);
      const hitRate = withShots ? trackingHitRate(shots) : null;
      const values: [MetricSpec, number | null][] = [
        [OFF_TARGET_ERROR_METRIC, score.offTargetError],
        [REACQUIRE_TIME_METRIC, score.reacquireTime],
        ...(withShots
          ? ([
              [TRACKING_HIT_RATE_METRIC, hitRate],
              [TRACKING_SHOTS_METRIC, shots.length],
            ] as [MetricSpec, number | null][])
          : []),
      ];
      // 「なし」の指標の項目は保存しない（docs/spec/scoring.md「保存の形」）。
      const fields = Object.fromEntries(values.filter((v): v is [MetricSpec, number] => v[1] !== null).map(([m, v]) => [m.id, v]));
      return {
        value: score.onTargetRate,
        metrics: [row(ON_TARGET_RATE_METRIC, score.onTargetRate), ...values.map(([m, v]) => row(m, v))],
        fields,
      };
    },
  };
}

/** 速さの id の的の速さ（メートル毎秒）。知らない id はふつう。 */
export function trackingSpeed(id: string | undefined): number {
  return id !== undefined && id in TRACKING_SPEEDS ? TRACKING_SPEEDS[id as TrackingSpeedId] : TRACKING_SPEEDS.normal;
}

export interface TrackingModeSpec {
  readonly id: string;
  /** 表示名（日本語と英語）。 */
  readonly name: Localized;
  /** トップ画面のモードのカードに出すひとこと説明（日本語と英語）。 */
  readonly description: Localized;
  readonly order: number;
  /** リコイルをかけるか。かけるモードは武器を使い、撃ち切ったあと fire を離すと残弾を戻す。 */
  readonly recoil: boolean;
}

/** 追いエイムのモードを作る。練習ごとの状態は setup で作り直す。 */
export function createTrackingMode(spec: TrackingModeSpec): TrainingMode<TrackingResult> {
  let motion: TrackingMotion | undefined;
  let steps: TrackingStep[] = [];
  let dt = 0;
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    icon: spec.recoil ? 'track-spray' : 'track',
    category: 'aim',
    order: spec.order,
    usesWeapon: spec.recoil,
    refillOnRelease: spec.recoil,
    timeLimit: TRACKING_DURATION,
    scoring: trackingScoring(spec.recoil),
    directionSound: false,
    options: [SPEED_OPTION],
    setup(context) {
      const { player } = context.world;
      // 開始時の照準は的の中心（基準の点）を向く。
      motion = createTrackingMotion(context.random, { eye: player.position, aim: viewAngles(player), speed: trackingSpeed(context.options[SPEED_OPTION.id]) });
      const current = motion;
      steps = [];
      dt = 0;
      // 的は縮尺 1 の人形で、的の中心（人形の中心 = 胴の中心）が動きの位置にある。
      context.targets.add({ id: TRACKING_TARGET_ID, parts: humanoidParts(1), position: (time) => current.positionAt(time), highlightAimed: true });
    },
    step(context, stepDt) {
      dt = stepDt;
      const target = context.targets.get(TRACKING_TARGET_ID);
      const { player } = context.world;
      // 照準の向きはリコイルのオフセットを含めた向き（クロスヘアの向き）。
      if (target) steps.push({ on: context.targets.isAimed(TRACKING_TARGET_ID), offAngle: angleToPoint(player.position, viewAngles(player), target.center) });
      return true;
    },
    result() {
      // 練習の終わりの時刻は、記録したステップの数から求める（終わりの判定のあとに呼ばれる）。
      const end = steps.length * dt;
      return { steps: [...steps], reversals: (motion?.reversals ?? []).map((r) => r.time).filter((t) => t <= end + 1e-9), dt };
    },
    teardown() {},
  };
}
