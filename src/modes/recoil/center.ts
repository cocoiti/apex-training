import type { ModeResult, TrainingMode } from '../types';

/**
 * センター維持（docs/spec/modes.md）。ゴーストを表示せず、中心の的に弾をまとめる。設定が ON なら補正のパネルを出す。採点する。
 * 採点の指標はリザルトの Issue で足す。ここでは採点するモードであることだけを結果に載せる。
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
    return { scored: true };
  },
  teardown() {},
};

export default center;
