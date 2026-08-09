# サードパーティ ソフトウェア表示 (Third-Party Notices)

light-3dcad は本体を MIT License で公開していますが、以下のサードパーティ製ライブラリを利用しています。
各ライブラリのライセンス条文は `node_modules/<package>/LICENSE`(npm install 後)、または各プロジェクトの
リポジトリで確認できます。本ファイルの内容は `package.json` の `dependencies` および実際に
`node_modules/*/LICENSE` を確認して作成しています。

## 実行時依存 (dependencies)

### three (three.js)
- バージョン: 0.185.1
- ライセンス: MIT
- リポジトリ: https://github.com/mrdoob/three.js
- 用途: 3Dビューア表示・面/エッジのRaycastピック(表示専用。CAD演算は行わない)

### react / react-dom
- バージョン: 19.2.8
- ライセンス: MIT
- リポジトリ: https://github.com/react/react.git (`packages/react`, `packages/react-dom`)
- 用途: UIフレームワーク

### zustand
- バージョン: 5.0.14
- ライセンス: MIT
- リポジトリ: https://github.com/pmndrs/zustand
- 用途: ドキュメント状態・UI状態管理

### @anthropic-ai/sdk
- バージョン: 0.116.0
- ライセンス: MIT
- リポジトリ: https://github.com/anthropics/anthropic-sdk-typescript
- 用途: AIモデル生成機能でのAnthropic API呼び出し(BYOK、動的importでメインバンドルから分離)

### openai
- バージョン: 7.4.0
- ライセンス: Apache License 2.0
- リポジトリ: https://github.com/openai/openai-node
- 用途: AIモデル生成機能でのOpenAI API呼び出し(BYOK、動的importでメインバンドルから分離)
- 備考: Apache-2.0のため、`NOTICE`ファイルが同梱されている場合はその内容も引き継がれます。
  本パッケージには2026年8月時点でNOTICEファイルの同梱はありません(`node_modules/openai`直下を確認)。

### replicad
- バージョン: 0.23.1
- ライセンス: MIT
- リポジトリ: https://github.com/sgenoud/replicad
- 用途: B-Rep形状のパラメトリック生成・ブーリアン演算等を行うTypeScript API層(下記
  replicad-opencascadejs 経由でOpenCascade Technologyを呼び出す)

### replicad-opencascadejs (LGPL-2.1 由来のWASMを含む — 要注意)
- バージョン: 0.23.0
- npmパッケージ自体のライセンス: MIT (`node_modules/replicad-opencascadejs/LICENSE`、Copyright QuaroTech Sàrl)
- リポジトリ(ビルドツール): https://github.com/donalffons/opencascade.js
- **重要**: このnpmパッケージが同梱するWebAssemblyバイナリ(`replicad_single.wasm` /
  `replicad_with_exceptions.wasm`)は、[OpenCascade Technology (OCCT)](https://dev.opencascade.org/)を
  [opencascade.js](https://github.com/donalffons/opencascade.js)でWebAssemblyへビルドしたものです。
  OCCTは **GNU Lesser General Public License v2.1 (LGPL-2.1)**(Open CASCADE Technology Public
  License例外付き)で配布されています。本リポジトリはこのWASMバイナリを**改変せず**、npm経由で
  取得したものをそのまま `src/worker/cad.worker.ts` から動的import(Web Worker内、UIスレッドとは
  分離)して利用しています。ソースの入手方法: OCCT自体のソースは
  https://dev.opencascade.org/ (公式) または https://github.com/Open-Cascade-SAS/OCCT から、
  WASMへのビルド手順・バインディングのソースは https://github.com/donalffons/opencascade.js から
  それぞれ入手できます。LGPL-2.1はリンク(動的呼び出し)する側のアプリケーションに同じライセンスを
  適用することを要求しないため、本体のMITライセンスとは独立して扱っています。

### @salusoft89/planegcs (LGPL-2.1-or-later — 要注意)
- バージョン: 1.2.0
- ライセンス: **LGPL-2.1-or-later**(`node_modules/@salusoft89/planegcs/LICENSE`の同梱テキストは
  GNU Lesser General Public License Version 2.1。`package.json`の`license`フィールドは
  `LGPL-2.0-or-later`と表記されていますが、同梱ライセンス文書はv2.1であるため、本表示ではv2.1系列
  として扱います)
- リポジトリ: https://github.com/Salusoft89/planegcs
- 由来: [FreeCAD](https://github.com/FreeCAD/FreeCAD)のSketcherモジュールが使う2D幾何拘束ソルバ
  `planegcs`(C++)をWebAssemblyへ移植したものです。
- **重要**: 本リポジトリはこのWASMバイナリ(`planegcs.wasm`)を**改変せず**、npm経由で取得したものを
  そのまま `src/sketch/gcsAdapter.ts` から動的import(メインバンドルとは別チャンク)して利用して
  います。ソースは上記リポジトリ https://github.com/Salusoft89/planegcs から入手できます(FreeCAD側の
  原実装は https://github.com/FreeCAD/FreeCAD/tree/main/src/Mod/Sketcher/App/planegcs )。LGPL-2.1は
  リンクする側のアプリケーションに同じライセンスを適用することを要求しないため、本体のMIT
  ライセンスとは独立して扱っています。

## LGPLコンポーネントに関する補足

上記の通り、本リポジトリは OpenCascade Technology (replicad-opencascadejs 経由) と planegcs
(@salusoft89/planegcs) という2つのLGPL-2.1系コンポーネントをWebAssemblyの形で利用しています。
いずれも:

1. npm packageとして配布されているバイナリを**無改変**で使用しています(独自パッチ・フォークは
   行っていません)。
2. アプリケーションのメインバンドルには含めず、**動的import**により機能が実際に必要になった時点
   (3D形状評価 / スケッチ拘束解決)でのみ別チャンクとして読み込みます。
3. ユーザーは上記リポジトリURLから、利用しているバージョンに対応するソースを自身で入手・再ビルド
   できます(いずれも公開リポジトリであり、取得に制限はありません)。
4. LGPL-2.1は動的リンク(本リポジトリのようにWASMモジュールとして分離importする形態を含む)を
   行うアプリケーション本体に対して同一ライセンスの適用を要求しないため、本リポジトリ本体は
   MIT Licenseのまま配布しています。

## 開発時依存 (devDependencies、参考)

ビルド・テストにのみ使用し、配布物には含まれない(または配布物のロジックに影響しない)ツール類です。
参考として記載します。

| パッケージ | ライセンス |
| --- | --- |
| typescript | Apache-2.0 |
| vite | MIT |
| vitest | MIT |
| @playwright/test | Apache-2.0 |
| oxlint | MIT |
| @vitejs/plugin-react | MIT |
| @types/* (node, react, react-dom, three) | MIT |

---

本ファイルの記載に誤りや更新漏れを見つけた場合は、Issue または Pull Requestでご指摘ください。
依存関係を追加・更新した際は、`package.json`の変更とあわせて本ファイルの更新もお願いします。
