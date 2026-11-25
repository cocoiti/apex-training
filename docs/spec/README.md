# SPEC

このディレクトリはプロダクト全体の今の仕様を、領域ごとのファイルで持つ。

## 運用ルール

- SPEC は「今のプロダクトがどう振る舞うか」を書く。今後の計画や TODO は書かない。
- Issue は SPEC への変更・追加の依頼。PR で SPEC と実装・テストを一緒に更新する。
- 「なぜそうしたか」は SPEC ではなく ADR（`docs/adr/`）に書く。

## 書式（全領域で共通）

```
# <領域名>
## 概要
## 用語（必要なら）
## 振る舞い（機能ごとの小見出し）
## 受け入れ条件
```

受け入れ条件は「- **<接頭辞>-<番号>**: <条件> のとき <期待結果>」の形で、外から観測できる入力と期待結果だけを書く。
実装の内部（クラス名など）は書かない。番号は欠番にして再利用しない。

## 領域の目次

| ファイル | 領域 | 受け入れ条件の接頭辞 |
|---------|------|-------------------|
| [overview.md](overview.md) | 全体と制約（権利、練習の範囲、公開） | OVR |
| [input.md](input.md) | 入力の共通（入力方式の切替、アクション、記録と再生） | INP |
| [mouse.md](mouse.md) | マウス入力と感度 | MOU |
| [pad.md](pad.md) | パッド入力 | PAD |
| [weapons.md](weapons.md) | 武器とリコイル | WPN |
| [modes.md](modes.md) | 練習モード | MODE |
| [scoring.md](scoring.md) | 採点とリザルト、練習の履歴 | SCO |
| [screens.md](screens.md) | 画面と設定 | UI |
| [architecture.md](architecture.md) | 構成と拡張性 | ARC |

MVP の外の予定と未決定の事項は [docs/roadmap.md](../roadmap.md) に置く。
