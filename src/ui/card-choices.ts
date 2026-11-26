/**
 * トップ画面の武器とモードのカードの並び（docs/spec/screens.md「トップ画面」）。
 * 選んでいる値は隠した `<select>` が持ち、カードはその select の選択肢から作って select の値に合わせて表示する。
 * カードをクリックする・キーボードの矢印キー・パッドの左右（src/ui/pad-menu.ts）で選ぶと、select の値を変えて input・change を送る。
 * 並び全体を 1 つの選択肢の欄（`data-card-choice` を持つ要素）とし、カード 1 枚ずつは項目にしない。
 * 決定の理由は docs/adr/2026-11-26-top-cards-over-hidden-selects.md。
 */

/** カードの並びの要素に付ける属性。値は選んでいる値を持つ select の id。 */
export const CARD_CHOICE_ATTR = 'data-card-choice';

/** カード 1 枚。value は select の選択肢の値、label は表示名。 */
export interface CardItem {
  readonly value: string;
  readonly label: string;
}

/** 見出しの下にまとめたカード。heading がないものは見出しなしで並べる。 */
export interface CardGroup {
  readonly heading?: string;
  readonly items: readonly CardItem[];
}

/** select の直下の要素の読むところ（optgroup は label と option、option は value と textContent）。 */
export interface SelectChildLike {
  readonly tagName: string;
  readonly label?: string;
  readonly value?: string;
  readonly textContent: string | null;
  readonly children?: ArrayLike<SelectChildLike>;
}

const item = (option: SelectChildLike): CardItem => ({ value: option.value ?? '', label: (option.textContent ?? '').trim() });

/**
 * select の直下の要素からカードの並びを作る。optgroup は label を見出しにした 1 つのまとまり、続けて並ぶ option は見出しなしの 1 つのまとまりにする。
 * 並びは select の順のまま（武器は分類の順、分類の中は一覧の順）。
 */
export function cardGroupsOf(children: ArrayLike<SelectChildLike>): CardGroup[] {
  const groups: { heading?: string; items: CardItem[] }[] = [];
  for (const child of Array.from(children)) {
    if (child.tagName === 'OPTGROUP') {
      groups.push({ heading: child.label ?? '', items: Array.from(child.children ?? []).map(item) });
      continue;
    }
    const last = groups.at(-1);
    if (last && last.heading === undefined) last.items.push(item(child));
    else groups.push({ items: [item(child)] });
  }
  return groups;
}

/** キーボードのキーの、並びの中での向き。左・上で前（-1）、右・下で次（1）。ほかのキーは undefined。 */
export function keyDirection(key: string): -1 | 1 | undefined {
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return -1;
    case 'ArrowRight':
    case 'ArrowDown':
      return 1;
    default:
      return undefined;
  }
}

/** select の値を変え、マウスやキーボードで選んだときと同じく input・change を送る。値が同じなら何もしない。 */
export function chooseValue(select: HTMLSelectElement, value: string): void {
  if (select.value === value) return;
  select.value = value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

/** カードの並びの要素が選んでいる値を持つ select。並びの要素でないときは null。 */
export function cardChoiceSelect(element: Element): HTMLSelectElement | null {
  const id = element.getAttribute(CARD_CHOICE_ATTR);
  if (!id) return null;
  const found = element.ownerDocument.getElementById(id);
  return found instanceof HTMLSelectElement ? found : null;
}

export interface CardChoiceOptions {
  /** 選んでいる値を持つ select。カードを出すあいだは隠しておく。id を持つ。 */
  readonly select: HTMLSelectElement;
  /** カードを入れる要素。並び全体の枠になる。 */
  readonly container: HTMLElement;
  /** 並びの名前（読み上げ用）。関数なら作り直すたびに呼ぶ（表示の言語を選び直したとき）。 */
  readonly label: string | (() => string);
  /** カードの中身。省くと表示名だけ。 */
  readonly content?: (card: CardItem, doc: Document) => readonly (Node | string)[];
}

/** select に結び付けたカードの並び。 */
export class CardChoice {
  private readonly cards = new Map<string, HTMLElement>();

  constructor(private readonly options: CardChoiceOptions) {
    const { container, select } = options;
    this.applyLabel();
    container.addEventListener('click', (event) => {
      const card = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-value]') : null;
      if (!card || !this.selectable || !container.contains(card)) return;
      chooseValue(select, card.dataset.value ?? '');
    });
    container.addEventListener('keydown', (event) => {
      const direction = keyDirection(event.key);
      if (direction === undefined || !this.selectable || event.altKey || event.ctrlKey || event.metaKey) return;
      // 矢印キーでページをスクロールしない。
      event.preventDefault();
      this.step(direction);
    });
    select.addEventListener('change', () => this.sync());
    select.addEventListener('input', () => this.sync());
  }

  /** 選べる並びか（選択肢が 2 つ以上）。1 つのときはそのカードを選ばれた形で出すだけで、欄にしない。 */
  get selectable(): boolean {
    return this.cards.size > 1;
  }

  private applyLabel(): void {
    const { label } = this.options;
    this.options.container.setAttribute('aria-label', typeof label === 'function' ? label() : label);
  }

  /** select の選択肢からカードを作り直し、選んでいる値に合わせる。並びの名前も付け直す。 */
  rebuild(): void {
    const { container, select, content } = this.options;
    this.applyLabel();
    const doc = container.ownerDocument;
    this.cards.clear();
    const groups = cardGroupsOf(select.children as unknown as ArrayLike<SelectChildLike>);
    container.replaceChildren(
      ...groups.map((group) => {
        const list = doc.createElement('div');
        list.className = 'card-list';
        list.append(
          ...group.items.map((entry) => {
            const card = doc.createElement('div');
            card.className = 'card';
            card.dataset.value = entry.value;
            card.append(...(content ? content(entry, doc) : [cardName(doc, entry.label)]));
            this.cards.set(entry.value, card);
            return card;
          }),
        );
        if (group.heading === undefined) return list;
        const section = doc.createElement('div');
        section.className = 'card-category';
        const heading = doc.createElement('h3');
        heading.className = 'card-heading';
        heading.textContent = group.heading;
        section.append(heading, list);
        return section;
      }),
    );
    // 選べる並びだけを欄にする（Tab とパッドのフォーカスが移る）。1 つのときは欄にしない（docs/spec/screens.md「モードの選択」）。
    const selectable = this.selectable;
    container.setAttribute('role', selectable ? 'radiogroup' : 'group');
    if (selectable) {
      container.setAttribute(CARD_CHOICE_ATTR, select.id);
      container.tabIndex = 0;
    } else {
      container.removeAttribute(CARD_CHOICE_ATTR);
      container.removeAttribute('tabindex');
    }
    for (const card of this.cards.values()) card.setAttribute('role', selectable ? 'radio' : 'presentation');
    this.sync();
  }

  /** 選んでいる値のカードを選ばれた表示にし、ほかのカードを選ばれていない表示にする。 */
  sync(): void {
    const value = this.options.select.value;
    for (const [id, card] of this.cards) {
      const selected = id === value;
      card.classList.toggle('selected', selected);
      if (this.selectable) card.setAttribute('aria-checked', String(selected));
      else card.removeAttribute('aria-checked');
    }
  }

  /** 並びの順で前（-1）・次（1）のカードを選ぶ。最初と最後で止まる。 */
  step(direction: -1 | 1): void {
    const values = [...this.cards.keys()];
    const index = values.indexOf(this.options.select.value);
    const next = values[Math.min(values.length - 1, Math.max(0, index + direction))];
    if (next !== undefined) chooseValue(this.options.select, next);
  }

  /** 値のカード。 */
  card(value: string): HTMLElement | undefined {
    return this.cards.get(value);
  }
}

/** カードの表示名。 */
export function cardName(doc: Document, label: string): HTMLElement {
  const name = doc.createElement('span');
  name.className = 'card-name';
  name.textContent = label;
  return name;
}
