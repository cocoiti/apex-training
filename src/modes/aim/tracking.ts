import { createTrackingMode } from '../tracking';

/**
 * 追いエイム（docs/spec/modes.md「追いエイム」）。左右に動く的に照準を乗せ続ける、リコイルをかけない練習。
 * 武器を使わず、fire は採点に使わない。
 */
export default createTrackingMode({ id: 'tracking', name: '追いエイム', description: '左右に動く的に照準を乗せ続ける', order: 30, recoil: false });
