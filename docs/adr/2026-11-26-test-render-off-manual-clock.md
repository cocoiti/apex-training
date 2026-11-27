---
status: accepted
domain: architecture
summary: テストのための描画の省略と時計の差し替えは、本番のビルドが URL のクエリ render=off・clock=manual で切り替え、時計は描画の予定ごと FrameClock で差し替える
related: [docs/spec/architecture.md, src/main.ts, src/core/frame-clock.ts, src/ui/page-options.ts, src/render/scene.ts, tests/helpers/browser.ts]
---
# テストのための描画の省略と時計の差し替えは、本番のビルドが URL のクエリ render=off・clock=manual で切り替え、時計は描画の予定ごと差し替える

## 背景

ブラウザのテストは、描画を確かめないテストでも swiftshader で 3D を描き、撃ち切る・撃たない 2 秒・短いリザルトの 3 秒を
実時間で待っていた。`npm run test:browser` が重いマシンで 18 分かかり、時間を決めている振る舞いは描画の間隔の揺れで不安定だった。
pad-navigation-qa・pad-settings-qa は、ページの performance.now と requestAnimationFrame をテストの初期化スクリプトで
差し替えて時計を進めていた（docs/spec/architecture.md「テストのための描画の省略と時計の差し替え」、ARC-23〜ARC-25）。

## 決定

- `src/main.ts` が起動時に `location.search` を読む（`src/ui/page-options.ts`）。`render=off` なら WebGL の描画器の代わりに
  `UndrawnSceneRenderer`（`src/render/scene.ts`。シーン・カメラ・層は同じに保ち、WebGL の文脈を作らず描画しない）を使う。
- ページの時計は `FrameClock`（`src/core/frame-clock.ts`）にまとめ、固定ステップのループ・短いリザルトの残り時間・
  パッドの項目の移動の繰り返しの時刻と、描画の予定（requestFrame）をこれで決める。既定は performance.now と
  requestAnimationFrame の `RealFrameClock`。`clock=manual` なら `ManualFrameClock` にし、`window.__apexTestClock.advance(秒, 描画の間隔)` で
  進める。advance は間隔ごとに時刻を進めて描画を同期で行うので、実時間で待たずにその時間がたったときと同じになる。
  実際の requestAnimationFrame でも時刻を進めずに描画するので、時計を進めない間もパッドの読み取りや HUD の表示は動く。
- advance の中の描画ではシミュレーションと HUD だけを進め、3D（WebGL）は描かない（`FrameClock.draws` が false）。
  3D は次の実際の requestAnimationFrame で最後の状態を 1 回だけ描く。描画を確かめるテストは時計を進めたあと実際の描画を待ってから
  画面写しを撮るので、写る画面は変わらない。進めるたびに swiftshader で描くと、ゴースト追従のテストのように描画を確かめながら
  時計を細かく進めるテストが重くなる（ARC-28）。
- テストは `tests/helpers/browser.ts` の `appUrl`・`Page.advanceClock`・`Page.advanceClockUntil` を使い、描画を確かめるテストだけが描画する。

## 却下した案

- テスト用のビルド（環境変数や Vite の define で切り替える）: ビルドが 2 種類になり、テストが利用者に配るものと違うものを確かめる。
- テストの初期化スクリプトで performance.now と requestAnimationFrame を差し替える（今までの 2 ファイルのやり方）:
  ページ全体の時間を偽るので描画や Chromium の動きまで巻き込み、ファイルごとに写しが増える。進めた時間の描画も 1 回にまとまる。
- Chromium を `--disable-gpu` などで起動して描画を軽くする: WebGL の文脈と描画の呼び出しは残り、ARC-23 を満たさない。
- `render=off` で canvas を消す: ポインターロックとマウスの入力はキャンバスで受けるので、入力の経路が変わる。

## 影響

- spec/architecture.md（テストのための描画の省略と時計の差し替え、ARC-23〜ARC-25、ARC-27・ARC-28）
- src/main.ts, src/core/frame-clock.ts, src/ui/page-options.ts, src/render/scene.ts, tests/helpers/browser.ts,
  tests/acceptance/render-clock-qa.acceptance.test.ts と、ブラウザを使う受け入れテスト
- 2026-11-25-test-projects-by-browser-import.md の「仕様が時間を決めている所はページの時計（performance.now）で条件にする」を置き換える
