# CLAUDE.md

Apex Legends のリコイル制御をブラウザで練習する非公式のファンツール。

## 開発の進め方

Issue 駆動。SPEC（`docs/spec/`）はプロダクト全体の仕様で、Issue は SPEC への変更・追加の依頼。
PR で SPEC と実装・テストを一緒に更新する。立ち上げ時点では SPEC が実装より先にあり、MVP の Issue は
「SPEC に合わせて実装する」ものになる。

- 新しく足す受け入れ条件の ID は `<接頭辞>-<Issue 番号>-<その Issue の中の番号>`（例: Issue #81 なら `UI-81-1`）。
  前からある `UI-43` などの ID は付け替えず、消した ID は欠番にして再利用しない（`docs/spec/README.md`「受け入れ条件の ID」）。
- 決定の理由は ADR（`docs/adr/`）。`docs/adr/README.md` のドメインの一覧から、対象の SPEC の領域と `cross` の目次
  （`docs/adr/index/<ドメイン>.md`）だけを読み、関連（SPEC・パス）が合う行の ADR を開く。`index/inactive.md`（置き換え済み・取り下げ）は普段は読まない。
- ADR は先頭に frontmatter（`status`・`domain`・`summary`・`related`、置き換え済みなら `superseded_by`）を持つ（書き方は `docs/adr/README.md`）。
  目次は手で書かず、ADR を足したり状態を変えたりしたら `python3 ~/dotfiles/scripts/adr-index.py` で作り直して一緒にコミットする
  （`--check` で目次が最新かを確かめる）。
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

- テストは `tests/` に `src/` と同じ構成で置く（`src/sim/` の依存の確認がテストのファイルを拾わないように）。
- ブラウザを使うテストのファイルは、`npm test` でも `npm run test:browser` でも既定で 3 つを同時に流す。同時に流す数は環境変数
  `APEX_BROWSER_WORKERS` に 1 以上の整数を渡して変える（`APEX_BROWSER_WORKERS=1` で 1 ファイルずつ。1 以上の整数でない値はテストを流す前に失敗する）。
- `tests/helpers/browser.ts` を import するテストのファイルが、ブラウザを使うテストの組になる。テストが立てるサーバーはポート 0 で待ち受け（`tests/helpers/server.ts`）、
  画面の状態は sleep ではなく条件で待つ（`page.waitFor`・`page.frames`・`waitUntil`）。
- マップと武器の JSON の読み込みが終わったことは、`<html>` の `data-app-state`（`loading` → `ready` か `error`）で読む。ページを開く・読み込み直すときは
  道具の `page.goto`・`page.reload` を使い（既定で `data-app-state` が `ready` か `error` になるまで待つ）、`Page.navigate`・`Page.reload`・`location.reload()` を
  直に使わない（`tests/architecture/test-code.test.ts` が調べる）。読み込み前の振る舞いを確かめるテストだけが `{ waitForApp: false }` を渡す。
  トップ画面が見えたことや select に選択肢があることで、読み込みの終わりを推し量らない（ADR: app-state-attribute-for-tests）。
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

- PR を作ったとき・PR のブランチに push したときと、`main` に push したときに、`ubuntu-latest` の runner で走る。ジョブは次の 3 種類。
  - 検査（1 つ）: `npm ci` → `npm run lint` → `npm run test:unit` → `npm run build` → `npm run check:subpath` → `npm run check:assets` の順に流し、
    どれかが失敗したらそこで止まる。
  - ブラウザのテスト（4 つ）: ブラウザを使うテストのファイルを Vitest の `--shard=<組の番号>/4` で 4 つの組に分け、組ごとに
    `npm ci` → Chromium の導入（Playwright のキャッシュの場所）→ `npm run test:browser -- --shard=<組の番号>/4` を流す。
    検査を待たずに同時に始まり、1 つの組が失敗してもほかの組は最後まで流す。
  - まとめ（1 つ）: ほかのジョブがすべて終わってから（失敗・取り消しでも）走り、すべて成功したときだけ成功する（`scripts/ci-summary.mjs`）。
    PR のチェックの結果はこのジョブで見る。
- CI のブラウザのテストでは `APEX_REQUIRE_CHROMIUM=1` にして、Chromium が見つからなければブラウザを使うテストを飛ばさずに失敗にする。
  流れたブラウザを使うテストが 1 件もない組（ファイルがない・全部飛ばされた）も失敗にする（`vite.config.ts` の `requireBrowserTestsRan`）。
- CI では `APEX_BROWSER_WORKERS=2` にして、組のジョブの中でブラウザを使うテストのファイルを 2 つずつ流す（runner の CPU が 4 つで、3 つでは実時間で動くテストが待ちの上限に当たる）。
- 同じブランチ（同じ PR）に新しい push があると、走っている古い実行は取り消される。

### 公開のワークフロー

GitHub Pages（https://cocoiti.github.io/apex-training/ ）への公開は、CI とは別のワークフロー `.github/workflows/deploy.yml` が行う。

- `main` に push したコミットで CI が成功したときに走り（`workflow_run`）、その CI が流れたコミットを `npm ci` → `npm run build` でビルドして、
  `dist/` を Pages に公開する（`actions/upload-pages-artifact` → `actions/deploy-pages`）。CI が失敗・取り消しのときは公開しない。
- 手で走らせるときは `gh workflow run deploy.yml`（`main` の今のコミットを公開する）。
- PR を作ったとき・PR のブランチに push したときは走らない。手元から公開するコマンドはない。
- リポジトリの Pages の公開元は「GitHub Actions」にする。

## 守ること

- EA / Respawn の画像・ロゴ・武器モデル・効果音を使わない。自作などの画像・音声・3D モデルを足すときは `src/assets/assets.json` に出どころを書く。
- 補正値のエクスポートや外部デバイスとの連携など、チートに転用できる出力を作らない。
- `src/sim/` から Three.js と DOM を参照しない。
- CI と公開のワークフローは GitHub がホストする標準の Linux の runner（`ubuntu-latest`）だけで動かす。macOS・Windows の runner を使わない。
- GitHub Pages への公開は `deploy.yml` だけが行い、CI が成功した `main` のコミットだけを公開する（手で走らせたときは `main`）。CI のワークフロー（`ci.yml`）では公開しない。
