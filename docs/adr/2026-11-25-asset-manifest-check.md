# 配布物の素材は src/assets/assets.json の一覧と名前で照らし、資産は大きさによらず data: URL に埋め込まない

状態: 承認

## 背景

画像・音声・3D モデルを一切含めない検査から、出どころを記録した素材だけを含めてよい検査に変える（Issue #29、overview.md「素材の一覧」）。
ビルド結果のファイルと一覧の項目をどう対応させるか、一覧の path をどこから解決するか、data: URL への埋め込みをどう止めるかを決める必要がある。

## 決定

- 素材の一覧は `src/assets/assets.json`（`path`・`author`・`license`・`source` を持つ項目の配列）に置き、素材がない今は空の配列にする。
- `scripts/check-assets.mjs` は、一覧と `path` をスクリプトの 1 つ上（リポジトリのルート）から解決する。作業ディレクトリには依存しない。
- ビルド結果のファイルは、`public/` の項目ならルートからのパス、それ以外ならファイル名から `-<8 文字のハッシュ>` を除いた名前で照らす
  （Vite のハッシュは `[A-Za-z0-9_-]{8}`）。ハッシュのない名前がそのまま一致しても載っているとみなす。
- 問題は種類ごとに止めずにすべて集め、最後にまとめて示して 1 で終わる。一覧が読めないときも、ビルド結果の素材は「載っていない」として示す。
- `vite.config.ts` の `build.assetsInlineLimit` を `0` にし、JSON・画像・音声・3D モデルを含むすべての資産をファイルとして出す。

## 却下した案

- Vite の `build.manifest`（出力とソースの対応表）で照らす: `public/` の素材が載らず、検査がビルドの設定に依存し、
  引数で渡した任意のフォルダを調べられなくなる。名前で照らせば SPEC の規則どおりで、別の名前のファイルの混入は防げる。
- `assetsInlineLimit` を拡張子で判定する関数にして、対象の拡張子と `.json` だけ埋め込まない: 拡張子の一覧を
  vite.config.ts と検査のスクリプトの 2 か所で揃える必要があり、埋め込みたい資産（フォントなど）も今はない。
- 一覧を JSON でなく Markdown の表にする: 機械で読みにくく、空の項目や欠けた列の判定があいまいになる。

## 影響

- docs/spec/overview.md（素材の一覧、OVR-2、OVR-10〜OVR-14）
- scripts/check-assets.mjs、src/assets/assets.json、vite.config.ts、tests/scripts/check-assets.test.ts
