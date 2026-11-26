import type { PracticeResult } from '../modes/session';
import type { SetSummary } from './set-summary';
import { formatDegrees, formatPercent, type ResultView } from './result-view';

/**
 * 結果のシェア（docs/spec/screens.md「結果のシェア」）。渡すのは成績の要約の文（シェアの文）だけで、
 * 補正値・照準の軌道・パターンの数値・入力の記録・画像は渡さない（docs/spec/overview.md「練習の範囲」）。
 * 文は外部のサーバーへ送らず、ブラウザのシェアの機能・クリップボード・X の投稿画面のリンクに渡すだけ。
 */

/** シェアの文に入れる公開 URL。開いている URL（開発サーバーなど）によらず、公開先を書く。 */
export const PUBLIC_URL = 'https://cocoiti.github.io/apex-training/';

const APP_NAME = 'リコイル練習（非公式ファンツール）';
const BEST_UPDATED = '自己ベスト更新！';

/** リザルト画面（回数 1）のシェアの文に入れるもの。 */
export interface ResultShare {
  readonly weaponName: string;
  readonly modeName: string;
  /** 平均ズレ（度）。「なし」のときは null。 */
  readonly meanDeviation: number | null;
  /** 命中率（%）。「なし」のときは null。 */
  readonly hitRate: number | null;
  readonly bestUpdated: boolean;
}

/** セットのまとめのシェアの文に入れるもの。 */
export interface SetShare {
  readonly weaponName: string;
  readonly modeName: string;
  /** 終えた回の数。 */
  readonly rounds: number;
  /** 選んだ回数。 */
  readonly count: number;
  /** セットの平均ズレ（度）。「なし」のときは null。 */
  readonly average: number | null;
  /** そのセットのどれかの回で自己ベストを更新したか。 */
  readonly bestUpdated: boolean;
}

function lines(title: string, weaponName: string, modeName: string, score: string, bestUpdated: boolean): string {
  return [title, `武器: ${weaponName} / モード: ${modeName}`, score, ...(bestUpdated ? [BEST_UPDATED] : []), PUBLIC_URL].join('\n');
}

/** リザルト画面のシェアの文。数の書き方はリザルト画面の表示と同じ。 */
export function resultShareText(share: ResultShare): string {
  const score = `平均ズレ: ${formatDegrees(share.meanDeviation)} / 命中率: ${formatPercent(share.hitRate)}`;
  return lines(`${APP_NAME}の結果`, share.weaponName, share.modeName, score, share.bestUpdated);
}

/** セットのまとめのシェアの文。 */
export function setShareText(share: SetShare): string {
  const score = `回数: ${share.rounds} / ${share.count} 回 / セットの平均ズレ: ${formatDegrees(share.average)}`;
  return lines(`${APP_NAME}のセットの結果`, share.weaponName, share.modeName, score, share.bestUpdated);
}

/** リザルト画面の練習の結果と表示から、シェアの文に入れるものを取り出す。 */
export function resultShare(
  result: { readonly weapon: Pick<PracticeResult['weapon'], 'name'>; readonly mode: Pick<PracticeResult['mode'], 'name'> },
  view: Pick<ResultView, 'meanDeviation' | 'hitRate' | 'bestUpdated'>,
): ResultShare {
  return {
    weaponName: result.weapon.name,
    modeName: result.mode.name,
    meanDeviation: view.meanDeviation,
    hitRate: view.hitRate,
    bestUpdated: view.bestUpdated,
  };
}

/** セットのまとめから、シェアの文に入れるものを取り出す。 */
export function setShare(weaponName: string, modeName: string, summary: Pick<SetSummary, 'rounds' | 'count' | 'average' | 'bestUpdated'>): SetShare {
  return { weaponName, modeName, rounds: summary.rounds.length, count: summary.count, average: summary.average, bestUpdated: summary.bestUpdated };
}

/** 「X に投稿」のリンクの行き先。投稿の画面の下書きにシェアの文が入る。 */
export function xPostUrl(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}

/**
 * シェアに使うブラウザの機能。ないものは省く。
 * share には `text` だけを渡す（`files`・`url`・`title` は渡さない）。
 */
export interface ShareTarget {
  readonly share?: ((data: { text: string }) => Promise<void>) | undefined;
  readonly writeText?: ((text: string) => Promise<void>) | undefined;
}

/**
 * シェアした結果。
 * - shared: シェアの機能で渡した。
 * - aborted: 利用者が共有の画面を閉じて取りやめた（何も表示しない）。
 * - copied: クリップボードにコピーした。
 * - failed: シェアもコピーもできなかった（文を読み取り専用の欄に出す）。
 */
export type ShareOutcome = 'shared' | 'aborted' | 'copied' | 'failed';

/** 取りやめ（AbortError）か。navigator.share は DOMException で失敗する。 */
const isAbort = (error: unknown) => typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';

/** シェアの機能があれば使い、ないか取りやめ以外の理由で失敗したらクリップボードにコピーする。どちらも失敗しても投げない。 */
export async function shareText(text: string, target: ShareTarget): Promise<ShareOutcome> {
  if (target.share) {
    try {
      await target.share({ text });
      return 'shared';
    } catch (error) {
      if (isAbort(error)) return 'aborted';
      // パッドのボタンからの操作で許可されない（NotAllowedError）ときなどは、コピーに切り替える。
    }
  }
  if (!target.writeText) return 'failed';
  try {
    await target.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/** 今のブラウザのシェアの機能とクリップボード。差し替えた navigator.share も拾えるよう、押すたびに読む。 */
export function browserShareTarget(nav: Navigator = navigator): ShareTarget {
  const clipboard = nav.clipboard as Clipboard | undefined;
  return {
    share: typeof nav.share === 'function' ? (data) => nav.share(data) : undefined,
    writeText: typeof clipboard?.writeText === 'function' ? (text) => clipboard.writeText(text) : undefined,
  };
}

export const COPIED_MESSAGE = 'コピーしました';
export const COPY_FAILED_MESSAGE = 'コピーできませんでした。下の文を選んでコピーしてください。';

/** 結果のシェアの要素。index.html の #result-share-* と #set-share-* の要素。 */
export interface ShareElements {
  /** 「X に投稿」のリンク。 */
  readonly post: Pick<HTMLAnchorElement, 'href'>;
  /** ボタンの近くのメッセージ。 */
  readonly message: Pick<HTMLElement, 'textContent' | 'hidden'>;
  /** コピーできなかったときにシェアの文を出す読み取り専用の欄。 */
  readonly fallback: Pick<HTMLTextAreaElement, 'value' | 'hidden'>;
}

/**
 * 1 つの画面（リザルト画面かセットのまとめ）の結果のシェア。シェアの操作は練習の結果・保存・画面を変えない。
 * 押すたびに前のメッセージを結果のメッセージに置き換え、先に押した分の結果があとから届いても上書きしない。
 */
export class ShareControl {
  private text = '';
  private pressed = 0;

  constructor(
    private readonly elements: ShareElements,
    private readonly target: () => ShareTarget = () => browserShareTarget(),
  ) {}

  /** 画面に出す結果のシェアの文を決め、メッセージと欄を消す。画面を出すたびに呼ぶ。 */
  set(text: string): void {
    this.text = text;
    this.pressed += 1;
    this.elements.post.href = xPostUrl(text);
    this.show(undefined);
  }

  /** 「結果をシェア」を押した。 */
  async share(): Promise<ShareOutcome> {
    const id = ++this.pressed;
    const outcome = await shareText(this.text, this.target());
    if (id === this.pressed) this.show(outcome);
    return outcome;
  }

  private show(outcome: ShareOutcome | undefined): void {
    const { message, fallback } = this.elements;
    // 共有の画面を閉じて取りやめたとき（aborted）とシェアしたときは、メッセージを出さない。
    const text = outcome === 'copied' ? COPIED_MESSAGE : outcome === 'failed' ? COPY_FAILED_MESSAGE : '';
    message.textContent = text;
    message.hidden = text === '';
    fallback.value = outcome === 'failed' ? this.text : '';
    fallback.hidden = outcome !== 'failed';
  }
}
