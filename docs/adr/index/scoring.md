# ADR の目次: scoring

このファイルは scripts/adr-index.py が作る。手で書き換えない。

| ADR | 決定の要点 | 関連 |
|-----|-----------|------|
| [2026-11-25-result-plots-as-svg](../2026-11-25-result-plots-as-svg.md) | リザルトの図は依存を足さず、度の座標の SVG を文字列で作って描く | docs/spec/scoring.md, src/ui/result-plot.ts, src/ui/result-view.ts, index.html |
| [2026-11-25-score-inputs-from-map-target](../2026-11-25-score-inputs-from-map-target.md) | 的の半径はマップの的の箱の見込み角から求め、外れの弾のズレは弾の向きと中心との差にする（一部は 2026-11-26-mode-scoring-and-weaponless-modes で置き換え） | docs/spec/scoring.md, src/sim/scoring.ts, src/sim/trajectory.ts, src/ui/result-view.ts |
| [2026-11-26-history-shot-sections-additive](../2026-11-26-history-shot-sections-additive.md) | 履歴の 1 件に発の区間（5 発ごと）の集計を任意の項目 sections として足して版は 1 のままにし、苦手な区間は保存せず表示のたびに履歴から求める | docs/spec/scoring.md, docs/spec/screens.md, src/sim/scoring.ts, src/ui/practice-history.ts, src/ui/weak-section.ts, src/ui/history-view.ts, src/ui/correction-panel.ts |
| [2026-11-26-mode-scoring-and-weaponless-modes](../2026-11-26-mode-scoring-and-weaponless-modes.md) | モードの採点は任意の scoring で持ち、保存は比べる指標の id を項目名にした版 1 の形にし、武器を使わないモードは武器の id を `-` にする | docs/spec/scoring.md, docs/spec/screens.md, docs/spec/modes.md, src/modes/types.ts, src/ui/mode-scoring.ts, src/ui/personal-best.ts, src/ui/practice-history.ts, src/ui/result-view.ts, src/ui/history-view.ts, src/ui/set-summary.ts, src/ui/share.ts |
