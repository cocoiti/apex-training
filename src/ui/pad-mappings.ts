import {
  isStandardMapping,
  MAPPING_ITEMS,
  MAPPING_THRESHOLD,
  MappingCapture,
  type DetectedGamepadLike,
  type MappingAssignment,
  type MappingItem,
  type MappingSource,
  type PadLayout,
} from '../input/pad-layout';
import { loadPadMappings, savePadMapping } from './settings';
import type { SafeStorage } from './storage';

/**
 * 保存したボタン割り当て（docs/spec/pad.md「ボタン割り当て」）。描画のたびに引くので、読んだ値をメモリに持ち、
 * 保存と消去のときだけ localStorage（appStorage）に書く。
 */
export class PadMappingStore {
  private mappings: Record<string, PadLayout>;

  constructor(private readonly storage: Pick<SafeStorage, 'get' | 'set'>) {
    this.mappings = loadPadMappings(storage);
  }

  /** パッドの名前（id）の割り当て。 */
  readonly get = (id: string): PadLayout | undefined => this.mappings[id];

  save(id: string, layout: PadLayout): void {
    this.mappings = savePadMapping(this.storage, id, layout);
  }

  clear(id: string): void {
    this.mappings = savePadMapping(this.storage, id, undefined);
  }
}

/** ボタン割り当ての項目の名前と、「割り当てる」を押したあとの案内。 */
export const MAPPING_LABELS: Readonly<Record<MappingItem, { name: string; guide: string }>> = {
  fire: { name: '射撃（fire）', guide: '射撃に使うボタンを押してください' },
  ads: { name: 'ADS（ads）', guide: 'ADS に使うボタンを押してください' },
  lookX: { name: '右スティックの左右', guide: '右に倒してください' },
  lookY: { name: '右スティックの上下', guide: '上に倒してください' },
};

export const NO_NONSTANDARD_PAD_MESSAGE = '標準配置でないパッドがつながっていません';

/** 割り当てた番号の表示。まだなら「未割り当て」。 */
export function assignmentText(item: MappingItem, assignment: Readonly<MappingAssignment>): string {
  if (item === 'fire' || item === 'ads') {
    const button = assignment[item];
    return button === undefined ? '未割り当て' : `ボタン ${button}`;
  }
  const axis = assignment[item];
  return axis ? `軸 ${axis.axis}${axis.invert ? '（反転）' : ''}` : '未割り当て';
}

/** ボタン割り当て画面の対象。接続している標準配置でないパッドのうち番号が最も小さいもの。 */
export function mappingTarget<P extends DetectedGamepadLike>(pads: readonly (P | null)[]): P | undefined {
  return pads
    .filter((pad): pad is P => pad !== null && pad.connected && !isStandardMapping(pad))
    .sort((a, b) => a.index - b.index)[0];
}

/** ボタン割り当て画面に出すもの。 */
export interface MappingScreenState {
  /** 対象のパッドの名前。対象がないときは undefined。 */
  readonly target: string | undefined;
  /** 項目ごとの割り当てた番号か案内。 */
  readonly items: Readonly<Record<MappingItem, string>>;
  /** 対象のパッドに保存した割り当てがあるか。 */
  readonly saved: boolean;
}

/**
 * ボタン割り当て画面の動き。frame() を描画のたびに呼び、対象のパッドの値で割り当てを進める。
 * 4 つの項目がすべて割り当てられたら、そのパッドの割り当てとして保存する。
 */
export class PadMappingScreen<P extends DetectedGamepadLike & MappingSource> {
  private readonly capture = new MappingCapture();
  private targetId: string | undefined;
  private target: P | undefined;

  constructor(private readonly store: PadMappingStore) {}

  /** 今の対象のパッドを読み、割り当てを進める。 */
  frame(pads: readonly (P | null)[]): MappingScreenState {
    this.target = mappingTarget(pads);
    const id = this.target?.id;
    if (id !== this.targetId) {
      this.targetId = id;
      this.capture.reset();
      // 保存した割り当てから始める。1 項目だけ割り当て直しても 4 項目がそろい、表示と保存が一致する。
      const saved = id === undefined ? undefined : this.store.get(id);
      if (saved) this.capture.seed(saved);
    }
    if (this.target && this.capture.poll(this.target)) {
      const layout = this.capture.layout;
      if (layout && id !== undefined) this.store.save(id, layout);
    }
    return this.state();
  }

  /** 「割り当てる」を押して操作を待っているか。 */
  get waiting(): boolean {
    return this.capture.pending !== undefined;
  }

  /** item の「割り当てる」を押した。対象がないときは何もしない。 */
  start(item: MappingItem): void {
    if (this.target) this.capture.start(item, this.target);
  }

  /** 「割り当てを消す」を押した。保存した割り当てと、途中の割り当てを消す。 */
  clear(): void {
    if (this.targetId !== undefined) this.store.clear(this.targetId);
    this.capture.reset();
  }

  /** 画面を離れた。途中の割り当てと待っている操作を忘れる（次の frame() で保存した割り当てから始め直す）。 */
  leave(): void {
    this.capture.reset();
    this.targetId = undefined;
  }

  private state(): MappingScreenState {
    const id = this.targetId;
    const saved = id === undefined ? undefined : this.store.get(id);
    // capture は保存した割り当てから始めているので、途中の割り当てがそのまま表示になる。
    const shown: Readonly<MappingAssignment> = this.capture.assignment;
    const items = {} as Record<MappingItem, string>;
    for (const item of MAPPING_ITEMS) {
      items[item] = this.capture.pending === item ? MAPPING_LABELS[item].guide : assignmentText(item, shown);
    }
    return { target: id, items, saved: saved !== undefined };
  }
}

/** ボタンの押下を読むパッドの値。 */
interface ButtonSource {
  readonly buttons: readonly { readonly value: number; readonly pressed: boolean }[];
}

/**
 * ボタン割り当て画面を自動で開くかの判断（docs/spec/pad.md「ボタン割り当て」）。トップ画面か設定画面を開いている間に、
 * 標準配置でなく割り当てのないパッドだけがつながっていて（状態が「標準配置でない」）、そのパッドのボタンが押されたら開く。
 * 同じパッド（名前）については、ページを開いている間に 1 回だけ開く。練習中などほかの画面では開かない。
 */
export class MappingAutoOpen {
  private readonly opened = new Set<string>();

  /** 開くべきなら true を返し、そのパッドを開いたものとして覚える。 */
  check<P extends DetectedGamepadLike & ButtonSource>(
    screen: string,
    pads: readonly (P | null)[],
    usable: boolean,
  ): boolean {
    if ((screen !== 'top' && screen !== 'settings') || usable) return false;
    const pressed = pads.find(
      (pad): pad is P =>
        pad !== null &&
        pad.connected &&
        !this.opened.has(pad.id) &&
        pad.buttons.some((button) => button.pressed || button.value >= MAPPING_THRESHOLD),
    );
    if (!pressed) return false;
    this.opened.add(pressed.id);
    return true;
  }
}
