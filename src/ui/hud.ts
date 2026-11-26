import { INPUT_METHOD_LABELS, type InputMethod } from '../input/input-switch';

/** HUD に出すもの（docs/spec/modes.md「共通」）。 */
export interface HudState {
  /** 武器名と残弾。武器を使わないモードでは undefined で、武器名と残弾の要素を隠す。 */
  readonly weapon: { readonly name: string; readonly ammo: number; readonly magSize: number } | undefined;
  /** 練習の開始からの時間（秒、固定ステップの時刻）。 */
  readonly elapsed: number;
  /** 今の入力方式（docs/spec/input.md「入力方式の切替」）。 */
  readonly inputMethod: InputMethod;
  /** 連続練習の今の回の番号（1 から）と回数（docs/spec/modes.md「連続練習（セット）」）。回数が 1 のときは表示しない。 */
  readonly round?: { readonly index: number; readonly count: number } | undefined;
  /**
   * 入力に使うパッドの状態の表示（docs/spec/pad.md「入力に使うパッド」）。入力方式の設定が「マウス」のときは undefined で、
   * パッドの状態の要素を隠す。
   */
  readonly padStatus?: string | undefined;
}

export interface HudTexts {
  readonly weapon: string;
  readonly ammo: string;
  readonly time: string;
  readonly input: string;
  /** 回の表示（例: 「2 / 5」）。連続練習でないときは空。 */
  readonly round: string;
  /** パッドの状態。出さないときは空文字。 */
  readonly pad: string;
}

/** 経過時間を秒の小数第 1 位までにする。切り捨てるので、2 秒たつまで「2.0」にならない。 */
export function formatElapsed(seconds: number): string {
  // 固定ステップの時刻の浮動小数の誤差で 0.1 秒の境目を切り捨てすぎないよう、わずかに足してから切り捨てる。
  const tenths = Math.floor(Math.max(seconds, 0) * 10 + 1e-6);
  return `${(tenths / 10).toFixed(1)} 秒`;
}

export function hudTexts(state: HudState): HudTexts {
  return {
    weapon: state.weapon?.name ?? '',
    ammo: state.weapon ? `残弾 ${state.weapon.ammo} / ${state.weapon.magSize}` : '',
    time: formatElapsed(state.elapsed),
    input: INPUT_METHOD_LABELS[state.inputMethod],
    round: state.round && state.round.count >= 2 ? `${state.round.index} / ${state.round.count}` : '',
    pad: state.padStatus ?? '',
  };
}

/** HUD の要素。index.html の [data-hud] の要素。パッドの状態と武器名・残弾の要素は出さないときに隠す。 */
export type HudElements = Readonly<Record<Exclude<keyof HudTexts, 'pad' | 'weapon' | 'ammo'>, Pick<HTMLElement, 'textContent'>>> & {
  readonly pad: Pick<HTMLElement, 'textContent' | 'hidden'>;
  readonly weapon: Pick<HTMLElement, 'textContent' | 'hidden'>;
  readonly ammo: Pick<HTMLElement, 'textContent' | 'hidden'>;
};

/** HUD の要素の文字を書き換える。変わっていない要素は書き換えない。 */
export function renderHud(elements: HudElements, state: HudState): void {
  const texts = hudTexts(state);
  for (const key of Object.keys(texts) as (keyof HudTexts)[]) {
    if (elements[key].textContent !== texts[key]) elements[key].textContent = texts[key];
  }
  const setHidden = (element: Pick<HTMLElement, 'hidden'>, hidden: boolean) => {
    if (element.hidden !== hidden) element.hidden = hidden;
  };
  setHidden(elements.pad, state.padStatus === undefined);
  setHidden(elements.weapon, state.weapon === undefined);
  setHidden(elements.ammo, state.weapon === undefined);
}
