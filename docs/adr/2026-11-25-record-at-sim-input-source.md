---
status: accepted
domain: input
summary: 入力の記録はシミュレーションに積む入力の元で取り、練習ごとに種を決めて World から作り直し、再生と照準の軌道は記録から計算し直す
related: [docs/spec/input.md, docs/spec/architecture.md, src/input/recording.ts, src/sim/practice.ts, src/sim/trajectory.ts, src/modes/session.ts, src/main.ts]
---
# 入力の記録はシミュレーションに積む入力の元で取り、再生と照準の軌道は記録から計算し直す

## 背景

Issue #9 で、練習の入力を記録し、再生で同じ弾痕・採点結果を再現し、記録から照準の軌道を取り出す（INP-4〜INP-7、ARC-2、ARC-3）。
どこで何を記録するか、種をどう決めるか、再生をどこまで進めるかで、再現できるかどうかと記録の形が決まる。記録の形は後から変えにくい。

## 決定

- 記録は `src/input/recording.ts` の `RecordingInput` で取る。シミュレーションが入力を取り出す元（InputSource）そのものにし、
  マウス・パッドが積むアクションを、積んだ時刻（練習の開始からの秒）と一緒に積んだ順にすべて残す。記録は `{ seed, actions }` だけ。
- 種は練習の開始ごとに `crypto.getRandomValues` で 0 以上 2³² 未満の整数を 1 つ決め、Gun とモードの乱数はその種だけから作る。
- 練習は「開始」ごとに作り直す（ADR: practice-session-per-start の `PracticeSession`）。その入力の元を `RecordingInput` にする。
- 画面の練習の再生（`src/modes/session.ts` の `replayPracticeSession`）は、元と同じ World・武器・モードで `PracticeSession` を作り、
  練習が終わるまで進める。モードも Gun と同じ乱数を使うので、モードを含めないと一致しない。
- モードを含めないシミュレーションだけの再生（`src/sim/practice.ts` の `replayRecording`、ARC-3）は、記録のアクションをすべて消費し、
  撃ち続けていない状態になるまでステップを進める。その先は弾が出ないので、元の練習の長さを記録に持たなくても結果が一致する。
- 照準の軌道（`src/sim/trajectory.ts`）は、記録を Simulation と共有の `applyActions` で別のプレイヤーに流して計算し直す。

## 却下した案

- マウス・パッドのデバイスのイベントを記録する: パッドの look は固定ステップごとに作るので、再生で感度やカーブの設定が違うと結果が変わる。
  入力方式ごとに再生の処理も要る。
- 練習中にステップごとの照準を保存して軌道にする: 記録の外に状態が増え、再生した結果と軌道が食い違いうる。
- 種を `Date.now()` にする（これまでの実装）: 2³² を超え、同じミリ秒に始めた練習で同じ種になる。
- 再生する時間（秒）を記録に持つ: 結果に効かない値を記録の形に足すことになる。

## 影響

- docs/spec/input.md（INP-4〜INP-8、記録の形、照準の軌道）、docs/spec/architecture.md（ARC-2、ARC-3）
- src/input/recording.ts、src/sim/practice.ts、src/sim/trajectory.ts、src/sim/simulation.ts、src/main.ts
