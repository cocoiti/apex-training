# CLAUDE.md

Apex Legends のリコイル制御をブラウザで練習する非公式のファンツール。

## 開発の進め方

Issue 駆動。SPEC（`docs/spec/`）はプロダクト全体の仕様で、Issue は SPEC への変更・追加の依頼。
PR で SPEC と実装・テストを一緒に更新する。立ち上げ時点では SPEC が実装より先にあり、MVP の Issue は
「SPEC に合わせて実装する」ものになる。

- 決定の理由は ADR（`docs/adr/`）。目次の `docs/adr/README.md` だけを読み、関係するファイルを開く。
- MVP の外の予定と未決定の事項は `docs/roadmap.md`。元の企画書は `docs/proposal.md`（更新しない）。

## 技術スタック

Vite + TypeScript + Three.js、テストは Vitest、lint は ESLint（typescript-eslint）と `tsc --noEmit`。Node.js 22.12 以上。

| 目的 | コマンド |
|------|---------|
| セットアップ | `npm ci` |
| 開発サーバー | `npm run dev`（http://localhost:3100/apex-training/） |
| 単体テスト | `npm test` |
| ブラウザ（Chromium）を使うテストだけ | `npm run test:browser`（既定で 3 ファイルずつ並行に流す。`APEX_BROWSER_WORKERS=1 npm run test:browser` で 1 ファイルずつ） |
| ブラウザを使わないテストだけ | `npm run test:unit`（並列に流す） |
| ブラウザを使うテストを Docker のコンテナの中で | `npm run test:remote`（下の「Docker でのブラウザのテスト」） |
| lint・型の確認 | `npm run lint` |
| ビルド | `npm run build`（`dist/` に出る。配信先は `/apex-training/`） |
| サブパスでの配信の確認 | `npm run build && npm run check:subpath`（ポート 3102） |
| 配布物の画像・音声・3D モデルが素材の一覧（`src/assets/assets.json`）に載っていることの確認 | `npm run build && npm run check:assets` |
| GitHub Pages への公開（手動） | `npm run deploy`（ビルドして `gh-pages` ブランチに push する） |

- テストは `tests/` に `src/` と同じ構成で置く（`src/sim/` の依存の確認がテストのファイルを拾わないように）。
- ブラウザを使うテストのファイルは、`npm test` でも `npm run test:browser` でも既定で 3 つを同時に流す。同時に流す数は環境変数
  `APEX_BROWSER_WORKERS` に 1 以上の整数を渡して変える（`APEX_BROWSER_WORKERS=1` で 1 ファイルずつ。1 以上の整数でない値はテストを流す前に失敗する）。
- `tests/helpers/browser.ts` を import するテストのファイルが、ブラウザを使うテストの組になる。テストが立てるサーバーはポート 0 で待ち受け（`tests/helpers/server.ts`）、
  画面の状態は sleep ではなく条件で待つ（`page.waitFor`・`page.frames`・`waitUntil`）。
- ブラウザを使うテストで、スティックを倒している長さやボタンを押している長さは実時間や描画の回数で決めず、`clock=manual` で開いて
  倒す・押す → `page.advanceClock`・`page.advanceClockUntil` で時計を進める → 戻す・離す、の形で与える（`tests/architecture/test-code.test.ts` が調べる）。
- ブラウザを使うテストはページを固定の種で開く（`appUrl` の `seed` にファイルに書いた数を渡す。URL の `seed=<数>`）。失敗したときは使った種がメッセージに出る。
- マップなどのデータの JSON は `src/data/` に置き、`?url` の資産として fetch する（ADR: data-json-as-fetched-assets）。

## Docker でのブラウザのテスト

`npm run test:remote` は、`Dockerfile.test`（Playwright の公式イメージ）でイメージを作り、コンテナの中で `npm run test:browser` を流す。

- 前提として Docker が要る（`docker` のコマンドと、つながる Docker）。
- 環境変数 `TEST_DOCKER_CONTEXT` に docker context の名前を渡す。既定は `macmini`（Mac mini の Docker）。
  その context がないとき、またはその context の Docker につながらないときは、手元の Docker（今の docker context）で流す。どちらで流すかはテストの前に出力に出る。
- 終了コードはコンテナの中の `npm run test:browser` の終了コード（1 件でも失敗すれば 0 以外）。イメージを作れなかったときも 0 以外。
- コンテナの中ではブラウザを使うテストのファイルを既定で 2 つずつ流す（Mac mini で 3 つずつだと実時間で動くテストが待ちの上限に当たる）。
  `APEX_BROWSER_WORKERS` を渡すと、その値がコンテナの中に渡る。
- `Dockerfile.test` の Playwright の版は、CI のワークフローの `PLAYWRIGHT_VERSION` と揃える。依存は `package.json` と lockfile から先に入れるので、
  ソースだけを変えたときは `npm ci` の層がキャッシュから使われる。CI ではこのコマンドを使わない。

## CI

GitHub Actions は有効で、GitHub がホストする標準の Linux の runner だけを使う。CI のワークフローは `.github/workflows/ci.yml` の 1 つ。

- PR を作ったとき・PR のブランチに push したときと、`main` に push したときに、`ubuntu-latest` の 1 つのジョブで走る。
- `npm ci` → `npm run lint` → `npm run test:unit` → Chromium の導入（Playwright のキャッシュの場所）→ `npm run test:browser` → `npm run build` →
  `npm run check:subpath` → `npm run check:assets` の順に流し、どれかが失敗したらそこで止まってチェックが失敗になる。
- CI では `APEX_REQUIRE_CHROMIUM=1` にして、Chromium が見つからなければブラウザを使うテストを飛ばさずに失敗にする。
- CI では `APEX_BROWSER_WORKERS=2` にして、ブラウザを使うテストのファイルを 2 つずつ流す（runner の CPU が 4 つで、3 つでは実時間で動くテストが待ちの上限に当たる）。
- 同じブランチ（同じ PR）に新しい push があると、走っている古い実行は取り消される。

## 守ること

- EA / Respawn の画像・ロゴ・武器モデル・効果音を使わない。自作などの画像・音声・3D モデルを足すときは `src/assets/assets.json` に出どころを書く。
- 補正値のエクスポートや外部デバイスとの連携など、チートに転用できる出力を作らない。
- `src/sim/` から Three.js と DOM を参照しない。
- CI は GitHub がホストする標準の Linux の runner（`ubuntu-latest`）だけで動かす。macOS・Windows の runner を使わず、`gh-pages` への公開を CI でしない。
