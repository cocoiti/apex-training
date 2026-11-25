/**
 * アクションの定義。入力方式（マウス・パッド）の差はここより手前で吸収し、
 * シミュレーションはアクションと角度（度）だけを扱う（docs/spec/input.md）。
 */

/** 照準の角度の変化（度）。ヨーは右が正、ピッチは上が正。 */
export interface LookAction {
  type: 'look';
  yaw: number;
  pitch: number;
}

export interface FireAction {
  type: 'fire';
  pressed: boolean;
}

export interface AdsAction {
  type: 'ads';
  pressed: boolean;
}

export type Action = LookAction | FireAction | AdsAction;

/** 発生時刻（練習の開始からの秒）付きのアクション。 */
export interface TimedAction {
  time: number;
  action: Action;
}
