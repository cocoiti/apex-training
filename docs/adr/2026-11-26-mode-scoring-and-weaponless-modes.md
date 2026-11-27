---
status: accepted
domain: scoring
summary: モードの採点は任意の scoring で持ち、保存は比べる指標の id を項目名にした版 1 の形にし、武器を使わないモードは武器の id を `-` にする
related: [docs/spec/scoring.md, docs/spec/screens.md, docs/spec/modes.md, src/modes/types.ts, src/ui/mode-scoring.ts, src/ui/personal-best.ts, src/ui/practice-history.ts, src/ui/result-view.ts, src/ui/history-view.ts, src/ui/set-summary.ts, src/ui/share.ts]
---
# モードの採点は任意の scoring で持ち、保存は比べる指標の id を項目名にした版 1 の形にし、武器を使わないモードは武器の id を `-` にする

## 背景

Issue #72 で、追いエイム・フリックのための土台として、武器を使わないモードと、モードごとの採点（命中数など「大きいほど良い」指標を含む）を足す
（docs/spec/scoring.md「モードごとの採点」）。これまでの採点・自己ベスト・履歴・セットのまとめ・シェアの文は、どれも平均ズレ（小さいほど良い）に固定だった。
既存の反復練習の保存（`apex-training:best:...:ghost`・`apex-training:history:...:ghost`）は、足したあとも同じ項目で残す必要がある（SCO-43）。

## 決定

- `TrainingMode` に任意の `scoring`（`compare`: 比べる指標の id・名前・単位・書き方・良い向き・とりうる値、`columns`: 履歴の一覧に並べる指標、
  `score(input)`: 弾の記録・練習の時間・モードの結果から値と表示の行を返す）を足す。持たないモードは今までの弾痕のズレの採点で、比べる指標は平均ズレ。
  弾痕の散布図・照準の軌道・入力推移のグラフ・苦手な区間は弾痕のズレの採点のモードだけが出す。
- 武器を使うか（`usesWeapon`）・制限時間（`timeLimit`）・苦手な区間・向きの音も任意の項目にし、省くと反復練習と同じ振る舞いにする
  （今あるモードのファイルと、受け入れテストが足すモードのファイルを書き換えずに済む）。
- 保存の形は版 1 のまま、比べる指標の id を項目名にする（自己ベストは `version`・比べる指標・モードが決めた指標・`achievedAt`、
  履歴の 1 件は `at`・比べる指標・モードが決めた指標）。読むときは比べる指標の項目だけを確かめ、合わない件を読み飛ばす。
  反復練習の比べる指標の id は `meanError` なので、反復練習の保存の項目と順は変わらない。
- 武器を使わないモードのキーは、武器の id の代わりに `-` を書く（`apex-training:best:mouse:-:<モードの id>`）。
- 自己ベスト・セットのまとめのいちばん良かった回は、比べる指標の良い向きで比べ、等しいときは更新しない・番号の小さい回にする。

## 却下した案

- モードごとにリザルト画面の HTML を描く関数を持たせる: 自己ベスト・履歴・セットのまとめ・シェアの文がそれぞれ指標を知る必要があり、
  画面ごとに書き方がずれる。指標の書き方を 1 か所（`format`）に持たせ、画面は共通の処理で書く。
- 保存の形を版 2 にして、指標を `{ id, value }` の配列で持つ: 反復練習の既存の保存を読み替えるか書き換える処理がいり、SCO-43（同じ項目）に反する。
- 武器を使わないモードも武器の id でキーを分ける: 武器を選ばないので、トップ画面で隠した武器の選択によって履歴が分かれてしまう。

## 影響

- docs/spec/scoring.md（モードごとの採点、自己ベスト、保存の形、練習の履歴、SCO-40〜SCO-44）, docs/spec/screens.md（履歴の画面、セットのまとめ、シェアの文、UI-96, UI-97, UI-100）,
  docs/spec/modes.md（モードの登録、MODE-32〜MODE-35）
- src/modes/types.ts, src/modes/registry.ts, src/ui/mode-scoring.ts, src/ui/personal-best.ts, src/ui/practice-history.ts, src/ui/result-view.ts,
  src/ui/history-view.ts, src/ui/set-summary.ts, src/ui/round-result.ts, src/ui/share.ts, src/main.ts
