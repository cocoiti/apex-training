# ブラウザで確かめる受け入れ条件は tests/acceptance/README.md の表で 1 ファイルに割り当て、describe を含むテストの名前の ID で照らす

状態: 承認

## 背景

同じ受け入れ条件（SCO-18・UI-24・MODE-23 など）と同じ武器 × モードの組を、複数のブラウザのテストのファイルが
それぞれ実時間で流していた。Issue ごとに足した QA のファイルが前のファイルを確かめ直すためで、`npm run test:browser` の時間の
多くを占めていた。どれがどの条件の持ち主かが書かれておらず、重なりを機械で見つけられなかった
（docs/spec/architecture.md「テストの網羅の分担」、ARC-26・ARC-29）。

## 決定

- `tests/acceptance/README.md` に「受け入れ条件 | SPEC | テストのファイル」の表を置き、1 つの ID を 1 つのファイルに割り当てる。
- テストの名前は、囲む describe の名前とテストの名前をつないだもの（Vitest が表示する名前）とし、ID はそこから読む。
  describe に ID を書いてテストごとに書かない今のファイルを、名前を書き換えずに表に載せられる。
- `tests/architecture/test-coverage.test.ts` が TypeScript の構文木で、表の ID が表のファイルにだけあること、ブラウザのテストの名前の ID が
  すべて表にあること、Chromium の起動が各ファイルの beforeAll に 1 つだけで、ページを使うテストが新しいページを開くことを確かめる
  （`tests/helpers/test-coverage.ts`）。
- 重なっていたテストは表の持ち主に残し、ほかのファイルからは消すか、ID を名前から外す（換算だけを確かめる単体のものなど）。

## 却下した案

- `it` の名前だけを見る: describe にだけ ID を書いた 60 ほどの条件を表に載せるため、多くのテストの名前を書き換えることになる。
- 表を作らず、テストの名前の ID の重なりだけを調べる: どのファイルが持ち主かを決められず、消す側を選べない。
- 表を JSON にしてテストから読む: 人が読む一覧と照らす元が分かれる。README の Markdown の表を行ごとに読めば足りる。

## 影響

- spec/architecture.md（テストの実行、テストの網羅の分担、ARC-26・ARC-29）
- tests/acceptance/README.md, tests/helpers/test-coverage.ts, tests/architecture/test-coverage.test.ts,
  tests/acceptance/measured-weapons-qa.acceptance.test.ts, tests/acceptance/ghost-follow-qa.acceptance.test.ts,
  tests/acceptance/modes.acceptance.test.ts, tests/acceptance/history-qa.acceptance.test.ts, tests/ui/pad-menu-browser.test.ts（削除）
