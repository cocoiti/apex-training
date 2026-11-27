# ADR の目次: screens

このファイルは scripts/adr-index.py が作る。手で書き換えない。

| ADR | 決定の要点 | 関連 |
|-----|-----------|------|
| [2026-11-25-correction-panel-from-session-shot-aims](../2026-11-25-correction-panel-from-session-shot-aims.md) | 補正のパネルの自分の線は PracticeSession が発射のステップで取った照準から描き、パネルは度の座標の SVG を HTML の重ね表示で置き直す | docs/spec/screens.md, docs/spec/modes.md, src/modes/session.ts, src/ui/correction-panel.ts, src/ui/settings.ts, src/main.ts, index.html |
| [2026-11-25-environment-as-generated-geometry](../2026-11-25-environment-as-generated-geometry.md) | 壁のパネル・的のリング・床・空は画像のテクスチャでなくコードで作る形で描き、レイに当てず、光の計算をしない材質で軽く描く | docs/spec/screens.md, src/render/environment.ts, src/render/scene.ts |
| [2026-11-25-safe-storage-remove](../2026-11-25-safe-storage-remove.md) | 履歴を消すときはキーを removeItem で消し、SafeStorage はこのページで消したことをメモリに持つ | docs/spec/screens.md, docs/spec/scoring.md, src/ui/storage.ts, src/ui/practice-history.ts |
| [2026-11-25-scope-overlay-from-input](../2026-11-25-scope-overlay-from-input.md) | ADS 中のスコープは HTML と CSS の重ね表示で描き、表示の切替は積んだ ads の入力で決める | docs/spec/screens.md, index.html, src/ui/scope.ts, src/ui/style.css, src/main.ts |
| [2026-11-25-screen-controls-outside-actions](../2026-11-25-screen-controls-outside-actions.md) | 画面の操作のキー（R・Space・Q）とパッドの A / ×・B / ○ はアクションの経路と入力の記録に入れず、押し始めだけを画面ごとの操作に変える | docs/spec/screens.md, docs/spec/pad.md, src/input/screen-controls.ts, src/ui/screen-commands.ts, src/main.ts |
| [2026-11-25-settings-json-per-section](../2026-11-25-settings-json-per-section.md) | 設定は区分ごとに 1 つのキーに JSON で保存し、読むときに項目ごとに範囲に収めるか既定値にする | docs/spec/screens.md, docs/spec/input.md, docs/spec/mouse.md, src/ui/settings.ts, src/ui/settings-form.ts |
| [2026-11-26-direction-sounds-web-audio](../2026-11-26-direction-sounds-web-audio.md) | 向きの音は Web Audio の発振器でその場で合成し、描画のたびに増えた弾の記録の patternShot で鳴らす発を決め、試聴は押した時点の AudioContext の時刻を起点に、ページの時計で先読みして予約する | docs/spec/screens.md, docs/spec/modes.md, src/ui/direction-sound.ts, src/sim/gun.ts, src/ui/settings.ts, src/main.ts, index.html |
| [2026-11-26-pad-menu-navigation](../2026-11-26-pad-menu-navigation.md) | パッドでの項目の移動は PadNavigator（読み取り）と PadMenu（画面への当て方）に分け、フォーカスは枠のクラスで表し、値は要素の値を変えて input・change を送り、入力方式の切替はプレイ画面の操作だけで数える | docs/spec/screens.md, docs/spec/pad.md, docs/spec/input.md, src/input/pad-navigation.ts, src/ui/pad-menu.ts, src/ui/history-view.ts, src/main.ts |
| [2026-11-26-recoil-moves-camera](../2026-11-26-recoil-moves-camera.md) | リコイルは視点が跳ねる表示（カメラが動き、クロスヘアは中心のまま）だけにし、表示の方式を切り替える設定を作らない | docs/spec/screens.md, src/render/scene.ts, src/sim/player.ts, src/ui/style.css, src/ui/settings.ts, index.html |
| [2026-11-26-share-summary-text-only](../2026-11-26-share-summary-text-only.md) | 結果のシェアは src/ui/share.ts が作る要約の文だけを navigator.share の text かクリップボードの writeText に渡し、公開 URL は固定の文字列にし、パッドの Y / △ は画面の操作として読む | docs/spec/screens.md, docs/spec/overview.md, docs/spec/pad.md, src/ui/share.ts, src/ui/screen-commands.ts, src/input/screen-controls.ts, src/main.ts, index.html |
| [2026-11-26-top-cards-over-hidden-selects](../2026-11-26-top-cards-over-hidden-selects.md) | トップ画面の武器とモードはカードで選び、選んでいる値は隠した select が持ち、カードの並び全体（data-card-choice）を 1 つの選択肢の欄にし、モードは必須の説明とアイコンの形の名前を持つ | docs/spec/screens.md, docs/spec/modes.md, index.html, src/ui/card-choices.ts, src/ui/mode-cards.ts, src/ui/mode-icons.ts, src/ui/pad-menu.ts, src/modes/types.ts, src/modes/registry.ts, src/main.ts |
