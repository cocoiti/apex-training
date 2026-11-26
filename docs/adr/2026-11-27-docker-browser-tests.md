# ブラウザのテストは Playwright の公式イメージのコンテナで流し、context に届かなければ手元の Docker に切り替え、作ったイメージは ID で動かす

## 状態

承認

## 背景

ブラウザを使うテストは重く、手元のマシンを長く塞ぐ。Mac mini（docker context `macmini`）の Docker でも流したい（Issue #85）。
Mac mini は arm64、CI の runner は amd64 で、どちらでも同じイメージを作れ、CI と同じ版の Chromium で流れる必要がある。
複数の作業ツリーが並行に同じ Docker を使うことがある。

## 決定

- `Dockerfile.test` は `mcr.microsoft.com/playwright:v<版>-noble` をもとにし、版は CI の `PLAYWRIGHT_VERSION` と同じにする（テストで照らす）。
  `package.json` と lockfile だけを先にコピーして `npm ci` し、そのあとで `COPY . .` する。`ENV` で `APEX_REQUIRE_CHROMIUM=1` にする。
  `.git` は入れず、コピーしたソースをイメージの中で `git init` して 1 つのコミットにする（公開のテストがソースを clone するため）。
- Chromium の探し方（`findChromium`）は Playwright の `PLAYWRIGHT_BROWSERS_PATH` を最初に見て、arm64 の Linux の置き場所
  （`chrome-linux-arm64`・`chrome-headless-shell-linux-arm64`）も探す。依存を足さずに Chromium を探す部分を `tests/helpers/chromium.ts` に分け、
  Chromium を起動しない単体テストからも import できるようにする（`browser.ts` から export し直すので、既存のテストは変えない）。
- `scripts/test-remote.mjs` は `docker context inspect <名前>` で context の有無を、`docker --context <名前> info` を 15 秒の上限で
  動かしてつながるかを見る。どちらかが失敗したら `--context` を付けずに今の context で流し、どちらで流すかを先に出す。
- イメージは `--iidfile` で ID を受け取り、`docker run` には ID を渡す（タグ `apex-training-test` も付ける）。
- コンテナは `--rm --init --ipc=host` で動かす。`APEX_BROWSER_WORKERS` は手元にあればその値を、なければ 2 を `-e` で渡す
  （Mac mini で既定の 3 つずつ流すと、実時間で動くテストが待ちの上限に当たったため）。
- 単体テストは `TEST_DOCKER_COMMAND` で docker を偽物に差し替えて確かめる（`DEPLOY_BUILD_COMMAND` と同じ形）。

## 却下した案

- Node の公式イメージに `npx playwright install --with-deps chromium` で入れる: 作るたびに大きなダウンロードがあり、OS のライブラリの揃え方も自前になる。
- イメージの中で `~/.cache/ms-playwright` へのリンクを張る / `CHROMIUM_PATH` を決め打ちする: リビジョンの番号と CPU で置き場所が変わり、版を上げるたびに壊れる。
- 決まったタグで `docker run` する: 並行する作業ツリーが間にタグを上書きすると、別の作業ツリーのソースのイメージでテストを流してしまう。
- context の有無だけで判断する: Mac mini が止まっているときに build がつながるまで待たされ、失敗の理由もわかりにくい。
- 本物の Docker で作って流すテストを `npm test` に入れる: 全部のブラウザのテストをもう一度流すことになり、CI の時間が倍になる。手で確かめる。

## 影響

- spec/architecture.md（Docker でのブラウザのテスト、ARC-69〜ARC-73）
- Dockerfile.test, .dockerignore, scripts/test-remote.mjs, package.json, tests/helpers/chromium.ts, tests/helpers/browser.ts, CLAUDE.md
- tests/scripts/test-remote.test.ts, tests/architecture/docker-test.test.ts
