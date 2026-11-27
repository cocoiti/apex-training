---
status: accepted
domain: input
summary: 入力方式の切替はデバイスとキューの間の InputSwitch 1 か所で行い、操作は押し始め・デッドゾーンを出た瞬間で判定し、練習の入力方式は 1 発目のときの入力方式にする
related: [docs/spec/input.md, docs/spec/modes.md, docs/spec/scoring.md, src/input/input-switch.ts, src/input/pad.ts, src/input/mouse.ts, src/modes/session.ts, src/main.ts]
---
# 入力方式の切替はデバイスとキューの間の InputSwitch 1 か所で行い、操作は押し始め・デッドゾーンを出た瞬間で判定する

## 背景

Issue #13 で、入力方式（マウス / パッド / 自動）を切り替え、HUD に今の入力方式を出し、自己ベストを練習の入力方式で保存する
（INP-1〜INP-3、INP-9〜INP-14）。どこで振り分けるか、何を「操作」とみなすか、練習の入力方式をいつ決めるかで、
記録の形・パッドの look の積み方（ADR: pad-look-per-fixed-step）・自己ベストのキーへの影響が変わる。

## 決定

- `src/input/input-switch.ts` の `InputSwitch` を、マウス・パッドと練習の入力のキュー（RecordingInput）の間に置く。
  デバイスは操作を `activity(device)`、アクションを `input(device, action, time?)` で渡し、今の入力方式のデバイスのアクションだけを積む。
  シミュレーションと記録の形は変えない（記録には実際に積んだアクションだけが入る）。
- 切り替えたときは、InputSwitch が通した fire・ads のうち押したままのものの解放を積む。デバイス側の押下の状態は変えない
  （マウスの左ボタンを押したまま戻っても、押し直すまで撃たない）。
- 操作は「押し始め」で判定する。パッドはボタンの押し始め（R2 / L2 はしきい値以上）と、右スティックがデッドゾーンの内側から外へ出た瞬間。
  マウスはロック中の移動とボタンの押下。今の入力方式は InputSwitch がページを開いている間だけ持ち、練習をまたいで引き継ぐ。
- 練習の入力方式は `PracticeSession` が 1 発目を撃ったステップで今の入力方式を 1 回読み、`PracticeResult.inputMethod` に入れる。
  リザルトと自己ベストはこれを使う。

## 却下した案

- デッドゾーンの外にスティックがある間、毎回パッドの操作とみなす: スティックを倒したままマウスに触れると、描画ごとに切り替わり、
  そのたびに fire が離される。
- 振り分けを Simulation か記録の再生で行う（両方のアクションを記録に入れる）: 入力方式の差は `src/input/` で吸収する決定
  （ADR: input-actions-and-angles）に反し、記録の形も変わる。
- 練習の入力方式を練習の終わりの今の入力方式にする: 撃ち終えたあとに触ったデバイスで自己ベストのキーが変わる（INP-14）。
- 切り替えたときにデバイスの押下の状態も消して、押したままのボタンを押し直しとして積み直す: 撃つつもりのない射撃が始まる。

## 影響

- docs/spec/input.md（入力方式の切替、入力方式ごとの保存、INP-1〜INP-3、INP-9〜INP-14）、docs/spec/modes.md（HUD）、docs/spec/scoring.md（自己ベスト）
- src/input/input-switch.ts、src/input/mouse.ts、src/input/pad.ts、src/modes/session.ts、src/ui/hud.ts、src/main.ts、index.html
