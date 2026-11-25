import type { ModeResult, TrainingMode } from '../types';

/**
 * センター維持（docs/spec/modes.md）。ゴーストを表示せず、中心の的に弾をまとめる。設定が ON なら補正のパネルを出す。採点する。
 * 採点はモードによらない共通の処理が行うので、結果に足すものはない。
 */
const center: TrainingMode<ModeResult> = {
  id: 'center',
  name: 'センター維持',
  category: 'recoil',
  order: 30,
  correctionPanel: 'setting',
  setup() {},
  step() {
    return true;
  },
  result() {
    return {};
  },
  teardown() {},
};

export default center;
