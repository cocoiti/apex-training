# 練習の的は World が持ち、Simulation がステップの終わりの時刻で位置と出現を決め、照準と的の当たりは射撃のあとに PracticeSession が求め、武器を使わない練習は TapFire で撃つ

状態: 承認

## 背景

Issue #72 で、動く的・出てくる的と照準の当たり（docs/spec/architecture.md「練習の的」「照準と的の当たり」「武器を使わない練習」）を足す。
位置と出現は固定ステップの時刻だけで決まり、描画の間隔によらず、入力の記録の再生で同じになる必要がある（ARC-36, ARC-42）。
弾は練習の的にもマップの箱にも当たり、目の位置からいちばん近いものに当たる（ARC-39, ARC-40）。

## 決定

- 練習の的の集まり `PracticeTargets`（src/sim/targets.ts）を World に持たせる。World は練習ごとに作り直すので、的もほかの練習に残らない。
- Simulation はステップごとに入力を適用したあと、ほかの処理の前に `targets.update(そのステップの終わりの時刻)` を呼ぶ。位置はステップの番号から
  求めた時刻だけで決まり、直前のステップの位置を描画の補間のために残す。出現は「出現の時刻 < ステップの終わり ≤ 消える時刻」で決める。
- 弾の当たりと照準の当たりは、マップの箱と出現している的を 1 つのレイ（`raycastScene`）で調べる。照準の当たりは PracticeSession が
  そのステップの射撃のあと・モードの処理の前に求め、モードは `context.targets.aimed` で読む。
- 武器を使わない練習は Gun の代わりに `TapFire`（押し始めごとに 1 発、リコイルなし）で撃つ。PracticeSession の `gun` は武器の型引数で
  `Gun` か `undefined` になり、武器を使う練習の既存のコードとテストは `gun` をそのまま使える。撃った弾は両方とも `session.shots` で読む。
- 描画は src/render/targets.ts が描画のたびに的の状態を読んで層に置き直すだけで、シミュレーションの状態を変えない（ARC-43）。

## 却下した案

- 的をマップの箱の配列（`world.boxes`）に足し引きする: 箱は読み込んだマップの不変のデータで、採点の的の半径（targetRadius）や描画の環境もそれを読む。
  動く的を混ぜると、それらがステップごとに変わってしまう。
- 的の状態をモードの中だけに持たせ、当たりもモードが求める: 弾の当たり（Gun）と描画がモードの内部に依存し、モードごとに同じ処理を書くことになる。
- 武器を使わない練習でも、装弾数が大きく発射間隔が長い仮の武器で Gun を使う: リコイルの戻り・パターン・残弾の終わりの判定が混ざり、
  「押し続けても 2 発目は出ない」を発射間隔の長さで近似することになる。

## 影響

- docs/spec/architecture.md（練習の的、照準と的の当たり、武器を使わない練習、ARC-36〜ARC-43）, docs/spec/screens.md（3D の表示、UI-98）, docs/spec/modes.md（共通）
- src/sim/targets.ts, src/sim/hit.ts, src/sim/gun.ts, src/sim/tap-fire.ts, src/sim/simulation.ts, src/sim/world.ts, src/modes/session.ts, src/modes/types.ts,
  src/render/targets.ts, src/render/impacts.ts, src/main.ts
