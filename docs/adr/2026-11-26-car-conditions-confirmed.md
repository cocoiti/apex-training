# C.A.R. SMG の撮影の条件は撮影者に確かめた値とし、計測の記録から仮定の一覧をなくす

## 状態

承認

## 背景

- 2026-11-25-measure-with-all-purple-attachments.md では、C.A.R. SMG の FOV・壁までの距離・射撃中の操作を撮影者に
  確かめられず、L-STAR と同じ値（FOV 104・10 m・操作なし）を置いて計測の記録の `assumptions` に書いた。
- Issue #65 で撮影者に確かめ、どれも置いた値と同じだった。

## 決定

- C.A.R. SMG の計測の記録から `assumptions` を消し、`conditions.aimInputWhileFiring` を確認済みの「なし」にする。
  `pattern`・`randomness`・許容差の数値は変えない（置いた値と確かめた値が同じため）。
- L-STAR と C.A.R. SMG の両方で、`source` に「FOV 104・壁まで 10 m・射撃中の照準操作なし（撮影者に確認済み）」と書き、
  計測の記録の `conditions.confirmation` に確かめた条件を 1 文で書く。
- 確かめられない条件を仮定として記録に書く決まり（SPEC の計測の換算）は、これからの計測のために残す。

## 却下した案

- `assumptions` を空の配列で残す: 仮定があるのか読み手に分からない。WPN-30 は一覧そのものがないことを求める。
- 確認したことを `assumptions` の文に書き足す: 確かめた条件が仮定の一覧に並び、未確認と読み違える。

## 影響

- spec/weapons.md（計測した武器データ、WPN-30）
- src/data/weapons/car.json, src/data/weapons/lstar.json, docs/measurements/car.json, docs/measurements/lstar.json
- tests/sim/weapon.test.ts
- 2026-11-25-measure-with-all-purple-attachments.md の「確かめられなかった条件を置いて assumptions に書く」の C.A.R. SMG の部分を置き換える
