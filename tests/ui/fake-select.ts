// fillWeaponSelect を DOM の環境なしで確かめるための、最小の select と document。
// fillWeaponSelect が使う ownerDocument.createElement・append・replaceChildren・label・value・textContent だけを持つ。

export interface FakeElement {
  readonly tagName: string;
  readonly children: FakeElement[];
  /** select の option（子の要素と同じ並び）。 */
  readonly options: FakeElement[];
  readonly ownerDocument: FakeDocument;
  label: string;
  value: string;
  textContent: string;
  append(...nodes: FakeElement[]): void;
  replaceChildren(...nodes: FakeElement[]): void;
}

export interface FakeDocument {
  createElement(tagName: string): FakeElement;
}

export function createFakeDocument(): FakeDocument {
  const doc: FakeDocument = {
    createElement(tagName) {
      const element: FakeElement = {
        tagName: tagName.toUpperCase(),
        children: [],
        get options() {
          return element.children;
        },
        ownerDocument: doc,
        label: '',
        value: '',
        textContent: '',
        append(...nodes) {
          element.children.push(...nodes);
        },
        replaceChildren(...nodes) {
          element.children.splice(0, element.children.length, ...nodes);
        },
      };
      return element;
    },
  };
  return doc;
}

/** fillWeaponSelect に渡せる select。 */
export function createFakeSelect(): { select: HTMLSelectElement; element: FakeElement } {
  const element = createFakeDocument().createElement('select');
  return { select: element as unknown as HTMLSelectElement, element };
}

/** select の中身を、optgroup ごとの label と option の value・textContent に写す。 */
export function describeSelect(element: FakeElement) {
  return element.children.map((group) => ({
    tag: group.tagName,
    label: group.label,
    options: group.children.map((o) => ({ tag: o.tagName, value: o.value, text: o.textContent })),
  }));
}
