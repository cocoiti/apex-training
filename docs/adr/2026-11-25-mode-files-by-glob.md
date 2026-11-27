---
status: accepted
domain: modes
summary: 練習モードは `src/modes/<category>/*.ts` の default export を import.meta.glob で集め、並び順とファイル名で並べる（一部は 2026-11-26-mode-scoring-and-weaponless-modes で置き換え）
related: [docs/spec/modes.md, docs/spec/screens.md, src/modes/registry.ts, src/modes/types.ts, src/sim/practice.ts]
---
# 練習モードは `src/modes/<category>/*.ts` のファイルの default export を import.meta.glob で集め、並び順とファイル名で並べる

## 置き換え

一部は次の ADR で置き換えた: [2026-11-26-mode-scoring-and-weaponless-modes](2026-11-26-mode-scoring-and-weaponless-modes.md)（モードの種類に aim を足し、撃ち切りと「離して 2 秒」の終わりは武器を使うモードだけにする）

## 背景

MODE-5 は「`src/modes/` にモードのファイルを 1 つ足してビルドしたとき、ほかのファイルを変えずにトップ画面の選択肢に出る」。
`src/modes/` には、モードのファイルのほかに共通の型（`types.ts`）・一覧（`registry.ts`）・練習の進行（`session.ts`）も置く。
どのファイルをモードとみなすか、どう並べるか、練習ごとの状態をどこに持つかを決める必要がある。

## 決定

- モードのファイルは `src/modes/<category>/*.ts`（`recoil/`・`movement/`・`combined/`、architecture.md のフォルダ構成）に置き、
  `TrainingMode` を default で export する。`src/modes/registry.ts` が `import.meta.glob('./*/*.ts', { eager: true })` で集める。
- 各モードは `order`（数）を持ち、一覧は `order` の順、同じならファイルのパスの順にする。
- default がモードの形でないファイルと、id が重なるファイルは一覧から外し、コンソールに出す（武器の JSON と同じ扱い）。
- モードのオブジェクトは 1 つを練習ごとに使い回し、練習ごとの状態は `setup` で作り直す。
- 撃ち切りと「離して 2 秒」の練習の終わりはモードによらないので、モードではなく練習の側（`src/sim/practice.ts`）で判定する。
  モードは `step` で false を返して練習を終えることもできる。

## 却下した案

- `src/modes/*.ts` を直下ごと集める: 共通のファイルとモードのファイルが混ざり、除外の一覧を持つことになる。
- モードの一覧を手で書いたファイルを持つ: ファイルを足すたびに一覧の変更が要り、MODE-5 を満たさない。
- モードのファイルが「モードを作る関数」を export する: 選択肢を作るだけのためにモードを作ることになる。
  練習は同時に 1 つしか動かないので、使い回して `setup` で状態を作り直すほうが単純。
- 並びを表示名やファイル名だけで決める: パターン観察 → ゴースト追従 → センター維持の順を名前で表せない。

## 影響

- docs/spec/modes.md（モードの登録、MODE-5）、docs/spec/screens.md（トップ画面）、docs/spec/architecture.md（モードとマップの追加）
- src/modes/registry.ts, src/modes/types.ts, src/modes/recoil/, src/sim/practice.ts
