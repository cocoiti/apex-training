import { t } from './i18n';
import { formatMetric } from './mode-scoring';
import type { ResultView } from './result-view';

/** 連続練習の短いリザルトに出すもの（docs/spec/modes.md「連続練習（セット）」）。 */
export interface RoundResultTexts {
  /** 回の番号と回数。例: 「1 / 5 回目」。 */
  readonly round: string;
  /** モードの比べる指標（反復練習は平均ズレ）とコメント。 */
  readonly score: string;
  /** その回で自己ベストを更新したときは「自己ベスト更新」、ほかは空。 */
  readonly best: string;
  /** 次の回までの残り秒数。例: 「次の回まで 3 秒」。 */
  readonly countdown: string;
}

/** 残り時間（秒）を、表示する残り秒数（切り上げ）にする。 */
export function countdownSeconds(remaining: number): number {
  // 浮動小数の誤差で 3 秒ちょうどが 4 にならないよう、わずかに引いてから切り上げる。
  return Math.max(Math.ceil(remaining - 1e-6), 0);
}

export function roundResultTexts(
  round: number,
  count: number,
  view: Pick<ResultView, 'metric' | 'value' | 'comments' | 'bestUpdated'>,
  remaining: number,
): RoundResultTexts {
  const comments = view.comments.join(' / ');
  return {
    round: t('play.roundIndex', { round, count }),
    score: `${view.metric.label} ${formatMetric(view.metric, view.value)}${comments ? ` — ${comments}` : ''}`,
    best: view.bestUpdated ? t('best.updated') : '',
    countdown: t('play.countdown', { seconds: countdownSeconds(remaining) }),
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
