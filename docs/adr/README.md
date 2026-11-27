# ADR（設計の決定記録）

SPEC（`docs/spec/`）はプロダクトが今どう振る舞うかを書く。ADR は「なぜそうしたか」を書く。

## 読み方

下の「目次」のドメインの一覧から、今の作業の SPEC の領域（`docs/spec/<領域>.md`）に当たるドメインと `cross` の目次
（`index/<ドメイン>.md`）だけを読む。目次で関連（SPEC・パス）が今の作業に合う行の ADR だけを開き、開いた ADR も先頭の frontmatter と
「決定」の節を先に読む。置き換え済み・取り下げの ADR（`index/inactive.md`）は、決定の経緯を追うときだけ読む。全部のファイルは読まない。

## 書き方

- 書くのは、決定が済んでいて、後からその決定を変える人が当時の制約と却下した案を知る必要があるもの（別の案を比べて却下した、
  データの形式・外部との境界・依存の追加など後から戻しにくい）だけ。実装の細かいこと、好み、SPEC に書いた振る舞いの言い換えは書かない。
- 1 つの決定を 1 ファイルにし、`docs/adr/<YYYY-MM-DD>-<短い英語の名前>.md` に書く（並行する PR でぶつからないよう連番にしない。フォルダは分けない）。
- 先頭に frontmatter（`---` で囲んだ部分）を書く。
  - `status`: `accepted`（承認）・`superseded`（置き換え済み）・`withdrawn`（取り下げ）のどれか。
  - `domain`: 主に決めた振る舞いの SPEC の領域（`docs/spec/` の領域のファイル名から `.md` を除いたもの）。テスト・CI・ビルド・配信・素材の扱いなど
    開発の仕組みの決定は `architecture`。2 つ以上の領域にまたがり 1 つに決められないものだけ `cross`。
  - `summary`: 決定の要点の 1 文。一部が別の ADR で置き換わったものは `accepted` のままにし、末尾に「（一部は <置き換えた ADR の名前> で置き換え）」と書く。
  - `related`: 関係する SPEC・ソース・テストのパスの一覧（`[docs/spec/weapons.md, src/sim/gun.ts]` の形）。
  - `superseded_by`: `status` が `superseded` のときだけ、置き換えた ADR のファイル名から `.md` を除いたもの。
- 本文の節は「# <決定の要点>」「背景」「決定」「却下した案」「影響（関係する SPEC の ID・パス）」。40 行程度に収める。
  状態は frontmatter だけに書き、本文に「状態:」の行を持たない。一部が置き換わった説明は「置き換え」の節に書く。
- 決定を変えるときは既存の ADR の本文を書き換えず、新しい ADR を書き、古い ADR の frontmatter の `status` と `superseded_by`
  （一部だけなら `summary` の末尾と「置き換え」の節）を変える。
- 目次は手で書かない。ADR を足したり状態を変えたりしたら、リポジトリのルートで `python3 ~/dotfiles/scripts/adr-index.py` を実行して
  この README のドメインの一覧と `index/` を作り直し、一緒にコミットする（`--check` で目次が最新かを確かめられる）。

## 目次

<!-- adr-index:start -->
| ドメイン | 有効な ADR | 目次 |
|---------|-----------|------|
| architecture | 23 | [index/architecture.md](index/architecture.md) |
| cross | 1 | [index/cross.md](index/cross.md) |
| input | 3 | [index/input.md](index/input.md) |
| modes | 11 | [index/modes.md](index/modes.md) |
| mouse | 1 | [index/mouse.md](index/mouse.md) |
| overview | 4 | [index/overview.md](index/overview.md) |
| pad | 4 | [index/pad.md](index/pad.md) |
| scoring | 4 | [index/scoring.md](index/scoring.md) |
| screens | 11 | [index/screens.md](index/screens.md) |
| weapons | 7 | [index/weapons.md](index/weapons.md) |
| （置き換え済み・廃止・取り下げ） | 1 | [index/inactive.md](index/inactive.md) |
<!-- adr-index:end -->
