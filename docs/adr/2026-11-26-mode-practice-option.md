# 練習の選択肢はモードの任意の 1 つの option で持ち、保存のキーの末尾に値の id を足し、トップ画面と履歴の画面では 1 つの select を同じ選択肢のモードで共有する

状態: 承認

## 背景

Issue #73 で追いエイムに速さ（遅い・ふつう・速い）を足す（docs/spec/modes.md「モードの登録」「追いエイム」）。速さはモードの準備と動きを変え、
自己ベストと履歴を速さごとに分ける（docs/spec/scoring.md「保存の形」）。速さの選択は追いエイムと追いエイム＋リコイルで共通にし、
反復練習を選んでいるあいだも残す（docs/spec/screens.md「トップ画面」）。

## 決定

- `TrainingMode` に任意の `option`（`id`・表示名・値の並び `choices`（`id` と表示名）・既定の値）を 1 つだけ持たせる。モードの一覧（registry）は
  値の id が重ならない・既定の値が値のどれか・id が英小文字と数字と `-` だけであることを確かめ、合わないモードを外す。
- 選んだ値の id は `PracticeSession` に渡し、`ModeContext.option` で setup と step が読む。練習の結果（`PracticeResult.option`）には
  値の id・表示名・選択肢の表示名を入れ、リザルト・セットのまとめ・シェアの文はそれで「速さ: ふつう」を書く。選択肢にない値は既定の値にする。
- 保存のキーは、モードの id のあとに `:<値の id>` を足す（`apex-training:best:mouse:-:tracking:normal`）。持たないモードのキーは変わらない。
  値の id は保存のキーの一部なので、あとから変えない。
- トップ画面と履歴の画面の速さの欄は 1 つの `<select>` で、選んでいるモードが選択肢を持つときだけ欄を出す（`hidden` で隠すので
  パッドの項目の移動の対象からも外れる）。同じ値の並びなら入れ直さず、選んでいる値を残す。

## 却下した案

- 速さの違いを別のモード（`tracking-slow` など 6 つ）にする: モードの選択肢が 6 つ以上に増え、SPEC の 3 つのモードの並び（MODE-27）に反する。
- 選択肢を複数持てる配列にする: 今の SPEC は速さの 1 つだけで、キーに足す順や表示の並びを決める規則がいる。必要になったら置き換える。
- 速さを共通の設定（`apex-training:settings:common`）に保存する: SPEC は保存せず、再読み込みで「ふつう」に戻すとする（screens.md「トップ画面」）。
- モードごとに別の select を置く: 追いエイムと追いエイム＋リコイルで選んだ値を共有できず、モードを足すたびに index.html を変えることになる。

## 影響

- docs/spec/modes.md（モードの登録、共通、やり直し、MODE-45）, docs/spec/scoring.md（保存の形、SCO-50, SCO-52）, docs/spec/screens.md（トップ画面、
  履歴の画面、セットのまとめ、シェアの文、UI-101〜UI-106）, docs/spec/architecture.md（モードとマップの追加）
- src/modes/types.ts, src/modes/registry.ts, src/modes/session.ts, src/ui/option-choices.ts, src/ui/personal-best.ts, src/ui/practice-history.ts,
  src/ui/result-view.ts, src/ui/result-summary.ts, src/ui/history-view.ts, src/ui/set-summary.ts, src/ui/share.ts, src/main.ts, index.html
