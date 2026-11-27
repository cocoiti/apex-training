---
status: accepted
domain: architecture
summary: テストは tests/helpers/browser.ts を import するかで Vitest の unit と browser の project に分け（browser は 1 ファイルずつ）、サーバーはポート 0 で待ち受け、画面の状態は sleep でなく条件で待つ（一部は 2026-11-26-test-render-off-manual-clock・2026-11-26-parallel-browser-test-files で置き換え）
related: [docs/spec/architecture.md, vite.config.ts, package.json, tests/helpers/browser.ts, tests/helpers/server.ts, tests/helpers/test-code.ts]
---
# テストは tests/helpers/browser.ts を import するかで Vitest の 2 つの project に分け、ポートは 0、待ちは条件で行う

## 置き換え

一部は次の ADR で置き換えた: 2026-11-26-test-render-off-manual-clock.md（仕様が時間を決めている所の待ち方）、2026-11-26-parallel-browser-test-files.md（browser の組を 1 ファイルずつ流すこと）

## 背景

ブラウザ（Chromium）を使う受け入れテストは、ファイルごとに決まったポート（3104〜3121）で配信と DevTools を待ち受け、
画面の状態を固定の時間の sleep で待っていた。別の作業ツリーで同時に npm test を流すとポートを取り合って落ち、
同じポートを 2 つのファイルが使っていた（3120・3121）ため 1 つの作業ツリーでも並列の実行で落ちることがあった。
sleep は、マシンが混んでいると足りず、空いていると無駄に長い（docs/spec/architecture.md「テストの実行」）。

## 決定

- `vite.config.ts` の `test.projects` に `unit` と `browser` を置く。`browser` は `fileParallelism: false` で 1 ファイルずつ流す。
  `npm test` は両方、`npm run test:unit` と `npm run test:browser` は片方だけを流す（`--project`）。
- ブラウザを使うファイルは、`tests/helpers/browser.ts` を import しているかで設定の読み込み時に決める（`usesChromium`）。
  Chromium はこの道具からしか起動しないため。判定は `vite.config.ts` の中に置く（tests/ を写さない写しのビルドでも設定を読めるように）。
- テストが立てるサーバー（静的な配信、Vite の開発サーバー、Chromium の DevTools）はポート 0 で待ち受け、
  割り当てられた番号を `server.address()`・`DevToolsActivePort` から読む（`tests/helpers/server.ts`）。
- 画面の待ちは `page.waitFor`（式）、`page.frames(n)`（n 回の描画）、`page.stableScreenshot()`（画面写しが止まる）、
  `page.lockPointerBy`（pointerlockchange / error）、`waitUntil` で行う。仕様が時間を決めている所（撃たない 2 秒など）は
  ページの時計（performance.now）で条件にする。
- ARC-18・ARC-22 は、テストのコードを行ごとに正規表現で調べるテスト（`tests/helpers/test-code.ts`）で確かめる。

## 却下した案

- ブラウザのテストを `*.browser.test.ts` に改名して分ける: 既存の `*.acceptance.test.ts` の名前の約束と並び、
  Chromium を使い始めたファイルの改名忘れで並列に流れる。import で決めれば忘れようがない。
- 全体を `fileParallelism: false` にする: ブラウザを使わない 50 ほどのファイルまで直列になり遅い。
- 作業ツリーごとにポートの範囲をずらす（環境変数）: 範囲の割り当てを人が管理することになり、空いている保証もない。
- Playwright Test に移す: 依存が増え、既存の DevTools の道具と受け入れテストを書き直すことになる。

## 影響

- spec/architecture.md（テストの実行、ARC-18〜ARC-22）
- vite.config.ts, package.json, CLAUDE.md, tests/helpers/browser.ts, tests/helpers/server.ts, tests/helpers/wait.ts,
  tests/helpers/test-code.ts, tests/architecture/test-code.test.ts, tests/acceptance/*（ブラウザを使うもの）
