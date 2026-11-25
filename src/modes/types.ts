import type { Random } from '../core/random';
import type { World } from '../sim/world';

export type ModeCategory = 'recoil' | 'movement' | 'combined';

/** 練習モードに渡すもの。シミュレーションの状態と種付きの乱数。 */
export interface ModeContext {
  readonly world: World;
  readonly random: Random;
}

/**
 * 練習モードの共通の型（docs/spec/architecture.md「モードとマップの追加」）。
 * 準備 → ステップごとの処理 → 結果 → 片付けの順に呼ぶ。
 */
export interface TrainingMode<TResult = unknown> {
  readonly id: string;
  readonly name: string;
  readonly category: ModeCategory;
  /** 練習の開始時に 1 回呼ぶ。 */
  setup(context: ModeContext): void;
  /** 固定ステップごとに、入力を適用したあとに呼ぶ。練習を続けるなら true、終えるなら false を返す。 */
  step(context: ModeContext, dt: number): boolean;
  /** 練習の結果を返す。 */
  result(context: ModeContext): TResult;
  /** 練習の終わりに 1 回呼ぶ。 */
  teardown(context: ModeContext): void;
}
