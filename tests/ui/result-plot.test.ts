import { describe, expect, it } from 'vitest';
import { escapeHtml, plotExtent, plotHtml } from '../../src/ui/result-plot';

describe('リザルトの図', () => {
  it('点の系列は円、線の系列は折れ線で描き、上を正にするため SVG の y を反転する', () => {
    const html = plotHtml({
      name: 'trajectory',
      title: '照準の軌道',
      series: [
        { name: 'shots', label: '弾痕', kind: 'points', points: [{ yaw: 1, pitch: 2 }] },
        { name: 'aim', label: '自分の照準', kind: 'line', points: [{ yaw: 0, pitch: 0 }, { yaw: -1, pitch: 0.5 }] },
      ],
    });
    expect(html).toContain('data-plot="trajectory"');
    expect(html).toMatch(/<g [^>]*data-series="shots" data-count="1"><circle cx="1" cy="-2" /);
    expect(html).toMatch(/<polyline [^>]*data-series="aim" data-count="2" points="0,0 -1,-0.5" \/>/);
    expect(html).toContain('弾痕');
    expect(html).toContain('自分の照準');
  });

  it('円を指定すると原点を中心にその半径の円を重ねる', () => {
    const html = plotHtml({ name: 'scatter', title: '散布図', series: [], circle: 1.5 });
    expect(html).toContain('<circle class="plot-target" cx="0" cy="0" r="1.5" />');
  });

  it('範囲はすべての点と円が入り、最小でも 1 度', () => {
    expect(plotExtent({ series: [] })).toBe(1);
    expect(plotExtent({ series: [{ name: 'a', label: 'a', kind: 'line', points: [{ yaw: -4, pitch: 2 }] }] })).toBeCloseTo(4.6, 9);
    expect(plotExtent({ series: [], circle: 2 })).toBeCloseTo(2.3, 9);
  });

  it('点がない系列も空の系列として描く', () => {
    const html = plotHtml({ name: 'scatter', title: '散布図', series: [{ name: 'shots', label: '弾痕', kind: 'points', points: [] }] });
    expect(html).toContain('data-series="shots" data-count="0"></g>');
  });

  it('文言はエスケープする', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
});
