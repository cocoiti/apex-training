---
status: accepted
domain: architecture
summary: CI は検査・Vitest の --shard で分けた 4 組のブラウザのテスト・always() で走るまとめのジョブに分け、流れたブラウザのテストが 0 件の組は browser の組の Vitest のプラグインで失敗にする
related: [docs/spec/architecture.md, .github/workflows/ci.yml, vite.config.ts, scripts/ci-summary.mjs, tests/architecture/ci.test.ts, CLAUDE.md]
---
# CI は検査・4 組のブラウザのテスト・まとめのジョブに分け、組は Vitest の --shard で決め、流れたテストが 0 件の組は Vitest のプラグインで失敗にする

## 置き換え

[2026-11-26-ci-github-actions-ubuntu](2026-11-26-ci-github-actions-ubuntu.md) の「1 つのジョブで順に流す」を置き換える。Chromium の導入・キャッシュ・起動の決定は引き継ぐ。

## 背景

1 つのジョブで順に流す CI は、ブラウザを使うテスト（2 ファイルずつ）が時間の大半を占めていた（Issue #97）。
runner の CPU は 4 つで、1 つのジョブの中で同時に流す数は 2 より増やせない。ジョブを分けると、PR のチェックが 6 つになり、
組の分け方・0 件の組・取り消された組を見落とす道ができる。

## 決定

- ジョブは `check`（lint・単体・ビルド・検査）、`browser`（`strategy.matrix.shard: [1, 2, 3, 4]`、`fail-fast: false`）、
  `summary`（`needs: [check, browser]`、`if: always()`）の 3 つ。`browser` は `check` を待たない。PR のチェックは `summary` で見る。
- 組は `npm run test:browser -- --shard=<番号>/4` で Vitest に任せる。ファイル単位で分かれ、どのファイルもちょうど 1 つの組に入る。
  組の一覧をリポジトリに持たないので、ブラウザを使うテストのファイルを足しても CI を直さなくてよい。
- 流れたテストが 0 件の組は、`vite.config.ts` の `requireBrowserTestsRan` が失敗にする。browser の組にだけ入れた Vite のプラグインが
  `configureVitest` で報告の受け手を足し、実行の終わりに browser の組で通った・落ちたテストを数え、0 件なら終了コードを 1 にする。
  効くのは `APEX_REQUIRE_CHROMIUM=1` のとき（Chromium を必須にするときは、実際に流れることも必須にする）。
- `summary` の判定は `scripts/ci-summary.mjs` に `toJSON(needs)` を渡して行う。待ったジョブのどれかが success でなければ
  （failure・cancelled・skipped・結果がない）、そのジョブと結果を出して失敗する。`if: always()` なので、ほかのジョブが失敗・取り消しでも走る。
- 4 つの組はそれぞれ `npm ci` と Chromium の導入をする。Chromium のキャッシュは Playwright の版ごとの同じキーで共有する。

## 却下した案

- 組をファイルの一覧で手で決める（matrix に include で書く）: ファイルを足すたびに直す必要があり、入れ忘れたファイルが流れない。
- `summary` を置かず、6 つのジョブをそれぞれ必須のチェックにする: 組の数を変えるたびにブランチの保護の設定も変える必要がある。
  matrix のジョブが取り消されたときに必須のチェックが「待ち」のまま残る。
- `summary` の判定を run の中の `test ... && test ...` で書く: 段は 1 つのコマンドだけを流す決まり（ARC-58 のテスト）と合わず、
  結果がない・skipped のときの扱いを手元で試せない。
- 0 件の組を、Vitest の JSON の報告を別のスクリプトで読んで確かめる: CI の段が 2 つのコマンドになり、`--reporter` を変えると外れる。
  設定の `reporters` に足す案も、コマンドの `--reporter` で置き換えると外れる。
- 組を 3 つにする: 4 つより 1 組が長く、15 分（ARC-97-6）に余裕がない。5 つ以上は組ごとの npm ci と Chromium の導入が重なって縮みが小さい。

## 影響

- spec/architecture.md（継続的インテグレーション（CI）、ARC-57・ARC-58・ARC-60・ARC-97-1〜ARC-97-6）
- .github/workflows/ci.yml, vite.config.ts, scripts/ci-summary.mjs, tests/architecture/ci.test.ts, tests/acceptance/ci-qa.acceptance.test.ts, CLAUDE.md
