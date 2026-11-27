# ADR の目次: cross

このファイルは scripts/adr-index.py が作る。手で書き換えない。

| ADR | 決定の要点 | 関連 |
|-----|-----------|------|
| [2026-11-26-ui-language-dictionaries](../2026-11-26-ui-language-dictionaries.md) | 画面の文言は TypeScript の言語ごとの辞書と index.html のキーの属性から出し、モードの名前はモードのファイルが両方の言語で持ち、src/sim/ は識別子で返し、今の言語はページに 1 つ持って選び直しをその場で書き直す | docs/spec/screens.md, docs/spec/overview.md, docs/spec/modes.md, docs/spec/architecture.md, src/ui/i18n.ts, src/ui/messages/, src/ui/page-language.ts, index.html, src/modes/, src/sim/scoring.ts, src/sim/simple-pattern.ts |
