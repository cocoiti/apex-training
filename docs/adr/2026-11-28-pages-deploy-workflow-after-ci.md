---
status: accepted
domain: architecture
summary: GitHub Pages へは CI とは別の deploy.yml が、main の push で CI が成功したときに workflow_run でそのコミットをビルドし、upload-pages-artifact と deploy-pages で公開する（手元から gh-pages ブランチへ push する公開はやめる）
related: [docs/spec/architecture.md, docs/spec/overview.md, .github/workflows/deploy.yml, .github/workflows/ci.yml, package.json, CLAUDE.md, README.md]
---
# GitHub Pages へは、main の CI が成功したあとに別のワークフローが Pages の成果物として公開する

## 背景

GitHub Actions を有効にし（2026-11-26）、PR と `main` で CI が走るようになった。公開は手元のスクリプトが
`gh-pages` ブランチへ push する形のままで、CI が通っていないコミットや手元の状態を公開できてしまい、公開を忘れることもある（Issue #104）。
CI（ci.yml）は公開の手順を持たないと決めている（ARC-61）。runner は費用のため `ubuntu-latest` だけを使う。

## 決定

- 公開は `.github/workflows/deploy.yml` だけが行う。きっかけは CI の `workflow_run`（`completed`、`branches: [main]`）と `workflow_dispatch` だけ。
  公開のジョブは `workflow_dispatch` のとき、または `workflow_run.event == 'push'` かつ `conclusion == 'success'` のときだけ走る。
- 取り出すのは `workflow_run.head_sha`（CI が流れたコミット。後から `main` が進んでも、通ったものを公開する）。手で走らせたときは `main`。
- `npm ci` → `npm run build` で作った `dist` を `actions/upload-pages-artifact` で成果物にし、`actions/deploy-pages` で公開する。
  Pages の公開元は「GitHub Actions」にする。`gh-pages` ブランチは使わず、git push しない。
- `permissions` は `contents: read`・`pages: write`・`id-token: write` だけ。secret は使わない（GTM の ID はビルドの設定にある）。
- `concurrency` は `pages` の 1 組で `cancel-in-progress: false`（公開の途中で取り消して Pages を半端にしない）。
- 手元の公開のスクリプトと `package.json` の `deploy` は消し、手元から公開する手段を残さない。

## 却下した案

- ci.yml に公開のジョブを足す（`needs: summary`、`if: main への push`）: PR の実行にも公開の権限（`pages: write`・`id-token: write`）が付き、
  CI に公開の手順を持たないと決めた ARC-61 とも合わない。
- deploy.yml を `push: main` で走らせて自分でもう一度テストする: CI と同じ検査を二重に流し、CI の結果と公開が食い違いうる。
- Actions から `gh-pages` ブランチへ push する（peaceiris/actions-gh-pages など）: `contents: write` が要り、外部の Action に依存する。
  公式の Pages の成果物の方式で足りる。
- 手元の公開のスクリプトを残して両方で公開できるようにする: CI を通っていないものを公開でき、公開されたものの出どころが 2 つになる。
- `workflow_run` で `main` の最新を取り出す: CI の後に別の push があると、CI を通っていないコミットを公開してしまう。

## 影響

- docs/spec/architecture.md（公開のワークフロー、ARC-61、ARC-104-1〜ARC-104-6）, docs/spec/overview.md（公開、OVR-8、OVR-104-1、OVR-104-2）
- .github/workflows/deploy.yml, .github/workflows/ci.yml, package.json, CLAUDE.md, README.md
- tests/architecture/deploy-workflow.test.ts, tests/acceptance/deploy.acceptance.test.ts, tests/acceptance/ci-qa.acceptance.test.ts
- 置き換え: 2026-11-25-manual-gh-pages-deploy-script
