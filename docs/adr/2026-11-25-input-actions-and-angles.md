---
status: accepted
domain: input
summary: 入力は最初からアクションと角度（度）に揃える
related: [docs/spec/input.md, docs/spec/mouse.md, docs/spec/pad.md, src/input/]
---
# 入力は最初からアクションと角度（度）に揃える

## 背景

マウス（移動量 = 角度）とパッド（傾き = 回転速度）は仕組みが違う。最初にマウスだけで作ると、パッドを足すときに
リコイル・採点・描画まで手を入れることになる。

## 決定

入力方式ごとの差は `src/input/` で吸収し、`look`・`fire`・`ads` などのアクションと、ステップごとの照準の角度の
変化（度）に揃える。リコイル・採点・描画は入力方式を意識しない。キー割り当ての変更もこの層で扱う。
パッドのカーブの式は 1 か所に分け、実機と見比べて調整しやすくする。

## 却下した案

- マウス専用で作り、あとから抽象化する: 手戻りが大きい。

## 影響

- docs/spec/input.md、docs/spec/mouse.md、docs/spec/pad.md
- src/input/
