---
status: accepted
domain: scoring
summary: 履歴の 1 件に発の区間（5 発ごと）の集計を任意の項目 sections として足して版は 1 のままにし、苦手な区間は保存せず表示のたびに履歴から求める
related: [docs/spec/scoring.md, docs/spec/screens.md, src/sim/scoring.ts, src/ui/practice-history.ts, src/ui/weak-section.ts, src/ui/history-view.ts, src/ui/correction-panel.ts]
---
# 履歴の 1 件に発の区間（5 発ごと）の集計を任意の項目 sections として足し、版は 1 のままにする

## 背景

苦手な区間（docs/spec/scoring.md「苦手な区間」）は、直近 5 回の練習の発ごとのズレから求める。今の履歴の 1 件は平均ズレなどの
集計だけを持ち、発ごとのズレを持たない。すでに保存してある古い形式の件（`sections` なし）を壊さずに読み続ける必要がある。

## 決定

- 採点（`src/sim/scoring.ts` の `score`）が発の区間ごとの弾数・水平と垂直のズレの平均・ズレの大きさの平均（`ShotSection`）を出し、
  履歴の 1 件に `sections` として保存する。発ごとのズレそのものは保存しない。
- 保存の形の `version` は 1 のままにし、`sections` は任意の項目にする。読むときは `entrySections` で形を確かめ、
  合わない件は「発の区間ごとのズレを持たない件」として数えないだけで、ほかの項目と元の値はそのまま書き直す。
- 苦手な区間は保存せず、表示のたびに履歴から求める（`src/ui/weak-section.ts`）。リザルト・履歴の画面・補正のパネルが同じ関数を使う。

## 却下した案

- 発ごとのズレ（弾ごとの h・v）をすべて保存する: 1 件が装弾数ぶん大きくなり、組ごとに 200 件を持つと localStorage の容量を
  圧迫する。苦手な区間は 5 発ごとの「平均 × 弾数」の和で合わせられるので、集計で足りる。
- `version` を 2 に上げる: 今の読み方は `version` が 1 でない値を空の履歴として扱うので、古い版の画面で開くと履歴が消えて見える。
  足すだけの変更なので、任意の項目にすれば前後どちらの版でも読める。
- 形に合わない `sections` を読むときに取り除く: SPEC は「そのまま書き直す」としている。直した版で読めるように元の値を残す。
- 苦手な区間を求めた結果を履歴に保存する: 求め方（件数・しきい値）を変えたときに古い結果が残る。履歴からいつでも求め直せる。

## 影響

- spec/scoring.md（発の区間ごとのズレ、苦手な区間、履歴の保存の形、SCO-31〜SCO-38）
- spec/screens.md（履歴の画面、補正のパネル、UI-64〜UI-68）
- src/sim/scoring.ts, src/ui/practice-history.ts, src/ui/weak-section.ts, src/ui/result-view.ts, src/ui/history-view.ts,
  src/ui/correction-panel.ts, src/main.ts, index.html
