---
status: accepted
domain: architecture
summary: 固定ステップで、DOM と Three.js から切り離し、入力だけで結果が決まるシミュレーションにする
related: [docs/spec/architecture.md, docs/spec/input.md, src/core/, src/sim/]
---
# シミュレーションは固定ステップで、DOM と Three.js から切り離し、入力だけで結果が決まるようにする

## 背景

発射の判定は表示のフレームレートに影響されてはいけない。将来の移動テクは「何フレーム以内に入力したか」で
成否が決まるものが多い。リプレイと、リザルトの軌道表示・入力タイミングの表示もしたい。

## 決定

- シミュレーションは固定ステップ（既定 1/120 秒、定数で変更可）で進め、描画は requestAnimationFrame で別に回して補間する。
- 入力は時刻付きでキューに積み、各ステップでその時間内の入力を消費する。
- `src/sim/` は Three.js と DOM に依存させない。乱数は種付きにし、入力の記録と種だけで結果が決まるようにする。
- 将来の移動の計算は、Source 系の「地上加速・摩擦・空中加速」の考え方で自前で書く。

## 却下した案

- 描画のフレームごとに計算する（可変ステップ）: リフレッシュレートで発射数や移動テクの成否が変わる。
- 移動を物理エンジンに任せる: 手触りを Apex に寄せて調整できない。

## 影響

- docs/spec/architecture.md、docs/spec/input.md（INP-4）、docs/spec/weapons.md（WPN-4）、docs/spec/pad.md（PAD-5）
- src/core/、src/sim/
