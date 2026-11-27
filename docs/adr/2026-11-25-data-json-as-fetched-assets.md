---
status: accepted
domain: architecture
summary: データの JSON は src/data/ に置き、Vite の資産として出してベースパス基準の URL で fetch する
related: [docs/spec/architecture.md, src/data/maps/, vite.config.ts, scripts/check-subpath.mjs]
---
# データの JSON は src/data/ に置き、Vite の資産として出してベースパス基準の URL で fetch する

## 背景

マップ（将来は武器も）の JSON は `src/data/` に置き、ファイルの取得はシミュレーションの外で行い、取得のパスは
ビルド時のベースパス（`/apex-training/`）基準にする（architecture.md）。どう配信して、どう一覧するかを決める必要がある。

## 決定

- JSON は `src/data/maps/*.json` に置き、`import.meta.glob('./*.json', { query: '?url', eager: true })` で
  ファイル名（= マップの id）から URL を引く（`src/data/maps/index.ts`）。URL はビルドでベースパスと内容のハッシュが付く。
- 小さい JSON が data: URL に埋め込まれないよう、`build.assetsInlineLimit` で `.json` の埋め込みを止める。
- 取得した中身は `unknown` のまま `src/sim/` の `loadWorld()` に渡し、形式の確認は sim の中で行う。
- `npm run check:subpath` でビルドの結果を `/apex-training/` で配信し、スクリプト・スタイル・JSON が 404 にならないことを確かめる。

## 却下した案

- `public/` に置いて `${import.meta.env.BASE_URL}maps/range.json` を fetch する: SPEC の置き場（`src/data/`）と違い、
  ファイルを足しても一覧に出ず、ハッシュが付かないのでキャッシュの更新を制御できない。
- JSON を `import` してバンドルに含める: 取得の誤りの扱いを試せず、データが増えると最初のスクリプトが重くなる。
  テストでは `import` で読む（Vitest は Node で動くので fetch しない）。

## 影響

- docs/spec/architecture.md（マップの形式、開発の手順、ARC-11、ARC-14）
- src/data/maps/、vite.config.ts、scripts/check-subpath.mjs
