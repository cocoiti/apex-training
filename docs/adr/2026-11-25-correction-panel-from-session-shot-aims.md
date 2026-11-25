# 補正のパネルの自分の線は PracticeSession が発射のステップで取った照準から描き、パネルは度の座標の SVG を HTML の重ね表示で置き直す

状態: 承認

## 背景

screens.md「補正のパネル」は、練習中のプレイ画面の右端に、理想の補正軌道の線・今の発の点・撃った各弾の発射時の照準を結んだ
自分の線を出す。自分の線はリザルトの「自分の照準の軌道」と同じもので、照準を理想の補正軌道に合わせて撃てば理想の線に重なる（UI-57）。
リザルトでは記録から `aimAtShots` で計算し直している（ADR: record-at-sim-input-source）。練習中は描画のたびに今の状態が要る。
1 回の描画で固定ステップが複数進むことがあり、描画の時点の照準では発射時の照準にならない。

## 決定

- `PracticeSession` のステップのフックで、`Gun.step` のあとに増えた弾の数だけ、そのステップの入力を適用したあとの照準
  （World の中心からの差、リコイルのオフセットを含まない）を `shotAims` に足す。`aimAtShots` と同じ決め方で、同じ値になる。
- Gun の `ShotRecord` とシミュレーションの状態は変えない。弾痕・採点・入力の記録はパネルの有無で変わらない（UI-61）。
- 今の発の点はゴーストと同じ `Gun.nextPatternShot` で決め、撃ち切った（残弾 0）ときは出さない。
- 範囲はリザルトの図と同じ `plotExtent` で、原点と 1〜装弾数発目の理想の補正軌道から練習の始めに 1 回だけ決める。範囲の外の点は枠の縁に寄せる。
- 描画は index.html の .correction-panel の SVG（度の座標の viewBox）の属性を `CorrectionPanel`（src/ui/correction-panel.ts）が
  描画のたびに置き直す。値が変わらない属性は書き直さない。設定の `correctionPanel`（共通の区分）は「開始」の時点で読む。
- パネルは右上の操作の下（top 64px）に置き、右下のパッドのガイドと離す（大きさと、どのモードで出すかは ADR: repeat-practice-panel-as-main-aid）。

## 却下した案

- 描画のたびに記録から `aimAtShots` で計算し直す: 練習が長いほど毎回の再計算が増え、結果は同じ。
- `ShotRecord` に照準を足す: sim のデータの形が変わり、リザルト・再生・履歴の比較に影響する。表示のためだけの値。
- 描画の時点の照準を新しい弾に当てる: 1 回の描画で複数のステップが進むと発射時の照準とずれ、UI-57 で重ならない。
- 描画のたびに `plotHtml` で innerHTML を作り直す: 毎フレームの DOM の作り直しになる。点の位置を data 属性で読めるようにもしたい。
- 範囲を自分の点も含めて広げる: 練習中に縮尺が変わり、理想の線の形が見比べにくくなる（SPEC が範囲を固定にしている）。

## 影響

- spec/screens.md（補正のパネル、設定項目、UI-11, UI-13, UI-55〜UI-61）, spec/modes.md（共通、MODE-24）, spec/weapons.md（理想の補正軌道）
- src/modes/session.ts, src/ui/correction-panel.ts, src/ui/settings.ts, src/ui/settings-form.ts, src/ui/practice-settings.ts, src/ui/style.css, src/main.ts, index.html
