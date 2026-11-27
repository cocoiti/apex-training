---
status: accepted
domain: architecture
summary: データの読み込みの終わりは <html> の data-app-state（index.html が loading を持ち、main.ts が ready・error にする）で出し、ブラウザのテストの道具の goto・reload が既定でそれを待ち、テストが Page.navigate・Page.reload・location.reload() を直接使わないことを調べる
related: [docs/spec/architecture.md, docs/spec/screens.md, index.html, src/ui/app-state.ts, src/main.ts, tests/helpers/browser.ts, tests/helpers/test-code.ts, tests/architecture/test-code.test.ts]
---
# データの読み込みの終わりは <html> の data-app-state で出し、テストの道具の goto・reload が既定でそれを待つ

## 背景

CI の遅い runner で、ブラウザのテストが時々落ちていた（Issue #103）。テストは `goto` の `document.readyState === "complete"` と、
トップ画面が見えること・select の選択肢の数で読み込みの終わりを推し量っていた。マップと武器の JSON の fetch は load を遅らせないので、
トップ画面が見えた時点ではまだ武器のカードも履歴の画面の武器の選択肢もない。そのため、
練習を始める手順ではカードが埋まって「開始」がずれる途中に押してプレイ画面に入れず（形 A）、履歴の画面では、最初からある入力方式の選択肢で
「選択肢がある」と見なして、武器の選択肢を空のまま読んでいた（形 B）。アプリの側は、読み込み前の開始・履歴の画面を開く操作を
`appReady` を待ってから行っていて、操作は捨てていなかった。

## 決定

- `index.html` の `<html>` が最初から `data-app-state="loading"` を持つ。`src/main.ts` は `AppStateMark`（`src/ui/app-state.ts`）で、
  トップ画面のカードと履歴の画面の選択肢を作り、`appReady` を解決したあとに `ready` にし、マップ・武器・モードを読み込めないときと
  `start()` が投げたときに `error` にする。一度 `ready` か `error` になったら変えない。
- `tests/helpers/browser.ts` の `Page.goto` と新しい `Page.reload` は、前の文書に印を付けてから開き、新しい文書（hash だけの移動なら同じ文書）の
  `readyState` が `complete` で、`data-app-state` がない（アプリでないページ）か `loading` でなくなるまでを 1 つの条件で 10 秒まで待つ。
  読み込み前の振る舞いを確かめるテストだけが `{ waitForApp: false }` を渡す。
- 既存のテストの `page.send('Page.reload')` と `location.reload()` は `page.reload()` に置き換え、`tests/helpers/test-code.ts` の
  `findDirectLoads` で、ブラウザを使うテストが `Page.navigate`・`Page.reload` を直接送らず `location.reload()` を呼ばないことを調べる（ARC-103-2）。

## 却下した案

- 待ちの上限を伸ばす・sleep を足す: 遅さの揺れに負けるだけで、Issue と ARC-22 が禁じている。
- テストごとに武器のカードの数や L-STAR の選択肢を待つ: 同じ待ちが各ファイルに散り、新しいテストがまた推し量る形で書かれる。
- `window` の大域の値（`__apexTestClock` のような）で出す: `<html>` の属性は index.html が最初から持てるので、スクリプトの読み込みの前から
  `loading` と読め、`data-app-state` がないページ（テストが置いた空のページ）をアプリでないと見分けられる。
- 読み込みが終わってから画面を出す: 3D やデータを読み込めなくても画面は出す今の作り（`startShell`）に反し、利用者の見た目が変わる。

## 影響

- spec/architecture.md（テストのための読み込みの完了の印、ARC-103-1〜ARC-103-3）、spec/screens.md（データの読み込み、UI-103-1・UI-103-2）
- index.html, src/ui/app-state.ts, src/main.ts, tests/helpers/browser.ts, tests/helpers/test-code.ts, tests/architecture/test-code.test.ts と、
  再読み込みをするブラウザを使うテスト
