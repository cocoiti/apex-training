import { modeOptionChoices, modeUsesWeakSections, modeUsesWeapon, type CompareMetric, type MetricSpec, type ModeOption, type TrainingMode } from '../modes/types';
import { compareMetric, formatMetric, historyColumns, NO_WEAPON_ID, SHOT_DEVIATION_COLUMNS, SHOT_DEVIATION_METRIC } from './mode-scoring';
import type { InputMethod } from './personal-best';
import {
  clearHistory,
  historyAverages,
  historyValues,
  loadModeHistory,
  type HistoryEntry,
  type HistorySelection,
  type StoredEntry,
} from './practice-history';
import { onLanguageChange, t } from './i18n';
import { escapeHtml } from './result-plot';
import type { SafeStorage } from './storage';
import {
  sectionRangeText,
  summarizeWeakSection,
  WEAK_SECTION_RUNS,
  weakSectionText,
  type SectionAverage,
  type WeakSectionSummary,
} from './weak-section';

/** 入力方式の選択肢の id（名前は index.html の選択肢が辞書から出す）。 */
export const HISTORY_INPUT_METHODS: readonly InputMethod[] = ['mouse', 'pad'];

/**
 * 開いたときに選ぶ組（docs/spec/screens.md「履歴の画面」）。このページで最後に終えた練習があり、その武器（武器を使わないモードの練習なら
 * NO_WEAPON_ID）とモードが選択肢にあればその組、なければ一覧の最初の武器・モードの並び順の最初のモード・マウス。
 * モードの選択肢は登録されたモード（src/modes/registry.ts）で、決定の理由は docs/adr/2026-11-26-all-modes-scored.md。
 */
export function initialHistorySelection(
  last: HistorySelection | null,
  weaponIds: readonly string[],
  modeIds: readonly string[],
): HistorySelection {
  if (last && modeIds.includes(last.modeId) && (weaponIds.includes(last.weaponId) || last.weaponId === NO_WEAPON_ID)) return last;
  return { input: 'mouse', weaponId: weaponIds[0] ?? '', modeId: modeIds[0] ?? '' };
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

/** 縦軸の上端（比べる指標の値）。 */
function plotTop(values: readonly number[]): number {
  return Math.max(MIN_TOP, ...values.map((v) => v * MARGIN));
}

/** 回（1 から）の順の点の SVG の座標。縦軸は比べる指標（既定は平均ズレ）の値で、0 が下。 */
export function historyPointPositions(entries: readonly StoredEntry[], metric: Pick<CompareMetric, 'id'> = SHOT_DEVIATION_METRIC): { x: number; y: number }[] {
  const values = historyValues(entries, metric);
  const top = plotTop(values);
  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const n = values.length;
  return values.map((v, i) => ({
    x: PAD_LEFT + (n === 1 ? plotWidth / 2 : (plotWidth * i) / (n - 1)),
    y: PAD_TOP + plotHeight * (1 - v / top),
  }));
}

/**
 * 比べる指標（既定は平均ズレ）の推移のグラフの HTML。横軸は回（1 から件数まで）、縦軸は比べる指標の値で、各回の点を回の順に線で結ぶ。
 * 数と固定の文言（指標の名前と単位はモードのもの）だけを書く。
 */
export function historyPlotHtml(entries: readonly StoredEntry[], metric: CompareMetric = SHOT_DEVIATION_METRIC): string {
  const values = historyValues(entries, metric);
  const points = historyPointPositions(entries, metric);
  const top = plotTop(values);
  const unit = escapeHtml(metric.unit);
  const left = PAD_LEFT;
  const bottom = HEIGHT - PAD_BOTTOM;
  const parts = [
    `<line class="plot-axis" x1="${left}" y1="${bottom}" x2="${WIDTH - PAD_RIGHT}" y2="${bottom}" />`,
    `<line class="plot-axis" x1="${left}" y1="${PAD_TOP}" x2="${left}" y2="${bottom}" />`,
    `<text class="plot-tick" x="${left - 4}" y="${bottom}" text-anchor="end">0${unit}</text>`,
    `<text class="plot-tick" x="${left - 4}" y="${PAD_TOP + 8}" text-anchor="end">${escapeHtml(top.toFixed(1))}${unit}</text>`,
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
    .map((p, i) => `<circle cx="${num(p.x)}" cy="${num(p.y)}" r="3" data-round="${i + 1}" data-value="${values[i] ?? 0}" />`)
    .join('');
  parts.push(`<g class="plot-series plot-history" data-series="history" data-count="${points.length}" data-metric="${escapeHtml(metric.id)}">${dots}</g>`);
  const title = escapeHtml(t('plot.trend', { metric: metric.label }));
  return (
    `<figure class="plot plot-wide" data-plot="history">` +
    `<figcaption>${title}</figcaption>` +
    `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${title}">${parts.join('')}</svg>` +
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

/**
 * 一覧の HTML。回・終えた日時と、比べる指標・モードが履歴に持つ指標（既定は平均ズレ・命中率・グルーピング半径）を回の順に並べる。
 * 数でない指標は「なし」と書く。履歴がなければ空。
 */
export function historyListHtml(
  entries: readonly StoredEntry[],
  metric: MetricSpec = SHOT_DEVIATION_METRIC,
  columns: readonly MetricSpec[] = SHOT_DEVIATION_COLUMNS,
): string {
  if (entries.length === 0) return '';
  const fields = [metric, ...columns];
  const rows = entries
    .map(
      (e, i) =>
        `<tr data-round="${i + 1}"><td>${i + 1}</td><td>${escapeHtml(formatHistoryTime(e.at))}</td>` +
        fields.map((f) => `<td data-field="${escapeHtml(f.id)}">${escapeHtml(formatMetric(f, finiteOrNull(e[f.id])))}</td>`).join('') +
        `</tr>`,
    )
    .join('');
  const heads = fields.map((f) => `<th>${escapeHtml(f.label)}</th>`).join('');
  return `<table class="history-table"><thead><tr><th>${escapeHtml(t('history.round'))}</th><th>${escapeHtml(t('history.finishedAt'))}</th>${heads}</tr></thead><tbody>${rows}</tbody></table>`;
}

/** 3 つの平均の HTML（dl の中身）。比べる指標（既定は平均ズレ）の値の平均。 */
export function historyAveragesHtml(entries: readonly StoredEntry[], now: Date, metric: CompareMetric = SHOT_DEVIATION_METRIC): string {
  const averages = historyAverages(entries, now, metric);
  return (
    [
      [t('history.today'), averages.today],
      [t('history.recent'), averages.recent],
      [t('history.overall'), averages.overall],
    ] as const
  )
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(formatMetric(metric, value))}</dd>`)
    .join('');
}

/** 発の区間の記録がある件が 5 件に満たないときの文言（n は持つ件の数）。 */
export function weakSectionPendingMessage(runs: number): string {
  return t('weak.pending', { required: WEAK_SECTION_RUNS, runs });
}

/** 図の上の 1 行。 */
export function weakSectionLine(summary: Pick<WeakSectionSummary, 'weak'>): string {
  return t('weak.line', { text: summary.weak ? weakSectionText(summary.weak) : t('none') });
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
      parts.push(`<text class="plot-section-mark" x="${num(cx)}" y="${num(y - 16)}" text-anchor="middle" data-mark="weak">${escapeHtml(t('weak.mark'))}</text>`);
    }
  });
  return (
    `<figure class="plot plot-wide" data-plot="sections">` +
    `<figcaption>${escapeHtml(t('weak.plotTitle', { runs: WEAK_SECTION_RUNS }))}</figcaption>` +
    `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeHtml(t('weak.plot'))}" data-count="${sections.length}">${parts.join('')}</svg>` +
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
  /** 武器の選択肢の欄。武器を使わないモードを選んでいるあいだは隠す。 */
  readonly weaponChoice?: Pick<HTMLElement, 'hidden'>;
  readonly mode: ChoiceElement;
  /**
   * 練習の選択肢（速さ、出る範囲、的の大きさなど）の欄。選択肢ごとに 1 つ（src/ui/option-choices.ts）。
   * 選んでいるモードが持つ選択肢の欄だけを出し、ほかの欄は隠す。
   */
  readonly options?: readonly HistoryOptionField[];
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

/** 履歴の画面の練習の選択肢 1 つの欄。id は選択肢の id、option は欄を作ったときの選択肢（既定の値に使う）。 */
export interface HistoryOptionField {
  readonly id: string;
  readonly option: Pick<ModeOption, 'defaultChoice'>;
  readonly select: ChoiceElement;
  readonly choice: Pick<HTMLElement, 'hidden'>;
}

/** click を登録できる要素。 */
export interface Clickable {
  addEventListener(type: 'click', listener: () => void): void;
}

/** 履歴の画面が使うモードの項目。 */
export type HistoryMode = Pick<TrainingMode, 'id' | 'usesWeapon' | 'scoring' | 'weakSections' | 'options'>;

export interface HistoryViewOptions {
  readonly storage: Pick<SafeStorage, 'get' | 'remove' | 'onUnavailable'>;
  readonly now: () => Date;
  /** 登録されたモード。選んだモードの id から、武器を使うか・比べる指標・苦手な区間を使うかを決める。省くと、どのモードも反復練習と同じ。 */
  readonly modes?: readonly HistoryMode[];
}

/** 履歴の画面。 */
export interface HistoryView {
  /** 画面を開いた。selection の組を選び、その組の履歴を表示する。 */
  open(selection: HistorySelection): void;
}

const INPUT_IDS: readonly string[] = HISTORY_INPUT_METHODS;

/**
 * 履歴の画面を動かす（docs/spec/screens.md「履歴の画面」）。選び直すとその組の表示に変え、
 * 「この履歴を消す」は画面の中に確認を出し、「消す」を選んだときだけ選んでいる組の履歴を消す（ブラウザの確認のダイアログは使わない）。
 * 書き出しや外部への送信はしない。
 */
export function bindHistoryView(elements: HistoryElements, options: HistoryViewOptions): HistoryView {
  const mode = (): HistoryMode => options.modes?.find((m) => m.id === elements.mode.value) ?? { id: elements.mode.value };
  // 武器を使わないモードの組は、武器の id の代わりに NO_WEAPON_ID のキーで持つ（docs/spec/scoring.md「保存の形」）。
  // 武器の選択肢は隠すだけで値を残すので、武器を使うモードに選び直すと前に選んでいた武器の組になる。
  // 練習の選択肢を持つモードの組は、選んだ値（速さ、出る範囲と的の大きさ）の組ごとのキーで持つ。選択肢の値は隠しているあいだも残し、
  // 同じ選択肢を持つモードで共有する。
  const fields = elements.options ?? [];
  const selection = (): HistorySelection => {
    const given = Object.fromEntries(fields.map((f) => [f.id, f.select.value]));
    const chosen = modeOptionChoices(mode(), given).map((s) => s.choice.id);
    return {
      input: INPUT_IDS.includes(elements.input.value) ? (elements.input.value as InputMethod) : 'mouse',
      weaponId: modeUsesWeapon(mode()) ? elements.weapon.value : NO_WEAPON_ID,
      modeId: elements.mode.value,
      ...(chosen.length > 0 ? { options: chosen } : {}),
    };
  };
  const entriesOf = () => loadModeHistory(options.storage, selection(), compareMetric(mode()));

  const render = () => {
    const current = mode();
    const metric = compareMetric(current);
    const entries = entriesOf();
    if (elements.weaponChoice) elements.weaponChoice.hidden = !modeUsesWeapon(current);
    for (const field of fields) field.choice.hidden = !current.options?.some((o) => o.id === field.id);
    elements.averages.innerHTML = historyAveragesHtml(entries, options.now(), metric);
    elements.plot.innerHTML = historyPlotHtml(entries, metric);
    // 発の区間ごとのズレの図と苦手な区間は、苦手な区間を使うモード（反復練習）だけで出す。
    elements.weak.innerHTML = modeUsesWeakSections(current) ? weakSectionHtml(entries as HistoryEntry[]) : '';
    elements.list.innerHTML = historyListHtml(entries, metric, historyColumns(current));
    elements.empty.textContent = t('history.empty');
    elements.empty.hidden = entries.length > 0;
    elements.clear.disabled = entries.length === 0;
  };

  const showConfirm = (shown: boolean) => {
    elements.confirm.message.textContent = t('history.clearConfirm');
    elements.confirm.root.hidden = !shown;
    elements.body.inert = shown;
  };

  for (const choice of [elements.weapon, elements.mode, elements.input, ...fields.map((f) => f.select)]) {
    choice.addEventListener('change', render);
  }
  elements.clear.addEventListener('click', () => {
    if (entriesOf().length === 0) return;
    showConfirm(true);
  });
  elements.confirm.ok.addEventListener('click', () => {
    showConfirm(false);
    clearHistory(options.storage, selection());
    render();
  });
  elements.confirm.cancel.addEventListener('click', () => showConfirm(false));
  options.storage.onUnavailable(() => {
    elements.unavailable.textContent = t('history.unavailable');
    elements.unavailable.hidden = false;
  });
  // 保存できないことの知らせは、表示の言語を切り替えたときにその言語の文言に書き直す。
  onLanguageChange(() => {
    if (!elements.unavailable.hidden) elements.unavailable.textContent = t('history.unavailable');
  });

  return {
    open(next) {
      // 武器を使わないモードの組を開くときは、武器の選択肢を変えない。
      if (next.weaponId !== NO_WEAPON_ID) elements.weapon.value = next.weaponId;
      elements.mode.value = next.modeId;
      elements.input.value = next.input;
      // 練習の選択肢は、このページで終えた練習の値か、なければ既定の値（速さはふつう）にする。
      const nextOptions = options.modes?.find((m) => m.id === next.modeId)?.options ?? [];
      const given = new Map(nextOptions.map((o, i) => [o.id, next.options?.[i]]));
      for (const field of fields) field.select.value = given.get(field.id) ?? field.option.defaultChoice;
      showConfirm(false);
      render();
    },
  };
}
