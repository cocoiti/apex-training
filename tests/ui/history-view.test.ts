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
  type HistoryElements,
} from '../../src/ui/history-view';
import { historyKey, loadHistory, recordHistory, recordHistoryEntry, type HistoryEntry } from '../../src/ui/practice-history';
import { NO_WEAPON_ID } from '../../src/ui/mode-scoring';
import { aimMode, HIT_COUNT } from '../helpers/aim-modes';
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

const LSTAR_GHOST = { input: 'mouse', weaponId: 'lstar', modeId: 'ghost' } as const;
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
    weak: { innerHTML: '' },
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
  it('UI-26: モードにする登録されたモードは反復練習だけで、センター維持とパターン観察はない', () => {
    expect(modes.map((m) => m.name)).toEqual(['反復練習']);
    expect(modes.map((m) => m.id)).toEqual(['ghost']);
  });

  it('入力方式はマウスとパッド', () => {
    expect(INPUT_METHODS.map((m) => m.id)).toEqual(['mouse', 'pad']);
  });

  it('最後に終えた練習があればその組、なければ最初の武器・最初のモード・マウス', () => {
    const weapons = ['lstar', 'car'];
    const modeIds = modes.map((m) => m.id);
    expect(initialHistorySelection(null, weapons, modeIds)).toEqual({ input: 'mouse', weaponId: 'lstar', modeId: 'ghost' });
    const last = { input: 'pad', weaponId: 'car', modeId: 'ghost' } as const;
    expect(initialHistorySelection(last, weapons, modeIds)).toEqual(last);
    // 登録されていないモード（以前のパターン観察・センター維持など）・一覧にない武器の組は選ばない。
    expect(initialHistorySelection({ ...last, modeId: 'pattern' }, weapons, modeIds)).toEqual({ input: 'mouse', weaponId: 'lstar', modeId: 'ghost' });
    expect(initialHistorySelection({ ...last, modeId: 'center' }, weapons, modeIds)).toEqual({ input: 'mouse', weaponId: 'lstar', modeId: 'ghost' });
    expect(initialHistorySelection({ ...last, weaponId: 'r99' }, weapons, modeIds).weaponId).toBe('lstar');
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

describe('発の区間ごとのズレの図', () => {
  /** 23 発のうち 11〜15 発目だけ水平 h 度、ほかの弾 0 の採点。 */
  const offAt11 = (h = 2) => score(Array.from({ length: 23 }, (_, i) => ({ yaw: i >= 10 && i < 15 ? h : 0, pitch: 0 })), 1);
  const bars = (html: string) =>
    [...html.matchAll(/<rect class="([^"]*)"[^>]*data-start="(\d+)"/g)].map((m) => ({ start: Number(m[2]), weak: m[1]?.includes('plot-section-weak') }));

  it('UI-64: 11〜15 発目だけ右に 2 度ずれた練習が 5 回ある組では、11〜15 の棒だけを違う色で描き「苦手」の印と 1 行を出す', () => {
    const page = openPage(new FakeBacking());
    for (let i = 0; i < 5; i += 1) recordHistory(page.storage, LSTAR_GHOST, offAt11(), NOW);
    page.view.open(LSTAR_GHOST);
    const html = page.elements.weak.innerHTML;
    expect(html).toContain('苦手な区間: 11〜15 発目、右に外しがち');
    expect(bars(html)).toEqual([
      { start: 1, weak: false },
      { start: 6, weak: false },
      { start: 11, weak: true },
      { start: 16, weak: false },
      { start: 21, weak: false },
    ]);
    expect(html.match(/data-mark="weak">苦手</g)).toHaveLength(1);
    expect(html).toContain('>11〜15</text>');
    expect(html).toContain('>2.00</text>');
  });

  it('UI-65: 発の区間の記録を持つ件が 4 件の組では、図を描かず「今 4 回」と出す', () => {
    const page = openPage(new FakeBacking());
    for (let i = 0; i < 4; i += 1) recordHistory(page.storage, LSTAR_GHOST, offAt11(), NOW);
    page.view.open(LSTAR_GHOST);
    expect(page.elements.weak.innerHTML).toContain('苦手な区間は、発の区間の記録がある練習を 5 回終えると表示されます（今 4 回）');
    expect(page.elements.weak.innerHTML).not.toContain('data-plot="sections"');
  });

  it('UI-66: sections を持たない古い形式の件だけの組では、推移と一覧を出し、図は描かない', () => {
    const backing = new FakeBacking();
    const old = Array.from({ length: 6 }, (_, i) => ({ at: NOW.toISOString(), meanError: i / 2, hitRate: 50, groupingRadius: 1, shots: 28 }));
    backing.items.set(historyKey(LSTAR_GHOST), JSON.stringify({ version: 1, entries: old }));
    const page = openPage(backing);
    page.view.open(LSTAR_GHOST);
    expect(pointCount(page.elements.plot.innerHTML)).toBe(6);
    expect(listedMeans(page.elements.list.innerHTML)).toHaveLength(6);
    expect(page.elements.weak.innerHTML).toContain('（今 0 回）');
    expect(page.elements.weak.innerHTML).not.toContain('data-plot="sections"');
  });

  it('苦手な区間が「なし」の組では「苦手な区間: なし」と図を出し、違う色の棒はない', () => {
    const page = openPage(new FakeBacking());
    for (let i = 0; i < 5; i += 1) recordHistory(page.storage, LSTAR_GHOST, offAt11(0.3), NOW);
    page.view.open(LSTAR_GHOST);
    expect(page.elements.weak.innerHTML).toContain('苦手な区間: なし');
    expect(bars(page.elements.weak.innerHTML).some((b) => b.weak)).toBe(false);
    expect(page.elements.weak.innerHTML).not.toContain('data-mark="weak"');
  });

  it('履歴が 1 件もない組では空', () => {
    const page = openPage(new FakeBacking());
    page.view.open(LSTAR_GHOST);
    expect(page.elements.weak.innerHTML).toBe('');
  });
});

describe('履歴の画面', () => {
  it('UI-24: 3 回の履歴の組を選ぶと、3 つの点と 3 回分の平均ズレを回の順に出す', () => {
    const backing = new FakeBacking();
    const page = openPage(backing);
    [0.5, 0.25, 0.75].forEach((h) => recordHistory(page.storage, LSTAR_GHOST, result(h), NOW));
    page.view.open({ input: 'mouse', weaponId: 'car', modeId: 'ghost' });
    expect(pointCount(page.elements.plot.innerHTML)).toBe(0);
    page.elements.weapon.select('lstar');
    expect(pointCount(page.elements.plot.innerHTML)).toBe(3);
    expect(listedMeans(page.elements.list.innerHTML)).toEqual(['0.50°', '0.25°', '0.75°']);
    expect(page.elements.empty.hidden).toBe(true);
    expect(page.elements.clear.disabled).toBe(false);
    expect(page.elements.averages.innerHTML).toContain('<dt>全体の平均</dt><dd>0.50°</dd>');
  });

  it('履歴がない組では空で「まだ履歴がありません」と出し、消すボタンは押せない', () => {
    const page = openPage(new FakeBacking());
    page.view.open(LSTAR_GHOST);
    expect(page.elements.list.innerHTML).toBe('');
    expect(page.elements.empty).toEqual({ hidden: false, textContent: HISTORY_EMPTY_MESSAGE });
    expect(page.elements.clear.disabled).toBe(true);
    expect(page.elements.averages.innerHTML).toBe(
      '<dt>今日の平均</dt><dd>なし</dd><dt>直近 10 回の平均</dt><dd>なし</dd><dt>全体の平均</dt><dd>なし</dd>',
    );
  });

  it('UI-27: 確認で消すと選んだ組だけが消え、再読み込みしても空で、ほかの組と自己ベストは残る', () => {
    const backing = new FakeBacking();
    const best = 'apex-training:best:mouse:lstar:ghost';
    backing.items.set(best, '{"version":1,"meanError":1}');
    const page = openPage(backing);
    recordHistory(page.storage, LSTAR_GHOST, result(1), NOW);
    recordHistory(page.storage, { ...LSTAR_GHOST, weaponId: 'car' }, result(1), NOW);
    page.view.open(LSTAR_GHOST);
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
    expect(loadHistory(reloaded.storage, LSTAR_GHOST)).toEqual([]);
    expect(loadHistory(reloaded.storage, { ...LSTAR_GHOST, weaponId: 'car' })).toHaveLength(1);
    expect(backing.items.get(best)).toBe('{"version":1,"meanError":1}');
  });

  it('UI-28: 確認で取りやめると表示も保存してある履歴も変えない', () => {
    const backing = new FakeBacking();
    const page = openPage(backing);
    recordHistory(page.storage, LSTAR_GHOST, result(1), NOW);
    const saved = backing.items.get(historyKey(LSTAR_GHOST));
    page.view.open(LSTAR_GHOST);
    const before = { ...page.elements.list };
    page.elements.clear.fire();
    page.elements.confirm.cancel.fire();
    expect(page.elements.confirm.root.hidden).toBe(true);
    expect(page.elements.body.inert).toBe(false);
    expect(page.elements.list).toEqual(before);
    expect(backing.items.get(historyKey(LSTAR_GHOST))).toBe(saved);
  });

  it('UI-52: 「この履歴を消す」は画面の中に確認を出し、出している間は確認のほかを操作できなくする', () => {
    const page = openPage(new FakeBacking());
    recordHistory(page.storage, LSTAR_GHOST, result(1), NOW);
    page.view.open(LSTAR_GHOST);
    page.elements.clear.fire();
    expect(page.elements.confirm.root.hidden).toBe(false);
    expect(page.elements.confirm.message.textContent).toBe(HISTORY_CLEAR_CONFIRM);
    expect(page.elements.body.inert).toBe(true);
    // 画面を開き直すと確認は閉じる。
    page.view.open(LSTAR_GHOST);
    expect(page.elements.confirm.root.hidden).toBe(true);
    expect(page.elements.body.inert).toBe(false);
  });

  it('履歴が 1 件もない組では確認を出さない', () => {
    const page = openPage(new FakeBacking());
    page.view.open(LSTAR_GHOST);
    page.elements.clear.fire();
    expect(page.elements.confirm.root.hidden).toBe(true);
  });

  it('UI-29・SCO-30: 書き込みが例外になる環境でも止まらず、保存できない文言とこのページの練習を出す', () => {
    const backing = new FakeBacking();
    backing.failWrites = true;
    const page = openPage(backing);
    recordHistory(page.storage, LSTAR_GHOST, result(1), NOW);
    recordHistory(page.storage, LSTAR_GHOST, result(2), NOW);
    page.view.open(LSTAR_GHOST);
    expect(page.elements.unavailable).toEqual({ hidden: false, textContent: HISTORY_UNAVAILABLE_MESSAGE });
    expect(HISTORY_UNAVAILABLE_MESSAGE).toBe('この環境では履歴を保存できません。ページを開いているあいだの練習だけが表示されます。');
    expect(listedMeans(page.elements.list.innerHTML)).toEqual(['1.00°', '2.00°']);
  });

  it('保存できる環境では保存できない文言を出さない', () => {
    const page = openPage(new FakeBacking());
    page.view.open(LSTAR_GHOST);
    expect(page.elements.unavailable.hidden).toBe(true);
  });

  it('UI-30: 画面の HTML に書き出しや外部へ送る操作がない', () => {
    const page = openPage(new FakeBacking());
    recordHistory(page.storage, LSTAR_GHOST, result(1), NOW);
    page.view.open(LSTAR_GHOST);
    const html = page.elements.plot.innerHTML + page.elements.list.innerHTML + page.elements.averages.innerHTML;
    expect(html).not.toMatch(/<a |<button|download|書き出|エクスポート|送信/);
  });
});

describe('武器を使わないモードの履歴の画面', () => {
  const flick = aimMode({ id: 'flick' });
  const ghost = modes.find((m) => m.id === 'ghost')!;
  const FLICK = { input: 'mouse', weaponId: NO_WEAPON_ID, modeId: 'flick' } as const;

  function openAimPage(backing: FakeBacking) {
    const storage = new SafeStorage(() => backing as unknown as Storage);
    storage.probe();
    const elements = {
      weapon: new FakeControl(),
      weaponChoice: { hidden: false },
      mode: new FakeControl(),
      input: new FakeControl(),
      averages: { innerHTML: '' },
      plot: { innerHTML: '' },
      weak: { innerHTML: '' },
      list: { innerHTML: '' },
      empty: { hidden: true, textContent: '' },
      clear: new FakeControl(),
      unavailable: { hidden: true, textContent: '' },
      body: { inert: false },
      confirm: { root: { hidden: true }, message: { textContent: '' }, ok: new FakeControl(), cancel: new FakeControl() },
    };
    const view = bindHistoryView(elements satisfies HistoryElements, { storage, now: () => NOW, modes: [ghost, flick] });
    return { storage, elements, view };
  }

  it('UI-96: 武器の欄を隠し、推移と一覧と平均がそのモードの比べる指標になり、発の区間の図と苦手な区間を出さない。反復練習に戻すと戻る', () => {
    const backing = new FakeBacking();
    const page = openAimPage(backing);
    [10, 14, 12].forEach((hits) => recordHistoryEntry(page.storage, FLICK, HIT_COUNT, { value: hits, fields: { shots: 20 } }, NOW));
    for (let i = 0; i < 5; i += 1) recordHistory(page.storage, LSTAR_GHOST, result(0.5), NOW);
    page.view.open({ input: 'mouse', weaponId: 'lstar', modeId: 'ghost' });
    expect(page.elements.weak.innerHTML).toContain('data-plot="sections"');

    page.elements.mode.select('flick');
    expect(page.elements.weaponChoice.hidden).toBe(true);
    expect(pointCount(page.elements.plot.innerHTML)).toBe(3);
    expect(page.elements.plot.innerHTML).toContain('命中数の推移');
    expect(page.elements.plot.innerHTML).not.toContain('°');
    expect([...page.elements.list.innerHTML.matchAll(/data-field="hits">([^<]*)</g)].map((m) => m[1])).toEqual(['10', '14', '12']);
    expect(page.elements.list.innerHTML).toContain('<th>命中数</th><th>撃った弾数</th>');
    expect(page.elements.list.innerHTML).not.toContain('平均ズレ');
    expect(page.elements.averages.innerHTML).toContain('<dt>全体の平均</dt><dd>12</dd>');
    expect(page.elements.weak.innerHTML).toBe('');

    page.elements.mode.select('ghost');
    expect(page.elements.weaponChoice.hidden).toBe(false);
    expect(page.elements.weapon.value).toBe('lstar');
    expect(page.elements.plot.innerHTML).toContain('平均ズレの推移');
    expect(page.elements.weak.innerHTML).toContain('data-plot="sections"');
  });

  it('最後に終えた練習が武器を使わないモードなら、その組で開き、武器の選択は変えない', () => {
    const page = openAimPage(new FakeBacking());
    recordHistoryEntry(page.storage, FLICK, HIT_COUNT, { value: 3 }, NOW);
    page.elements.weapon.value = 'car';
    const selection = initialHistorySelection(FLICK, ['lstar', 'car'], ['ghost', 'flick']);
    expect(selection).toEqual(FLICK);
    page.view.open(selection);
    expect(page.elements.weapon.value).toBe('car');
    expect(pointCount(page.elements.plot.innerHTML)).toBe(1);
  });

  it('武器を使わないモードの組を消すと、その組だけが消える', () => {
    const backing = new FakeBacking();
    const page = openAimPage(backing);
    recordHistoryEntry(page.storage, FLICK, HIT_COUNT, { value: 3 }, NOW);
    recordHistory(page.storage, LSTAR_GHOST, result(0.5), NOW);
    page.view.open(FLICK);
    page.elements.clear.fire();
    page.elements.confirm.ok.fire();
    expect(backing.items.has(historyKey(FLICK))).toBe(false);
    expect(backing.items.has(historyKey(LSTAR_GHOST))).toBe(true);
  });
});
