import type { NavCommand } from '../input/pad-navigation';
import type { ScreenId } from './router';
import {
  ADS_MULTIPLIER_RANGE,
  clampToRange,
  DPI_RANGE,
  formatNumberValue,
  FOV_RANGE,
  PAD_RANGES,
  SENSITIVITY_RANGE,
  VOLUME_RANGE,
  type NumberRange,
} from './settings';

/**
 * パッドでの項目の移動と変更（docs/spec/screens.md「パッドでの項目の移動と変更」）。
 * フォーカスは DOM のフォーカスを使わず、枠のクラス（pad-focus）で表す。値は要素の値を変えて input・change を送り、
 * マウスやキーボードで変えたときと同じ経路で反映・保存する。押すのは click() で、クリックしたときと同じにする。
 */

/** パッドで項目を移動できる画面。リザルト画面・セットのまとめ・プレイ画面では移動しない。 */
export const NAV_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>(['top', 'settings', 'history', 'settings-pad', 'settings-pad-mapping']);

/** 戻る（B / ○）の行き先。トップ画面では何もしない（undefined）。 */
export function backTarget(screen: ScreenId): ScreenId | undefined {
  switch (screen) {
    case 'settings':
    case 'history':
      return 'top';
    case 'settings-pad':
    case 'settings-pad-mapping':
      return 'settings';
    default:
      return undefined;
  }
}

/** 数の入力欄の左右の幅と範囲。要素の id で引く。 */
export interface NumberStep {
  readonly step: number;
  readonly range: NumberRange;
}

export const NUMBER_STEPS: Readonly<Record<string, NumberStep>> = {
  'setting-fov': { step: 1, range: FOV_RANGE },
  'setting-volume': { step: 10, range: VOLUME_RANGE },
  'setting-dpi': { step: 100, range: DPI_RANGE },
  'setting-sensitivity': { step: 0.1, range: SENSITIVITY_RANGE },
  'setting-ads-multiplier': { step: 0.1, range: ADS_MULTIPLIER_RANGE },
  'setting-pad-deadzone': { step: 1, range: PAD_RANGES.deadzone },
  'setting-pad-outer-threshold': { step: 1, range: PAD_RANGES.outerThreshold },
  'setting-pad-response-curve': { step: 1, range: PAD_RANGES.responseCurve },
  'setting-pad-yaw': { step: 10, range: PAD_RANGES.yaw },
  'setting-pad-pitch': { step: 10, range: PAD_RANGES.pitch },
  'setting-pad-ads-yaw': { step: 10, range: PAD_RANGES.adsYaw },
  'setting-pad-ads-pitch': { step: 10, range: PAD_RANGES.adsPitch },
  'calibration-deadzone-input': { step: 1, range: PAD_RANGES.deadzone },
};

/** 左右の向き。左が -1、右が 1。 */
export type StepDirection = -1 | 1;

/** 幅の小数の桁数。 */
function decimals(step: number): number {
  return String(step).split('.')[1]?.length ?? 0;
}

/**
 * 数の入力欄の値を幅だけ増減した表示。範囲に収め、幅の小数の桁で丸める。今の値が数として読めなければ undefined。
 */
export function stepNumber(text: string, { step, range }: NumberStep, direction: StepDirection): string | undefined {
  const trimmed = text.trim();
  const current = trimmed === '' ? NaN : Number(trimmed);
  if (!Number.isFinite(current)) return undefined;
  const moved = Number((current + direction * step).toFixed(decimals(step)));
  const clamped = clampToRange(moved, range);
  return clamped === undefined ? undefined : formatNumberValue(clamped, range);
}

/** パッドで選ぶクロスヘアの色の並び。 */
export const CROSSHAIR_COLOR_STEPS: readonly string[] = ['#77ccff', '#ffffff', '#ff0000', '#00ff00', '#ffff00', '#ff00ff', '#ff8800'];

/** 色の並びで前・次の色。並びにない色は、右で並びの最初、左で並びの最後の色にする。端で止まる。 */
export function stepColor(value: string, direction: StepDirection): string {
  const index = CROSSHAIR_COLOR_STEPS.indexOf(value.toLowerCase());
  const next =
    index < 0
      ? direction > 0
        ? 0
        : CROSSHAIR_COLOR_STEPS.length - 1
      : Math.min(CROSSHAIR_COLOR_STEPS.length - 1, Math.max(0, index + direction));
  return CROSSHAIR_COLOR_STEPS[next] ?? value;
}

/** 選択肢の前・次の番号。選べない選択肢は飛ばし、最初と最後で止まる（選べるものがなければ今のまま）。 */
export function stepChoice(selected: number, enabled: readonly boolean[], direction: StepDirection): number {
  for (let i = selected + direction; i >= 0 && i < enabled.length; i += direction) {
    if (enabled[i]) return i;
  }
  return selected;
}

/** フォーカスを前・次の項目へ。フォーカスがない（items にない）ときは最初の項目。端で止まる。 */
export function moveFocus<T>(items: readonly T[], current: T | undefined, direction: StepDirection): T | undefined {
  const index = current === undefined ? -1 : items.indexOf(current);
  if (index < 0) return items[0];
  return items[Math.min(items.length - 1, Math.max(0, index + direction))];
}

/**
 * フォーカスしている項目が使えなくなったときの移り先。all は項目になりうるものの順（使えないものを含む）。
 * 項目の順で次の使える項目、なければ前の使える項目。all にないときは undefined。
 */
export function relocateFocus<T>(all: readonly T[], usable: (item: T) => boolean, current: T): T | undefined {
  const index = all.indexOf(current);
  if (index < 0) return undefined;
  return all.slice(index + 1).find(usable) ?? all.slice(0, index).reverse().find(usable);
}

/** 項目の種類。 */
export type ItemKind = 'choice' | 'number' | 'color' | 'toggle' | 'press' | 'other';

const CONTROL_SELECTOR = 'select, input, button, a[href]';
/** 画面の中の確認（履歴を消す確認など）。出している間は項目をその中だけにする。 */
const MODAL_SELECTOR = '[role="dialog"], [role="alertdialog"]';
/** 確認を出したときにフォーカスを置く項目と、戻る（B / ○）で押す項目。 */
const MODAL_DEFAULT = '[data-pad-default]';
const MODAL_CANCEL = '[data-pad-cancel]';
export const FOCUS_CLASS = 'pad-focus';

function kindOf(element: HTMLElement): ItemKind {
  if (element instanceof HTMLSelectElement) return 'choice';
  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox') return 'toggle';
    if (element.type === 'color') return 'color';
    return NUMBER_STEPS[element.id] ? 'number' : 'other';
  }
  return 'press';
}

function shown(element: Element): boolean {
  return element.getClientRects().length > 0 && !element.closest('[hidden], [inert]');
}

/** 項目にできるか。表示していて、変更できる（disabled でない）もの。 */
function usable(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement && element.type === 'hidden') return false;
  return !element.matches(':disabled') && shown(element);
}

function controls(scope: ParentNode): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)];
}

function notify(element: HTMLElement): void {
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

export interface PadMenuOptions {
  /** 画面の要素。data-screen が screen の要素。 */
  readonly section: (screen: ScreenId) => HTMLElement | null;
  /** 戻る（B / ○）で画面を移る。 */
  readonly navigate: (screen: ScreenId) => void;
}

/** 項目のフォーカスと、パッドの操作をフォーカスしている項目に当てること。 */
export class PadMenu {
  private focused: HTMLElement | undefined;
  /** 出している確認。 */
  private modal: Element | undefined;
  /** 確認を出す前にフォーカスしていた項目。確認を閉じたときに戻す。 */
  private returnTo: HTMLElement | undefined;

  constructor(private readonly options: PadMenuOptions) {}

  /** フォーカスしている項目。 */
  get current(): HTMLElement | undefined {
    return this.focused;
  }

  /** 画面に入った。どの項目にもフォーカスがない状態にする。 */
  enter(): void {
    this.setFocus(undefined);
    this.modal = undefined;
    this.returnTo = undefined;
  }

  /**
   * 描画ごとに呼ぶ。フォーカスしている項目が使えなくなっていれば移し、commands を順に当てる。
   * locked のあいだ（ボタン割り当ての操作を待っている間）は操作を当てない。
   */
  frame(screen: ScreenId, commands: readonly NavCommand[], locked = false): void {
    const section = NAV_SCREENS.has(screen) ? this.options.section(screen) : null;
    if (!section) {
      if (this.focused) this.enter();
      return;
    }
    this.syncModal(section);
    this.revalidate(section);
    if (locked) return;
    for (const command of commands) {
      // 押した・戻ったあとは画面が変わることがあるので、この描画の残りの操作は当てない。
      if (this.run(screen, section, command)) break;
      this.syncModal(section);
      this.revalidate(section);
    }
  }

  private scope(section: HTMLElement): ParentNode {
    return this.modal ?? section;
  }

  private items(section: HTMLElement): HTMLElement[] {
    return controls(this.scope(section)).filter(usable);
  }

  /** 確認を出した・閉じたことを見て、フォーカスを確認の中に置く・確認の前の項目に戻す。 */
  private syncModal(section: HTMLElement): void {
    const modal = [...section.querySelectorAll(MODAL_SELECTOR)].find(shown);
    if (modal === this.modal) return;
    if (modal) {
      if (!this.modal) this.returnTo = this.focused;
      this.modal = modal;
      const preferred = modal.querySelector<HTMLElement>(MODAL_DEFAULT);
      this.setFocus(preferred && usable(preferred) ? preferred : controls(modal).find(usable));
      return;
    }
    this.modal = undefined;
    const back = this.returnTo;
    this.returnTo = undefined;
    if (this.focused && !section.contains(this.focused)) this.setFocus(undefined);
    if (back && (!this.focused || !usable(this.focused))) this.setFocus(back);
  }

  private revalidate(section: HTMLElement): void {
    const focused = this.focused;
    if (!focused) return;
    const scope = this.scope(section);
    if (scope.contains(focused) && usable(focused)) return;
    this.setFocus(relocateFocus(controls(scope), usable, focused));
  }

  /** 1 つの操作を当てる。押した・戻ったときは true。 */
  private run(screen: ScreenId, section: HTMLElement, command: NavCommand): boolean {
    const items = this.items(section);
    const focused = this.focused && items.includes(this.focused) ? this.focused : undefined;
    switch (command) {
      case 'up':
      case 'down':
        this.setFocus(moveFocus(items, focused, command === 'up' ? -1 : 1));
        return false;
      case 'left':
      case 'right':
        if (!focused) this.setFocus(items[0]);
        else change(focused, command === 'left' ? -1 : 1);
        return false;
      case 'confirm': {
        if (!focused) return false;
        const kind = kindOf(focused);
        if (kind !== 'toggle' && kind !== 'press') return false;
        focused.click();
        return true;
      }
      case 'back': {
        if (this.modal) {
          this.modal.querySelector<HTMLElement>(MODAL_CANCEL)?.click();
          return true;
        }
        const target = backTarget(screen);
        if (!target) return false;
        this.options.navigate(target);
        return true;
      }
    }
  }

  private setFocus(element: HTMLElement | undefined): void {
    if (element === this.focused) return;
    this.focused?.classList.remove(FOCUS_CLASS);
    this.focused = element;
    if (!element) return;
    element.classList.add(FOCUS_CLASS);
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

/** フォーカスしている項目の値を左右で変える。選択肢・数・色の欄のほかは何もしない。 */
function change(element: HTMLElement, direction: StepDirection): void {
  switch (kindOf(element)) {
    case 'choice': {
      const select = element as HTMLSelectElement;
      const next = stepChoice(select.selectedIndex, [...select.options].map((option) => !option.disabled), direction);
      if (next === select.selectedIndex) return;
      select.selectedIndex = next;
      notify(select);
      return;
    }
    case 'number': {
      const input = element as HTMLInputElement;
      const step = NUMBER_STEPS[input.id];
      const next = step ? stepNumber(input.value, step, direction) : undefined;
      if (next === undefined || next === input.value) return;
      input.value = next;
      notify(input);
      return;
    }
    case 'color': {
      const input = element as HTMLInputElement;
      const next = stepColor(input.value, direction);
      if (next === input.value.toLowerCase()) return;
      input.value = next;
      notify(input);
      return;
    }
    default:
      return;
  }
}
