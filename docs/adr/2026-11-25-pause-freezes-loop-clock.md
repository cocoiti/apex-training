---
status: accepted
domain: mouse
summary: 一時停止はループの時計を止めて止めていた時間を数えず、ポインターロックの結果は要求の Promise で判断する
related: [docs/spec/mouse.md, src/core/loop.ts, src/input/mouse.ts, src/main.ts]
---
# 一時停止はループの時計を止めて止めていた時間を数えず、ポインターロックの結果は要求の Promise で判断する

## 背景

ポインターロックが外れたら練習を止め、クリックで再開する（MOU-3、MOU-8）。発射の時刻（押し始めからの発数 × 発射間隔）、
リコイルの回復、入力の時刻はすべて固定ステップのループの時計で決まるので、「止める」をどの層で行うかで、再開後に
弾が一度に出たり、止めている間の入力がまぎれ込んだりする。また、加速を外したポインターロック（`unadjustedMovement`）が
拒否されたことを知る手段が、要求の Promise と `pointerlockerror` の 2 つある。

## 決定

- `FixedStepLoop` に `pause()`・`resume()` を足す。止めるまでの経過は蓄え、止めている間は `currentTime()` が止まった時刻を返し、
  `frame()` は描画だけを行う。再開のときに前回の描画の時刻を今に置き直し、止めていた時間は数えない。
- 止めるのはマウスのポインターロックが外れたときだけ。最初にロックするまでは止めない（パッドだけでも練習できる）。
  止めている間はパッドを読まず、マウスはロックしていないので入力を出さない。fire・ads は外れたときに離した扱いにする。
- ポインターロックの要求は、Promise を返すブラウザでは Promise の成否だけで判断する。Promise を返さないブラウザでは
  イベントで判断し、`unadjustedMovement` に対応していないとみなして、ロックできても加速の警告を出す。

## 却下した案

- requestAnimationFrame を止める: 止めている間にウィンドウの大きさを変えても描き直されない。再開時に経過時間の上限
  （0.25 秒）分のステップが一度に進む。
- ループは回したまま入力だけを捨てる: 押していた fire の発射やリコイルの回復が止まらず、MOU-3 の「練習が止まる」にならない。
- 拒否を `pointerlockerror` で判断する: Chrome は拒否のときに Promise の reject とイベントの両方を出し、順番によっては
  1 回目の要求のイベントを 2 回目の要求の失敗と取り違える。

## 影響

- docs/spec/mouse.md（MOU-1〜MOU-3、MOU-7、MOU-8）
- src/core/loop.ts、src/input/mouse.ts、src/main.ts
