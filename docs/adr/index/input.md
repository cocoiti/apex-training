# ADR の目次: input

このファイルは scripts/adr-index.py が作る。手で書き換えない。

| ADR | 決定の要点 | 関連 |
|-----|-----------|------|
| [2026-11-25-input-actions-and-angles](../2026-11-25-input-actions-and-angles.md) | 入力は最初からアクションと角度（度）に揃える | docs/spec/input.md, docs/spec/mouse.md, docs/spec/pad.md, src/input/ |
| [2026-11-25-input-switch-gate](../2026-11-25-input-switch-gate.md) | 入力方式の切替はデバイスとキューの間の InputSwitch 1 か所で行い、操作は押し始め・デッドゾーンを出た瞬間で判定し、練習の入力方式は 1 発目のときの入力方式にする | docs/spec/input.md, docs/spec/modes.md, docs/spec/scoring.md, src/input/input-switch.ts, src/input/pad.ts, src/input/mouse.ts, src/modes/session.ts, src/main.ts |
| [2026-11-25-record-at-sim-input-source](../2026-11-25-record-at-sim-input-source.md) | 入力の記録はシミュレーションに積む入力の元で取り、練習ごとに種を決めて World から作り直し、再生と照準の軌道は記録から計算し直す | docs/spec/input.md, docs/spec/architecture.md, src/input/recording.ts, src/sim/practice.ts, src/sim/trajectory.ts, src/modes/session.ts, src/main.ts |
