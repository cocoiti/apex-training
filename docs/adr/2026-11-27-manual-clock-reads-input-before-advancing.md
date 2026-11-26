# clock=manual の時計は、進める前に今の時刻のまま 1 回描画し、止めている間に変えた入力をいつも止めた時刻で読む

状態: 承認

## 背景

`clock=manual` のページでは、実際の requestAnimationFrame でも時刻を進めずに描画し、パッドを読む
（2026-11-26-test-render-off-manual-clock）。テストが時計を止めている間に R2 を押すと、押したことを読むのは
「次の実際の描画（止めた時刻 T）」か「時計を進めたときの最初の描画（T + 描画の間隔）」のどちらか先に来た方になる。
入力の時刻はループの時計（`FixedStepLoop.currentTime()`、前の描画からの経過を足す）で付くので、押した時刻が描画の間隔（1/60 秒、
固定ステップ 2 つ）だけずれ、撃つ弾の数や押していた長さが、実時間で待ったかどうか（実行の速さ）で変わっていた。
main の CI で落ちた MODE-11 は、さらに倒す長さを実時間（performance.now）で決めていた（docs/spec/architecture.md、ARC-67・ARC-68）。

## 決定

- `ManualFrameClock.advance()` は、時刻を進める前に今の時刻のまま描画を 1 回行う（`draws` は false）。止めている間に変えた入力は、
  実際の描画が間に入っても入らなくても、いつも止めた時刻 T で読まれ、進めた時間のステップはすべてその入力で進む。
  advance の戻り値は、時刻を進めた描画の回数のまま（先頭の描画は数えない）。
- ブラウザのテストは、倒す・押す → `Page.advanceClock` / `Page.advanceClockUntil` で時計を進める → 戻す・離す、の形で入力を与える。
  これを `tests/helpers/test-code.ts` の `findRealTimeHolds` が調べる（2026-11-27-real-time-hold-scan）。

## 却下した案

- clock=manual のとき、実際の描画ではパッドを読まない: 時計を止めたままの画面の操作（A で選ぶ、入力方式の表示が変わる）を
  確かめるテストが、時計を進めないと動かなくなる。
- clock=manual のとき、入力の時刻を前の描画の時刻で付ける（ループの時計に手を入れる）: 本番と同じ `FixedStepLoop` の時刻の付け方を
  テストのための時計の種類で変えることになり、`src/core/loop.ts` に clock=manual の知識が入る。
- テストの側で、押すたびに実際の描画を待ってから時計を進める: 待つのを忘れた書き方を見分けられず、実時間に頼る箇所が残る。

## 影響

- spec/architecture.md（テストのための描画の省略と時計の差し替え、ARC-67・ARC-68）
- src/core/frame-clock.ts, tests/core/frame-clock.test.ts, tests/acceptance/render-clock-qa.acceptance.test.ts
- 時計を進めるたびに描画が 1 回増える（advanceClockUntil は固定ステップごとに 2 回描画する）。3D は描かないので軽い。
