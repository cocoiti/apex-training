import { describe, expect, it } from 'vitest';
import { countdownSeconds, renderRoundResult, roundResultTexts } from '../../src/ui/round-result';

describe('連続練習の短いリザルト', () => {
  it('MODE-17: 回の番号と回数、平均ズレとコメント、次の回までの残り秒数を出す', () => {
    const texts = roundResultTexts(1, 5, { scored: true, meanDeviation: 0.8, comments: ['下げ不足', '横の補正不足'], bestUpdated: false }, 3);
    expect(texts).toEqual({
      round: '1 / 5 回目',
      score: '平均ズレ 0.80° — 下げ不足 / 横の補正不足',
      best: '',
      countdown: '次の回まで 3 秒',
    });
  });

  it('その回で自己ベストを更新したときは「自己ベスト更新」と出す', () => {
    expect(roundResultTexts(2, 5, { scored: true, meanDeviation: 0.5, comments: [], bestUpdated: true }, 1).best).toBe('自己ベスト更新');
  });

  it('採点しないモードでは平均ズレとコメントの代わりに「採点なし」と出す', () => {
    const texts = roundResultTexts(3, 10, { scored: false, meanDeviation: null, comments: [], bestUpdated: false }, 2.2);
    expect(texts.score).toBe('採点なし');
    expect(texts.best).toBe('');
  });

  it('残り秒数は切り上げ、0 より小さくしない', () => {
    expect(countdownSeconds(3)).toBe(3);
    expect(countdownSeconds(2.01)).toBe(3);
    expect(countdownSeconds(2)).toBe(2);
    expect(countdownSeconds(0.2)).toBe(1);
    expect(countdownSeconds(0)).toBe(0);
    expect(countdownSeconds(-1)).toBe(0);
  });

  it('要素の文字を書き換える', () => {
    const element = () => ({ textContent: '' });
    const elements = { round: element(), score: element(), best: element(), countdown: element() };
    renderRoundResult(elements, { round: '1 / 5 回目', score: '採点なし', best: '', countdown: '次の回まで 2 秒' });
    expect(elements.round.textContent).toBe('1 / 5 回目');
    expect(elements.countdown.textContent).toBe('次の回まで 2 秒');
  });
});
