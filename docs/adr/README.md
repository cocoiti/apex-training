# ADR（設計の決定記録）

SPEC（`docs/spec/`）はプロダクトが今どう振る舞うかを書く。ADR は「なぜそうしたか」を書く。

## 読み方

この目次だけを読み、関連（SPEC・パス）が今の作業に合う「承認」の行のファイルだけを開く。全部のファイルは読まない。

## 書き方

- 書くのは、別の案を比べて却下した、後から戻しにくい（データの形式、外部との境界、依存の追加など）、
  レビューで「なぜこうしたか」と聞かれそう、のどれかに当たる決定だけ。
- 1 つの決定を 1 ファイルにし、`docs/adr/<YYYY-MM-DD>-<短い英語の名前>.md` に書く（並行する PR でぶつからないよう連番にしない）。
- 節は「# <決定の要点>」「状態（承認 / 置き換え済み → <新しいファイル>）」「背景」「決定」「却下した案」
  「影響（関係する SPEC の ID・パス）」。40 行程度に収める。
- 書いたら下の目次に 1 行足す。
- 決定を変えるときは既存の ADR を書き換えず、新しい ADR を書き、古い ADR と目次の状態を「置き換え済み → <新しいファイル>」にする。

## 目次

| ADR | 決定の要点 | 状態 | 関連 |
|-----|-----------|------|------|
| [2026-11-25-3d-from-mvp](2026-11-25-3d-from-mvp.md) | MVP から Three.js の一人称 3D で作る | 承認 | spec/architecture.md, spec/screens.md, src/render/, src/sim/ |
| [2026-11-25-weapon-data-as-json](2026-11-25-weapon-data-as-json.md) | 武器のリコイルは JSON のデータとして外に出す | 承認 | spec/weapons.md, src/data/weapons/ |
| [2026-11-25-practice-only-no-cheat-outputs](2026-11-25-practice-only-no-cheat-outputs.md) | ブラウザ内の練習に限り、チートに転用できる出力とエイムアシストを作らない | 承認 | spec/overview.md, spec/pad.md |
| [2026-11-25-fixed-timestep-deterministic-sim](2026-11-25-fixed-timestep-deterministic-sim.md) | 固定ステップで、DOM と Three.js から切り離し、入力だけで結果が決まるシミュレーションにする | 承認 | spec/architecture.md, spec/input.md, src/core/, src/sim/ |
| [2026-11-25-input-actions-and-angles](2026-11-25-input-actions-and-angles.md) | 入力は最初からアクションと角度（度）に揃える | 承認 | spec/input.md, spec/mouse.md, spec/pad.md, src/input/ |
| [2026-11-25-static-site-hash-routing](2026-11-25-static-site-hash-routing.md) | サーバーなしの静的サイトにし、画面はハッシュで切り替える | 承認 | spec/overview.md, spec/screens.md |
| [2026-11-25-data-json-as-fetched-assets](2026-11-25-data-json-as-fetched-assets.md) | データの JSON は src/data/ に置き、Vite の資産として出してベースパス基準の URL で fetch する | 承認 | spec/architecture.md（ARC-11, ARC-14）, src/data/maps/, vite.config.ts, scripts/check-subpath.mjs |
| [2026-11-25-lint-eslint-typescript-6](2026-11-25-lint-eslint-typescript-6.md) | lint は ESLint（typescript-eslint）と tsc で行い、TypeScript は 6.0 系に留める | 承認 | spec/architecture.md（ARC-1, ARC-4, ARC-13）, package.json, eslint.config.js, tests/helpers/sim-boundary.ts |
| [2026-11-25-safe-storage-wrapper](2026-11-25-safe-storage-wrapper.md) | localStorage は例外を投げない SafeStorage を通し、失敗後もページを開いている間はメモリで値を持つ | 承認 | spec/overview.md（OVR-4）, src/ui/storage.ts, src/main.ts |
| [2026-11-25-fire-schedule-from-press](2026-11-25-fire-schedule-from-press.md) | 発射の時刻は押し始めのステップを起点に「発数 × 発射間隔」で決め、押し直しでは発射間隔を待たない | 承認 | spec/weapons.md（発射、WPN-4, WPN-5）, src/sim/gun.ts |
| [2026-11-25-pad-look-per-fixed-step](2026-11-25-pad-look-per-fixed-step.md) | パッドの look は描画ごとに読んだ値を保持し、固定ステップごとに「速度 × ステップの長さ」で積む | 承認 | spec/pad.md（PAD-4〜PAD-7、PAD-10〜PAD-14）, src/input/pad.ts, src/input/pad-curve.ts, src/main.ts |
| [2026-11-25-render-scene-without-webgl](2026-11-25-render-scene-without-webgl.md) | 描画はシーンとカメラ（ViewScene）と WebGL の描画器に分け、FOV の換算は fov.ts の 1 か所で行う | 承認 | spec/architecture.md（ARC-15〜17）, spec/screens.md（UI-5, UI-7, UI-8）, src/render/ |
| [2026-11-25-lstar-measured-from-view-motion](2026-11-25-lstar-measured-from-view-motion.md) | L-STAR の跳ねは録画の画面の動きから求め、FOV の値の Hor+ 換算（ADS の倍率なし）で角度にする | 承認 | spec/weapons.md（WPN-14〜WPN-17）, src/data/weapons/lstar.json, docs/measurements/lstar.json |
| [2026-11-25-manual-gh-pages-deploy-script](2026-11-25-manual-gh-pages-deploy-script.md) | GitHub Pages へは自前のスクリプトで一時的な作業ツリーから gh-pages ブランチへ手動で push して公開する | 承認 | spec/overview.md（OVR-7, OVR-8, OVR-9）, scripts/deploy.mjs, package.json |
| [2026-11-25-mode-files-by-glob](2026-11-25-mode-files-by-glob.md) | 練習モードは `src/modes/<category>/*.ts` の default export を import.meta.glob で集め、並び順とファイル名で並べる | 承認 | spec/modes.md（モードの登録、MODE-5）, spec/screens.md（トップ画面）, src/modes/registry.ts, src/modes/types.ts, src/sim/practice.ts |
| [2026-11-25-practice-session-per-start](2026-11-25-practice-session-per-start.md) | 練習は「開始」ごとに World・入力のキュー・シミュレーション・ループを作り直し、「開始」を押さずに開いた #/play はトップに戻す | 承認 | spec/modes.md（共通、MODE-6〜MODE-11）, spec/screens.md（UI-1, UI-3）, src/main.ts, src/modes/session.ts, src/ui/practice-flow.ts |
| [2026-11-25-pause-freezes-loop-clock](2026-11-25-pause-freezes-loop-clock.md) | 一時停止はループの時計を止めて止めていた時間を数えず、ポインターロックの結果は要求の Promise で判断する | 承認 | spec/mouse.md（MOU-1〜MOU-3, MOU-7, MOU-8）, src/core/loop.ts, src/input/mouse.ts, src/main.ts |
| [2026-11-25-record-at-sim-input-source](2026-11-25-record-at-sim-input-source.md) | 入力の記録はシミュレーションに積む入力の元で取り、練習ごとに種を決めて World から作り直し、再生と照準の軌道は記録から計算し直す | 承認 | spec/input.md（INP-4〜INP-8）, spec/architecture.md（ARC-2, ARC-3）, src/input/recording.ts, src/sim/practice.ts, src/sim/trajectory.ts, src/modes/session.ts, src/main.ts |
| [2026-11-25-settings-json-per-section](2026-11-25-settings-json-per-section.md) | 設定は区分ごとに 1 つのキーに JSON で保存し、読むときに項目ごとに範囲に収めるか既定値にする | 承認 | spec/screens.md（UI-2, UI-11〜UI-15）, spec/input.md, spec/mouse.md（MOU-12）, src/ui/settings.ts, src/ui/settings-form.ts |
| [2026-11-25-asset-manifest-check](2026-11-25-asset-manifest-check.md) | 配布物の素材は src/assets/assets.json の一覧とパス・ハッシュを除いた名前で照らし、資産は大きさによらず data: URL に埋め込まない | 一部置き換え済み → [2026-11-25-asset-license-allowlist](2026-11-25-asset-license-allowlist.md)（公式の名前の判定） | spec/overview.md（素材の一覧、OVR-2, OVR-10〜OVR-14）, scripts/check-assets.mjs, src/assets/assets.json, vite.config.ts |
| [2026-11-25-asset-license-allowlist](2026-11-25-asset-license-allowlist.md) | 素材の検査は作者・出どころの名前を見ず、license を self-made と許可した SPDX 識別子との完全一致で判定し、OSS 系には source の URL を求める | 承認 | spec/overview.md（許可するライセンス、OVR-2, OVR-15〜OVR-19）, scripts/check-assets.mjs |
| [2026-11-25-score-inputs-from-map-target](2026-11-25-score-inputs-from-map-target.md) | 的の半径はマップの的の箱の見込み角から求め、外れの弾のズレは弾の向きと中心との差にする | 承認 | spec/scoring.md（採点の入力、リザルト画面、SCO-16, SCO-18〜SCO-21）, src/sim/scoring.ts, src/sim/trajectory.ts, src/ui/result-view.ts |
| [2026-11-25-result-plots-as-svg](2026-11-25-result-plots-as-svg.md) | リザルトの図は依存を足さず、度の座標の SVG を文字列で作って描く | 承認 | spec/scoring.md（リザルト画面、SCO-16, SCO-17）, src/ui/result-plot.ts, src/ui/result-view.ts, index.html |
| [2026-11-25-ghost-angles-from-mode](2026-11-25-ghost-angles-from-mode.md) | ゴーストの向きはモードの任意の関数 ghost で求め、描画は src/render/ghost.ts が描画のたびに行う | 承認 | spec/modes.md（ゴースト追従、MODE-3, MODE-12〜MODE-15）, spec/screens.md（UI-4, UI-16, UI-17）, src/modes/types.ts, src/modes/recoil/ghost.ts, src/render/ghost.ts, src/ui/practice-settings.ts |
| [2026-11-25-environment-as-generated-geometry](2026-11-25-environment-as-generated-geometry.md) | 壁のパネル・的のリング・床・空は画像のテクスチャでなくコードで作る形で描き、レイに当てず、光の計算をしない材質で軽く描く | 承認 | spec/screens.md（3D の表示、UI-18〜UI-20, UI-23）, src/render/environment.ts, src/render/scene.ts |
| [2026-11-25-scope-overlay-from-input](2026-11-25-scope-overlay-from-input.md) | ADS 中のスコープは HTML と CSS の重ね表示で描き、表示の切替は積んだ ads の入力で決める | 承認 | spec/screens.md（ADS 中の照準、UI-21, UI-22）, index.html, src/ui/scope.ts, src/ui/style.css, src/main.ts |
| [2026-11-25-test-projects-by-browser-import](2026-11-25-test-projects-by-browser-import.md) | テストは tests/helpers/browser.ts を import するかで Vitest の unit と browser の project に分け（browser は 1 ファイルずつ）、サーバーはポート 0 で待ち受け、画面の状態は sleep でなく条件で待つ | 承認 | spec/architecture.md（テストの実行、ARC-18〜ARC-22）, vite.config.ts, package.json, tests/helpers/browser.ts, tests/helpers/server.ts, tests/helpers/test-code.ts |
| [2026-11-25-input-switch-gate](2026-11-25-input-switch-gate.md) | 入力方式の切替はデバイスとキューの間の InputSwitch 1 か所で行い、操作は押し始め・デッドゾーンを出た瞬間で判定し、練習の入力方式は 1 発目のときの入力方式にする | 承認 | spec/input.md（INP-1〜INP-3, INP-9〜INP-14）, spec/modes.md, spec/scoring.md, src/input/input-switch.ts, src/input/pad.ts, src/input/mouse.ts, src/modes/session.ts, src/main.ts |
| [2026-11-25-history-scored-modes-list](2026-11-25-history-scored-modes-list.md) | 履歴の画面のモードの選択肢は、採点するモードの id と名前の固定の一覧から作る | 承認 | spec/screens.md（履歴の画面、UI-24, UI-26）, src/ui/history-view.ts, src/main.ts |
| [2026-11-25-safe-storage-remove](2026-11-25-safe-storage-remove.md) | 履歴を消すときはキーを removeItem で消し、SafeStorage はこのページで消したことをメモリに持つ | 承認 | spec/screens.md（UI-27, UI-28）, spec/scoring.md（練習の履歴）, src/ui/storage.ts, src/ui/practice-history.ts |
| [2026-11-25-screen-controls-outside-actions](2026-11-25-screen-controls-outside-actions.md) | 画面の操作のキー（R・Space・Q）とパッドの A / ×・B / ○ はアクションの経路と入力の記録に入れず、押し始めだけを画面ごとの操作に変える | 承認 | spec/screens.md（画面の操作、UI-32, UI-33, UI-35, UI-37, UI-38）, spec/pad.md, src/input/screen-controls.ts, src/ui/screen-commands.ts, src/main.ts |
| [2026-11-25-practice-set-within-play-screen](2026-11-25-practice-set-within-play-screen.md) | やり直しと連続練習の各回はプレイ画面のまま練習を作り直し、セットの状態と短いリザルトの時間は sim の外の PracticeSet で持つ | 承認 | spec/modes.md（やり直し、連続練習、MODE-16〜MODE-23）, spec/screens.md（セットのまとめ、UI-34〜UI-36, UI-39）, src/ui/practice-set.ts, src/ui/practice-flow.ts, src/main.ts |
| [2026-11-25-pad-guide-from-pre-step-state](2026-11-25-pad-guide-from-pre-step-state.md) | 理想の補正速度は idealCorrectionRate 1 か所で求め、入力推移の理想はステップの入力を適用する前の状態から求め、ガイドはゴーストの表示の条件と今の入力方式がパッドのときに HTML の重ね表示で出す | 承認 | spec/pad.md（パッド向けのガイド、PAD-15〜PAD-20）, spec/modes.md（ゴースト追従）, spec/scoring.md（リザルト画面）, src/sim/weapon.ts, src/sim/trajectory.ts, src/modes/session.ts, src/ui/pad-guide.ts, src/ui/result-view.ts, src/main.ts |
| [2026-11-25-pad-layout-and-mapping-storage](2026-11-25-pad-layout-and-mapping-storage.md) | パッドは描画ごとに使えるパッドと配置（PadLayout）を選び直し、割り当ては名前ごとの PadLayout の JSON で apex-training:pad-mapping に、パッドの区分は簡易・詳細の値を別々に apex-training:settings:pad に保存する | 承認 | spec/pad.md（PAD-2, PAD-3, PAD-24〜PAD-29）, spec/screens.md（UI-40〜UI-42）, src/input/pad-layout.ts, src/input/pad.ts, src/ui/settings.ts, src/ui/pad-mappings.ts, src/ui/pad-settings-form.ts, src/ui/pad-calibration.ts, src/main.ts |
| [2026-11-25-pad-rumble-from-shot-count](2026-11-25-pad-rumble-from-shot-count.md) | パッドの振動は描画のたびに増えた弾の数だけ要求し、シミュレーションと記録の再生からは出さない | 承認 | spec/pad.md（振動、PAD-8, PAD-23）, src/input/pad-rumble.ts, src/main.ts |
| [2026-11-25-measure-with-all-purple-attachments](2026-11-25-measure-with-all-purple-attachments.md) | 計測はアタッチメントをすべて紫にして撮り、外れた射撃は記録の excludedFromAverage に理由を書いて平均から外し、撮影者に確かめられなかった条件は仮定として記録する | 承認 | spec/weapons.md（計測した武器データ、WPN-14〜WPN-16, WPN-18〜WPN-20）, spec/modes.md（MODE-1）, src/data/weapons/car.json, src/data/weapons/lstar.json, docs/measurements/ |
| [2026-11-26-pad-menu-navigation](2026-11-26-pad-menu-navigation.md) | パッドでの項目の移動は PadNavigator（読み取り）と PadMenu（画面への当て方）に分け、フォーカスは枠のクラスで表し、値は要素の値を変えて input・change を送り、入力方式の切替はプレイ画面の操作だけで数える | 承認 | spec/screens.md（パッドでの項目の移動と変更、UI-43〜UI-54）, spec/pad.md（PAD-32, PAD-33）, spec/input.md（INP-15, INP-16）, src/input/pad-navigation.ts, src/ui/pad-menu.ts, src/ui/history-view.ts, src/main.ts |
