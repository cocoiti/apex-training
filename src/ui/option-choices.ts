import type { ModeOption, TrainingMode } from '../modes/types';
import { localize } from './i18n';

/**
 * 練習の選択肢（追いエイムの速さ、フリックの出る範囲と的の大きさなど、docs/spec/screens.md「トップ画面」「履歴の画面」）の欄。
 * 選択肢の id ごとに欄を 1 つ作り、同じ id の選択肢を持つモードで共有する。決定の理由は docs/adr/2026-11-26-mode-practice-options-list.md。
 */

/** 登録されたモードの練習の選択肢を、id ごとに 1 つ（最初に出たもの）ずつ、モードの並び順・選択肢の並び順に並べる。 */
export function modeOptionsOf(modes: readonly Pick<TrainingMode, 'options'>[]): ModeOption[] {
  const seen = new Map<string, ModeOption>();
  for (const option of modes.flatMap((m) => m.options ?? [])) if (!seen.has(option.id)) seen.set(option.id, option);
  return [...seen.values()];
}

/** select の今の選択肢の値の id（option は select の直下に置く）。 */
function optionIds(select: HTMLSelectElement): string[] {
  return Array.from(select.children, (o) => (o as HTMLOptionElement).value);
}

/**
 * 練習の選択肢の値を select に入れる。並びは選択肢の並び順。入れたあとは、前に選んでいた値が選択肢にあればそのまま、なければ既定の値を選ぶ。
 * 同じ値の並びが入っているときは入れ直さない（選んでいる値を残す）。
 */
export function fillOptionSelect(select: HTMLSelectElement, option: ModeOption): void {
  const ids = option.choices.map((c) => c.id);
  const current = optionIds(select);
  if (current.length === ids.length && current.every((id, i) => id === ids[i])) return;
  const previous = select.value;
  const doc = select.ownerDocument;
  select.replaceChildren(
    ...option.choices.map((choice) => {
      const element = doc.createElement('option');
      element.value = choice.id;
      element.textContent = localize(choice.name);
      return element;
    }),
  );
  select.value = ids.includes(previous) ? previous : option.defaultChoice;
}

/** 練習の選択肢の欄の要素。choice は欄（label）、name は欄の見出し（例: 「速さ」）。 */
export interface OptionChoiceElements {
  readonly select: HTMLSelectElement;
  readonly choice: Pick<HTMLElement, 'hidden'>;
  readonly name?: Pick<HTMLElement, 'textContent'> | null;
}

/**
 * 練習の選択肢の欄を出すか決める。選択肢を渡したら欄を出し、その選択肢の値を入れる（同じ値の並びなら選んでいる値を残す）。
 * undefined なら欄を隠すだけで、select の値は残す。隠した欄にはパッドでの項目の移動でもフォーカスが移らない（src/ui/pad-menu.ts）。
 */
export function showOptionChoice(elements: OptionChoiceElements, option: ModeOption | undefined): void {
  elements.choice.hidden = option === undefined;
  if (!option) return;
  const label = localize(option.label);
  if (elements.name && elements.name.textContent !== label) elements.name.textContent = label;
  fillOptionSelect(elements.select, option);
}

/** 練習の選択肢 1 つの欄。id は選択肢の id。 */
export interface OptionField extends OptionChoiceElements {
  readonly id: string;
  /** 欄を作ったときの選択肢。履歴の画面を開くときの既定の値に使う。 */
  readonly option: ModeOption;
}

/**
 * 練習の選択肢ごとに欄（`<label class="choice">` の中に見出しと select）を作って container に入れる。どれも既定の値を選び、隠した状態で作る。
 * 要素の id は `<prefix><選択肢の id>`（select）・`<prefix><選択肢の id>-choice`（欄）・`<prefix><選択肢の id>-label`（見出し）
 * （例: `speed`、履歴の画面は `history-speed`）。
 */
export function buildOptionFields(container: HTMLElement, options: readonly ModeOption[], prefix = ''): OptionField[] {
  const doc = container.ownerDocument;
  const fields = options.map((option): OptionField => {
    const choice = doc.createElement('label');
    choice.className = 'choice';
    choice.id = `${prefix}${option.id}-choice`;
    choice.hidden = true;
    const name = doc.createElement('span');
    name.id = `${prefix}${option.id}-label`;
    name.textContent = localize(option.label);
    const select = doc.createElement('select');
    select.id = `${prefix}${option.id}`;
    fillOptionSelect(select, option);
    choice.append(name, ' ', select);
    return { id: option.id, option, select, choice, name };
  });
  container.replaceChildren(...fields.map((f) => f.choice as HTMLElement));
  return fields;
}

/** 選んでいるモードが持つ選択肢の欄だけを出す。持たない選択肢の欄は隠すだけで値を残す。 */
export function showOptionFields(fields: readonly OptionField[], mode: Pick<TrainingMode, 'options'> | undefined): void {
  for (const field of fields) showOptionChoice(field, mode?.options?.find((o) => o.id === field.id));
}

/** 欄で選んでいる値（選択肢の id → 値の id）。 */
export function optionFieldValues(fields: readonly Pick<OptionField, 'id' | 'select'>[]): Record<string, string> {
  return Object.fromEntries(fields.map((f) => [f.id, f.select.value]));
}

/** 欄の見出しと値の名前を今の表示の言語で書き直す。選んでいる値は変えない。 */
export function relabelOptionFields(fields: readonly OptionField[]): void {
  for (const field of fields) {
    if (field.name) field.name.textContent = localize(field.option.label);
    for (const element of field.select.options) {
      const choice = field.option.choices.find((c) => c.id === element.value);
      if (choice) element.textContent = localize(choice.name);
    }
  }
}
