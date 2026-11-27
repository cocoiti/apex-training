---
status: accepted
domain: pad
summary: パッドは描画ごとに使えるパッドと配置（PadLayout）を選び直し、割り当ては名前ごとの PadLayout の JSON で apex-training:pad-mapping に、パッドの区分は簡易・詳細の値を別々に apex-training:settings:pad に保存する
related: [docs/spec/pad.md, docs/spec/screens.md, src/input/pad-layout.ts, src/input/pad.ts, src/ui/settings.ts, src/ui/pad-mappings.ts, src/ui/pad-settings-form.ts, src/ui/pad-calibration.ts, src/main.ts]
---
# パッドは描画ごとに「使えるパッド」と配置（PadLayout）を選び直し、割り当ては名前ごとの PadLayout の JSON で保存する

## 背景

Issue #14 で、標準配置でないパッド（`mapping` が空文字）にボタン割り当てを保存し、使えるパッドのうち番号が最も小さいものを
入力に使い、HUD・設定画面・キャリブレーション画面にその状態を出す（PAD-2, PAD-3, PAD-24〜PAD-27）。割り当ての保存の形は、
あとから変えると利用者の割り当てが読めなくなる。パッドの区分の設定は、簡易設定と詳細設定の値を別々に残す必要がある（PAD-29）。

## 決定

- 配置は `src/input/pad-layout.ts` の `PadLayout`（`fire`・`ads` のボタンの番号、`lookX`・`lookY` の `{ axis, invert }`）で表し、
  標準配置も同じ形の `STANDARD_PAD_LAYOUT` にする。`PadInput.poll(pad, layout)` はどちらも同じ規則（しきい値・式・ADS 中の速度）で読む。
- `choosePad()` が描画のたびに `navigator.getGamepads()` から「使用中 / 見つからない / 標準配置でない」の状態を求める。
  練習・HUD・設定画面・キャリブレーション画面はこの 1 つの結果を使い、使えるパッドがないときは `poll(null)` で入力をなくす。
- 割り当ては localStorage の `apex-training:pad-mapping` に `{ [Gamepad.id]: PadLayout }` の JSON で保存する。読むときは
  パッドごとに形を確かめ、合わないパッドの割り当てだけを捨てる。描画のたびに引くので `PadMappingStore` がメモリに持つ。
- 割り当ての操作（`MappingCapture`）は、「割り当てる」を押した時点でしきい値以上のボタン・軸を、一度しきい値の下に戻るまで数えない。
- パッドの区分は `apex-training:settings:pad` に平らな 1 つのオブジェクトで保存する（`mode`、詳細設定の 7 項目、
  `simpleLook`・`simpleAds`・`simpleCurve`、`vibration`）。換算に使う値は `effectivePadSettings()` の 1 か所で決める。

## 却下した案

- 割り当てを Gamepad API の番号（`index`）で引く: つなぎ直す順で番号が変わり、別のパッドに割り当てが当たる。
- 割り当てをボタン・軸の番号の配列（`[fire, ads, x, y]`）で保存する: 反転を足すと位置の約束が増え、項目を足すと読めなくなる。
- 割り当ての操作で、値がしきい値以上なら押した時点からすぐに割り当てる: 離していても −1 を報告するトリガーの軸や、
  「割り当てる」を押すときに握っていたボタンを取り違える。
- 簡易設定を選んだときに対応表の値で詳細設定の項目を書き換える: 詳細設定に戻したときに元の値に戻せない（PAD-29）。
- 練習中だけパッドを選ぶ: 設定画面とキャリブレーション画面で同じ状態を出せず、選び方が 2 か所になる。

## 影響

- docs/spec/pad.md（接続と配置、入力に使うパッド、パッドの一覧、ボタン割り当て、パッドの設定画面、PAD-2, PAD-3, PAD-24〜PAD-29）、
  docs/spec/screens.md（UI-40〜UI-42）、docs/spec/input.md（入力方式の切替）
- src/input/pad-layout.ts、src/input/pad.ts、src/ui/settings.ts、src/ui/pad-mappings.ts、src/ui/pad-settings-form.ts、
  src/ui/pad-calibration.ts、src/main.ts、index.html
