---
status: accepted
domain: scoring
summary: リザルトの図は依存を足さず、度の座標の SVG を文字列で作って描く
related: [docs/spec/scoring.md, src/ui/result-plot.ts, src/ui/result-view.ts, index.html]
---
# リザルトの図は依存を足さず、度の座標の SVG を文字列で作って描く

## 背景

Issue #12 でリザルト画面に、弾痕の散布図、自分の照準の軌道と理想の軌道の重ね描き、パターン観察の弾痕とパターンの重ね描きを出す
（docs/spec/scoring.md「リザルト画面」）。単体テストは node の環境で動き DOM がない（vite.config.ts）。
配布物には画像を含めない（docs/spec/overview.md、check:assets）。

## 決定

- 図は `src/ui/result-plot.ts` の `plotHtml` で、`viewBox` を角度（度）の座標にした SVG を含む `figure` の HTML 文字列にする。
  右と上を正にするため y を反転し、範囲はすべての点と円が入る幅（最小 1 度）にする。線の太さは `vector-effect` で画面の px に揃える。
- 図と系列には `data-plot`（`scatter`・`trajectory`・`pattern`）と `data-series`・`data-count` を付け、テストはそれで中身を確かめる。
- 文言は固定の文言と数だけだが、埋める前にエスケープする。画面への反映は `renderResult` が `innerHTML` で行う。

## 却下した案

- グラフのライブラリ（Chart.js など）を足す: 点と折れ線と円だけのために依存と配布物の大きさが増える。
- canvas の 2D に描く: node の単体テストで中身を確かめられず、受け入れテストも画素で見る必要がある。
- Three.js のシーンに描く: リザルト画面は HTML の画面で、3D のシーンとは別の座標（度）で描きたい。
- DOM の API（createElementNS）で組み立てる: node の単体テストで DOM の代わりを用意する必要があり、文字列で足りる。

## 影響

- docs/spec/scoring.md（リザルト画面、SCO-16、SCO-17）
- src/ui/result-plot.ts、src/ui/result-view.ts、src/ui/style.css、index.html
