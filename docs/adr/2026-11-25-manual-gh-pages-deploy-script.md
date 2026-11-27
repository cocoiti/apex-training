---
status: accepted
domain: architecture
summary: GitHub Pages へは自前のスクリプトで一時的な作業ツリーから gh-pages ブランチへ手動で push して公開する
related: [docs/spec/overview.md, scripts/deploy.mjs, package.json]
---
# GitHub Pages へは自前のスクリプトで gh-pages ブランチに手動で push して公開する

## 背景

GitHub Actions は費用のため 2026-11-25 から止めている。公開先の GitHub Pages（`/apex-training/`）には、
Actions を使わずにビルドの結果を載せる必要がある。手元の作業ツリーやブランチを壊さずに、誰が実行しても同じ結果にしたい。

## 決定

- `npm run deploy`（`scripts/deploy.mjs`）で、ビルドし、`gh-pages` ブランチのルートにビルドの結果と空の `.nojekyll` を置いて push する。
  Pages の設定は「Deploy from a branch」の `gh-pages` / `(root)` にする。
- 作業は `git worktree add --detach --no-checkout` の一時的な作業ツリーで行い、終わったら消す。
  ローカルに `gh-pages` ブランチは作らず、作ったコミットを `<remote>:refs/heads/gh-pages` へ直接 push する。
- ビルドは `npm run build -- --outDir <一時ディレクトリ> --emptyOutDir` で作業ツリーの外に出す。
  手元の作業ツリーの `dist/` は作らず、あっても上書きしない（無視されたファイルも作業ツリーの内容に含める）。
- ビルドは実行した作業ツリーで行うので、未コミットの変更（無視されたファイルを除く）があれば公開を断る。
  公開したものが、コミットメッセージに書く HEAD のコミットと必ず一致し、あとから同じものを作り直せるようにする。
- 毎回、作業ツリーを空にしてビルドの結果だけを置くので、前回の古いファイルは残らない。
  前回の公開のコミットを親にして早送りの push にし、`--force` は使わない（同時に公開されたら失敗して気づける）。
- ビルドの結果が前回と同じなら push しない。ビルドか push が失敗したら 0 以外で終わる。
- テストで差し替えられるよう、remote とビルドのコマンドは環境変数（`DEPLOY_REMOTE`、`DEPLOY_BUILD_COMMAND`）で変えられる。
  差し替えたビルドのコマンドには出力先を環境変数 `DEPLOY_OUT_DIR` で渡す。

## 却下した案

- npm の `gh-pages` パッケージ: 依存が増え、キャッシュの clone の振る舞いを自分で確かめにくい。やることは git の数手で済む。
- main の `docs/` にビルドの結果をコミットする: ソースの履歴にビルドの結果が混ざり、配信先の `/apex-training/` とのずれも生む。
- 手元の `dist/` にビルドしてそれを使う: `dist/` は無視されていても、作業ツリーの中身を作ったり上書きしたりする（OVR-7 に反する）。
- 今の作業ツリーで `git checkout gh-pages` して作る: 未コミットの変更や今のブランチを巻き込む（OVR-7 に反する）。
- 毎回 orphan のコミットを force push する: 公開の履歴が消え、同時の公開を上書きしても気づけない。
- 未コミットの変更があってもコミットメッセージに `-dirty` を付けて公開する: どのコミットとも一致しないものが公開され、作り直せない。
- HEAD をきれいな一時的な作業ツリーに取り出してビルドする: 依存のインストールがそのたびに要り、遅い。断るほうが単純で足りる。
- 別のホスティング（Cloudflare Pages など）: 外部のアカウントと設定が増える。Pages で足りる。

## 影響

- docs/spec/overview.md（公開、OVR-7、OVR-8、OVR-9）
- scripts/deploy.mjs, package.json（deploy）, tests/scripts/deploy.test.ts
