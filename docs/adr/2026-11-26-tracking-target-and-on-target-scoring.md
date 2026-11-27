---
status: accepted
domain: modes
summary: 追いエイムの的の動きは練習の始めに種から区間の列として決め、乗っていたかはモードがステップごとに記録して採点し、撃ち切ったあとの残弾の戻しは Gun の選択にする
related: [docs/spec/modes.md, docs/spec/scoring.md, src/sim/tracking.ts, src/sim/gun.ts, src/modes/tracking.ts, src/modes/aim/, src/modes/session.ts, src/render/targets.ts]
---
# 追いエイムの的の動きは練習の始めに種から区間の列として決め、乗っていたかはモードがステップごとに記録して採点し、撃ち切ったあとの残弾の戻しは Gun の選択にする

## 背景

Issue #73 の追いエイム（docs/spec/modes.md「追いエイム」）は、0.5〜1.5 秒の乱数の間隔と動く範囲の端で切り返す的を左右に動かす。
位置は時刻と種だけで決まり（MODE-37）、採点は各ステップの「乗っている」と切り返しの時刻から求める（docs/spec/scoring.md「追いエイムの採点」）。
追いエイム＋リコイルは撃ち切ったあと `fire` を離すと残弾が装弾数に戻り、撃ち切りと「離して 2 秒」では終わらない（MODE-42）。

## 決定

- 的の動きは `createTrackingMotion`（src/sim/tracking.ts）が setup で練習の乱数から最初の向き・各区間の間隔をこの順に引き、
  練習の長さ（20 秒）までの「始まりの時刻・位置・向き」の区間の列と切り返しの時刻を先に求める。位置はその列から時刻だけで決まる関数で、
  練習の的（ADR: practice-targets-in-world）の `position` に渡す。setup は Gun が乱数を使う前に呼ばれるので、リコイルありでも同じ種なら同じ動き。
- 乗っていたか・照準と的の中心のなす角はモードの step がステップごとに記録し（照準と的の当たりは PracticeSession が先に求める）、
  result で切り返しの時刻・固定ステップの長さと一緒に返す。採点（`scoreTracking`）はその記録だけから決める純粋な関数にする。
- 乗っているときの色は練習の的の `highlightAimed` で的ごとに決め、描画（src/render/targets.ts）が最後のステップの照準の当たりで色を変える。
- 撃ち切ったあと離したら残弾を戻すのは `Gun` の選択（`refillOnRelease`）にし、モードの `refillOnRelease` が true のとき PracticeSession は
  撃ち切りと「離して 2 秒」の終わりの判定をせず、制限時間だけで終える。

## 却下した案

- ステップごとに直前の位置から動かす（状態を積み上げる）: 描画の補間と再生で同じ時刻の位置を求め直せず、足し算の誤差が積もる。
- 採点のために入力の記録を再生して各ステップの当たりを求め直す: 的の動きとレイの計算をリザルトでもう一度行うことになり、モードの外に的の作り方が漏れる。
- 撃ち切ったあとの残弾をモードの step で戻す: Gun の残弾とパターンの位置を外から書き換える口がいり、撃ち切りの終わりの判定と順序がぶつかる。

## 影響

- docs/spec/modes.md（追いエイム、MODE-36〜MODE-45）, docs/spec/scoring.md（追いエイムの採点、SCO-45〜SCO-54）, docs/spec/screens.md（3D の表示）
- src/sim/tracking.ts, src/sim/gun.ts, src/sim/targets.ts, src/modes/tracking.ts, src/modes/aim/tracking.ts, src/modes/aim/tracking-recoil.ts,
  src/modes/session.ts, src/modes/types.ts, src/render/targets.ts
