---
status: accepted
domain: pad
summary: パッドの look は描画ごとに読んだ値を保持し、固定ステップごとに「速度 × ステップの長さ」で積む
related: [docs/spec/pad.md, src/input/pad.ts, src/input/pad-curve.ts, src/main.ts]
---
# パッドの look は描画ごとに読んだ値を保持し、固定ステップごとに「速度 × ステップの長さ」で積む

## 背景

パッドは「傾き = 回転速度」で、回転量は時間で積分して決まる。Gamepad API はイベントではなくポーリングで、
値は描画（requestAnimationFrame）のたびにしか読めない。一方、シミュレーションは固定ステップ（1/120 秒）で進み、
入力は時刻付きのキューから消費する（2026-11-25-fixed-timestep-deterministic-sim）。PAD-5 では 60Hz と 144Hz で
回転量が同じであることを求める。

## 決定

- `PadInput.poll()` を描画のたびに呼び、最新のスティックの値とトリガーの状態を保持する。fire・ads は状態が
  変わったときだけ、読んだ時刻でキューに積む。
- `PadInput.step(dt)` を固定ステップの更新の直前に呼び、保持した値から回転速度を求め、`速度 × dt` の `look` を
  そのステップの開始時刻（`sim.time`）でキューに積む。回転量はステップの数だけで決まる。
- 入力量と回転速度の式・簡易設定の対応表は `src/input/pad-curve.ts` の 1 か所にまとめる。
- ADS 中の速度は、そのパッドの L2 / LT の状態で切り替える。

## 却下した案

- 描画ごとに「速度 × 描画の経過時間」の look を積む: 描画の境目とステップの境目がずれ、ステップに入る回転量が
  描画間隔で揺れる。0.25 秒の上限で捨てた時間との整合も取りにくい。
- シミュレーション（`src/sim/`）でスティックの値から積分する: 入力方式の差を `src/input/` で吸収する決定
  （2026-11-25-input-actions-and-angles）に反し、記録と再生でも速度ではなく角度を扱えなくなる。

## 影響

- docs/spec/pad.md（PAD-4〜PAD-7、PAD-10〜PAD-14）
- src/input/pad.ts、src/input/pad-curve.ts、src/main.ts
