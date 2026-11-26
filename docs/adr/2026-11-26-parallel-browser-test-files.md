# ブラウザのテストは browser の組の maxWorkers で既定 3 ファイルを並行に流し、APEX_BROWSER_WORKERS で変え、共有していた置き場をファイルごとにする

状態: 承認

## 背景

ブラウザ（Chromium）を使うテストは `fileParallelism: false` で 1 ファイルずつ流していた（2026-11-25-test-projects-by-browser-import）。
描画の省略と時計の差し替え（2026-11-26-test-render-off-manual-clock）で各ファイルは負荷に強くなったが、
25 ほどのファイルを直列に流すため `npm run test:browser` に 7 分ほどかかる。並行に流すと、
ファイル同士で共有していた置き場（Vite の開発サーバーの `node_modules/.vite`、Chromium が TMPDIR に作るファイル）を取り合う
（docs/spec/architecture.md「テストの実行」）。

## 決定

- `vite.config.ts` の browser の組に `maxWorkers` を置き、既定で 3 にする（`DEFAULT_BROWSER_WORKERS`）。browser の組は unit と
  `sequence.groupOrder` が違うので、`npm test` でも `npm run test:browser` でも組ごとの `maxWorkers` が効き、同じ数で流れる。
- 数は環境変数 `APEX_BROWSER_WORKERS`（1 以上の整数）で変える。読むのは `browserWorkers` 1 か所で、Vitest が設定を読むとき
  （`process.env.VITEST`）だけ確かめ、1 以上の整数でなければ変数の名前を示して投げる。設定の読み込みで止まるのでテストは 1 つも流れない。
- Chromium は起動ごとの一時ディレクトリの下に `profile/` と `tmp/` を作り、子のプロセスの TMPDIR を `tmp/` にする。閉じるときに
  まとめて消す（消す途中の ENOTEMPTY に備えて `maxRetries`）。
- Vite の開発サーバーを立てるファイルは、`cacheDir` をファイルごとの一時ディレクトリにする。ビルドの結果は前から各ファイルが
  一時ディレクトリの `--outDir` に出している。

## 却下した案

- 既定の数を CPU の数から決める（`os.availableParallelism()` の半分など）: SPEC は決まった数を求め、マシンごとに並び方が変わると
  負荷で落ちる組み合わせを再現しにくい。3 は 10 コアのマシンで swiftshader の描画とビルドを並べても描画が止まらない数として選んだ。
- Vitest の `VITEST_MAX_WORKERS` や `--maxWorkers` を使う: unit の組の数まで変わり、名前からブラウザのテストの数とわからない。
- 不正な値を既定の数に戻して続ける: 指定の誤りに気づけず、ARC-33 は失敗を求める。
- ビルドを全体の前処理（globalSetup）で 1 回だけ行い共有する: 各ファイルは写しのリポジトリや書き換えた配信物を使うものがあり、
  今回の範囲（並行に流すこと）を超えて書き直しが大きい。

## 影響

- spec/architecture.md（テストの実行、ARC-28, ARC-30〜ARC-35）
- vite.config.ts, CLAUDE.md, tests/helpers/browser.ts, tests/architecture/test-code.test.ts,
  tests/acceptance/parallel-browser-qa.acceptance.test.ts, tests/acceptance/{screens,mouse-qa,wall-target-scope-qa}.acceptance.test.ts
