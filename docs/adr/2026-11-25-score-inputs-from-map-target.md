---
status: accepted
domain: scoring
summary: 的の半径はマップの的の箱の見込み角から求め、外れの弾のズレは弾の向きと中心との差にする（一部は 2026-11-26-mode-scoring-and-weaponless-modes で置き換え）
related: [docs/spec/scoring.md, src/sim/scoring.ts, src/sim/trajectory.ts, src/ui/result-view.ts]
---
# 的の半径はマップの的の箱の見込み角から求め、外れの弾のズレは弾の向きと中心との差にする

## 置き換え

一部は次の ADR で置き換えた: [2026-11-26-mode-scoring-and-weaponless-modes](2026-11-26-mode-scoring-and-weaponless-modes.md)（採点の入力を弾痕のズレだけとする部分）

## 背景

Issue #12 でリザルト画面に採点結果を出す。採点（docs/spec/scoring.md「採点の入力」）は弾ごとのズレと的の半径（度）から決まるが、
SPEC は的の半径の値も、どの箱にも当たらなかった弾（`ShotRecord.deviation` が null）のズレも決めていない。
どちらも平均ズレ・命中率と、保存する自己ベストの値を左右するので、後から変えると過去の自己ベストと比べられなくなる。

## 決定

- 的の半径は `src/sim/scoring.ts` の `targetRadius` で、マップの `kind: "target"` の箱の幅と高さの小さいほうの半分を、
  目の位置から手前の面までの距離で見込む角度にする。的が複数あれば最も近いもの、なければ `DEFAULT_TARGET_RADIUS`（1 度）。
  `range` では 0.3 m ÷ 9.9 m で約 1.74 度になり、画面に見えている的の縁と命中の判定が一致する。
- 外れの弾のズレは `shotDeviations` で、弾の向き（`ShotRecord.angles`）と中心との差（ヨーは正規化）にする。
  弾のレイは目の位置から飛ぶので、当たった弾の `deviation` も弾の向きと中心との差に一致し、当たりと外れで同じ量になる。
- 各弾の発射時の自分の照準（軌道の重ね描き）は `src/sim/trajectory.ts` の `aimAtShots` で、記録から求めた照準の軌道のうち、
  その弾を撃つステップ（⌊発射の時刻 ÷ dt⌋、Gun と同じ許容幅）の終わりの点を使う。Gun はそのステップの入力を適用したあとに撃つ。

## 却下した案

- 的の半径を固定の定数にする: マップを足したり的の大きさを変えたりすると、見えている的と命中の判定がずれる。
- 的の半径をマップの JSON の項目にする: データの形（docs/spec/architecture.md のマップ）を変える必要があり、箱の大きさと二重に持つことになる。
- 外れの弾を採点から除く: 大きく外したほど弾数が減って平均ズレが小さくなり、自己ベストが良く見える。
- 外れの弾のズレを固定の大きな値にする: 値の選び方に根拠がなく、平均ズレが外れの数だけで決まってしまう。

## 影響

- docs/spec/scoring.md（採点の入力、リザルト画面、SCO-1〜SCO-3、SCO-16、SCO-18〜SCO-21）
- src/sim/scoring.ts、src/sim/trajectory.ts、src/ui/result-view.ts
