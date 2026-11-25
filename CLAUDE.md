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
| lint・型の確認 | `npm run lint` |
| ビルド | `npm run build`（`dist/` に出る。配信先は `/apex-training/`） |
| サブパスでの配信の確認 | `npm run build && npm run check:subpath`（ポート 3102） |
| 配布物の画像・音声・3D モデルが素材の一覧（`src/assets/assets.json`）に載っていることの確認 | `npm run build && npm run check:assets` |
| GitHub Pages への公開（手動） | `npm run deploy`（ビルドして `gh-pages` ブランチに push する） |

- テストは `tests/` に `src/` と同じ構成で置く（`src/sim/` の依存の確認がテストのファイルを拾わないように）。
- マップなどのデータの JSON は `src/data/` に置き、`?url` の資産として fetch する（ADR: data-json-as-fetched-assets）。

## 守ること

- EA / Respawn の画像・ロゴ・武器モデル・効果音を使わない。自作などの画像・音声・3D モデルを足すときは `src/assets/assets.json` に出どころを書く。
- 補正値のエクスポートや外部デバイスとの連携など、チートに転用できる出力を作らない。
- `src/sim/` から Three.js と DOM を参照しない。
- GitHub Actions は費用のため止めている（2026-11-25）。ワークフローを足しても動かない。
