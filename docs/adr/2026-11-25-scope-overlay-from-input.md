# ADS 中のスコープは HTML と CSS の重ね表示で描き、表示の切替はシミュレーションの状態でなく積んだ ads の入力で決める

状態: 承認

## 背景

#33 で、ads を押している間は腰撃ちのクロスヘアを消し、周りを暗く覆った円形の視野とレティクルを出す（screens.md「ADS 中の照準」、UI-21）。
視野角は変えない（UI-22）。ポインターロックが外れて ads が離した状態になったときも、すぐに腰撃ちの表示に戻す必要がある。
一時停止の間はループの時計が止まり（ADR: pause-freezes-loop-clock）、シミュレーションのステップは進まないので、`player.ads` は押したままの値で残る。

## 決定

- スコープは `index.html` の `.scope`（視野の円・レティクルの十字・中心の点）と `src/ui/style.css` で描く。視野の外は box-shadow で覆い、
  直径は 80vmin。レティクルの色は `--reticle-color` で、クロスヘアの色の設定から `applyReticleColor` で当てる。
- 表示の切替は `src/main.ts` の `emit`（練習の入力のキューに積む 1 か所）で、積んだ ads のアクションから `adsAfter` で押下の状態を求め、
  `showAimDisplay` でクロスヘアとスコープの `hidden` を切り替える。練習の開始・打ち切り・終わりで離した状態に戻す。
- カメラ（ViewScene）には触れない。

## 却下した案

- Three.js のシーンにスコープを描く（カメラの前の板や後処理）: 描画が重くなり、画面の比率に合わせた円と覆いの計算が要る。
  レティクルの色は HTML のクロスヘアと同じ仕組み（CSS の変数）で当てたほうが揃う。
- `player.ads`（シミュレーションの状態）を毎フレーム読む: 一時停止の間はステップが進まず、ロックが外れて ads を離しても表示が戻らない。
- マウスの右ボタンのイベントを直接見る: パッドの ads（同じ emit を通る）を別に扱う必要があり、入力方式ごとに分かれる。

## 影響

- docs/spec/screens.md（ADS 中の照準、UI-21, UI-22）
- index.html, src/ui/style.css, src/ui/scope.ts, src/main.ts, tests/ui/scope.test.ts
