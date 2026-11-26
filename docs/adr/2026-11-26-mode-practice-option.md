# 練習の選択肢はモードの任意の options（並び）で持ち、保存のキーの末尾に並び順に値の id を足し、トップ画面と履歴の画面では選択肢の id ごとの select を同じ選択肢のモードで共有する

状態: 承認

## 背景

Issue #73 で追いエイムに速さ（遅い・ふつう・速い）を足す（docs/spec/modes.md「モードの登録」「追いエイム」）。速さはモードの準備と動きを変え、
自己ベストと履歴を速さごとに分ける（docs/spec/scoring.md「保存の形」）。速さの選択は追いエイムと追いエイム＋リコイルで共通にし、
反復練習を選んでいるあいだも残す（docs/spec/screens.md「トップ画面」）。

Issue #74 のフリックは、出る範囲（近い・ふつう・遠い）と的の大きさ（大・中・小）の 2 つの選択肢を持ち、自己ベストと履歴をその組ごとに分ける
（docs/spec/modes.md「フリック」）。#73 の時点では選択肢を 1 つだけ持つ形にしていたので、2 つ以上を持てる形に広げる。

## 決定

- `TrainingMode` に任意の `options`（練習の選択肢の並び）を持たせる。1 つの選択肢は `id`・表示名・値の並び `choices`（`id` と表示名）・既定の値を持つ。
  モードの一覧（registry）は、選択肢の id が重ならない・値の id が重ならない・既定の値が値のどれか・値の id が英小文字と数字と `-` だけであることを確かめ、合わないモードを外す。
- 選んだ値（選択肢の id → 値の id）は `PracticeSession` に渡し、`ModeContext.options` で setup と step が読む。練習の結果（`PracticeResult.options`）には
  選択肢の並び順に、値の id・表示名・選択肢の id・選択肢の表示名を入れ、リザルト・セットのまとめ・シェアの文はそれで「速さ: ふつう」
  （2 つなら「出る範囲: 遠い / 的の大きさ: 小」）を書く。選択肢にない値と渡されなかった選択肢は既定の値にする。
- 保存のキーは、モードの id のあとに選択肢の並び順に `:<値の id>` を足す（`apex-training:best:mouse:-:tracking:normal`、
  `apex-training:best:mouse:-:flick:far:small`）。持たないモードのキーは変わらない。値の id と選択肢の並び順は保存のキーの一部なので、あとから変えない。
- トップ画面と履歴の画面の選択肢の欄は、登録されたモードの選択肢から id ごとに 1 つ（最初に出た選択肢で）作る（src/ui/option-choices.ts）。
  欄は index.html の囲み（`#mode-options`・`#history-mode-options`）に入れ、要素の id は `<選択肢の id>`（履歴の画面は `history-<選択肢の id>`）にする。
  選んでいるモードが持つ選択肢の欄だけを出し（`hidden` で隠すので、パッドの項目の移動の対象からも外れる）、隠した欄の値は残す。
  同じ id の選択肢を持つモード（追いエイムと追いエイム＋リコイルの速さ）は 1 つの欄を共有する。

## 却下した案

- 速さの違いを別のモード（`tracking-slow` など 6 つ）にする: モードの選択肢が 6 つ以上に増え、SPEC のモードの並び（MODE-27）に反する。
- 選択肢を 1 つだけ持つ形のまま、フリックの出る範囲と的の大きさを 1 つの選択肢（9 つの値）にする: 欄が 1 つになり、SPEC の 2 つの欄（UI-107）に反する。
- フリックの出る範囲と的の大きさの値の id をモードの id にはめ込む（`flick-far-small`）: 選択肢の仕組みと保存のキーの形が 2 通りになり、
  モードの id と値の id の区切りが `-` で紛れる。
- 速さを共通の設定（`apex-training:settings:common`）に保存する: SPEC は保存せず、再読み込みで既定の値に戻すとする（screens.md「トップ画面」）。
- 選択肢ごとの select を index.html に書く: モードや選択肢を足すたびに index.html を変えることになる。

## 影響

- docs/spec/modes.md（モードの登録、共通、やり直し、MODE-45、MODE-55）, docs/spec/scoring.md（保存の形、SCO-50, SCO-52, SCO-58, SCO-60）, docs/spec/screens.md（トップ画面、
  履歴の画面、セットのまとめ、シェアの文、UI-101〜UI-111）, docs/spec/architecture.md（モードとマップの追加）
- src/modes/types.ts, src/modes/registry.ts, src/modes/session.ts, src/modes/tracking.ts, src/modes/aim/flick.ts, src/ui/option-choices.ts, src/ui/personal-best.ts,
  src/ui/practice-history.ts, src/ui/result-view.ts, src/ui/result-summary.ts, src/ui/history-view.ts, src/ui/set-summary.ts, src/ui/share.ts, src/main.ts, index.html
