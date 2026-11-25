# CLAUDE.md

Apex Legends のリコイル制御をブラウザで練習する非公式のファンツール。

## 開発の進め方

Issue 駆動。SPEC（`docs/spec/`）はプロダクト全体の仕様で、Issue は SPEC への変更・追加の依頼。
PR で SPEC と実装・テストを一緒に更新する。立ち上げ時点では SPEC が実装より先にあり、MVP の Issue は
「SPEC に合わせて実装する」ものになる。

- 決定の理由は ADR（`docs/adr/`）。目次の `docs/adr/README.md` だけを読み、関係するファイルを開く。
- MVP の外の予定と未決定の事項は `docs/roadmap.md`。元の企画書は `docs/proposal.md`（更新しない）。

## 技術スタック

Vite + TypeScript + Three.js、テストは Vitest。セットアップ・テスト・ビルドのコマンドは、プロジェクトを
作る Issue で決めてここに書く。

## 守ること

- EA / Respawn の画像・ロゴ・武器モデル・効果音を使わない。
- 補正値のエクスポートや外部デバイスとの連携など、チートに転用できる出力を作らない。
- `src/sim/` から Three.js と DOM を参照しない。
- GitHub Actions は費用のため止めている（2026-11-25）。ワークフローを足しても動かない。
