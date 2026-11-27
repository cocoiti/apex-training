import { addAngles, type Angles } from '../../sim/angles';
import type { Gun } from '../../sim/gun';
import { humanoidPlate, placeHumanoid } from '../../sim/humanoid';
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

/** 反復練習の人型の板の練習の的の識別子。 */
export const DRILL_DUMMY_ID = 'dummy';

/**
 * 反復練習（docs/spec/modes.md）。壁の手前に縮尺 1 の人型の板を 1 枚、練習のあいだずっと置く。板は弾痕を残す練習の的で、
 * 正面に的のリングと中心点を描く（開始時の照準は板の中心を向く）。補正のパネルを主な補助として必ず出し、採点する。id は表示名を変える前の `ghost` のまま
 * （履歴・自己ベストの保存のキーに使っている）。3D の中のゴーストは src/render/ghost.ts が ghost の返す向きで描き、
 * 設定のゴースト表示が OFF（既定）なら描画しない。
 * 採点はモードによらない共通の処理が行うので、結果に足すものはない。
 */
const ghost: TrainingMode<ModeResult> = {
  id: 'ghost',
  name: { ja: '反復練習', en: 'Recoil Drill' },
  description: {
    ja: '同じ武器のリコイルを繰り返し撃って、パターンを手に覚えさせる',
    en: "Fire the same weapon's recoil again and again until the pattern is in your hands",
  },
  icon: 'spray',
  category: 'recoil',
  order: 20,
  correctionPanel: 'always',
  setup(context) {
    const { world } = context;
    // 板の中心はマップの開始時の照準（採点の中心）のレイの上にある。
    const dummy = placeHumanoid(world, world.center, 1);
    context.targets.add({ id: DRILL_DUMMY_ID, plate: humanoidPlate(dummy.scale), position: dummy.center, keepsImpacts: true, rings: true });
  },
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
