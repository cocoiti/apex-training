# ADR（設計の決定記録）

SPEC（`docs/spec/`）はプロダクトが今どう振る舞うかを書く。ADR は「なぜそうしたか」を書く。

## 読み方

この目次だけを読み、関連（SPEC・パス）が今の作業に合う「承認」の行のファイルだけを開く。全部のファイルは読まない。

## 書き方

- 書くのは、別の案を比べて却下した、後から戻しにくい（データの形式、外部との境界、依存の追加など）、
  レビューで「なぜこうしたか」と聞かれそう、のどれかに当たる決定だけ。
- 1 つの決定を 1 ファイルにし、`docs/adr/<YYYY-MM-DD>-<短い英語の名前>.md` に書く（並行する PR でぶつからないよう連番にしない）。
- 節は「# <決定の要点>」「状態（承認 / 置き換え済み → <新しいファイル>）」「背景」「決定」「却下した案」
  「影響（関係する SPEC の ID・パス）」。40 行程度に収める。
- 書いたら下の目次に 1 行足す。
- 決定を変えるときは既存の ADR を書き換えず、新しい ADR を書き、古い ADR と目次の状態を「置き換え済み → <新しいファイル>」にする。

## 目次

| ADR | 決定の要点 | 状態 | 関連 |
|-----|-----------|------|------|
| [2026-11-25-3d-from-mvp](2026-11-25-3d-from-mvp.md) | MVP から Three.js の一人称 3D で作る | 承認 | spec/architecture.md, spec/screens.md, src/render/, src/sim/ |
| [2026-11-25-weapon-data-as-json](2026-11-25-weapon-data-as-json.md) | 武器のリコイルは JSON のデータとして外に出す | 承認 | spec/weapons.md, src/data/weapons/ |
| [2026-11-25-practice-only-no-cheat-outputs](2026-11-25-practice-only-no-cheat-outputs.md) | ブラウザ内の練習に限り、チートに転用できる出力とエイムアシストを作らない | 承認 | spec/overview.md, spec/pad.md |
| [2026-11-25-fixed-timestep-deterministic-sim](2026-11-25-fixed-timestep-deterministic-sim.md) | 固定ステップで、DOM と Three.js から切り離し、入力だけで結果が決まるシミュレーションにする | 承認 | spec/architecture.md, spec/input.md, src/core/, src/sim/ |
| [2026-11-25-input-actions-and-angles](2026-11-25-input-actions-and-angles.md) | 入力は最初からアクションと角度（度）に揃える | 承認 | spec/input.md, spec/mouse.md, spec/pad.md, src/input/ |
| [2026-11-25-static-site-hash-routing](2026-11-25-static-site-hash-routing.md) | サーバーなしの静的サイトにし、画面はハッシュで切り替える | 承認 | spec/overview.md, spec/screens.md |
| [2026-11-25-data-json-as-fetched-assets](2026-11-25-data-json-as-fetched-assets.md) | データの JSON は src/data/ に置き、Vite の資産として出してベースパス基準の URL で fetch する | 承認 | spec/architecture.md（ARC-11, ARC-14）, src/data/maps/, vite.config.ts, scripts/check-subpath.mjs |
| [2026-11-25-lint-eslint-typescript-6](2026-11-25-lint-eslint-typescript-6.md) | lint は ESLint（typescript-eslint）と tsc で行い、TypeScript は 6.0 系に留める | 承認 | spec/architecture.md（ARC-1, ARC-4, ARC-13）, package.json, eslint.config.js, tests/helpers/sim-boundary.ts |
| [2026-11-25-safe-storage-wrapper](2026-11-25-safe-storage-wrapper.md) | localStorage は例外を投げない SafeStorage を通し、失敗後もページを開いている間はメモリで値を持つ | 承認 | spec/overview.md（OVR-4）, src/ui/storage.ts, src/main.ts |
| [2026-11-25-fire-schedule-from-press](2026-11-25-fire-schedule-from-press.md) | 発射の時刻は押し始めのステップを起点に「発数 × 発射間隔」で決め、押し直しでは発射間隔を待たない | 承認 | spec/weapons.md（発射、WPN-4, WPN-5）, src/sim/gun.ts |
