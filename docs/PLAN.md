# light-3dcad 実装計画

ブラウザで動作する単一部品向けの簡易パラメトリックCAD。

## 目的(対応する操作)

1. XY平面に2Dスケッチを作成する
2. 長方形を数値寸法で定義する
3. 閉じた長方形を押し出して3Dソリッドを作成する
4. 生成された平面をクリックして選択する
5. 選択した面を新しいスケッチ平面にする
6. その面に円を配置する
7. 円を使用して押し出しカットを行う
8. 最終形状をSTLとして出力する

## 技術スタック

- React + TypeScript + Vite
- Three.js(表示と面ピックのみ)
- Replicad + opencascade.js(WASM、Web Worker内で実行)
- Zustand(状態管理)
- Vitest(単体テスト)/ Playwright(E2E)
- GitHub Pages(静的配信、バックエンドなし)

## 設計原則

- CAD形状の正本はフィーチャーデータ列(`model/`)とB-Rep形状。Three.jsメッシュは派生表示。
- OpenCascadeの計算はすべてWeb Worker内。UIスレッドでBoolean演算をしない。
- 単位はmm。単一ボディのみ。スケッチ平面はXYと選択した平面面のみ。
- 押し出し操作は New Body と Cut(Addは初期スコープ外)。

## ディレクトリ構成

```
src/
├── app/                 # Reactシェル(レイアウト、ツールバー、ダイアログ)
├── components/          # フィーチャーツリー、寸法入力パネル等のUI部品
├── model/               # 正本。フィーチャーデータの型と操作(純粋TS、依存なし)
├── state/               # Zustandストア(ドキュメント状態+UI状態)
├── worker/              # CADカーネル側(UIから直接importしない)
│   ├── cad.worker.ts    #   Workerエントリ。メッセージディスパッチ
│   └── evaluator.ts     #   フィーチャー列→Replicad形状の逐次評価
├── protocol/            # Worker⇔UIのメッセージ型(両側から共有import)
├── viewer/              # Three.jsシーン、カメラ、Raycasterによる面ピック
└── export/              # STLダウンロード処理
tests/                   # Vitest
e2e/                     # Playwright
```

`model/` と `protocol/` は副作用のない純粋TypeScript。ReplicadのimportはWorker側に閉じ込める。

## 状態管理

Zustandで2層に分離:

- **ドキュメント状態(正本)**: `features: Feature[]`(順序付き配列=履歴)。編集のたびにWorkerへ再評価を依頼。
- **派生・UI状態**: メッシュ+faceGroups、評価中フラグ、エラー、選択面、ツールモード。

Three.jsシーンはReact stateに入れず、ストアをsubscribeして命令的に更新する。

## フィーチャーデータ型(要旨)

```typescript
type PlaneRef =
  | { kind: "world"; plane: "XY" }
  | { kind: "face"; featureId: FeatureId; faceId: number };

type SketchEntity =
  | { kind: "rectangle"; id: string; center: [number, number]; width: number; height: number }
  | { kind: "circle"; id: string; center: [number, number]; radius: number };

type SketchFeature = { type: "sketch"; id: FeatureId; name: string; plane: PlaneRef; entities: SketchEntity[] };
type ExtrudeFeature = {
  type: "extrude"; id: FeatureId; name: string;
  sketchId: FeatureId; distance: number; direction: 1 | -1;
  operation: "newBody" | "cut";
};
type Feature = SketchFeature | ExtrudeFeature;
type CadDocument = { version: 1; features: Feature[] };
```

## Workerメッセージ形式(要旨)

request/response + requestId。大きい配列はTransferableで転送。

- 要求: `init` / `evaluate(doc, quality)` / `exportSTL(doc, tolerance)`
- 応答: `ready` / `evaluated(mesh, faceInfo)` / `stl(blob)` / `error(featureId?, message)` / `progress`
- `mesh` は positions / normals / indices / faceGroups(三角形範囲→B-Rep面ID)/ edges
- `faceInfo` は各面の center / normal / isPlanar(面選択→スケッチ平面化に使用)

## Three.jsメッシュとCAD面の対応付け

1. Replicadの `mesh()` が返す faceGroups を BufferGeometry の group として登録
2. Raycasterの `faceIndex` から faceGroups を検索して faceId を特定
3. ハイライトは該当groupの materialIndex 差し替え
4. faceId + faceInfo(中心・法線)で `PlaneRef` を構築

## 段階的実装計画

各フェーズで `npm run build` + `tsc --noEmit` + 関連テストの通過をゲートとする。

- **Phase 0 – 技術スパイク**: Vite+React+TS雛形、WorkerでReplicad初期化、ハードコード矩形→押し出しをThree.js表示、faceGroups確認、STL出力。
- **Phase 1 – データモデルと状態**: `model/` `protocol/` 実装、Zustand導入、evaluatorのフィーチャー列駆動化、Vitest。
- **Phase 2 – 矩形スケッチUI+押し出し**: 寸法入力、フィーチャーツリー、押し出しダイアログ、編集→再評価の一巡。
- **Phase 3 – 面選択とスケッチ・オン・フェイス**: 面ピック+ハイライト、選択面への円スケッチ、押し出しカット。
- **Phase 4 – STLエクスポートとGitHub Pages**: ダウンロード、`base` 設定、Actionsでdeploy。
- **Phase 5 – E2Eと仕上げ**: Playwright一気通貫シナリオ、エラー表示、ローディングUI。

## Phase 0 合格条件

1. `npm run build` と `tsc --noEmit` が成功
2. WASM初期化がWorker内のみ(UIバンドルにopencascade.js非含有)
3. パラメータ変更→Worker再評価→Three.js表示の一巡
4. 評価中にUIスレッドがブロックされない
5. faceGroupsが取得でき、面クリックでfaceIdを特定できる
6. STL出力が外部ビューアで開ける
7. ビルド成果物の静的配信で上記が成立

## リスクと対策

| リスク | 対策 |
|---|---|
| トポロジカルネーミング問題(面インデックスのずれ) | 評価順を決定的に保ち、再評価時は旧面の中心・法線で幾何マッチング。不一致時はフィーチャーをエラー状態にして再選択を促す。完全解決はスコープ外 |
| WASMサイズによる初回ロード遅延 | 進捗表示、Worker非同期初期化、圧縮配信 |
| Vite+Worker+WASMバンドル設定 | Phase 0で最初に検証 |
| カット失敗等のOCCT例外 | evaluatorをtry/catchし `error` 応答。Worker再起動手段 |
| Pagesサブパス配信でのパス崩れ | Phase 4で静的配信検証をCIに含める |

## スコープ外(初期)

スケッチ拘束ソルバ、Add操作、複数ボディ、エッジ/頂点選択。アンドゥ/リドゥは余裕があればPhase 5で。

## 実装状況

Phase 0〜5すべて完了。

- **Phase 0 – 技術スパイク**: 完了。Vite+React+TS雛形、Worker内Replicad初期化、ハードコード矩形→押し出し表示、STL出力を確認。
- **Phase 1 – データモデルと状態**: 完了。`model/` `protocol/` `state/`(Zustand)を実装し、evaluatorをフィーチャー列駆動化。Vitestで検証。
- **Phase 2 – 矩形スケッチUI+押し出し**: 完了。寸法入力、フィーチャーツリー、押し出し編集UI、編集→再評価の一巡が動作。
- **Phase 3 – 面選択とスケッチ・オン・フェイス**: 完了。面ピック+ハイライト、選択面への円スケッチ、押し出しカット、トポロジカルネーミングの幾何マッチングによる面再解決を実装。
- **Phase 4 – STLエクスポートとGitHub Pages**: 完了。STLダウンロード、`base`のGITHUB_PAGES切り替え、`.github/workflows/deploy.yml`によるビルド検証+Pagesデプロイ。
- **Phase 5 – E2Eと仕上げ**: 完了。
  - `@playwright/test`を導入し`e2e/`にフルフロー(ロード→ready→上面選択→面上スケッチ→円→押し出しカット→STLダウンロード)、パラメトリック再評価(寸法変更後の再評価成功・穴の維持)、エラーと復帰(不正操作でのフィーチャーエラー表示と修正による復帰)の3シナリオ・5テストを実装。全シナリオでpageerror非発生を検証。
  - `playwright.config.ts`で`webServer`による`npm run dev`自動起動、WASM初期化を考慮した長めのタイムアウト(120〜150秒程度)、プリインストール済みChromiumの`executablePath`明示指定(バージョン不一致時のフォールバック)を設定。
  - WASM初期化中(ready前)のローディングオーバーレイ、再評価中インジケータをビューア上に追加。主要なUI要素に`data-testid`を付与(機能ロジックは変更なし)。
  - CI(`deploy.yml`のvalidateジョブ)に`playwright install --with-deps chromium` + `npm run e2e`を追加し、CI実行時のみリトライ(2回)を有効化。

### スコープ外として残った項目(継続)

- Add操作(押し出しの「材料追加」。現状は New Body / Cut のみ)
- 複数ボディ(単一ボディのみ対応。2つ目のNew Bodyはエラーになる仕様)
- スケッチ拘束ソルバ(寸法・幾何拘束はなく、数値入力のみ)
- アンドゥ/リドゥ(未実装。フィーチャーツリーでの削除のみ編集手段)
- エッジ/頂点選択(面選択のみ対応。エッジ・頂点をクリックしての参照は不可)
