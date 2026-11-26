import { t } from '../ui/i18n';

/**
 * パッドの配置（どのボタン・軸を fire・ads・look に使うか）と、入力に使うパッドの選び方（docs/spec/pad.md
 * 「接続と配置」「入力に使うパッド」「ボタン割り当て」）。DOM と保存には頼らない。保存は src/ui/pad-mappings.ts。
 */

/** 右スティックの 1 方向に使う軸。invert は値の向きを反転して読むか。 */
export interface AxisBinding {
  readonly axis: number;
  readonly invert: boolean;
}

/**
 * fire・ads に使うボタンの番号と、右スティックの左右・上下に使う軸。
 * lookX は反転しないとき値が正の向きを右、lookY は反転しないとき値が負の向きを上とする（標準配置と同じ）。
 */
export interface PadLayout {
  readonly fire: number;
  readonly ads: number;
  readonly lookX: AxisBinding;
  readonly lookY: AxisBinding;
}

/** 標準配置（mapping が "standard"）の番号。右スティックが軸 2・3、R2 / RT がボタン 7、L2 / LT がボタン 6。 */
export const STANDARD_PAD_LAYOUT: PadLayout = {
  fire: 7,
  ads: 6,
  lookX: { axis: 2, invert: false },
  lookY: { axis: 3, invert: false },
};

/** Gamepad API の Gamepad のうち、パッドを選ぶのに使う部分。 */
export interface DetectedGamepadLike {
  readonly id: string;
  readonly index: number;
  readonly connected: boolean;
  readonly mapping: string;
}

/** ブラウザが報告する配置が標準配置か。 */
export function isStandardMapping(pad: Pick<DetectedGamepadLike, 'mapping'>): boolean {
  return pad.mapping === 'standard';
}

/** パッドの名前（id）からボタン割り当てを引く。 */
export type MappingLookup = (id: string) => PadLayout | undefined;

/** そのパッドを読む配置。標準配置なら標準の番号、標準配置でなければ保存した割り当て、どちらでもなければ undefined。 */
export function layoutFor(pad: Pick<DetectedGamepadLike, 'id' | 'mapping'>, mappings: MappingLookup): PadLayout | undefined {
  return isStandardMapping(pad) ? STANDARD_PAD_LAYOUT : mappings(pad.id);
}

/** 入力に使うパッドの状態（docs/spec/pad.md「入力に使うパッド」の表）。 */
export type PadStatus<P> =
  | { readonly kind: 'using'; readonly pad: P; readonly layout: PadLayout }
  | { readonly kind: 'missing' }
  | { readonly kind: 'nonstandard'; readonly pad: P };

/**
 * 入力に使うパッドを選ぶ。使えるパッド（接続していて、標準配置か割り当てを保存したもの）のうち番号が最も小さいもの。
 * なければ、接続しているパッドがあれば「標準配置でない」（番号が最も小さい接続しているパッド）、なければ「見つからない」。
 * pads は navigator.getGamepads() の結果。並びによらず index で比べる。
 */
export function choosePad<P extends DetectedGamepadLike>(pads: readonly (P | null)[], mappings: MappingLookup): PadStatus<P> {
  const connected = pads
    .filter((pad): pad is P => pad !== null && pad.connected)
    .sort((a, b) => a.index - b.index);
  for (const pad of connected) {
    const layout = layoutFor(pad, mappings);
    if (layout) return { kind: 'using', pad, layout };
  }
  const first = connected[0];
  return first ? { kind: 'nonstandard', pad: first } : { kind: 'missing' };
}


/** HUD に出すパッドの名前の最大の文字数。 */
export const HUD_PAD_NAME_LENGTH = 32;

/** パッドの名前（docs/spec/pad.md「パッドの名前」）。Gamepad API の id で、空文字やないときは分からない（undefined）。 */
export function padName(id: string | undefined): string | undefined {
  return id === undefined || id === '' ? undefined : id;
}

/**
 * 画面に出すパッドの名前（docs/spec/pad.md「パッドの名前」）。分からないときは「パッド」。
 * short なら HUD 向けに縮める（shortPadName）。パッドの名前を表示する画面はすべてこれを通す。
 */
export function padDisplayName(id: string | undefined, short = false): string {
  const name = padName(id);
  if (name === undefined) return t('pad.unknownName');
  return short ? shortPadName(name) : name;
}

/** HUD に出すパッドの名前。最初の「 (」より前を最大 32 文字（超えるときは 31 文字と「…」）。 */
export function shortPadName(id: string): string {
  const cut = id.indexOf(' (');
  const name = cut >= 0 ? id.slice(0, cut) : id;
  const chars = [...name];
  if (chars.length <= HUD_PAD_NAME_LENGTH) return name;
  return `${chars.slice(0, HUD_PAD_NAME_LENGTH - 1).join('')}…`;
}

/** 状態の表示。short なら HUD 向けに名前を縮める。 */
export function padStatusText(status: PadStatus<Pick<DetectedGamepadLike, 'id'>>, short = false): string {
  const name = (id: string) => padDisplayName(id, short);
  switch (status.kind) {
    case 'using':
      return name(status.pad.id);
    case 'missing':
      return t('pad.missing');
    case 'nonstandard':
      return t('pad.nonstandardWithName', { name: name(status.pad.id) });
  }
}

/** ボタン割り当ての項目。 */
export type MappingItem = 'fire' | 'ads' | 'lookX' | 'lookY';

export const MAPPING_ITEMS: readonly MappingItem[] = ['fire', 'ads', 'lookX', 'lookY'];

/** 割り当てで、押した・倒したとみなす値。 */
export const MAPPING_THRESHOLD = 0.5;

/** 割り当てに読むパッドの値。 */
export interface MappingSource {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly value: number }[];
}

/** 割り当てた値。ボタンは番号、軸は番号と反転。 */
export type MappingAssignment = Partial<{ fire: number; ads: number; lookX: AxisBinding; lookY: AxisBinding }>;

/**
 * ボタン割り当ての操作（docs/spec/pad.md「ボタン割り当て」）。start(item) のあと poll() のたびにパッドの値を読み、
 * fire・ads はしきい値以上になったボタン、lookX・lookY は絶対値がしきい値以上になった軸で割り当てる。
 * 「割り当てる」を押した時点ですでにしきい値以上のボタン・軸は、一度しきい値の下に戻るまで数えない
 * （押したままのボタンや、離していても −1 を報告するトリガーの軸を取り違えないため）。
 */
export class MappingCapture {
  private assigned: MappingAssignment = {};
  private waiting: MappingItem | undefined;
  private busyButtons = new Set<number>();
  private busyAxes = new Set<number>();

  /** 今の割り当て。 */
  get assignment(): Readonly<MappingAssignment> {
    return this.assigned;
  }

  /** 操作を待っている項目。 */
  get pending(): MappingItem | undefined {
    return this.waiting;
  }

  /** 4 つの項目がすべて割り当てられていれば、その配置。 */
  get layout(): PadLayout | undefined {
    const { fire, ads, lookX, lookY } = this.assigned;
    if (fire === undefined || ads === undefined || !lookX || !lookY) return undefined;
    return { fire, ads, lookX, lookY };
  }

  /** 割り当てをすべて忘れる（対象のパッドが変わったとき）。 */
  reset(): void {
    this.assigned = {};
    this.waiting = undefined;
  }

  /** 割り当てを、保存してある配置から始める（保存済みのパッドで 1 項目だけ割り当て直せるように）。 */
  seed(layout: PadLayout): void {
    const { fire, ads, lookX, lookY } = layout;
    this.assigned = { fire, ads, lookX: { ...lookX }, lookY: { ...lookY } };
  }

  /** item の操作を待ち始める。今の値でしきい値以上のボタン・軸を覚える。 */
  start(item: MappingItem, pad: MappingSource): void {
    this.waiting = item;
    this.busyButtons = new Set(indicesOver(pad.buttons.map((b) => b.value)));
    this.busyAxes = new Set(indicesOver(pad.axes.map(Math.abs)));
  }

  /** 操作を待っていれば値を読み、割り当てが決まったらその項目を返す。 */
  poll(pad: MappingSource): MappingItem | undefined {
    const item = this.waiting;
    if (!item) return undefined;
    const buttons = pad.buttons.map((b) => b.value);
    const axes = pad.axes.map(Math.abs);
    const found = item === 'fire' || item === 'ads' ? firstNew(buttons, this.busyButtons) : firstNew(axes, this.busyAxes);
    if (found === undefined) return undefined;
    if (item === 'fire' || item === 'ads') {
      this.assigned = { ...this.assigned, [item]: found };
    } else {
      const value = pad.axes[found] ?? 0;
      // 左右は「右に倒して」値が負なら反転、上下は「上に倒して」値が正なら反転（反転しないときは負の向きが上）。
      const invert = item === 'lookX' ? value < 0 : value > 0;
      this.assigned = { ...this.assigned, [item]: { axis: found, invert } };
    }
    this.waiting = undefined;
    return item;
  }
}

function indicesOver(values: readonly number[]): number[] {
  return values.flatMap((value, index) => (value >= MAPPING_THRESHOLD ? [index] : []));
}

/** busy でない最初の、しきい値以上の番号。しきい値の下に戻った番号は busy から外す。 */
function firstNew(values: readonly number[], busy: Set<number>): number | undefined {
  let found: number | undefined;
  values.forEach((value, index) => {
    if (value < MAPPING_THRESHOLD) busy.delete(index);
    else if (found === undefined && !busy.has(index)) found = index;
  });
  return found;
}
