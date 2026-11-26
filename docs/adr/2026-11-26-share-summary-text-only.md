# 結果のシェアは src/ui/share.ts が作る要約の文だけを navigator.share の text かクリップボードの writeText に渡し、公開 URL は固定の文字列にする

状態: 承認

## 背景

リザルト画面とセットのまとめから成績を SNS に渡したい（Issue #70）。一方で、補正値や照準の動きを外へ出す操作は作らない
（ADR: practice-only-no-cheat-outputs、OVR-5）。外へ渡す経路を作る以上、何をどの API で渡すかを 1 か所に閉じ込める必要がある。

## 決定

- シェアの文は `src/ui/share.ts` の純粋な関数（`resultShareText`・`setShareText`）だけが作る。入力は武器とモードの名前・平均ズレ・命中率
  （またはセットの回数とセットの平均）・自己ベストを更新したかだけで、記録・軌道・各弾の値を受け取らない形にする。
- `navigator.share` には `{ text }` だけを渡す（`files`・`url`・`title` は渡さない）。`AbortError` 以外で失敗したら
  `navigator.clipboard.writeText` に切り替え、それも失敗したら読み取り専用の欄に文を出す。`document.execCommand('copy')` は使わない。
- 文の公開 URL は `https://cocoiti.github.io/apex-training/` の固定の文字列とし、開いている `location` から作らない。
- パッドの Y / △（ボタン 3）は画面の操作 `pad-y` として `PadButtons` で読み、`screenCommand` が `share` に変える
  （ADR: screen-controls-outside-actions と同じ経路。アクションにも入力の記録にも入らない）。
- 「外へ出す操作がない」ことを確かめる INP-8 のテストは、`data-share` の区画と `src/ui/share.ts` だけを除外し、その中身を別に確かめる。
- セットで自己ベストを更新したかは、`PracticeSet` の各回の記録（`RoundRecord.bestUpdated`）に残して `summarizeSet` でまとめる。

## 却下した案

- 公開 URL を `location.origin + BASE_URL` から作る: 開発サーバーやテストのサーバーで開いたときに localhost の URL が文に入る。
- `navigator.share` に `url` も渡す: 共有先によって文と URL が二重になり、SPEC の「シェアの文」と渡る内容が一致しなくなる。
- 結果の画像（カード）を作って `files` で渡す: 図に照準の軌道が入り、OVR-20 に反する。依存（canvas の描画）も増える。
- クリップボードの代わりに `execCommand('copy')` を使う: 非推奨で、選択範囲を作る DOM 操作が要る。失敗時は読み取り専用の欄で代える。

## 影響

- docs/spec/screens.md（結果のシェア、UI-87〜UI-95）, docs/spec/overview.md（OVR-5, OVR-20）, docs/spec/pad.md, docs/spec/scoring.md
- src/ui/share.ts, src/ui/screen-commands.ts, src/input/screen-controls.ts, src/input/pad.ts, src/ui/practice-set.ts, src/ui/set-summary.ts,
  src/ui/result-view.ts, src/main.ts, index.html, tests/acceptance/input.acceptance.test.ts, tests/acceptance/input-recording-qa.acceptance.test.ts
