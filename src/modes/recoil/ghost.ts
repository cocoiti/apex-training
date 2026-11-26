import { addAngles, type Angles } from '../../sim/angles';
import type { Gun } from '../../sim/gun';
import { idealCorrection } from '../../sim/weapon';
import type { World } from '../../sim/world';
import type { ModeResult, TrainingMode } from '../types';

/**
 * ゴーストの向き（docs/spec/modes.md「反復練習」）。
 * 「マップの開始時の照準 + 次の弾の理想の補正軌道 + 今のリコイルの累積」（ヨー・ピッチ、度）。
 * 次の弾は Gun が次に使うパターンの発で、撃つ前と戻りきったあとは 1 発目。撃ち切った（残弾 0）ときは undefined（表示しない）。
 * World と Gun は読むだけで、書き換えない。
 */
export function ghostAngles(world: Readonly<Pick<World, 'center' | 'player'>>, gun: Readonly<Pick<Gun, 'ammo' | 'nextPatternShot' | 'weapon'>>): Angles | undefined {
  if (gun.ammo === 0) return undefined;
  const ideal = idealCorrection(gun.weapon)[gun.nextPatternShot - 1];
  if (!ideal) return undefined;
  const { recoilOffset } = world.player;
  return addAngles(world.center, { yaw: ideal.yaw + recoilOffset.yaw, pitch: ideal.pitch + recoilOffset.pitch });
}

/**
 * 反復練習（docs/spec/modes.md）。補正のパネルを主な補助として必ず出し、採点する。id は表示名を変える前の `ghost` のまま
 * （履歴・自己ベストの保存のキーに使っている）。3D の中のゴーストは src/render/ghost.ts が ghost の返す向きで描き、
 * 設定のゴースト表示が OFF（既定）なら描画しない。
 * 採点はモードによらない共通の処理が行うので、結果に足すものはない。
 */
const ghost: TrainingMode<ModeResult> = {
  id: 'ghost',
  name: '反復練習',
  category: 'recoil',
  order: 20,
  correctionPanel: 'always',
  setup() {},
  step() {
    return true;
  },
  result() {
    return {};
  },
  teardown() {},
  ghost(context) {
    return context.gun ? ghostAngles(context.world, context.gun) : undefined;
  },
};

export default ghost;
