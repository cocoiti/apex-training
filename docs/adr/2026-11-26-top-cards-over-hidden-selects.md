---
status: accepted
domain: screens
summary: トップ画面の武器とモードはカードで選び、選んでいる値は隠した select が持ち、カードの並び全体（data-card-choice）を 1 つの選択肢の欄にし、モードは必須の説明とアイコンの形の名前を持つ
related: [docs/spec/screens.md, docs/spec/modes.md, index.html, src/ui/card-choices.ts, src/ui/mode-cards.ts, src/ui/mode-icons.ts, src/ui/pad-menu.ts, src/modes/types.ts, src/modes/registry.ts, src/main.ts]
---
# トップ画面の武器とモードはカードで選び、選んでいる値は隠した select が持ち、カードの並び全体を 1 つの選択肢の欄にする

## 背景

Issue #77 で、トップ画面の武器とモードを select からカードの並びに変える（screens.md「トップ画面」、UI-10, UI-117〜UI-124、MODE-56）。
練習を始める所・履歴の画面・リザルトからの「もう一度」・多くのテストは、`#weapon`・`#mode` の select の値と change で選択を読み書きしている。
パッドでは、カードの並び全体を 1 つの選択肢の欄として左右で選ぶ（カード 1 枚ずつは項目にしない）。モードのカードには説明とアイコンを出し、
モードのファイルを 1 つ足すだけでカードが出る（MODE-56）。

## 決定

- `#weapon`・`#mode` の select は `hidden` で残し、選んでいる値の持ち主のままにする。`src/ui/card-choices.ts` の `CardChoice` が select の選択肢
  （optgroup は見出し）からカードを作り、select の change・input でカードの選ばれた表示を合わせる。カードのクリック・矢印キーは select の値を変えて
  input・change を送る（パッドの値の変更と同じ経路、ADR: pad-menu-navigation）。
- カードの並びの要素は `data-card-choice="<select の id>"`・`tabindex="0"`・`role="radiogroup"` を持つ。`PadMenu` はこの要素を選択肢の欄として数え、
  左右でその select を変える。隠した select は `[hidden]` なので項目にならない。選択肢が 1 つの並び（モードが 1 つ）は属性を外し、欄にしない。
- モードは必須の `description`（ひとこと説明）と `icon`（`ModeIcon` の形の名前）を持ち、一覧（registry）はどちらかが合わないモードを外す。
  アイコンの絵は `src/ui/mode-icons.ts` が形の名前ごとに自作の SVG を作る。モードのファイルは形の名前を選ぶだけで、SVG を持たない。
- 自己ベストの要約は、保存の形（ADR: mode-scoring-and-weaponless-modes）のキーを `src/ui/mode-cards.ts` がトップ画面で読んで書く。

## 却下した案

- select をなくしてカードの状態を持つ: 練習の開始・履歴・テストの読み書きの経路を全部変えることになり、パッドの値の変更も別の道筋が要る。
- `<input type="radio">` のカードにする: 矢印キーは効くが、PadMenu ではラジオ 1 つずつが項目になり、並び全体を 1 項目にする扱いを別に作る必要は変わらない。
  select との二重の状態も残る。
- モードのファイルが SVG の文字列を持つ: モード（src/modes/）に表示の資産が混ざり、形を揃えにくい。形の名前の一覧から選ぶほうが足しやすい。
- `description`・`icon` を省けるようにして既定の文とアイコンを出す: SPEC はどのモードも説明とアイコンを持つとし、書き忘れに気づけない。

## 影響

- 一部置き換える ADR: [2026-11-26-remove-center-mode-and-panel-setting](2026-11-26-remove-center-mode-and-panel-setting.md)（トップ画面で、モードが 1 つのときに名前だけの欄を出す部分。履歴の画面はそのまま）
- docs/spec/screens.md（トップ画面、パッドでの項目の移動と変更、UI-10, UI-117〜UI-124）, docs/spec/modes.md（モードの登録、MODE-56）
- index.html, src/ui/card-choices.ts, src/ui/mode-cards.ts, src/ui/mode-icons.ts, src/ui/pad-menu.ts, src/ui/style.css, src/modes/types.ts, src/modes/registry.ts,
  src/modes/recoil/ghost.ts, src/modes/tracking.ts, src/modes/aim/, src/main.ts
