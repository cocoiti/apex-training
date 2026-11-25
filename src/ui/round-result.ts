import { formatDegrees, type ResultView } from './result-view';

/** 連続練習の短いリザルトに出すもの（docs/spec/modes.md「連続練習（セット）」）。 */
export interface RoundResultTexts {
  /** 回の番号と回数。例: 「1 / 5 回目」。 */
  readonly round: string;
  /** 平均ズレとコメント。採点しないモードでは「採点なし」。 */
  readonly score: string;
  /** その回で自己ベストを更新したときは「自己ベスト更新」、ほかは空。 */
  readonly best: string;
  /** 次の回までの残り秒数。例: 「次の回まで 3 秒」。 */
  readonly countdown: string;
}

/** 採点しないモードの短いリザルトの表示。 */
export const UNSCORED_TEXT = '採点なし';

/** 残り時間（秒）を、表示する残り秒数（切り上げ）にする。 */
export function countdownSeconds(remaining: number): number {
  // 浮動小数の誤差で 3 秒ちょうどが 4 にならないよう、わずかに引いてから切り上げる。
  return Math.max(Math.ceil(remaining - 1e-6), 0);
}

export function roundResultTexts(
  round: number,
  count: number,
  view: Pick<ResultView, 'scored' | 'meanDeviation' | 'comments' | 'bestUpdated'>,
  remaining: number,
): RoundResultTexts {
  const comments = view.comments.join(' / ');
  const score = view.scored
    ? `平均ズレ ${formatDegrees(view.meanDeviation)}${comments ? ` — ${comments}` : ''}`
    : UNSCORED_TEXT;
  return {
    round: `${round} / ${count} 回目`,
    score,
    best: view.scored && view.bestUpdated ? '自己ベスト更新' : '',
    countdown: `次の回まで ${countdownSeconds(remaining)} 秒`,
  };
}

/** 短いリザルトの要素。index.html の #interlude-* の要素。 */
export type RoundResultElements = Readonly<Record<keyof RoundResultTexts, Pick<HTMLElement, 'textContent'>>>;

/** 短いリザルトの要素の文字を書き換える。変わっていない要素は書き換えない（残り秒数は描画のたびに呼ぶ）。 */
export function renderRoundResult(elements: RoundResultElements, texts: RoundResultTexts): void {
  for (const key of Object.keys(texts) as (keyof RoundResultTexts)[]) {
    if (elements[key].textContent !== texts[key]) elements[key].textContent = texts[key];
  }
}
