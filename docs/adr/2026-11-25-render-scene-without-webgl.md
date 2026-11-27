---
status: accepted
domain: architecture
summary: 描画はシーンとカメラ（ViewScene）と WebGL の描画器に分け、FOV の換算は fov.ts の 1 か所で行う
related: [docs/spec/architecture.md, docs/spec/screens.md, src/render/]
---
# 描画はシーンとカメラ（ViewScene）と WebGL の描画器に分け、カメラ・視野角・層をブラウザなしで確かめる

## 背景

ARC-15〜17・UI-8 は「描画したときのカメラの向き・位置・視野角」と「描画の層」を確かめる条件で、
単体テストは Vitest の node 環境で動く。Three.js の `WebGLRenderer` は WebGL の文脈を作れない node では作れない。

## 決定

- `src/render/scene.ts` を、シーン・カメラ・層を持つ `ViewScene`（WebGL に依存しない）と、
  それをキャンバスに描く `SceneRenderer`（`WebGLRenderer` を持つ）に分ける。
- カメラの位置と向きの反映（`update`）、FOV と縦横比からの視野角（`setFov`・`setAspect`）、層（`layer`）は `ViewScene` に置き、
  テストは `ViewScene` を直接作ってカメラの方向ベクトル・`fov`・シーンの中身を確かめる。
- FOV の値から視野角への換算は `src/render/fov.ts` の `fieldOfView` の 1 か所で行い、カメラの縦の視野角と
  画面上の位置への換算（`projectAngleOffset`）の両方がこれを使う。Three.js を参照しないので、将来のリザルトの散布図からも使える。
- 層は `DisplayLayer`（`THREE.Group` を 1 つ持つ）で、シーンに一度だけ足す。足し引きは描画のオブジェクトだけを変え、World に触れない。

## 却下した案

- `WebGLRenderer` を差し替え可能にしてテストで偽物を渡す: 描画器の型に合わせた偽物が要り、確かめたいのはカメラなので遠回り。
- jsdom と WebGL の偽装（headless-gl など）を入れる: 依存が増え、ネイティブのビルドが要る。
- カメラの確認をブラウザの受け入れテスト（画素の色）だけで行う: 遅く、向きの符号の誤りを細かく切り分けられない。
  画面の中心に的が見えること（UI-6）はブラウザの確認にも残す。

## 影響

- docs/spec/architecture.md（ARC-15, ARC-16, ARC-17）、docs/spec/screens.md（UI-5, UI-7, UI-8）
- src/render/scene.ts, src/render/fov.ts, src/render/layer.ts
