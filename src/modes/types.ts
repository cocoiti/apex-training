import type { Random } from '../core/random';
import type { Angles } from '../sim/angles';
import type { Gun } from '../sim/gun';
import type { World } from '../sim/world';

export type ModeCategory = 'recoil' | 'movement' | 'combined';

/** 練習モードに渡すもの。シミュレーションの状態、その練習の武器（残弾・弾痕の記録）、種付きの乱数。 */
export interface ModeContext {
  readonly world: World;
  readonly gun: Gun;
  readonly random: Random;
}

/** 練習モードの結果のうち、どのモードにもあるもの。 */
export interface ModeResult {
  /** 採点するモードか（docs/spec/modes.md）。採点の中身はリザルトの Issue で足す。 */
  readonly scored: boolean;
}

/**
 * 練習モードの共通の型（docs/spec/architecture.md「モードとマップの追加」）。
 * 準備 → ステップごとの処理 → 結果 → 片付けの順に呼ぶ。
 * モードのファイル（`src/modes/<category>/*.ts`）はこの型を default で export する（src/modes/registry.ts）。
 * 1 つのモードを練習ごとに使い回すので、練習ごとの状態は setup で作り直す。
 */
export interface TrainingMode<TResult extends ModeResult = ModeResult> {
  readonly id: string;
  readonly name: string;
  readonly category: ModeCategory;
  /** トップ画面の選択肢の並び順。小さいほど前。同じならファイル名の順。 */
  readonly order: number;
  /** 練習の開始時に 1 回呼ぶ。 */
  setup(context: ModeContext): void;
  /**
   * 固定ステップごとに、入力と射撃を適用したあとに呼ぶ。練習を続けるなら true、終えるなら false を返す。
   * 撃ち切りと撃たない時間による終わりは、モードによらず練習の側で判定する（src/sim/practice.ts）。
   */
  step(context: ModeContext, dt: number): boolean;
  /** 練習の結果を返す。 */
  result(context: ModeContext): TResult;
  /** 練習の終わりに 1 回呼ぶ。 */
  teardown(context: ModeContext): void;
  /**
   * ゴーストを表示するモードだけが持つ。今のステップの状態からゴーストの向き（ヨー・ピッチ、度）を返し、
   * 表示しないときは undefined を返す。描画のたびに呼ぶので、シミュレーションの状態を変えない（docs/spec/modes.md「ゴースト追従」）。
   */
  ghost?(context: ModeContext): Angles | undefined;
}
