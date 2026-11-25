import { INPUT_METHOD_LABELS, type InputMethod } from '../input/input-switch';

/** HUD に出すもの（docs/spec/modes.md「共通」）。 */
export interface HudState {
  readonly weaponName: string;
  readonly ammo: number;
  readonly magSize: number;
  /** 練習の開始からの時間（秒、固定ステップの時刻）。 */
  readonly elapsed: number;
  /** 今の入力方式（docs/spec/input.md「入力方式の切替」）。 */
  readonly inputMethod: InputMethod;
}

export interface HudTexts {
  readonly weapon: string;
  readonly ammo: string;
  readonly time: string;
  readonly input: string;
}

/** 経過時間を秒の小数第 1 位までにする。切り捨てるので、2 秒たつまで「2.0」にならない。 */
export function formatElapsed(seconds: number): string {
  // 固定ステップの時刻の浮動小数の誤差で 0.1 秒の境目を切り捨てすぎないよう、わずかに足してから切り捨てる。
  const tenths = Math.floor(Math.max(seconds, 0) * 10 + 1e-6);
  return `${(tenths / 10).toFixed(1)} 秒`;
}

export function hudTexts(state: HudState): HudTexts {
  return {
    weapon: state.weaponName,
    ammo: `残弾 ${state.ammo} / ${state.magSize}`,
    time: formatElapsed(state.elapsed),
    input: INPUT_METHOD_LABELS[state.inputMethod],
  };
}

/** HUD の要素。index.html の [data-hud] の要素。 */
export type HudElements = Readonly<Record<keyof HudTexts, Pick<HTMLElement, 'textContent'>>>;

/** HUD の要素の文字を書き換える。変わっていない要素は書き換えない。 */
export function renderHud(elements: HudElements, state: HudState): void {
  const texts = hudTexts(state);
  for (const key of Object.keys(texts) as (keyof HudTexts)[]) {
    if (elements[key].textContent !== texts[key]) elements[key].textContent = texts[key];
  }
}
