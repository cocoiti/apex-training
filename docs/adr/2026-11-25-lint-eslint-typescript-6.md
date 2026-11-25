# lint は ESLint（typescript-eslint）と tsc で行い、TypeScript は 6.0 系に留める

状態: 承認

## 背景

立ち上げの時点で TypeScript の最新は 7.0（ネイティブ実装）だが、typescript-eslint は `typescript <6.1` までにしか
対応していない。`src/sim/` の独立（ARC-1）は AST を見るテストで確かめるので、TypeScript のコンパイラ API も使いたい。

## 決定

- TypeScript は `~6.0.3` に固定する。typescript-eslint が 7 系に対応したら上げる。
- `npm run lint` は `eslint .` と `tsc --noEmit` を続けて実行する。
- ESLint では `src/sim/` に `three` の import と DOM のグローバルの参照を禁じるルールを置き、編集中に気づけるようにする。
  正式な確認は ARC-1 のテスト（`tests/helpers/sim-boundary.ts`、TypeScript のコンパイラ API で import と識別子を見る）。

## 却下した案

- Biome: 依存は少ないが、`src/sim/` の境界のような import の制限をディレクトリごとに書くのが ESLint より手間で、
  TypeScript の型を使うルールを後から足せない。
- TypeScript 7 にして lint は `tsc` だけにする: 未使用の import などを拾えず、境界の確認も別の仕組みが要る。
- ARC-1 を正規表現で確認する: コメントや文字列の中の `window` を誤検出する。

## 影響

- docs/spec/architecture.md（ARC-1、ARC-4、ARC-13）
- package.json、eslint.config.js、tests/helpers/sim-boundary.ts
