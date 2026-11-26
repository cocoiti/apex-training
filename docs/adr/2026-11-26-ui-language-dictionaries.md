# 画面の文言は TypeScript の言語ごとの辞書と index.html のキーの属性から出し、今の言語はページに 1 つ持って選び直しをその場で書き直す

## 状態

承認

## 背景

Issue #81 で日本語と英語を切り替えられるようにする（docs/spec/screens.md「表示の言語」）。最初の画面から選んだ言語で出し、選び直したら読み込み直さずに
すべての画面を変える。文言は index.html と `src/` の 40 ほどのファイルに直接書かれていて、`src/sim/` も採点のコメントや簡易版のパターンの向きの名前を
日本語の文字列で返していた。辞書のキーの漏れや、辞書の外に日本語を書き足したことをテストで止めたい（ARC-44〜ARC-48）。

## 決定

- 辞書は `src/ui/messages/ja.ts`・`en.ts` の TypeScript のオブジェクトにする。ja のキーを型（MessageKey）にし、en は同じキーの組を型で求める。
  埋め込む場所は `{名前}` で、`t(key, vars)` が今の言語の文言を返す。辞書のキーの組・空の文言・埋め込む場所の名前は `tests/architecture/ui-text.test.ts` が実行して確かめる。
- 今の言語は `src/ui/i18n.ts` がページに 1 つ持ち、`setLanguage` で変わったら登録した関数を呼ぶ。画面は登録した関数でコードで作った文言を書き直す
  （モードのカード・練習の選択肢・回数・同意の案内・フッターの保存できない表示など）。描画のたびに書く HUD・パッドの画面は次の描画で変わる。
- index.html は文言を持たず、`data-i18n`・`data-i18n-aria-label` などに辞書のキーを持たせ、`src/ui/page-language.ts` が文字・属性・`<html lang>`・タイトルを書く。
  言語の欄（「言語 / Language」「日本語」「English」）だけは言語によらず同じなので index.html に直接書く。
- モードの表示名・ひとこと説明・練習の選択肢の名前は、モードのファイルが `{ ja, en }`（Localized）で持つ（モードはファイルを 1 つ足すだけで出る、modes.md）。
  指標の名前・単位はモードのファイルでも辞書のキーで読み、`label`・`unit` を getter にして今の言語の文言を返す（使う側は変えない）。
- `src/sim/` は文言を持たない。採点のコメントは `over-pull` などの識別子、簡易版の区切りの向きは `down` などの識別子で返し、言葉にするのは `src/ui/`。
  開発者向けのエラーと出力の文は英語にする（`src/` の文字列リテラルにひらがな・カタカナを置かない、ARC-47）。
- 選んだ言語は `apex-training:language` に `ja`・`en` で SafeStorage を通して保存する（保存できない環境ではページを開いている間だけ残る）。

## 却下した案

- i18next などの国際化のライブラリ: 2 言語・複数形なしには大きく、依存を足すほどの機能を使わない。
- 辞書を JSON にして `?url` で fetch する（2026-11-25-data-json-as-fetched-assets と同じ形）: 読み込みを待つ間は文言のない画面が出て、最初の画面から選んだ言語で出せない。キーの型も付かない。
- 言語ごとに別のビルド・パス（`/apex-training/en/`）: 選び直しで読み込み直しになり、サブパスの配信と保存のキーが言語ごとに分かれる。
- 選び直したら `location.reload()`: 設定画面のほかの欄の値やフォーカスが残らず、UI-126 の「読み込み直さずに」を満たさない。
- 文言を作る関数すべてに翻訳の関数を引数で渡す: 呼び出しの連鎖を広く変え、テストの準備も増える。今の言語を 1 か所に持ち、テストは `setLanguage` で切り替える。

## 影響

- spec/screens.md（表示の言語、UI-125〜UI-134）、spec/overview.md（OVR-28, OVR-29）、spec/modes.md（MODE-57）、spec/architecture.md（ARC-44〜ARC-48）
- src/ui/i18n.ts, src/ui/messages/, src/ui/page-language.ts, index.html, src/main.ts, src/modes/types.ts, src/modes/registry.ts, src/modes/, src/sim/scoring.ts, src/sim/simple-pattern.ts
- tests/architecture/ui-text.test.ts, tests/helpers/ui-text.ts, tests/helpers/browser.ts（newPage の language。既定は ja-JP）
