# ADR の目次: weapons

このファイルは scripts/adr-index.py が作る。手で書き換えない。

| ADR | 決定の要点 | 関連 |
|-----|-----------|------|
| [2026-11-25-fire-schedule-from-press](../2026-11-25-fire-schedule-from-press.md) | 発射の時刻は押し始めのステップを起点に「発数 × 発射間隔」で決め、押し直しでは発射間隔を待たない | docs/spec/weapons.md, src/sim/gun.ts |
| [2026-11-25-lstar-measured-from-view-motion](../2026-11-25-lstar-measured-from-view-motion.md) | L-STAR の跳ねは録画の画面の動きから求め、FOV の値の Hor+ 換算（ADS の倍率なし）で角度にする | docs/spec/weapons.md, src/data/weapons/lstar.json, docs/measurements/lstar.json |
| [2026-11-25-measure-with-all-purple-attachments](../2026-11-25-measure-with-all-purple-attachments.md) | 計測はアタッチメントをすべて紫にして撮り、外れた射撃は記録の excludedFromAverage に理由を書いて平均から外し、撮影者に確かめられなかった条件は仮定として記録する（一部は 2026-11-26-car-conditions-confirmed で置き換え） | docs/spec/weapons.md, docs/spec/modes.md, src/data/weapons/car.json, src/data/weapons/lstar.json, docs/measurements/ |
| [2026-11-25-weapon-data-as-json](../2026-11-25-weapon-data-as-json.md) | 武器のリコイルは JSON のデータとして外に出す | docs/spec/weapons.md, src/data/weapons/ |
| [2026-11-26-car-conditions-confirmed](../2026-11-26-car-conditions-confirmed.md) | C.A.R. SMG の撮影の条件は撮影者に確かめた値とし、計測の記録から仮定の一覧をなくす | docs/spec/weapons.md, src/data/weapons/car.json, src/data/weapons/lstar.json, docs/measurements/ |
| [2026-11-26-measured-flag-hides-placeholder-weapons](../2026-11-26-measured-flag-hides-placeholder-weapons.md) | 武器の JSON に必須の `measured` を持たせ、`false` の仮データの武器は残したまま武器の一覧から外す | docs/spec/weapons.md, docs/spec/modes.md, docs/spec/screens.md, src/data/weapons/, src/sim/weapon.ts |
| [2026-11-26-simple-pattern-minmax-dp](../2026-11-26-simple-pattern-minmax-dp.md) | 簡易版のパターンは練習の始めに sim の純粋関数が動的計画法で厳密に求め、武器の JSON にも設定にも持たせない | docs/spec/weapons.md, docs/spec/screens.md, src/sim/simple-pattern.ts, src/ui/correction-panel.ts, src/ui/settings.ts |
