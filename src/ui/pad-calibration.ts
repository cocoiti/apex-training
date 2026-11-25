import {
  isStandardMapping,
  PAD_MISSING_MESSAGE,
  STANDARD_PAD_LAYOUT,
  type DetectedGamepadLike,
  type MappingLookup,
  type PadLayout,
  type PadStatus,
} from '../input/pad-layout';

/**
 * キャリブレーション画面の表示（docs/spec/pad.md「パッドの一覧」「キャリブレーション」）。
 * 表示の中身は DOM に頼らずに求め、要素への書き込みは変わったときだけ行う。
 */

/** キャリブレーション画面が読むパッドの値。 */
export interface CalibrationGamepad extends DetectedGamepadLike {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly value: number }[];
}

/** パッドの一覧の 1 行（番号・名前・配置・標準配置・割り当て・接続・入力）。 */
export type PadListRow = readonly [string, string, string, string, string, string, string];

/** ブラウザが見つけたパッドを番号の順に並べた一覧。外れたパッドも、ブラウザが一覧に残している間は出す。 */
export function padListRows<P extends DetectedGamepadLike>(
  pads: readonly (P | null)[],
  status: PadStatus<P>,
  mappings: MappingLookup,
): PadListRow[] {
  const using = status.kind === 'using' ? status.pad.index : undefined;
  return pads
    .filter((pad): pad is P => pad !== null)
    .sort((a, b) => a.index - b.index)
    .map((pad) => {
      const standard = isStandardMapping(pad);
      const mapped = standard ? '—' : mappings(pad.id) ? '済み' : 'なし';
      return [
        String(pad.index),
        pad.id,
        pad.mapping === '' ? '（空）' : pad.mapping,
        standard ? 'はい' : 'いいえ',
        mapped,
        pad.connected ? 'はい' : 'いいえ',
        pad.index === using ? '使用中' : '',
      ] as const;
    });
}

/** 値を表示する対象。入力に使うパッドで、ないときは番号が最も小さい接続しているパッド（状態の「標準配置でない」のパッド）。 */
export function calibrationTarget<P>(status: PadStatus<P>): { pad: P; layout: PadLayout } | undefined {
  if (status.kind === 'using') return { pad: status.pad, layout: status.layout };
  if (status.kind === 'nonstandard') return { pad: status.pad, layout: STANDARD_PAD_LAYOUT };
  return undefined;
}

/** 値を小数第 2 位までにする（−0 は 0 にする）。 */
export function formatPadValue(value: number): string {
  const text = value.toFixed(2);
  return text === '-0.00' ? '0.00' : text;
}

/** 対象のパッドのすべての軸とボタンの値の表示。 */
export function padValueTexts(pad: Pick<CalibrationGamepad, 'axes' | 'buttons'>): { axes: string[]; buttons: string[] } {
  return {
    axes: pad.axes.map((value, index) => `軸 ${index}: ${formatPadValue(value)}`),
    buttons: pad.buttons.map((button, index) => `ボタン ${index}: ${formatPadValue(button.value)}`),
  };
}

/**
 * 右スティックの位置。傾き 1 を半径 1 とする円の中の座標で、x は右、y は下が正（SVG の座標）。
 * 配置の反転を当て、右に倒すと x が正、上に倒すと y が負になる。円の外には出さない。
 */
export function stickPoint(pad: Pick<CalibrationGamepad, 'axes'>, layout: PadLayout): { x: number; y: number } {
  const rawX = pad.axes[layout.lookX.axis] ?? 0;
  const rawY = pad.axes[layout.lookY.axis] ?? 0;
  const x = layout.lookX.invert ? -rawX : rawX;
  const y = layout.lookY.invert ? -rawY : rawY;
  const m = Math.hypot(x, y);
  return m > 1 ? { x: x / m, y: y / m } : { x, y };
}

/** 重ねる円の半径。デッドゾーンは「デッドゾーン ÷ 100」、外側しきい値の境目は「1 − 外側しきい値 ÷ 100」。 */
export function calibrationRadii(deadzone: number, outerThreshold: number): { deadzone: number; outer: number } {
  return { deadzone: deadzone / 100, outer: 1 - outerThreshold / 100 };
}

/** キャリブレーション画面の要素。 */
export interface CalibrationElements {
  /** パッドの一覧の表の本体。 */
  readonly list: HTMLElement;
  /** パッドが 1 つも見つからないときの表示。 */
  readonly empty: HTMLElement;
  /** 一覧の表（パッドがないときは隠す）。 */
  readonly table: HTMLElement;
  readonly status: Pick<HTMLElement, 'textContent'>;
  readonly axes: HTMLElement;
  readonly buttons: HTMLElement;
  readonly stick: Element;
  readonly deadzoneCircle: Element;
  readonly outerCircle: Element;
}

/** 子の要素を texts のとおりに作り直す。前と同じなら触らない。 */
export function renderTextList(parent: HTMLElement, tag: string, texts: readonly string[]): void {
  const key = texts.join('\n');
  if (parent.dataset.rendered === key) return;
  parent.dataset.rendered = key;
  parent.replaceChildren(
    ...texts.map((text) => {
      const item = parent.ownerDocument.createElement(tag);
      item.textContent = text;
      return item;
    }),
  );
}

/** 表の本体を rows のとおりに作り直す。前と同じなら触らない。 */
export function renderRows(body: HTMLElement, rows: readonly PadListRow[]): void {
  const key = JSON.stringify(rows);
  if (body.dataset.rendered === key) return;
  body.dataset.rendered = key;
  const doc = body.ownerDocument;
  body.replaceChildren(
    ...rows.map((cells) => {
      const tr = doc.createElement('tr');
      tr.dataset.index = cells[0];
      for (const text of cells) {
        const td = doc.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    }),
  );
}

function setAttribute(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/** キャリブレーション画面を今のパッドの値で描き直す。radii は今のデッドゾーンと外側しきい値の円の半径。 */
export function renderCalibration<P extends CalibrationGamepad>(
  elements: CalibrationElements,
  pads: readonly (P | null)[],
  status: PadStatus<P>,
  mappings: MappingLookup,
  radii: { deadzone: number; outer: number },
  statusText: string,
): void {
  const rows = padListRows(pads, status, mappings);
  elements.table.hidden = rows.length === 0;
  elements.empty.hidden = rows.length > 0;
  elements.empty.textContent = PAD_MISSING_MESSAGE;
  renderRows(elements.list, rows);
  if (elements.status.textContent !== statusText) elements.status.textContent = statusText;

  const target = calibrationTarget(status);
  const values = target ? padValueTexts(target.pad) : { axes: [], buttons: [] };
  renderTextList(elements.axes, 'li', values.axes);
  renderTextList(elements.buttons, 'li', values.buttons);
  const point = target ? stickPoint(target.pad, target.layout) : { x: 0, y: 0 };
  setAttribute(elements.stick, 'cx', String(point.x));
  setAttribute(elements.stick, 'cy', String(point.y));
  setAttribute(elements.deadzoneCircle, 'r', String(radii.deadzone));
  setAttribute(elements.outerCircle, 'r', String(radii.outer));
}
