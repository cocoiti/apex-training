# ADR の目次: overview

このファイルは scripts/adr-index.py が作る。手で書き換えない。

| ADR | 決定の要点 | 関連 |
|-----|-----------|------|
| [2026-11-25-practice-only-no-cheat-outputs](../2026-11-25-practice-only-no-cheat-outputs.md) | ブラウザ内の練習に限り、チートに転用できる出力とエイムアシストを作らない | docs/spec/overview.md, docs/spec/pad.md |
| [2026-11-25-safe-storage-wrapper](../2026-11-25-safe-storage-wrapper.md) | localStorage は例外を投げない SafeStorage を通し、失敗後もページを開いている間はメモリで値を持つ | docs/spec/overview.md, src/ui/storage.ts, src/main.ts |
| [2026-11-25-static-site-hash-routing](../2026-11-25-static-site-hash-routing.md) | サーバーなしの静的サイトにし、画面はハッシュで切り替える | docs/spec/overview.md, docs/spec/screens.md |
| [2026-11-26-gtm-page-views-with-consent](../2026-11-26-gtm-page-views-with-consent.md) | 計測は許可した人だけ GTM（gtm.js）を読み込み、アプリが dataLayer に積むのは画面の表示だけにし、それ以外を集めない GTM の設定は運用側の責任とする | docs/spec/overview.md, docs/spec/screens.md, index.html, src/main.ts, src/ui/ |
