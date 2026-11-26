# センター維持と補正のパネルの設定項目をなくし、登録されたモードが 1 つのときはモードの選択欄を隠して名前だけを出す

状態: 一部置き換え済み → [2026-11-26-top-cards-over-hidden-selects](2026-11-26-top-cards-over-hidden-selects.md)（トップ画面のモードの欄）

## 背景

Issue #64 でセンター維持をなくし、モードは反復練習だけになった（docs/spec/modes.md）。補正のパネルの ON/OFF の設定は
センター維持だけが使っていたので、使う所がなくなった（ADR: repeat-practice-panel-as-main-aid の `'setting'`）。
以前のセンター維持の自己ベスト・履歴（`...:center`）と、共通の設定に `correctionPanel: false` を保存した環境が残っている（MODE-29、UI-75）。
SPEC は、登録されたモードが 1 つのときはトップ画面と履歴の画面にモードの選択肢を出さず名前だけを出し、2 つ以上なら出すとする。

## 決定

- `src/modes/recoil/center.ts` を消す。`CorrectionPanelUse` は `'always'` だけにし、`correctionPanelShown` は設定を受け取らない。
- 共通の設定から `correctionPanel` をなくす。読むときは今の項目だけを作るので、保存された `correctionPanel` は読み飛ばされ、
  次に共通の設定を保存したときにその項目は保存の値から落ちる。`apex-training:settings:common` のキーと版は変えない。
- モードの欄は `<select>` を残したまま、`fillModeChoice`（src/ui/mode-choices.ts）が登録されたモードの数で
  選択肢の欄（label）と名前だけの欄の `hidden` を切り替える。選んでいるモードは、隠したときも select の値で読む。
  隠した欄はパッドの項目の移動（PadMenu）の対象から外れる（`[hidden]` の中は数えない）ので、フォーカスもモードに移らない。
- 以前のセンター維持のキーは読まず、消さない（ADR: all-modes-scored のパターン観察と同じ扱い）。苦手な区間はモードの id を含むキーの履歴から
  求めるので、センター維持の履歴は反復練習の苦手な区間に混ざらない。

## 却下した案

- 補正のパネルの設定項目を残し、反復練習では使わない: 効かない項目が画面に残り、SPEC（UI-11, UI-13, MODE-24）とずれる。
- 読み込み時に古い `correctionPanel` や `...:center` のキーを消す・移す: SPEC（MODE-29）がキーを残すことを求め、消すと戻せない。
  設定の項目は保存し直したときに自然に落ちるので、移行の処理はいらない。
- モードが 1 つのときは select を DOM から外す: 練習を始める所・履歴の画面・テストが select の値でモードを読む作りを、
  モードの数で分けることになる。モードを足したときに選択欄へ戻す道筋も 2 つになる。
- モードの数によらず選択欄を出したままにする: SPEC（MODE-27, UI-26, UI-43）が 1 つのときは出さないことを求める。

## 影響

- 一部置き換える ADR: [2026-11-26-repeat-practice-panel-as-main-aid](2026-11-26-repeat-practice-panel-as-main-aid.md)（`'setting'` と設定の補正のパネル）
- docs/spec/modes.md（モードの登録、共通、MODE-1, MODE-5, MODE-24, MODE-27〜MODE-29）, docs/spec/screens.md（トップ画面、履歴の画面、設定項目、
  補正のパネル、UI-11, UI-13, UI-26, UI-43, UI-75）, docs/spec/scoring.md（SCO-39）, docs/spec/pad.md（PAD-18, PAD-19）
- src/modes/recoil/, src/modes/types.ts, src/ui/correction-panel.ts, src/ui/settings.ts, src/ui/settings-form.ts, src/ui/practice-settings.ts,
  src/ui/mode-choices.ts, src/main.ts, index.html
