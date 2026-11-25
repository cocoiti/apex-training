# 反復練習は補正のパネルを主な補助にし、パネルの出し方はモードが持つ。表示名だけを変え、id `ghost` は残す

状態: 承認

## 背景

3D の中のゴーストに照準を重ねるのは難しく、練習の主な補助を画面の端の補正のパネル（パターンのガイド）にしたい、という人間の決定があった。
あわせて「ゴースト追従」の表示名を「反復練習」に変える。パターン観察は別の Issue で廃止する予定。
モードの id は履歴・自己ベストの保存のキー（`apex-training:best:<入力方式>:<武器>:<モード>` など）に使っている。

## 決定

- `TrainingMode` に任意の `correctionPanel`（`'always' | 'setting'`）を足し、反復練習は `always`、センター維持は `setting` を持つ。
  持たないモード（パターン観察）では出さない。表示するかは `correctionPanelShown`（src/ui/correction-panel.ts）で決める。
- 設定の「補正のパネル」はセンター維持だけが使う（既定 ON）。設定の「ゴースト表示」は 3D の中のゴーストだけに使い、既定を OFF にする。
- パッドのスティック型のガイドは、ゴースト表示の設定から切り離し、反復練習でパッドのあいだは出す（2D の補助で、3D のゴーストの難しさとは別）。
  ADR: pad-guide-from-pre-step-state のガイドの表示の条件（ゴースト表示が ON のとき）を置き換える。
- パネルに今の照準の印と、今の照準から次の発の点への向かう先の線を足す。今の照準は `PracticeSession.aim`（開始時の照準からの差）。
  パネルの大きさは画面の短い辺の 45%（360px まで）で、低い画面ではパッドのガイドの上に収まるまで縮める。
- 表示名だけを「反復練習」に変え、id は `ghost` のまま残す。ADR と元の企画書の「ゴースト追従」は当時の記録として書き換えない。

## 却下した案

- id も `repeat` などに変える: 保存済みの履歴と自己ベストのキーが変わり、読み替えの移行が要る。表示名の変更だけには見合わない。
- パネルを出すモードを main.ts で id を見て決める: モードのファイルを足すだけで選択肢に出る作り（ADR: mode-files-by-glob）に合わない。
- 反復練習でも設定の補正のパネルで消せるようにする: 主な補助を消すと反復練習の意味がなくなる。補助なしの練習はセンター維持で行う。
- ゴースト表示の既定を ON のままにする: 主な補助がパネルになり、見づらい 3D のゴーストが既定で重なると、どちらを見るか迷う。

## 影響

- 置き換える ADR: 2026-11-25-pad-guide-from-pre-step-state（ガイドの表示の条件だけ）
- spec/modes.md（共通、反復練習、センター維持、MODE-3, MODE-12〜MODE-15, MODE-24〜MODE-27）, spec/screens.md（設定項目、補正のパネル、UI-4, UI-13, UI-55〜UI-63）, spec/pad.md（練習中のガイド、PAD-17, PAD-18）
- src/modes/types.ts, src/modes/recoil/ghost.ts, src/modes/recoil/center.ts, src/modes/session.ts, src/ui/correction-panel.ts, src/ui/pad-guide.ts, src/ui/settings.ts, src/main.ts, src/ui/style.css, index.html
