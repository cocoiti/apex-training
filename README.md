# apex-training

仕様は [docs/spec/](docs/spec/README.md)、設計の決定は [docs/adr/](docs/adr/README.md) を参照。

## 公開

公開先は https://cocoiti.github.io/apex-training/ 。`main` に push したコミットで CI（`.github/workflows/ci.yml`）が成功したあとに、
公開のワークフロー（`.github/workflows/deploy.yml`）がそのコミットをビルドして GitHub Pages に公開する。CI が失敗したとき・PR では公開しない。
手で公開し直すときは `gh workflow run deploy.yml`（`main` の今のコミットを公開する）。リポジトリの Pages の公開元は「GitHub Actions」にする。
