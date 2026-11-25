# 向きの音は Web Audio の発振器でその場で合成し、描画のたびに増えた弾の記録の patternShot で鳴らす発を決める

状態: 承認

## 背景

Issue #54 で、簡易版のパターンの区切りの最初の発を撃つたびに、その区切りの補正の向きの音を鳴らす（screens.md「音」）。
音声のファイルは配布物に入れない（UI-84、overview.md「権利」）。発の番号はシミュレーションが撃つときに使う pattern の発で、
戻りの時間がたつ前の押し直しでは続きの番号になる（UI-81）。記録の再生とリザルトの計算し直しでは鳴らさず（UI-80）、
Web Audio が使えない・操作の前でもエラーにしない（UI-83）。トップ画面の試聴は途中で止められる（UI-78, UI-79）。

## 決定

- `src/ui/direction-sound.ts` の `DirectionSound` が `OscillatorNode`（向きごとの高さと波形）と `GainNode`（0.01 秒の上げ下げ）で
  0.12 秒の音を合成する。AudioContext は最初の pointerdown・keydown・click・パッドのボタンの押し下げで作り、
  `running` でないあいだは鳴らさない。例外と拒否された Promise は外に出さない。
- 弾の記録（`ShotRecord`）に `patternShot`（使った pattern の発、1 始まり）を足す。`src/main.ts` は振動と同じく描画のたびに
  増えた弾を `ShotSounds.sync` に渡し、`patternShot` が区切りの `from + 1` の弾で 1 回鳴らす。簡易版は練習の始めに武器から求める。
- 試聴（`SoundPreview`）は区切りごとに `setTimeout` を `from × 発射間隔` で予約し、止める・武器を変える・トップ画面を出る・
  「開始」で残りの予約を消す。
- 音量は共通の区分の `volume`（0〜100 の整数、既定 50）として保存し、音の大きさは `0.3 × volume / 100` にする。

## 却下した案

- 音声のファイル（wav など）を作って配る: 配布物に音声を入れない SPEC に反し、素材の一覧と検査の対象も増える。
- シミュレーションの発射のフックから鳴らす: `src/sim/` が Web Audio に頼ることになり、記録の再生でも鳴る
  （ADR: pad-rumble-from-shot-count と同じ理由）。
- 描画のたびに `gun.nextPatternShot` の変化から発の番号を推し量る: 1 つの描画で戻りの完了・押し直し・複数の発射が重なると
  番号を取り違える。シミュレーションが撃った時点の番号を記録に持たせれば、記録の再生と同じ決まり方になる。
- 試聴を AudioContext の時刻で先にまとめて予約する: 止めたときに予約済みの発振器を探して止める必要があり、
  操作の前（AudioContext がない）だと試験もできない。音の時刻の精度は試聴には `setTimeout` で足りる。

## 影響

- spec/screens.md（音、設定項目、UI-11, UI-13, UI-75〜UI-84）, spec/modes.md（MODE-28, MODE-29）, spec/weapons.md（簡易版のパターン）
- src/ui/direction-sound.ts, src/sim/gun.ts, src/ui/settings.ts, src/ui/settings-form.ts, src/ui/practice-settings.ts, src/ui/pad-menu.ts,
  src/main.ts, index.html, src/ui/style.css
