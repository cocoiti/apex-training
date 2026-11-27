---
status: accepted
domain: screens
summary: 設定は区分ごとに 1 つのキーに JSON で保存し、読むときに項目ごとに範囲に収めるか既定値にする
related: [docs/spec/screens.md, docs/spec/input.md, docs/spec/mouse.md, src/ui/settings.ts, src/ui/settings-form.ts]
---
# 設定は区分ごとに 1 つのキーに JSON で保存し、読むときに項目ごとに範囲に収めるか既定値にする

## 背景

SPEC（docs/spec/screens.md「設定の保存と読み出し」、docs/spec/input.md「入力方式ごとの保存」）は、
設定を変えるとすぐに保存し、マウスとパッドの区分は入力方式ごとに別々に、共通の区分は 1 つを共有することを求める。
保存された値が壊れている・範囲の外・項目が欠けているときは、その項目だけを直し、ほかの項目は使い続ける（UI-15）。
localStorage のキーと値の形はあとから変えると、利用者の保存した設定が読めなくなる。

## 決定

- 区分ごとに 1 つのキーにし、値は区分の項目を持つ JSON のオブジェクトにする。
  - 共通: `apex-training:settings:common`（`inputMethod`, `fov`, `crosshairShape`, `crosshairColor`, `ghost`, `sound`）
  - マウス: `apex-training:settings:mouse`（`dpi`, `sensitivity`, `adsMultiplier`）
  - パッドの区分は、パッドの設定画面の Issue で `apex-training:settings:pad` に置く。
- 読むときは JSON として読めない・オブジェクトでなければ空のオブジェクトとし、項目ごとに型と範囲を確かめる。
  数は範囲に収め（整数の項目は四捨五入）、型の違う値や選べない値は既定値にする。版の番号は持たない。
- 保存するときは、今の区分を読み、変えた項目を重ね、範囲に収めてから区分ごと書き直す。
- 読み書きは `src/ui/settings.ts` に集め、localStorage は `appStorage`（ADR: safe-storage-wrapper）を通す。

## 却下した案

- すべての設定を 1 つのキーにまとめる: 1 か所が壊れると JSON 全体が読めず、共通の区分まで既定値に戻る。
  入力方式ごとの区分を分けて足す・消すのも書き直しが大きくなる。
- 項目ごとに 1 つのキーにする: キーが増え、区分（入力方式）ごとに分けることがキーの名前の約束だけになる。
- 版の番号を付けて移行の処理を持つ: 今は形が 1 つしかなく、項目ごとの既定値への置き換えで足りる。
  形を互換なく変えるときに、新しいキーか版の番号を足す。

## 影響

- docs/spec/screens.md（UI-2, UI-11〜UI-15）、docs/spec/input.md、docs/spec/mouse.md（MOU-12）
- src/ui/settings.ts、src/ui/settings-form.ts、src/main.ts
