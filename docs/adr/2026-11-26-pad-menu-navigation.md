# パッドでの項目の移動は PadNavigator と PadMenu に分け、フォーカスは DOM のフォーカスでなく枠のクラスで表し、値は要素の値を変えて input・change を送る

状態: 承認

## 背景

Issue #47 で、トップ・設定・履歴・キャリブレーション・ボタン割り当ての画面を標準配置のパッドだけで操作できるようにする
（screens.md「パッドでの項目の移動と変更」、UI-43〜UI-54、PAD-32, PAD-33、INP-15, INP-16）。十字キー・左スティックの押し続けの繰り返し、
画面をまたいで押し続けたものの扱い、フォーカスの表し方、値を変えたときの保存の経路、メニューの操作と入力方式の切替の関係を決める。

## 決定

- 読み取りは `src/input/pad-navigation.ts` の `PadNavigator` が描画ごとに行い、`NavCommand`（上下左右・confirm・back）を返す。
  `Action` とは別の経路で、`InputSwitch` にも `RecordingInput` にも渡さない（ADR: screen-controls-outside-actions と同じ考え）。
  入力に使うパッドが標準配置のときだけ読む。どの画面でも読み、画面が変わったら `block()` で押しているものを離すまで止める。
- 画面への当て方は `src/ui/pad-menu.ts` の `PadMenu` が行う。項目は画面の `select, input, button, a[href]` を DOM の順に、
  表示していて `:disabled` でないものだけを毎回数え直す。画面の中の確認（`role="alertdialog"`）が出ている間は項目をその中に限る。
- フォーカスは DOM の `focus()` を使わず、`pad-focus` のクラスで枠を出す。
- 値の変更は要素の値を変えて `input`・`change` を送り、押す・ON/OFF は `click()` にする。マウス・キーボードと同じリスナーで反映・保存される。
- 履歴を消す確認は `window.confirm` をやめ、画面の中の「消す」「取りやめる」にし、出している間は残りを `inert` にする。
- 入力方式の切替の操作（`InputSwitch.activity`）は、プレイ画面を表示している間だけ数える。

## 却下した案

- DOM の `focus()` と Tab の順を使う: 文字の入力欄にフォーカスするとキーボードの R・Q が入力欄に入り画面の操作にならない。
  select にフォーカスしたときの見た目と動きはブラウザで違い、枠の表示を SPEC のとおりに揃えにくい。
- 画面ごとに項目の一覧を TypeScript に書く: 画面の項目を足すたびに一覧の書き足しが要り、表示していない・変更できない項目の判定が二重になる。
- 設定の値を `saveCommonSettings` などで直接保存する: 欄の表示や cm/360、キャリブレーションの円の更新を別に呼ぶ必要があり、マウスで変えたときと結果がずれうる。
- `window.confirm` のままにする: ブラウザのダイアログはパッドで操作できない。
- メニューでのパッドの操作も入力方式の切替に数える: パッドでメニューを操作しただけで、マウスで練習するつもりの HUD と自己ベストのキーがパッドになる（INP-15）。

## 影響

- docs/spec/screens.md（パッドでの項目の移動と変更、履歴の画面、UI-43〜UI-54）, docs/spec/pad.md（PAD-32, PAD-33）, docs/spec/input.md（INP-15, INP-16）
- src/input/pad-navigation.ts, src/ui/pad-menu.ts, src/ui/history-view.ts, src/ui/pad-mappings.ts, src/ui/style.css, index.html, src/main.ts
