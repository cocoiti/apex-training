# 練習の的の形は部分の箱の並びとしてシミュレーションが持ち、人形はその 6 つの箱で作り、弾痕を残すかは的と弾の記録の印で持つ

状態: 一部置き換え済み → [2026-11-27-humanoid-silhouette-plate](2026-11-27-humanoid-silhouette-plate.md)（人形を 6 つの部分の箱で作り 3 次元の箱で当たりを求める部分）

## 背景

Issue #90 で、すべてのモードの的を頭・胴・腕・脚の箱でできた人形にする（docs/spec/architecture.md「人形の的」）。
当たりは奥行きを持つ部分の箱の和で求める。空き（脇の下・脚のあいだ）は見通せるときだけ当たらず、斜めから見て側面でふさがれば当たる。空きを「外れ」とする受け入れ条件は置かず、外れは人形の外形から十分離れた向きで確かめる（ARC-63, MODE-51, MODE-59, MODE-61）。描画はシミュレーションと同じ形を読む（ARC-66, UI-136）。
反復練習の人形だけは弾痕を残し、正面にリングを描く（ARC-65, UI-135）。フリックの人形は胴の幅の見込み角で縮尺を決める（MODE-62）。

## 決定

- 練習の的は形として部分の箱の並び `parts`（大きさと、的の中心からの相対的な位置）を持つ（src/sim/targets.ts の `TargetPart`）。
  `add` には 1 つの箱の的なら `size`、組み合わせの的なら `parts` を渡し、状態はどちらも `parts` に揃える。
  `raycastScene` は部分の箱ごとに当たりを求め、当たった部分も返す。人形の箱の表（縮尺 1）と縮尺・置き方は src/sim/humanoid.ts に 1 か所で持つ。
- 当たりは 3 次元の箱で求める（見えている側面にも当たる）。奥行きが 0.25 × 縮尺あるので、視線が斜めになるほど空きは側面で塞がり、
  視線の水平の傾きの tan が 空きの幅 ÷ 奥行き（脇の下 0.16・脚のあいだ 0.24）を超えると、空きを通る照準はなくなる。
- 弾痕を残すかは的の `keepsImpacts` で持ち、残す的に当たった弾は記録に `impactOnTarget: true` を持つ。弾痕の表示（ImpactMarks）は
  弾の記録だけを見て、マップの箱の弾と `impactOnTarget` の弾を表示する。弾痕の位置・ズレは何に当たっても当たった点から求める。
- 描画（src/render/targets.ts）は的ごとに入れ物を作り、部分の箱を `offset` の位置に地の箱と暗い縁の線で置く。リングを描く的（`rings`）は、
  部分の箱を壁と同じ式（environment.ts の `targetFaces`・`ringMarks`）に渡して正面に描き、的の中心が変わったときだけ作り直す。
- 人形は目の位置からのレイの上に、後ろの面をマップの箱のいちばん手前の面より 0.05 メートル手前に置く。フリックでは縮尺が距離 L に比例し、
  奥行きも縮尺で変わるので、L を一次方程式で解く。

## 却下した案

- 描画の側に人形の形を持たせ、シミュレーションは外枠の 1 つの箱で当たりを求める: 空きに当たり、見えている形と当たりがずれる（ARC-63, UI-136 に反する）。
- 当たりを正面の面（2 次元の形）だけで求め、空きを斜めから見ても通るようにする: 見えている側面に当たらず、
  「見えている所に当たれば人形に当たる」（screens.md「3D の表示」）に反する。
- 弾痕を残さない的に当たった弾の位置を null にする: 外れと同じ記録になり、ズレの求め方と命中の数え方が変わる。
- 弾痕を残す的の識別子の一覧を描画に渡す: 練習が終わって的がなくなったあとも、弾の記録だけで同じ表示にできない。

## 影響

- docs/spec/architecture.md（練習の的、人形の的、照準と的の当たり、ARC-63〜ARC-66）, docs/spec/modes.md（反復練習・追いエイム・フリック、MODE-51, MODE-58〜MODE-64）,
  docs/spec/screens.md（3D の表示、UI-135〜UI-138）, docs/spec/weapons.md（当たり判定と弾痕）
- src/sim/targets.ts, src/sim/humanoid.ts, src/sim/hit.ts, src/sim/gun.ts, src/sim/tracking.ts, src/modes/recoil/ghost.ts, src/modes/tracking.ts, src/modes/aim/flick.ts,
  src/render/targets.ts, src/render/impacts.ts, src/render/environment.ts, src/main.ts
- docs/adr/2026-11-26-flick-targets-planned-at-setup.md の、的を壁の正面と平行な正方形の板として置く部分を置き換える（並びの決め方はそのまま）。
