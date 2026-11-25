# ゴーストの向きはモードの任意の関数 ghost で求め、描画は src/render/ghost.ts が描画のたびに行う

状態: 承認

## 背景

ゴースト追従（docs/spec/modes.md）は、次の弾で照準を合わせるべき位置にゴーストを表示する。ゴーストの向きは
シミュレーションの状態（開始時の照準・次に使うパターンの発・リコイルの累積・残弾）から決まるが、表示は描画の層に足すだけで
弾痕と採点を変えてはいけない。練習モードの共通の型（src/modes/types.ts）には、描画にかかわる口がなかった。

## 決定

- `TrainingMode` に任意の関数 `ghost(context): Angles | undefined` を足す。ゴーストを表示するモードだけが持ち、
  表示しないとき（撃ち切った）は undefined を返す。状態は読むだけで書き換えない。登録時（registry.ts）は、あれば関数かを確かめる。
- `PracticeSession.ghost` は練習が終わったあと undefined を返し、それ以外はモードの `ghost` を呼ぶ。
- 描画は src/render/ghost.ts の `GhostMarker` が、ループの描画（render）のたびに `session.ghost` の向きで置き直す。
  目から 5 メートル（射撃場の的と壁より手前）に、深度の判定を外した球で置く。設定のゴースト表示が OFF なら向きを渡さない。
- 設定（FOV・クロスヘア・ゴースト表示・マウス）を「開始」の時点で練習に当てる処理は src/ui/practice-settings.ts に出し、
  main.ts から呼ぶ（DOM なしで UI-4・UI-16・UI-17 の設定の部分を確かめるため）。

## 却下した案

- モードが ModeContext から描画の層（Three.js）を受け取り、自分でゴーストを描く: モードのファイルが Three.js に依存し、
  DOM なしの単体テストと再生（replayPracticeSession）でも描画の層が要る。描画の口を持つかどうかがモードごとにばらつく。
- ゴーストの向きを Simulation か Gun の状態として持つ: 表示だけのものをシミュレーションの状態に入れることになり、
  ARC-17（描画の層は状態を変えない）と「入力だけで結果が決まる」の線引きがあいまいになる。
- main.ts でモードの id（'ghost'）を見て向きを求める: モードを足すたびに main.ts を変えることになり、MODE-5 に反する。
- ゴーストを DOM の要素にして、projectAngleOffset で画面上の位置に換算する: 壁と的の「手前」を 3D の奥行きで表せず、
  カメラの補間と別の計算になる。

## 影響

- docs/spec/modes.md（ゴースト追従、MODE-3, MODE-12〜MODE-15）、docs/spec/screens.md（UI-4, UI-16, UI-17）
- src/modes/types.ts, src/modes/registry.ts, src/modes/session.ts, src/modes/recoil/ghost.ts, src/render/ghost.ts,
  src/ui/practice-settings.ts, src/main.ts
