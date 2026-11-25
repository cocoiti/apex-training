import type { TrainingMode } from '../modes/types';
import type { InputMethod } from './personal-best';
import {
  clearHistory,
  historyAverages,
  loadHistory,
  type HistoryEntry,
  type HistorySelection,
} from './practice-history';
import { escapeHtml } from './result-plot';
import { formatDegrees, formatPercent } from './result-view';
import type { SafeStorage } from './storage';
import {
  sectionRangeText,
  summarizeWeakSection,
  WEAK_SECTION_RUNS,
  weakSectionText,
  type SectionAverage,
  type WeakSectionSummary,
} from './weak-section';

/**
 * 履歴の画面のモードの選択肢。採点するモード（反復練習・センター維持）を並び順に並べ、パターン観察は出さない
 * （docs/spec/screens.md「履歴の画面」）。決定の理由は docs/adr/2026-11-25-history-scored-modes-list.md。
 */
export const SCORED_MODES: readonly Pick<TrainingMode, 'id' | 'name'>[] = [
  { id: 'ghost', name: '反復練習' },
  { id: 'center', name: 'センター維持' },
];

/** 入力方式の選択肢。 */
export const INPUT_METHODS: readonly { readonly id: InputMethod; readonly name: string }[] = [
  { id: 'mouse', name: 'マウス' },
  { id: 'pad', name: 'パッド' },
];

/** 履歴がない組の表示。 */
export const HISTORY_EMPTY_MESSAGE = 'まだ履歴がありません';

/** 保存できない環境で履歴の画面に出す文言。 */
export const HISTORY_UNAVAILABLE_MESSAGE = 'この環境では履歴を保存できません。ページを開いているあいだの練習だけが表示されます。';

/** 「この履歴を消す」の確認の文言。 */
export const HISTORY_CLEAR_CONFIRM = '選んでいる武器・モード・入力方式の履歴を消します。よろしいですか？';

/**
 * 開いたときに選ぶ組。このページで最後に終えた練習が採点するモードならその組、そうでなければ
 * 一覧の最初の武器・採点するモードの最初のモード・マウス。
 */
export function initialHistorySelection(
  last: HistorySelection | null,
  weaponIds: readonly string[],
): HistorySelection {
  if (last && SCORED_MODES.some((m) => m.id === last.modeId) && weaponIds.includes(last.weaponId)) return last;
  return { input: 'mouse', weaponId: weaponIds[0] ?? '', modeId: SCORED_MODES[0]?.id ?? '' };
}

/** 推移のグラフの大きさ（SVG の座標）。 */
const WIDTH = 480;
const HEIGHT = 200;
const PAD_LEFT = 40;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;
/** 縦軸の最小の上端（度）。 */
const MIN_TOP = 1;
const MARGIN = 1.15;

function num(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded === 0 ? 0 : rounded);
}

/** 縦軸の上端（度）。 */
function plotTop(entries: readonly Pick<HistoryEntry, 'meanError'>[]): number {
  return Math.max(MIN_TOP, ...entries.map((e) => e.meanError * MARGIN));
}

/** 回（1 から）の順の点の SVG の座標。 */
export function historyPointPositions(entries: readonly Pick<HistoryEntry, 'meanError'>[]): { x: number; y: number }[] {
  const top = plotTop(entries);
  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const n = entries.length;
  return entries.map((e, i) => ({
    x: PAD_LEFT + (n === 1 ? plotWidth / 2 : (plotWidth * i) / (n - 1)),
    y: PAD_TOP + plotHeight * (1 - e.meanError / top),
  }));
}

/**
 * 平均ズレの推移のグラフの HTML。横軸は回（1 から件数まで）、縦軸は平均ズレ（度）で、各回の点を回の順に線で結ぶ。
 * 数と固定の文言だけを書く。
 */
export function historyPlotHtml(entries: readonly HistoryEntry[]): string {
  const points = historyPointPositions(entries);
  const top = plotTop(entries);
  const left = PAD_LEFT;
  const bottom = HEIGHT - PAD_BOTTOM;
  const parts = [
    `<line class="plot-axis" x1="${left}" y1="${bottom}" x2="${WIDTH - PAD_RIGHT}" y2="${bottom}" />`,
    `<line class="plot-axis" x1="${left}" y1="${PAD_TOP}" x2="${left}" y2="${bottom}" />`,
    `<text class="plot-tick" x="${left - 4}" y="${bottom}" text-anchor="end">0°</text>`,
    `<text class="plot-tick" x="${left - 4}" y="${PAD_TOP + 8}" text-anchor="end">${escapeHtml(top.toFixed(1))}°</text>`,
  ];
  if (points.length > 0) {
    const last = points[points.length - 1];
    parts.push(`<text class="plot-tick" x="${num(points[0]?.x ?? left)}" y="${HEIGHT - 6}" text-anchor="middle">1</text>`);
    if (points.length > 1 && last) {
      parts.push(`<text class="plot-tick" x="${num(last.x)}" y="${HEIGHT - 6}" text-anchor="middle">${points.length}</text>`);
    }
    parts.push(
      `<polyline class="plot-series plot-history" points="${points.map((p) => `${num(p.x)},${num(p.y)}`).join(' ')}" />`,
    );
  }
  const dots = points
    .map((p, i) => `<circle cx="${num(p.x)}" cy="${num(p.y)}" r="3" data-round="${i + 1}" data-value="${entries[i]?.meanError ?? 0}" />`)
    .join('');
  parts.push(`<g class="plot-series plot-history" data-series="history" data-count="${points.length}">${dots}</g>`);
  return (
    `<figure class="plot plot-wide" data-plot="history">` +
    `<figcaption>平均ズレの推移</figcaption>` +
    `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="平均ズレの推移">${parts.join('')}</svg>` +
    `</figure>`
  );
}

/** 終えた日時のブラウザの時間帯での表示。 */
export function formatHistoryTime(at: string): string {
  const d = new Date(at);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** 一覧の HTML。回・終えた日時・平均ズレ・命中率・グルーピング半径を回の順に並べる。履歴がなければ空。 */
export function historyListHtml(entries: readonly HistoryEntry[]): string {
  if (entries.length === 0) return '';
  const rows = entries
    .map(
      (e, i) =>
        `<tr data-round="${i + 1}"><td>${i + 1}</td><td>${escapeHtml(formatHistoryTime(e.at))}</td>` +
        `<td data-field="meanError">${escapeHtml(formatDegrees(e.meanError))}</td>` +
        `<td data-field="hitRate">${escapeHtml(formatPercent(finiteOrNull(e.hitRate)))}</td>` +
        `<td data-field="groupingRadius">${escapeHtml(formatDegrees(finiteOrNull(e.groupingRadius)))}</td></tr>`,
    )
    .join('');
  return (
    `<table class="history-table"><thead><tr><th>回</th><th>終えた日時</th><th>平均ズレ</th><th>命中率</th><th>グルーピング半径</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`
  );
}

/** 3 つの平均の HTML（dl の中身）。 */
export function historyAveragesHtml(entries: readonly HistoryEntry[], now: Date): string {
  const averages = historyAverages(entries, now);
  return [
    ['今日の平均', averages.today],
    ['直近 10 回の平均', averages.recent],
    ['全体の平均', averages.overall],
  ]
    .map(([label, value]) => `<dt>${escapeHtml(String(label))}</dt><dd>${escapeHtml(formatDegrees(value as number | null))}</dd>`)
    .join('');
}

/** 発の区間の記録がある件が 5 件に満たないときの文言（n は持つ件の数）。 */
export function weakSectionPendingMessage(runs: number): string {
  return `苦手な区間は、発の区間の記録がある練習を ${WEAK_SECTION_RUNS} 回終えると表示されます（今 ${runs} 回）`;
}

/** 図の上の 1 行。 */
export function weakSectionLine(summary: Pick<WeakSectionSummary, 'weak'>): string {
  return `苦手な区間: ${summary.weak ? weakSectionText(summary.weak) : 'なし'}`;
}

/** 発の区間ごとのズレの図の大きさ（SVG の座標）。 */
const SECTION_TOP_PAD = 28;
const SECTION_BOTTOM_PAD = 20;

/**
 * 発の区間ごとのズレの図の HTML。比べる対象の発の区間を発の番号の順に左から並べ、ズレの大きさの平均の長さの棒で描く。
 * 棒の下に発の番号の範囲、上にズレの大きさの平均（小数第 2 位まで）を書き、苦手な区間の棒は違う色にして「苦手」の印を付ける。
 */
export function weakSectionPlotHtml(sections: readonly SectionAverage[], weakStart: number | null): string {
  const top = Math.max(MIN_TOP, ...sections.map((s) => s.meanError * MARGIN));
  const left = PAD_LEFT;
  const bottom = HEIGHT - SECTION_BOTTOM_PAD;
  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = bottom - SECTION_TOP_PAD;
  const slot = sections.length > 0 ? plotWidth / sections.length : plotWidth;
  const barWidth = slot * 0.6;
  const parts = [
    `<line class="plot-axis" x1="${left}" y1="${bottom}" x2="${WIDTH - PAD_RIGHT}" y2="${bottom}" />`,
    `<text class="plot-tick" x="${left - 4}" y="${bottom}" text-anchor="end">0°</text>`,
  ];
  sections.forEach((s, i) => {
    const weak = s.start === weakStart;
    const height = plotHeight * (s.meanError / top);
    const x = left + slot * i + (slot - barWidth) / 2;
    const cx = left + slot * i + slot / 2;
    const y = bottom - height;
    parts.push(
      `<rect class="plot-section${weak ? ' plot-section-weak' : ''}" x="${num(x)}" y="${num(y)}" width="${num(barWidth)}" height="${num(height)}"` +
        ` data-start="${s.start}" data-value="${s.meanError}"${weak ? ' data-weak="true"' : ''} />`,
      `<text class="plot-tick" x="${num(cx)}" y="${HEIGHT - 6}" text-anchor="middle">${escapeHtml(sectionRangeText(s))}</text>`,
      `<text class="plot-tick" x="${num(cx)}" y="${num(y - 4)}" text-anchor="middle">${escapeHtml(s.meanError.toFixed(2))}</text>`,
    );
    if (weak) {
      parts.push(`<text class="plot-section-mark" x="${num(cx)}" y="${num(y - 16)}" text-anchor="middle" data-mark="weak">苦手</text>`);
    }
  });
  return (
    `<figure class="plot plot-wide" data-plot="sections">` +
    `<figcaption>発の区間ごとのズレ（直近 ${WEAK_SECTION_RUNS} 回）</figcaption>` +
    `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="発の区間ごとのズレ" data-count="${sections.length}">${parts.join('')}</svg>` +
    `</figure>`
  );
}

/**
 * 苦手な区間の表示の HTML（docs/spec/screens.md「履歴の画面」）。履歴がなければ空。発の区間の記録がある件が 5 件に満たなければ
 * 図を描かずに文言だけ、5 件あれば「苦手な区間: …」の 1 行と図。
 */
export function weakSectionHtml(entries: readonly HistoryEntry[]): string {
  if (entries.length === 0) return '';
  const summary = summarizeWeakSection(entries);
  if (!summary.sections) {
    return `<p class="history-weak-message" data-weak="pending">${escapeHtml(weakSectionPendingMessage(summary.runs))}</p>`;
  }
  return (
    `<p class="history-weak-text" data-weak="line">${escapeHtml(weakSectionLine(summary))}</p>` +
    weakSectionPlotHtml(summary.sections, summary.weak?.start ?? null)
  );
}

/** 選択肢の要素の、履歴の画面が使う部分。 */
export interface ChoiceElement {
  value: string;
  addEventListener(type: 'change', listener: () => void): void;
}

/** 履歴の画面の要素。index.html の #history-* の要素。 */
export interface HistoryElements {
  readonly weapon: ChoiceElement;
  readonly mode: ChoiceElement;
  readonly input: ChoiceElement;
  readonly averages: Pick<HTMLElement, 'innerHTML'>;
  readonly plot: Pick<HTMLElement, 'innerHTML'>;
  /** 苦手な区間の 1 行と発の区間ごとのズレの図。 */
  readonly weak: Pick<HTMLElement, 'innerHTML'>;
  readonly list: Pick<HTMLElement, 'innerHTML'>;
  readonly empty: Pick<HTMLElement, 'hidden' | 'textContent'>;
  readonly clear: Pick<HTMLButtonElement, 'disabled'> & Clickable;
  readonly unavailable: Pick<HTMLElement, 'hidden' | 'textContent'>;
  /** 確認のほかの項目を入れたもの。確認を出している間は操作できなくする（inert）。 */
  readonly body: Pick<HTMLElement, 'inert'>;
  /** 画面の中に出す、消してよいかの確認。 */
  readonly confirm: {
    readonly root: Pick<HTMLElement, 'hidden'>;
    readonly message: Pick<HTMLElement, 'textContent'>;
    /** 「消す」。 */
    readonly ok: Clickable;
    /** 「取りやめる」。 */
    readonly cancel: Clickable;
  };
}

/** click を登録できる要素。 */
export interface Clickable {
  addEventListener(type: 'click', listener: () => void): void;
}

export interface HistoryViewOptions {
  readonly storage: Pick<SafeStorage, 'get' | 'remove' | 'onUnavailable'>;
  readonly now: () => Date;
}

/** 履歴の画面。 */
export interface HistoryView {
  /** 画面を開いた。selection の組を選び、その組の履歴を表示する。 */
  open(selection: HistorySelection): void;
}

const INPUT_IDS: readonly string[] = INPUT_METHODS.map((m) => m.id);

/**
 * 履歴の画面を動かす（docs/spec/screens.md「履歴の画面」）。選び直すとその組の表示に変え、
 * 「この履歴を消す」は画面の中に確認を出し、「消す」を選んだときだけ選んでいる組の履歴を消す（ブラウザの確認のダイアログは使わない）。
 * 書き出しや外部への送信はしない。
 */
export function bindHistoryView(elements: HistoryElements, options: HistoryViewOptions): HistoryView {
  const selection = (): HistorySelection => ({
    input: INPUT_IDS.includes(elements.input.value) ? (elements.input.value as InputMethod) : 'mouse',
    weaponId: elements.weapon.value,
    modeId: elements.mode.value,
  });

  const render = () => {
    const entries = loadHistory(options.storage, selection());
    elements.averages.innerHTML = historyAveragesHtml(entries, options.now());
    elements.plot.innerHTML = historyPlotHtml(entries);
    elements.weak.innerHTML = weakSectionHtml(entries);
    elements.list.innerHTML = historyListHtml(entries);
    elements.empty.textContent = HISTORY_EMPTY_MESSAGE;
    elements.empty.hidden = entries.length > 0;
    elements.clear.disabled = entries.length === 0;
  };

  const showConfirm = (shown: boolean) => {
    elements.confirm.message.textContent = HISTORY_CLEAR_CONFIRM;
    elements.confirm.root.hidden = !shown;
    elements.body.inert = shown;
  };

  for (const choice of [elements.weapon, elements.mode, elements.input]) choice.addEventListener('change', render);
  elements.clear.addEventListener('click', () => {
    if (loadHistory(options.storage, selection()).length === 0) return;
    showConfirm(true);
  });
  elements.confirm.ok.addEventListener('click', () => {
    showConfirm(false);
    clearHistory(options.storage, selection());
    render();
  });
  elements.confirm.cancel.addEventListener('click', () => showConfirm(false));
  options.storage.onUnavailable(() => {
    elements.unavailable.textContent = HISTORY_UNAVAILABLE_MESSAGE;
    elements.unavailable.hidden = false;
  });

  return {
    open(next) {
      elements.weapon.value = next.weaponId;
      elements.mode.value = next.modeId;
      elements.input.value = next.input;
      showConfirm(false);
      render();
    },
  };
}
