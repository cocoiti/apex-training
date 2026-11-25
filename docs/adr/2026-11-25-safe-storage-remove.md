# 履歴を消すときはキーを removeItem で消し、SafeStorage はこのページで消したことをメモリに持つ

状態: 承認

## 背景

SPEC（docs/spec/screens.md「履歴の画面」、UI-27）は、「この履歴を消す」で選んでいる組の履歴だけを消し、
再読み込みしても空のままにすることを求める。localStorage の読み書きは SafeStorage を通す
（ADR: 2026-11-25-safe-storage-wrapper）が、SafeStorage には消す操作がなかった。
SafeStorage は書いた値をメモリにも持ち、`get` はこのページで書いた値を優先する。

## 決定

- `SafeStorage.remove(key)` を足し、localStorage の `removeItem` を呼ぶ。例外は投げず、失敗したら「保存できない」にする（`set` と同じ）。
- メモリには消したことを `null` で持ち、`get` はこのページで消したキーに `null` を返す。
  保存できない環境でも、消した履歴が同じページで再び表示されない。
- `clearHistory`（src/ui/practice-history.ts）は組のキーを `remove` で消す。自己ベストのキーには触れない。

## 却下した案

- 空の履歴（`{"version":1,"entries":[]}`）を `set` で書く: 消したあとも中身のないキーが残り続け、組の数だけ localStorage を使う。
- メモリから消すだけにする: localStorage から消せなかったとき、`get` が localStorage の古い値を読み返し、消した履歴が戻って見える。

## 影響

- docs/spec/screens.md（UI-27, UI-28）、docs/spec/scoring.md（練習の履歴）
- src/ui/storage.ts、src/ui/practice-history.ts、src/ui/history-view.ts
