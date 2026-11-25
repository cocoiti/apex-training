import type { MouseSettings } from '../input/mouse-sensitivity';
import type { PadSettings } from '../input/pad-curve';
import { applyCrosshair, type CrosshairElement } from './crosshair';
import { effectivePadSettings, loadCommonSettings, loadMouseSettings, loadPadSettings } from './settings';
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
  /** 補正のパネル（ON/OFF）。モードと入力方式によらず、練習中のプレイ画面に出すか（docs/spec/screens.md「補正のパネル」）。 */
  readonly correctionPanel: boolean;
  /** マウスの換算に使う DPI・感度・ADS 倍率。 */
  readonly mouse: MouseSettings;
  /** スティックの換算に使う値。簡易設定のときは対応表で置き換えた値（docs/spec/pad.md「パッドの設定画面」）。 */
  readonly pad: PadSettings;
  /** パッドの振動（ON/OFF）。 */
  readonly vibration: boolean;
}

/**
 * 「開始」を押した時点の保存された設定を練習に当てる（docs/spec/screens.md「設定の保存と読み出し」）。
 * FOV はカメラの視野角に、クロスヘアの色と形はプレイ画面のクロスヘアに当て、ゴースト表示・補正のパネルとマウス・パッドの設定は返す。
 */
export function applyPracticeSettings(storage: Pick<SafeStorage, 'get'>, targets: PracticeSettingTargets): PracticeSettings {
  const common = loadCommonSettings(storage);
  targets.view.setFov(common.fov);
  if (targets.crosshair) applyCrosshair(targets.crosshair, { shape: common.crosshairShape, color: common.crosshairColor });
  const pad = loadPadSettings(storage);
  return { ghost: common.ghost, correctionPanel: common.correctionPanel, mouse: loadMouseSettings(storage), pad: effectivePadSettings(pad), vibration: pad.vibration };
}
