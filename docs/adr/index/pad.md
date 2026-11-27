# ADR の目次: pad

このファイルは scripts/adr-index.py が作る。手で書き換えない。

| ADR | 決定の要点 | 関連 |
|-----|-----------|------|
| [2026-11-25-pad-guide-from-pre-step-state](../2026-11-25-pad-guide-from-pre-step-state.md) | 理想の補正速度は idealCorrectionRate 1 か所で求め、入力推移の理想はステップの入力を適用する前の状態から求め、ガイドはゴーストの表示の条件と今の入力方式がパッドのときに HTML の重ね表示で出す（一部は 2026-11-26-repeat-practice-panel-as-main-aid で置き換え） | docs/spec/pad.md, docs/spec/modes.md, docs/spec/scoring.md, src/sim/weapon.ts, src/sim/trajectory.ts, src/modes/session.ts, src/ui/pad-guide.ts, src/ui/result-view.ts, src/main.ts |
| [2026-11-25-pad-layout-and-mapping-storage](../2026-11-25-pad-layout-and-mapping-storage.md) | パッドは描画ごとに使えるパッドと配置（PadLayout）を選び直し、割り当ては名前ごとの PadLayout の JSON で apex-training:pad-mapping に、パッドの区分は簡易・詳細の値を別々に apex-training:settings:pad に保存する | docs/spec/pad.md, docs/spec/screens.md, src/input/pad-layout.ts, src/input/pad.ts, src/ui/settings.ts, src/ui/pad-mappings.ts, src/ui/pad-settings-form.ts, src/ui/pad-calibration.ts, src/main.ts |
| [2026-11-25-pad-look-per-fixed-step](../2026-11-25-pad-look-per-fixed-step.md) | パッドの look は描画ごとに読んだ値を保持し、固定ステップごとに「速度 × ステップの長さ」で積む | docs/spec/pad.md, src/input/pad.ts, src/input/pad-curve.ts, src/main.ts |
| [2026-11-25-pad-rumble-from-shot-count](../2026-11-25-pad-rumble-from-shot-count.md) | パッドの振動は描画のたびに増えた弾の数だけ要求し、シミュレーションと記録の再生からは出さない | docs/spec/pad.md, src/input/pad-rumble.ts, src/main.ts |
