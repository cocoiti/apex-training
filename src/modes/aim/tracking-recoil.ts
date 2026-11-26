import { createTrackingMode } from '../tracking';

/**
 * 追いエイム＋リコイル（docs/spec/modes.md「追いエイム」）。トップ画面で選んだ武器のリコイルをかけながら、左右に動く的を追う練習。
 * 撃ち切ったあと fire を離すと残弾が装弾数に戻り、撃ち切りと「離して 2 秒」では終わらない。
 */
export default createTrackingMode({
  id: 'tracking-recoil',
  name: { ja: '追いエイム＋リコイル', en: 'Tracking + Recoil' },
  description: { ja: 'リコイルを抑えながら、動く的に照準を乗せ続ける', en: 'Keep your crosshair on a moving target while controlling recoil' },
  order: 40,
  recoil: true,
});
