import { describe, expect, it } from 'vitest';
import type { RoundRecord } from '../../src/ui/practice-set';
import {
  renderSetSummary,
  setAverageText,
  setBestText,
  setRoundsHtml,
  setSummaryHeading,
  setTrendPlotHtml,
  summarizeSet,
} from '../../src/ui/set-summary';

const rounds = (means: readonly (number | null)[]): RoundRecord[] => means.map((meanDeviation, i) => ({ round: i + 1, meanDeviation }));
const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;

describe('セットのまとめ', () => {
  it('UI-34: 各回の平均ズレを回の順に並べ、推移の図に点を打ち、セットの平均といちばん良かった回を出す', () => {
    const summary = summarizeSet(rounds([1.0, 0.8, 1.2, 0.6, 0.9]), 5);
    expect(summary.rounds.map((r) => r.meanDeviation)).toEqual([1.0, 0.8, 1.2, 0.6, 0.9]);
    expect(summary.average).toBeCloseTo(0.9, 9);
    expect(summary.best).toEqual({ round: 4, meanDeviation: 0.6 });
    expect(setAverageText(summary)).toBe('セットの平均 0.90°');
    expect(setBestText(summary)).toBe('いちばん良かった回 4 回目（0.60°）');

    const list = setRoundsHtml(summary);
    expect([...list.matchAll(/<li data-round="(\d)"/g)].map((m) => m[1])).toEqual(['1', '2', '3', '4', '5']);
    expect([...list.matchAll(/data-best="true"/g)]).toHaveLength(1);
    expect(list).toContain('<li data-round="4" data-best="true">');
    expect(list).toContain('1.20°');

    const plot = setTrendPlotHtml(summary);
    expect(plot).toContain('data-plot="trend"');
    expect(plot).toContain('data-series="mean" data-count="5"');
    expect(count(plot, /<circle /g)).toBe(5);
  });

  it('推移の図は回の順に左から右へ、平均ズレが大きいほど上に点を打つ', () => {
    const plot = setTrendPlotHtml(summarizeSet(rounds([1.0, 0.5]), 2));
    const points = [...plot.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(points).toHaveLength(2);
    const [[x1, y1], [x2, y2]] = points as [[number, number], [number, number]];
    expect(x2).toBeGreaterThan(x1);
    expect(y2).toBeGreaterThan(y1);
  });

  it('最も小さい回が複数あるときは番号の小さい回をいちばん良かった回にする', () => {
    expect(summarizeSet(rounds([0.7, 0.5, 0.5]), 5).best).toEqual({ round: 2, meanDeviation: 0.5 });
  });

  it('平均ズレが「なし」の回は一覧に「なし」と出し、平均・いちばん良かった回・推移の図に入れない', () => {
    const summary = summarizeSet(rounds([1.0, null, 0.5]), 5);
    expect(summary.average).toBeCloseTo(0.75, 9);
    expect(summary.best).toEqual({ round: 3, meanDeviation: 0.5 });
    expect(setRoundsHtml(summary)).toContain('<li data-round="2"><span class="set-round-number">2 回目</span> なし</li>');
    expect(count(setTrendPlotHtml(summary), /<circle /g)).toBe(2);
  });

  it('対象の回がないとき（どの回も平均ズレが「なし」）は平均といちばん良かった回を「なし」とし、推移の図は空で出す', () => {
    const summary = summarizeSet(rounds([null, null]), 5);
    expect(setAverageText(summary)).toBe('セットの平均 なし');
    expect(setBestText(summary)).toBe('いちばん良かった回 なし');
    const plot = setTrendPlotHtml(summary);
    expect(plot).toContain('data-count="0"');
    expect(count(plot, /<circle /g)).toBe(0);
  });

  it('見出しに武器・モード・入力方式と、終えた回の数と選んだ回数を出す', () => {
    expect(setSummaryHeading('L-STAR', '反復練習', 'mouse', summarizeSet(rounds([1, 2, 3]), 5))).toBe(
      'L-STAR / 反復練習 / マウス — 3 / 5 回',
    );
  });

  it('要素を書き換える', () => {
    const elements = {
      heading: { textContent: '' },
      rounds: { innerHTML: '' },
      plot: { innerHTML: '' },
      average: { textContent: '' },
      best: { textContent: '' },
    };
    const summary = summarizeSet(rounds([0.4, 0.2]), 5);
    renderSetSummary(elements, '見出し', summary);
    expect(elements.heading.textContent).toBe('見出し');
    expect(elements.average.textContent).toBe('セットの平均 0.30°');
    expect(elements.best.textContent).toBe('いちばん良かった回 2 回目（0.20°）');
    expect(elements.rounds.innerHTML).toContain('data-round="2"');
    expect(elements.plot.innerHTML).toContain('<svg');
  });
});
