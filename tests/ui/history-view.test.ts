import { describe, expect, it } from 'vitest';
import { modes } from '../../src/modes/registry';
import { score } from '../../src/sim/scoring';
import {
  bindHistoryView,
  HISTORY_CLEAR_CONFIRM,
  HISTORY_EMPTY_MESSAGE,
  HISTORY_UNAVAILABLE_MESSAGE,
  historyListHtml,
  historyPlotHtml,
  historyPointPositions,
  initialHistorySelection,
  INPUT_METHODS,
  SCORED_MODES,
  type HistoryElements,
} from '../../src/ui/history-view';
import { historyKey, loadHistory, recordHistory, type HistoryEntry } from '../../src/ui/practice-history';
import { SafeStorage } from '../../src/ui/storage';

/** 値と change・click の登録だけを持つ要素。 */
class FakeControl {
  value = '';
  disabled = false;
  private readonly listeners: (() => void)[] = [];
  addEventListener(_type: string, listener: () => void): void {
    this.listeners.push(listener);
  }
  fire(): void {
    for (const listener of this.listeners) listener();
  }
  select(value: string): void {
    this.value = value;
    this.fire();
  }
}

class FakeBacking {
  readonly items = new Map<string, string>();
  failWrites = false;
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new DOMException('quota', 'QuotaExceededError');
    this.items.set(key, value);
  }
  removeItem(key: string) {
    if (this.failWrites) throw new DOMException('quota', 'QuotaExceededError');
    this.items.delete(key);
  }
}

const R301_CENTER = { input: 'mouse', weaponId: 'r301', modeId: 'center' } as const;
const NOW = new Date('2026-11-25T05:00:00.000Z');
const result = (h: number) => score(Array.from({ length: 10 }, () => ({ yaw: h, pitch: 0 })), 1);

function openPage(backing: FakeBacking) {
  const storage = new SafeStorage(() => backing as unknown as Storage);
  storage.probe();
  const elements = {
    weapon: new FakeControl(),
    mode: new FakeControl(),
    input: new FakeControl(),
    averages: { innerHTML: '' },
    plot: { innerHTML: '' },
    list: { innerHTML: '' },
    empty: { hidden: true, textContent: '' },
    clear: new FakeControl(),
    unavailable: { hidden: true, textContent: '' },
    body: { inert: false },
    confirm: { root: { hidden: true }, message: { textContent: '' }, ok: new FakeControl(), cancel: new FakeControl() },
  };
  const view = bindHistoryView(elements satisfies HistoryElements, { storage, now: () => NOW });
  return { storage, elements, view };
}

const pointCount = (html: string) => Number(/data-series="history" data-count="(\d+)"/.exec(html)?.[1]);
const listedMeans = (html: string) => [...html.matchAll(/data-field="meanError">([^<]*)</g)].map((m) => m[1]);

describe('履歴の画面の選択肢', () => {
  it('UI-26: モードの選択肢はゴースト追従とセンター維持で、パターン観察は出ない', () => {
    expect(SCORED_MODES.map((m) => m.name)).toEqual(['ゴースト追従', 'センター維持']);
    expect(SCORED_MODES.map((m) => m.id)).not.toContain('pattern');
    // 登録されたモードと id・名前が食い違わない。
    for (const mode of modes) {
      const scored = SCORED_MODES.find((m) => m.id === mode.id);
      if (scored) expect(scored.name).toBe(mode.name);
    }
  });

  it('入力方式はマウスとパッド', () => {
    expect(INPUT_METHODS.map((m) => m.id)).toEqual(['mouse', 'pad']);
  });

  it('最後に終えた練習が採点するモードならその組、なければ最初の武器・最初の採点するモード・マウス', () => {
    const weapons = ['r301', 'r99'];
    expect(initialHistorySelection(null, weapons)).toEqual({ input: 'mouse', weaponId: 'r301', modeId: 'ghost' });
    const last = { input: 'pad', weaponId: 'r99', modeId: 'center' } as const;
    expect(initialHistorySelection(last, weapons)).toEqual(last);
    expect(initialHistorySelection({ ...last, modeId: 'pattern' }, weapons).modeId).toBe('ghost');
  });
});

describe('推移のグラフと一覧', () => {
  const entries: HistoryEntry[] = [3, 1, 2].map((m, i) => ({
    at: `2026-11-25T0${i}:00:00.000Z`,
    meanError: m,
    hitRate: 50,
    groupingRadius: 0.5,
    shots: 28,
  }));

  it('各回の点を回の順に左から並べ、平均ズレが大きいほど上に置く', () => {
    const points = historyPointPositions(entries);
    expect(points[0]!.x).toBeLessThan(points[1]!.x);
    expect(points[1]!.x).toBeLessThan(points[2]!.x);
    expect(points[0]!.y).toBeLessThan(points[2]!.y);
    expect(points[2]!.y).toBeLessThan(points[1]!.y);
    const html = historyPlotHtml(entries);
    expect(pointCount(html)).toBe(3);
    expect([...html.matchAll(/data-round="(\d+)"/g)].map((m) => m[1])).toEqual(['1', '2', '3']);
  });

  it('一覧は回・日時・平均ズレ・命中率・グルーピング半径を回の順に並べる', () => {
    const html = historyListHtml(entries);
    expect(listedMeans(html)).toEqual(['3.00°', '1.00°', '2.00°']);
    expect(html).toContain('50.0%');
    expect(html).toContain('0.50°');
    expect(historyListHtml([])).toBe('');
  });

  it('履歴がなければ点を描かない', () => {
    expect(pointCount(historyPlotHtml([]))).toBe(0);
  });
});

describe('履歴の画面', () => {
  it('UI-24: 3 回の履歴の組を選ぶと、3 つの点と 3 回分の平均ズレを回の順に出す', () => {
    const backing = new FakeBacking();
    const page = openPage(backing);
    [0.5, 0.25, 0.75].forEach((h) => recordHistory(page.storage, R301_CENTER, result(h), NOW));
    page.view.open({ input: 'mouse', weaponId: 'r301', modeId: 'ghost' });
    expect(pointCount(page.elements.plot.innerHTML)).toBe(0);
    page.elements.mode.select('center');
    expect(pointCount(page.elements.plot.innerHTML)).toBe(3);
    expect(listedMeans(page.elements.list.innerHTML)).toEqual(['0.50°', '0.25°', '0.75°']);
    expect(page.elements.empty.hidden).toBe(true);
    expect(page.elements.clear.disabled).toBe(false);
    expect(page.elements.averages.innerHTML).toContain('<dt>全体の平均</dt><dd>0.50°</dd>');
  });

  it('履歴がない組では空で「まだ履歴がありません」と出し、消すボタンは押せない', () => {
    const page = openPage(new FakeBacking());
    page.view.open(R301_CENTER);
    expect(page.elements.list.innerHTML).toBe('');
    expect(page.elements.empty).toEqual({ hidden: false, textContent: HISTORY_EMPTY_MESSAGE });
    expect(page.elements.clear.disabled).toBe(true);
    expect(page.elements.averages.innerHTML).toBe(
      '<dt>今日の平均</dt><dd>なし</dd><dt>直近 10 回の平均</dt><dd>なし</dd><dt>全体の平均</dt><dd>なし</dd>',
    );
  });

  it('UI-27: 確認で消すと選んだ組だけが消え、再読み込みしても空で、ほかの組と自己ベストは残る', () => {
    const backing = new FakeBacking();
    const best = 'apex-training:best:mouse:r301:center';
    backing.items.set(best, '{"version":1,"meanError":1}');
    const page = openPage(backing);
    recordHistory(page.storage, R301_CENTER, result(1), NOW);
    recordHistory(page.storage, { ...R301_CENTER, modeId: 'ghost' }, result(1), NOW);
    page.view.open(R301_CENTER);
    page.elements.clear.fire();
    expect(page.elements.confirm.root.hidden).toBe(false);
    expect(pointCount(page.elements.plot.innerHTML)).toBe(1);
    page.elements.confirm.ok.fire();
    expect(page.elements.confirm.root.hidden).toBe(true);
    expect(page.elements.body.inert).toBe(false);
    expect(pointCount(page.elements.plot.innerHTML)).toBe(0);
    expect(page.elements.list.innerHTML).toBe('');
    expect(page.elements.empty).toEqual({ hidden: false, textContent: HISTORY_EMPTY_MESSAGE });

    const reloaded = openPage(backing);
    expect(loadHistory(reloaded.storage, R301_CENTER)).toEqual([]);
    expect(loadHistory(reloaded.storage, { ...R301_CENTER, modeId: 'ghost' })).toHaveLength(1);
    expect(backing.items.get(best)).toBe('{"version":1,"meanError":1}');
  });

  it('UI-28: 確認で取りやめると表示も保存してある履歴も変えない', () => {
    const backing = new FakeBacking();
    const page = openPage(backing);
    recordHistory(page.storage, R301_CENTER, result(1), NOW);
    const saved = backing.items.get(historyKey(R301_CENTER));
    page.view.open(R301_CENTER);
    const before = { ...page.elements.list };
    page.elements.clear.fire();
    page.elements.confirm.cancel.fire();
    expect(page.elements.confirm.root.hidden).toBe(true);
    expect(page.elements.body.inert).toBe(false);
    expect(page.elements.list).toEqual(before);
    expect(backing.items.get(historyKey(R301_CENTER))).toBe(saved);
  });

  it('UI-52: 「この履歴を消す」は画面の中に確認を出し、出している間は確認のほかを操作できなくする', () => {
    const page = openPage(new FakeBacking());
    recordHistory(page.storage, R301_CENTER, result(1), NOW);
    page.view.open(R301_CENTER);
    page.elements.clear.fire();
    expect(page.elements.confirm.root.hidden).toBe(false);
    expect(page.elements.confirm.message.textContent).toBe(HISTORY_CLEAR_CONFIRM);
    expect(page.elements.body.inert).toBe(true);
    // 画面を開き直すと確認は閉じる。
    page.view.open(R301_CENTER);
    expect(page.elements.confirm.root.hidden).toBe(true);
    expect(page.elements.body.inert).toBe(false);
  });

  it('履歴が 1 件もない組では確認を出さない', () => {
    const page = openPage(new FakeBacking());
    page.view.open(R301_CENTER);
    page.elements.clear.fire();
    expect(page.elements.confirm.root.hidden).toBe(true);
  });

  it('UI-29・SCO-30: 書き込みが例外になる環境でも止まらず、保存できない文言とこのページの練習を出す', () => {
    const backing = new FakeBacking();
    backing.failWrites = true;
    const page = openPage(backing);
    recordHistory(page.storage, R301_CENTER, result(1), NOW);
    recordHistory(page.storage, R301_CENTER, result(2), NOW);
    page.view.open(R301_CENTER);
    expect(page.elements.unavailable).toEqual({ hidden: false, textContent: HISTORY_UNAVAILABLE_MESSAGE });
    expect(HISTORY_UNAVAILABLE_MESSAGE).toBe('この環境では履歴を保存できません。ページを開いているあいだの練習だけが表示されます。');
    expect(listedMeans(page.elements.list.innerHTML)).toEqual(['1.00°', '2.00°']);
  });

  it('保存できる環境では保存できない文言を出さない', () => {
    const page = openPage(new FakeBacking());
    page.view.open(R301_CENTER);
    expect(page.elements.unavailable.hidden).toBe(true);
  });

  it('UI-30: 画面の HTML に書き出しや外部へ送る操作がない', () => {
    const page = openPage(new FakeBacking());
    recordHistory(page.storage, R301_CENTER, result(1), NOW);
    page.view.open(R301_CENTER);
    const html = page.elements.plot.innerHTML + page.elements.list.innerHTML + page.elements.averages.innerHTML;
    expect(html).not.toMatch(/<a |<button|download|書き出|エクスポート|送信/);
  });
});
