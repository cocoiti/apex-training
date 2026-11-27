---
status: accepted
domain: modes
summary: 練習の選択肢はモードの任意の options（並び）で複数持て、保存のキーの末尾に並び順に値の id を足し、トップ画面と履歴の画面の欄は選択肢の id ごとに作って同じ選択肢のモードで共有する
related: [docs/spec/modes.md, docs/spec/scoring.md, docs/spec/screens.md, src/modes/types.ts, src/modes/registry.ts, src/modes/session.ts, src/modes/tracking.ts, src/modes/aim/flick.ts, src/ui/option-choices.ts, src/ui/personal-best.ts, src/ui/practice-history.ts, src/ui/history-view.ts, src/ui/result-view.ts, src/ui/share.ts, src/main.ts, index.html]
---
# 練習の選択肢はモードの任意の options（並び）で複数持て、保存のキーの末尾に並び順に値の id を足し、トップ画面と履歴の画面の欄は選択肢の id ごとに作って同じ選択肢のモードで共有する

## 背景

2026-11-26-mode-practice-option は、Issue #73 の追いエイムの速さのために、練習の選択肢をモードの任意の 1 つの `option` で持つと決めた
（選択肢を複数持てる配列にする案は、必要になったら置き換えるとして却下した）。

Issue #74 のフリックは、出る範囲（近い・ふつう・遠い）と的の大きさ（大・中・小）の 2 つの選択肢を持ち、自己ベストと履歴をその組ごとに分ける
（docs/spec/modes.md「フリック」）。選択肢が 2 つ要るので、2026-11-26-mode-practice-option の「1 つだけ」の部分を置き換える。
値の id を保存のキーの末尾に足すこと、選んだ値を同じ選択肢のモードで共有すること、選んだ値を保存しないことは変えない。

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

- 選択肢を 1 つだけ持つ形のまま、フリックの出る範囲と的の大きさを 1 つの選択肢（9 つの値）にする: 欄が 1 つになり、SPEC の 2 つの欄（UI-107）に反する。
- フリックの出る範囲と的の大きさの値の id をモードの id にはめ込む（`flick-far-small`）: 選択肢の仕組みと保存のキーの形が 2 通りになり、
  モードの id と値の id の区切りが `-` で紛れる。
- 選択肢ごとの select を index.html に書く（#73 の速さの欄の形）: 選択肢を足すたびに index.html を変えることになる。

## 影響

- docs/spec/modes.md（モードの登録、共通、やり直し、MODE-45、MODE-55）, docs/spec/scoring.md（保存の形、SCO-50, SCO-52, SCO-58, SCO-60）, docs/spec/screens.md（トップ画面、
  履歴の画面、セットのまとめ、シェアの文、UI-101〜UI-111）, docs/spec/architecture.md（モードとマップの追加）
- src/modes/types.ts, src/modes/registry.ts, src/modes/session.ts, src/modes/tracking.ts, src/modes/aim/flick.ts, src/ui/option-choices.ts, src/ui/personal-best.ts,
  src/ui/practice-history.ts, src/ui/result-view.ts, src/ui/result-summary.ts, src/ui/history-view.ts, src/ui/set-summary.ts, src/ui/share.ts, src/main.ts, index.html
