# 素材の検査は作者・出どころの名前を見ず、license を許可リストとの完全一致で判定する

状態: 承認

## 背景

素材の検査は `author`・`source` に公式の名前（EA・Respawn など）があると失敗させていた（旧 OVR-11）。
名前は書き方しだいで避けられ、逆に「Apex Legends の画面を参考に描いた」のような正当な記載や「EA」を含む作者名で誤って失敗する。
Issue #32 で、自作と許可した OSS 系のライセンスの素材だけを通す検査に変える（overview.md「許可するライセンス」）。

## 決定

- `scripts/check-assets.mjs` から公式の名前の判定を外し、`license` を許可リスト
  （`self-made` と SPDX 識別子 8 つ）と、前後の空白を除いた文字列の完全一致（大文字・小文字も区別）で照らす。
- 許可リストはスクリプトの定数に置き、SPEC の表と揃える。`self-made` 以外（OSS 系）は `source` に
  `/https?:\/\/\S/` に当たる配布元の URL を求める。
- `license` か `source` が欠けているときは「必須の項目」の問題だけを示し、ライセンスと URL の問題は重ねて示さない。

## 却下した案

- 名前の判定を残し、許可リストと併用する: 誤検知と回避の容易さは変わらず、正当な記載のために一覧の文言を言い換えさせることになる。
  公式の素材を使わないことは「権利と表記」の決まりとして守る。
- SPDX の式（`MIT OR Apache-2.0` など）を解釈する（`spdx-expression-parse` などへの依存）: 依存が増え、
  どのライセンスに従うかがあいまいになる。1 つ選んで書かせるほうが記録として明確。
- 大文字・小文字を区別せずに照らす: SPDX の識別子の表記揺れを一覧に残すことになり、`self-made` と「自作」のような別表記も
  受けるかの線引きが要る。完全一致なら一覧の値がそのまま SPEC の表の値になる。
- 許可リストを別の JSON に置く: 値を足すのは SPEC の変更を伴う決定で、スクリプトと SPEC の 2 か所を揃えるのは今と変わらない。

## 影響

- docs/spec/overview.md（許可するライセンス、OVR-2、OVR-11 の削除、OVR-15〜OVR-19）
- scripts/check-assets.mjs、tests/scripts/check-assets.test.ts、tests/acceptance/asset-manifest-qa.acceptance.test.ts
