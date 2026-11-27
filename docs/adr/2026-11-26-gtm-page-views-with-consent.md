---
status: accepted
domain: overview
summary: 計測は許可した人だけ GTM（gtm.js）を読み込み、アプリが dataLayer に積むのは画面の表示だけにし、それ以外を集めない GTM の設定は運用側の責任とする
related: [docs/spec/overview.md, docs/spec/screens.md, index.html, src/main.ts, src/ui/]
---
# 計測は許可した人だけ GTM を読み込み、アプリが dataLayer に積むのは画面の表示だけにする

## 背景

画面の表示回数を Google Analytics で知りたい。一方で、練習の成績・照準の動き・補正値・入力の記録は外へ出さない
（ADR: practice-only-no-cheat-outputs、OVR-5）。計測は同意した人だけに限り、同意の前は外部への要求も Cookie も作らない。
人間の決定で、GA4 の計測 ID（`G-`）ではなく Google Tag Manager のコンテナ ID `GTM-MNFCCG6N` を使い、GA4 の設定は GTM の側で行う。

## 決定

- 読み込むのは `https://www.googletagmanager.com/gtm.js?id=<コンテナ ID>` だけで、gtag.js は読み込まない。
  同意の状態が許可のときだけスクリプトの要素を足して読み込む。`index.html` に GTM の断片も `noscript` の `iframe` も書かない。
- コンテナ ID はビルドの設定の 1 か所に置き、空なら案内・設定の区分・読み込み・`dataLayer` のどれも作らない。
- 同意の状態は `apex-training:analytics-consent` に `granted` / `denied` で、設定の JSON（ADR: settings-json-per-section）とは別のキーに保存する。
  保存できない環境では案内を出さない（毎回出すと開くたびに尋ねることになる）。
- アプリが `dataLayer` に積むのは GTM の開始の 1 件と、表示する画面が変わるたびの `{ event: 'page_view', screen_name, page_path }` だけ。
  `page_path` はベースパスと画面のハッシュで作り、URL のクエリ（`render=off` など）は入れない。
- 許可の取り消しでは「許可しない」を保存し、`_ga*`・`_gid` の Cookie を消してページを読み込み直す。読み込み済みの GTM は外せず、
  GTM の側の履歴の変化のトリガーなどが動き続けうるため。
- GTM のコンテナにはどんなタグでも足せる。アプリが渡すのは画面の表示だけで、それ以外を集めない設定（クリックやページの内容を集めるタグ、
  GA4 の拡張計測のうち画面の表示以外の項目を使わないこと）にするのは GTM を運用する側の責任とする（SPEC overview.md「画面の表示の計測」）。

## 却下した案

- gtag.js と GA4 の計測 ID を直接使う: 人間の決定で GTM のコンテナにした。
- GTM を常に読み込み、Consent Mode で送信だけ止める: 同意の前に Google への要求が出る。
- 取り消し後も読み込み直さず `dataLayer` に積むのをやめるだけにする: 読み込み済みの GTM が自分でハッシュの変化を拾いうる。
- 保存できない環境でも毎回案内を出す: 開くたびに尋ねることになり、選んでも次に開くと消えている。

## 影響

- docs/spec/overview.md（画面の表示の計測、練習の範囲、OVR-21〜OVR-27）, docs/spec/screens.md（計測の同意の案内、計測の設定、UI-112〜UI-116）
- index.html, src/main.ts, src/ui/（同意の案内・計測の設定・dataLayer への積み込み）
