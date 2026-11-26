// テストで使うエイムのモードと指標。製品のビルドにはエイムのモードがないので、モードの型の公開された形だけで作る。
import type { CompareMetric, ModeContext, ModeScoring, TrainingMode } from '../../src/modes/types';
import { vec3, type Vec3 } from '../../src/sim/vec3';

/** 大きいほど良い命中数（docs/spec/scoring.md の SCO-40・UI-97 の例）。 */
export const HIT_COUNT: CompareMetric = {
  id: 'hits',
  label: '命中数',
  unit: '',
  better: 'higher',
  format: (value) => String(value),
  valid: (value) => Number.isInteger(value) && value >= 0,
};

/** 弾の記録のうち練習の的に当たった弾の数を比べる指標にする採点。 */
export const HIT_COUNT_SCORING: ModeScoring = {
  compare: HIT_COUNT,
  columns: [{ id: 'shots', label: '撃った弾数', unit: '', format: (value) => String(value) }],
  score: ({ shots }) => {
    const hits = shots.filter((s) => s.target !== undefined).length;
    return {
      value: hits,
      metrics: [
        { label: '命中数', value: String(hits) },
        { label: '撃った弾数', value: String(shots.length) },
      ],
      fields: { shots: shots.length },
    };
  },
};

export interface AimModeOptions {
  readonly id?: string;
  readonly usesWeapon?: boolean;
  readonly timeLimit?: number;
  /** setup で置く練習の的。 */
  readonly targets?: (context: ModeContext) => void;
  /** ステップごとの処理。省くと続ける。 */
  readonly step?: (context: ModeContext) => boolean;
}

/** 命中数で採点するエイムのモード。 */
export function aimMode(options: AimModeOptions = {}): TrainingMode {
  return {
    id: options.id ?? 'aim-test',
    name: 'エイムのテスト',
    category: 'aim',
    order: 100,
    usesWeapon: options.usesWeapon ?? false,
    ...(options.timeLimit === undefined ? {} : { timeLimit: options.timeLimit }),
    scoring: HIT_COUNT_SCORING,
    setup(context) {
      options.targets?.(context);
    },
    step(context) {
      return options.step?.(context) ?? true;
    },
    result() {
      return {};
    },
    teardown() {},
  };
}

/** 大きさ 1 メートル四方・奥行き 0.2 メートルの的。 */
export const TARGET_SIZE: Vec3 = vec3(1, 1, 0.2);
