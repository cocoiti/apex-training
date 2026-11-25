# パッドの振動は描画のたびに増えた弾の数だけ要求し、シミュレーションと記録の再生からは出さない

状態: 承認

## 背景

Issue #14 で、入力に使うパッドで弾が 1 発出るたびに `dual-rumble`（60 ミリ秒・強い側 0.2・弱い側 0.5）を 1 回要求する（PAD-8）。
OFF のとき・今の入力方式がマウスのとき・記録の再生では振動せず、振動に対応しないパッドやブラウザでもエラーにしない（PAD-17）。
シミュレーション（`src/sim/`）は DOM と Gamepad API に触れず、記録の再生でも同じ結果になる必要がある（ADR: fixed-timestep-deterministic-sim）。

## 決定

- `src/main.ts` の描画のたびに、練習の `gun.shots` の数と、振動を出し終えた数（`Running.rumbledShots`）を比べ、
  増えた弾ごとに `rumbleShot()`（`src/input/pad-rumble.ts`）を 1 回呼ぶ。振動の ON/OFF は「開始」を押した時点の設定を使い、
  今の入力方式がパッドで、使えるパッドがあるときだけ要求する。
- `rumbleShot()` は `vibrationActuator.playEffect` がなければ何もせず、例外と拒否された Promise を握りつぶす。
- 設定画面の「振動に対応していません」の表示は、入力に使うパッドに `playEffect` があるかだけで決める（`canRumble()`）。

## 却下した案

- シミュレーションの発射のフック（`Gun` やステップのフック）から振動を出す: `src/sim/` が Gamepad API に頼ることになり、
  記録の再生（リザルトの軌道の計算）でも振動してしまう。
- 発射の時刻に合わせて `setTimeout` で振動を予約する: 一時停止やタブの切替と時計がずれ、止めている間にも振動する。
- 対応を確かめるために一度振動を要求し、失敗したら「対応していない」とする: 設定画面を開くたびにパッドが震える。

## 影響

- docs/spec/pad.md（振動、PAD-8, PAD-17）
- src/input/pad-rumble.ts、src/main.ts、src/ui/practice-settings.ts、index.html
