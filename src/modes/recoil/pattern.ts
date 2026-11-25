import type { ModeResult, TrainingMode } from '../types';

/**
 * パターン観察（docs/spec/modes.md）。補正の有無にかかわらず弾痕を残し、ゴーストは表示せず、採点しない。
 * 弾痕の記録と表示、練習の終わりはモードによらない共通の処理が行うので、このモードが足すことはない。
 */
const pattern: TrainingMode<ModeResult> = {
  id: 'pattern',
  name: 'パターン観察',
  category: 'recoil',
  order: 10,
  setup() {},
  step() {
    return true;
  },
  result() {
    return { scored: false };
  },
  teardown() {},
};

export default pattern;
