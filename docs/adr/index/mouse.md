# ADR の目次: mouse

このファイルは scripts/adr-index.py が作る。手で書き換えない。

| ADR | 決定の要点 | 関連 |
|-----|-----------|------|
| [2026-11-25-pause-freezes-loop-clock](../2026-11-25-pause-freezes-loop-clock.md) | 一時停止はループの時計を止めて止めていた時間を数えず、ポインターロックの結果は要求の Promise で判断する | docs/spec/mouse.md, src/core/loop.ts, src/input/mouse.ts, src/main.ts |
