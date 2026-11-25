# 武器の JSON に必須の `measured` を持たせ、`false` の仮データの武器は残したまま武器の一覧から外す

## 状態

承認

## 背景

- 武器データのうち計測した値は L-STAR と C.A.R. SMG だけで、R-301・R-99・フラットライン・ボルト・スピットファイアは形だけそれらしい仮の数値。
- 仮データで練習すると実際のゲームと違うリコイルを覚えてしまうため、利用者に見せない。
- 武器は JSON のデータとして外に出す決定（2026-11-25-weapon-data-as-json.md）と、JSON を足すだけで選択肢に出る WPN-1 は変えない。

## 決定

- 武器の JSON に必須の真偽値 `measured` を足す。`true` が計測した値、`false` が仮データ。欠けた・真偽値でない JSON は他の項目の誤りと同じく一覧から外して出力する。
- 武器の一覧（トップ画面・履歴の画面の選択肢の元）は、項目の確認を通った武器データのうち `measured` が `true` のものだけにする。
  `false` は誤りではないので、開発者向けの出力はしない。
- 仮データの 5 武器の JSON は `src/data/weapons/` に `measured: false` のまま残す。計測したら同じファイルの数値・`source`・`version` を差し替えて
  `measured` を `true` にし、`docs/measurements/<id>.json` を足せば、コードを変えずに選択肢に出る。
- `measured: true` の JSON に同じ `id` の計測の記録があること、`false` の JSON の `source` に仮データと書かれていることはテストで確かめる（WPN-23）。
- テストが仮データの武器に頼る所は、テストの中だけで使う武器データか、計測した武器（L-STAR・C.A.R. SMG）に置き換える。

## 却下した案

- 計測の記録（`docs/measurements/`）があるかで判断する: 記録は配布物に入れないため、ブラウザでは判断できない。ビルド時に調べると JSON だけを見ても分からない。
- `source` の文言（「仮データ」）で判断する: 文の書き方で振る舞いが変わり、書き間違いに気づけない。
- 仮データの JSON を消す: 計測したときに項目と形を一から作り直すことになる。git の履歴には残るが、どの武器が未計測かが見えにくい。
- `measured` を省略可能（省略時は `false`）にする: 計測した武器で書き忘れると黙って選択肢から消える。必須にして誤りとして出す。

## 影響

- spec/weapons.md（用語、武器データ、MVP の武器、WPN-1、WPN-3、WPN-21〜WPN-23）、spec/modes.md（MODE-1、MODE-23）、spec/screens.md（トップ画面、履歴の画面、UI-24）、spec/scoring.md（保存の形の例、SCO-18・SCO-20・SCO-23・SCO-26）
- src/data/weapons/*.json、src/sim/weapon.ts、src/data/weapons/index.ts、仮データの武器を使っていたテスト
