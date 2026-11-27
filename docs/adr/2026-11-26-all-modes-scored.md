---
status: accepted
domain: modes
summary: パターン観察をなくしてすべてのモードを採点し、ModeResult の scored と採点しない道筋を消し、履歴の画面のモードの選択肢は登録されたモードから作り、以前のモードのキーは読まず消さない（一部は 2026-11-26-mode-scoring-and-weaponless-modes で置き換え）
related: [docs/spec/modes.md, docs/spec/scoring.md, docs/spec/screens.md, docs/spec/pad.md, src/modes/types.ts, src/modes/recoil/, src/ui/result-view.ts, src/ui/round-result.ts, src/ui/history-view.ts, src/main.ts]
---
# すべてのモードを採点し、モードの結果から採点の印をなくし、履歴の画面のモードの選択肢は登録されたモードから作る

## 置き換え

一部は次の ADR で置き換えた: [2026-11-26-mode-scoring-and-weaponless-modes](2026-11-26-mode-scoring-and-weaponless-modes.md)（採点をモードによらない共通の処理とする部分）

## 背景

Issue #51 でパターン観察をなくし、モードは反復練習とセンター維持の 2 つになった（docs/spec/modes.md）。どちらも採点する。
これまでは、モードの `result()` が返す `ModeResult.scored` で採点するかを分け、リザルト・短いリザルト・自己ベスト・履歴・
入力推移のグラフに採点しないときの道筋（「採点なし」、補正しなかった場合のパターンの図など）があった。
履歴の画面のモードの選択肢は、採点するかが静的に分からないため、固定の一覧 `SCORED_MODES` から作っていた
（[2026-11-25-history-scored-modes-list](2026-11-25-history-scored-modes-list.md)）。
また、以前のパターン観察の自己ベスト・履歴のキー（`...:pattern`）が保存されたまま残っている環境がある（MODE-28）。

## 決定

- `src/modes/recoil/pattern.ts` を消す。モードの登録（import.meta.glob）から外れるので、トップ画面の選択肢から消える。
- `ModeResult` から `scored` をなくし、`Readonly<Record<string, unknown>>`（モードが結果に足すもの。今はない）にする。
  リザルト（`ResultView.scored`）・短いリザルト（「採点なし」）・補正しなかった場合のパターンの図（`uncorrectedPattern`）など、
  採点しないモードの道筋を消し、どの練習も採点して自己ベストと履歴を保存する。
- 履歴の画面のモードの選択肢は、トップ画面と同じ登録されたモードの一覧（`src/modes/registry.ts` の `modes`）から作り、
  `SCORED_MODES` を消す。開いたときの組は、このページで最後に終えた練習の組（武器とモードが選択肢にあるとき）か、最初の武器・最初のモード・マウス。
- 登録されていないモードの id の保存（以前のパターン観察のキー）は読まず、消さない。選択肢は登録から作るので、そのキーは表示に出ない。

## 却下した案

- `scored` を残し、採点しない道筋も残す: 今どのモードも採点するので、通らない道筋とテストが残り、SPEC（すべてのモードを採点する）とずれる。
  採点しないモードを足すときは、そのときにモードの型に静的な印を足して決め直す。
- `SCORED_MODES` を残して反復練習とセンター維持にする: 固定の一覧にした理由（採点するかが静的に分からない、反復練習のファイルがない）がなくなり、
  モードを足すたびに 2 か所を直すことになる。
- 以前のパターン観察のキーを読み込み時に消す: SPEC（MODE-28）が残すことを求める。消すと戻せず、保存の形を変える処理がいる。

## 影響

- docs/spec/modes.md（MODE-1, MODE-27, MODE-28）, docs/spec/scoring.md（リザルト画面、自己ベスト、練習の履歴）,
  docs/spec/screens.md（履歴の画面、UI-26）, docs/spec/pad.md（PAD-18, PAD-19）
- src/modes/types.ts, src/modes/recoil/, src/ui/result-view.ts, src/ui/round-result.ts, src/ui/history-view.ts, src/sim/weapon.ts, src/main.ts, index.html
- [2026-11-25-history-scored-modes-list](2026-11-25-history-scored-modes-list.md) を置き換える。
