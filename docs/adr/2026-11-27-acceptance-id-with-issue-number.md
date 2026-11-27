---
status: accepted
domain: architecture
summary: 新しく足す受け入れ条件の ID は `<接頭辞>-<Issue 番号>-<番号>` にし、前からある ID は付け替えず、`UI-81-1` を `UI-81` と別の 1 つの ID として読む
related: [docs/spec/README.md, docs/spec/architecture.md, tests/helpers/test-coverage.ts, tests/architecture/test-coverage.test.ts]
---
# 新しく足す受け入れ条件の ID に Issue 番号を入れ、前からある ID は付け替えずに 2 つの形を並べて使う

## 背景

受け入れ条件の ID は `<接頭辞>-<番号>`（`UI-43` など）で、番号は SPEC の中の通し番号だった。
複数の Issue を別々の作業ツリーで並行して進めると、どの PR も「今の最後の番号 + 1」を振るので、
同じ `UI-81` が 2 つの PR で別の条件を指し、後からマージする側で ID と表の行・テストの名前を振り直す手間が出ていた。

## 決定

- 新しく足す ID は `<接頭辞>-<Issue 番号>-<その Issue の中の番号>`（`UI-81-1`）にする。Issue 番号は GitHub が重ならずに振るので、
  並行する PR 同士で ID がぶつからない。
- 前からある `<接頭辞>-<番号>` の ID は付け替えない。2 つの形を同じ表・テストの名前で並べて使う。
- テストの名前と `tests/acceptance/README.md` の表から ID を読む正規表現は `[A-Z]{2,5}-\d+(?:-\d+)?` にし、
  `UI-81-1` を 1 つの ID として読む（`UI-81` を確かめたことにしない）。照らし合わせは `tests/helpers/test-coverage.ts` の
  `coverageProblems` 1 か所で行う。

## 却下した案

- マージのときに後の PR が番号を振り直す: 並行が増えるほど振り直しと競合が増え、レビュー済みの ID が変わる。
- 接頭辞ごとに Issue へ番号の範囲を前もって割り当てる: 割り当ての台帳が要り、範囲の見積もりを外すと結局ぶつかる。
- 前からある ID もすべて新しい形に付け替える: SPEC・表・テストの名前・ADR・コミットの記録にある ID がたくさん変わり、
  過去の Issue や PR からたどれなくなる。
- `UI-81-1` を `UI-81` の一部として読む（前方一致）: 古い形の `UI-81` と新しい形の `UI-81-1` が別の条件のとき、
  一方のテストがもう一方を確かめたことになってしまう。

## 影響

- spec/README.md（受け入れ条件の ID）、spec/architecture.md（ARC-29, ARC-96-1〜ARC-96-4）
- tests/helpers/test-coverage.ts, tests/architecture/test-coverage.test.ts, tests/acceptance/browser-tests-qa.acceptance.test.ts,
  tests/acceptance/README.md, CLAUDE.md
