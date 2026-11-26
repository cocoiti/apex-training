# CI は GitHub Actions の ubuntu-latest の 1 ジョブで流し、Chromium は版を決めた npx の Playwright で入れ、CI では見つからなければ失敗にする

## 状態

一部置き換え済み → [2026-11-27-ci-browser-shards](2026-11-27-ci-browser-shards.md)（1 つのジョブで順に流すのをやめ、検査・4 組のブラウザのテスト・まとめのジョブに分ける）

## 背景

Actions を有効にし（2026-11-26）、PR と `main` で lint・単体・ブラウザのテスト・ビルド・配布物の検査を流す（Issue #83）。
ブラウザを使うテストは依存を足さずに Playwright が置いた Chromium を DevTools プロトコルで動かし、見つからなければ飛ばす。
CI でそのまま流すと、Chromium の導入に失敗しても全部飛ばされて成功になる。費用のため macOS・Windows の runner は使わない。

## 決定

- `.github/workflows/ci.yml` の 1 つのジョブを `ubuntu-latest` で動かし、SPEC の順にステップを並べる。並列のジョブに分けない。
  `concurrency` を PR 番号（なければ ref）でまとめ、`cancel-in-progress: true` にする。権限は `contents: read` だけ。
- Chromium は `npx --yes playwright@<版> install --with-deps chromium` で `~/.cache/ms-playwright` に入れ、そのディレクトリを版ごとのキーで
  `actions/cache` に置く。Playwright は package.json の依存に足さない。キャッシュがあってもこの手順で OS のライブラリだけは入れる。
- `tests/helpers/browser.ts` の `findChromium` は、環境変数 `APEX_REQUIRE_CHROMIUM=1` のとき見つからなければ例外を投げる。
  ブラウザを使うテストのファイルの読み込みが失敗になり、`npm run test:browser` が失敗する。CI のそのステップだけで 1 にする。
- CI のブラウザを使うテストは `APEX_BROWSER_WORKERS=2` で 2 ファイルずつ流す。runner の CPU は 4 つで、ソフトウェアの WebGL で描く
  Chromium を既定の 3 つ並べると、実時間で動くテスト（練習の時間切れ・10 秒の待ち）が落ちた。
- Chromium は新しいプロセスグループで起動し、閉じるときは子のプロセスまで止めてからプロファイルを消す。Linux では本体だけを止めると
  子のプロセスが残ってプロファイルに書き続け（消すときに ENOTEMPTY）、CPU を使い続けた。
- Chromium は `--disable-gpu-watchdog` で起動する。重いマシンでは、ソフトウェアの WebGL の描画が遅いのを GPU の監視が固まったと見なして
  GPU のプロセスを止め、ブラウザ全体が応答しなくなった（補正のパネルのテストが 60 秒の上限で次々に落ちた）。
- テストの `clickSelector` は、要素が動かずにその座標でいちばん上にあるのを確かめてから押す。トップ画面の武器のカードは読み込み後に
  埋まって「開始」がずれ、遅い環境ではずれる前の座標で別の要素を押していた。
- Linux では Chromium を `--no-sandbox` で起動する（Ubuntu の runner は権限のない利用者の名前空間を制限していてサンドボックスが起動しない）。
  開くのはテストが立てた手元のサーバーのページだけ。
- Node.js は `22`（22 系の最新）。CLAUDE.md の「22.12 以上」を満たし、ESLint 10 が求める 22.13 以上も満たす。
- 公開のテストが手元のリポジトリを clone するので、checkout は `fetch-depth: 0` にする。

## 却下した案

- Playwright を devDependencies に足す: ブラウザの導入のためだけに依存が増え、テストの道具は Playwright を使っていない。
- `CI` の環境変数で Chromium を必須にする: 入れ子に流すテストが子のプロセスに `CI=1` を渡しており、手元の実行の振る舞いまで変わる。
- 導入の直後に別のスクリプトで Chromium の有無だけを確かめる: 探し方が `findChromium` と二重になり、ずれると飛ばされて成功になる。
- lint・単体・ブラウザを並列のジョブに分ける: 毎回 `npm ci` が重なり、順に流して早く止める SPEC と合わない。

## 影響

- spec/architecture.md（継続的インテグレーション（CI）、ARC-57〜ARC-62）
- .github/workflows/ci.yml, tests/helpers/browser.ts, tests/architecture/ci.test.ts, CLAUDE.md
