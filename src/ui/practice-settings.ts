import type { MouseSettings } from '../input/mouse-sensitivity';
import { applyCrosshair, type CrosshairElement } from './crosshair';
import { loadCommonSettings, loadMouseSettings } from './settings';
import type { SafeStorage } from './storage';

/** 練習の始めに設定を当てる先。view はカメラ（src/render/scene.ts の ViewScene）、crosshair はプレイ画面のクロスヘア。 */
export interface PracticeSettingTargets {
  readonly view: { setFov(fov: number): void };
  readonly crosshair: CrosshairElement | null;
}

/** 練習のあいだ使う、当てる先のない設定。 */
export interface PracticeSettings {
  /** ゴースト表示（ON/OFF）。ゴーストを表示するモードだけが使う。 */
  readonly ghost: boolean;
  /** マウスの換算に使う DPI・感度・ADS 倍率。 */
  readonly mouse: MouseSettings;
}

/**
 * 「開始」を押した時点の保存された設定を練習に当てる（docs/spec/screens.md「設定の保存と読み出し」）。
 * FOV はカメラの視野角に、クロスヘアの色と形はプレイ画面のクロスヘアに当て、ゴースト表示とマウスの設定は返す。
 */
export function applyPracticeSettings(storage: Pick<SafeStorage, 'get'>, targets: PracticeSettingTargets): PracticeSettings {
  const common = loadCommonSettings(storage);
  targets.view.setFov(common.fov);
  if (targets.crosshair) applyCrosshair(targets.crosshair, { shape: common.crosshairShape, color: common.crosshairColor });
  return { ghost: common.ghost, mouse: loadMouseSettings(storage) };
}
