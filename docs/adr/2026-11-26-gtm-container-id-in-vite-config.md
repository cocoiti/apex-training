# GTM のコンテナ ID は vite.config.ts の定数から define で埋め込み、環境変数で置き換えられるようにし、テストのビルドは既定で空にする

状態: 承認

## 背景

SPEC（overview.md「画面の表示の計測」）は、コンテナ ID をビルドの設定の 1 か所に置き、空なら計測に関わることを何もしないことを求める。
公開するビルドの ID は `GTM-MNFCCG6N`。受け入れ条件には ID を設定したビルド（OVR-21〜24, 26, 27）と空のビルド（OVR-25）の両方がある。
一方、既存のブラウザのテストは同意の状態を保存せずに開くので、ID のあるビルドでは同意の案内が出て、パッドで最初にフォーカスする項目が
「許可」に変わる（UI-113）。テストから googletagmanager.com へ要求が出ることも避けたい。

## 決定

- ID は `vite.config.ts` の `GTM_CONTAINER_ID` に置き、`define` で `__GTM_CONTAINER_ID__` としてビルドに埋め込む（型は `src/env.d.ts`）。
  環境変数 `APEX_GTM_CONTAINER_ID` があれば、その値（空を含む）で置き換える（`gtmContainerId`）。
- Vitest の `test.env` で `APEX_GTM_CONTAINER_ID` を既定で空にし、テストが子のプロセスで行うビルドは計測のないビルドにする。
  計測を確かめるテスト（tests/ui/analytics-browser.test.ts）だけが ID を渡してビルドし、GTM への要求は DevTools の Fetch で止めて代わりのスクリプトを返す。

## 却下した案

- `.env` の `VITE_GTM_CONTAINER_ID` に置く: `.env` は `.gitignore` で除いており、公開するビルドの ID をリポジトリに残せない。
- `src/` の定数に置く: 空のビルドを作るのにソースを書き換えることになり、テストで両方のビルドを作れない。
- 既存のブラウザのテストすべてで同意の状態を保存してから開く: 数十のファイルを直すことになり、書き忘れると案内のフォーカスで別の項目が押される。
  計測と関係のないテストが、外部の GTM への要求の有無に左右される。

## 影響

- docs/spec/overview.md（画面の表示の計測、OVR-21〜OVR-27）, docs/spec/screens.md（UI-112〜UI-116）
- vite.config.ts, src/env.d.ts, src/main.ts, src/ui/analytics.ts, tests/ui/analytics-browser.test.ts
