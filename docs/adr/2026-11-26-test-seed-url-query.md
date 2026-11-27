---
status: accepted
domain: architecture
summary: テストのための乱数の種の固定は本番のビルドが URL のクエリ seed で行い、ブラウザのテストは appUrl の必須の seed で固定の種のページを開き、失敗したときは使った種をメッセージに足す
related: [docs/spec/architecture.md, docs/spec/input.md, src/ui/page-options.ts, src/main.ts, tests/helpers/browser.ts, tests/helpers/seed-report.ts, tests/helpers/test-seed.ts]
---
# テストのための乱数の種の固定は URL のクエリ seed で行い、ブラウザのテストは appUrl の必須の seed で開き、失敗時に種をメッセージに足す

## 背景

ブラウザのテストでは練習の種が `createSeed()`（`crypto.getRandomValues`）で毎回変わり、フリックの MODE-46 が
「次の的が前の的の近くに出た」実行だけで落ちた（Issue #87）。SPEC はテストから種を固定でき、ブラウザのテストはすべて固定の種で流し、
失敗したときに使った種が分かることを求める（docs/spec/architecture.md「テストのための乱数の種の固定」、ARC-44〜ARC-51）。

## 決定

- 本番のビルドが URL のクエリ `seed=<数>` を `src/ui/page-options.ts` の `parsePageOptions` で読む（`render=off`・`clock=manual` と同じ置き方。
  数字だけの 10 進で 2³² 未満のときだけ有効、それ以外は無視）。`src/main.ts` は練習を始めるたびに `pageOptions.seed ?? createSeed()` を種にする。
- `tests/helpers/browser.ts` の `appUrl` はクエリの引数を必須にし、`seed`（数か `NO_SEED`）を必須の項目にする。型で渡し忘れを止め、
  `tests/helpers/test-seed.ts` の `findUnseededPages` が構文木で「seed がファイルに書いた数（const も可）か」「`${origin}${BASE}` の
  テンプレートで seed= なしのページの URL を作っていないか」を調べる（ARC-49）。`NO_SEED` は `UNSEEDED_PAGE_FILES` のファイルだけが使える。
- `Page.goto` が開いた URL の seed を `tests/helpers/seed-report.ts` に渡し、browser.ts を import したファイルでは `beforeEach` の
  `onTestFailed` で、そのテストで開いた種（なければファイルで最後に開いた種）を失敗のメッセージと stack に足す（ARC-50）。
- ブラウザを使わないテストは `findChangingSeeds` が、`createRandom`・`new RecordingInput` の引数と seed・random などの名前の値に
  乱数・時刻・`createSeed` を使う箇所を探す。種を選ぶ処理そのものを確かめるテストは `SEED_CHOICE_TESTS` にファイルとテストの名前で書いて除く（ARC-51）。

## 却下した案

- `window.__apexTest*` の差し替えの口（初期化スクリプトで `crypto.getRandomValues` などを差し替える）: ページ全体の乱数を偽り、
  `render=off`・`clock=manual` の置き方とそろわない。開き直した URL だけで同じ条件を再現できない。
- テスト用のビルドで種を埋め込む: ビルドが 2 種類になり、利用者に配るものと違うものを確かめる（2026-11-26-test-render-off-manual-clock と同じ理由）。
- 種をテストの名前に書く（describe の名前に seed=…）: 33 のファイルの名前を変え、ID の照合（ARC-29）の名前も揺れる。
  失敗のメッセージに足せば、テストの名前を変えずにすべてのブラウザのテストで出る。
- 練習を始めるページだけに seed を求める: どのページが練習を始めるかはコードを読んでも決めにくい。開くページすべてに付けても害がない。

## 影響

- spec/architecture.md（種付きの乱数、テストのための乱数の種の固定、ARC-44〜ARC-51）, spec/input.md（入力の記録と再生）
- src/ui/page-options.ts, src/main.ts, tests/helpers/browser.ts, tests/helpers/seed-report.ts, tests/helpers/test-seed.ts,
  tests/architecture/test-seed.test.ts, tests/acceptance/fixed-seed-qa.acceptance.test.ts と、ブラウザを使うテストのすべてのファイル
