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

- 複数ボディ(単一ボディのみ対応。2つ目のNew Bodyはエラーになる仕様)
- スケッチ拘束ソルバ(寸法・幾何拘束はなく、数値入力のみ)
- アンドゥ/リドゥ(未実装。フィーチャーツリーでの削除のみ編集手段)
- エッジ/頂点選択(面選択のみ対応。エッジ・頂点をクリックしての参照は不可)

## 追加フェーズ(Phase 6〜8)

Phase 0〜5(上記)の完了後に追加されたフェーズ。

- **Phase 6 – 押し出しAdd操作**: 完了。`ExtrudeFeature.operation` に `"add"` を追加し(New Body / Cut / Add の3択)、モデル層のバリデーションを対応させた。evaluatorにCutと対称なfuse分岐(`body.fuse(tool)`)を実装し、既存ボディが無い状態でのAddはfeatureId付きエラーになる。押し出し編集UI(`ExtrudeEditor`)の操作セレクトに「Add」を追加。Vitestに、面上スケッチ+円でのAdd評価(バウンディングボックス高さが箱20+ボス10=30に増加すること)・ボディ無しAddのエラー・モデル層のoperationバリデーションのテストを追加。E2Eに、上面への円スケッチ→Add(方向+1、距離10)でエラーなく再評価が完了する(ready復帰)シナリオを1本追加。
- **Phase 7 – スケッチ線の可視化**: 完了。evaluate応答に`sketchPlanes`(各スケッチの解決済みorigin/xDir/yDir/normal。押し出しに使われていないスケッチも含む)を追加し、evaluatorが押し出し用Planeの構築と同一の計算(facePlaneRawXDir/facePlaneBasis)を共有することで線と実形状のずれを防いだ。CadViewerがスケッチの矩形・円を3D線(LineLoop、円は64分割)として描画し、選択中スケッチはオレンジ強調+平面グリッド(10mm間隔)を表示する。表示トグル(デフォルトON)をツールバーに追加し、E2Eからの検証用に開発ビルド限定の`window.__cadViewerDebug`フックを設けた。
- **Phase 8 – 2D CAD風線描画スケッチ**: 完了。閉じた頂点列(points、3点以上、隣接重複点なし)を持つ`polygon`エンティティを`model/`に追加した。evaluatorは`draw(points[0]).lineTo(...).close()`(replicadのDrawingPen API)でプロファイルを構築し、既存の複数エンティティfuseパターンに合流させる。CadViewerのスケッチ線オーバーレイにpolygon描画(LineLoop)を追加し、選択中スケッチの線・グリッドは`depthTest:false`+高`renderOrder`で常にソリッドより手前に見えるようにした(Phase 7からの申し送り事項)。「平面に正対」ボタン(OrbitControlsのtarget/カメラ位置設定のみ)を追加した。
  線描画モードはCadViewerが状態を持ち(`startPolygonDrawing`/`cancelPolygonDrawing`等)、選択中スケッチの平面(Workerが返す`sketchPlanes`の基底をそのまま使用)へレイキャストしてクリックごとに頂点を追加する。確定済みセグメント+マウス追従のラバーバンド(破線)をプレビュー表示し、始点付近(スクリーン距離10px以内)のクリックまたはEnterで閉じて確定(3点未満は無視)、Escで頂点列を破棄してモード終了する。1mmグリッドスナップはデフォルトON(チェックボックスでOFF可)。描画モード中は面選択・面ハイライトを無効化し、カーソルをcrosshairにする。E2E検証用に`window.__cadViewerDebug.projectPoint()`(開発ビルド限定)を追加し、現在のカメラでワールド座標をcanvas内ピクセル座標に投影できるようにした。
  SketchEditorパネルにpolygonエンティティの頂点座標を数値編集できるUI(頂点ごとのX/Y入力+削除、3点未満になる削除は無効化)を追加した。頂点追加は描画モード推奨のためUIには持たせていない。
  Vitestに、L字型polygon押し出し(バウンディングボックス40x40x20、体積が矩形40x40x20より小さいこと)・面上スケッチのpolygon+Cut・バリデーション(頂点数不足・隣接重複点)のテストを追加した。E2Eに、新規スケッチ→平面に正対→線描画モードで矩形を4クリック+始点付近クリックで確定→Cut押し出し、までの一気通貫シナリオと、Escキーでの描画中断シナリオの2本を追加した。

## 追加フェーズ2(Phase 9〜11)

Phase 6〜8(上記)の完了後に追加されたフェーズ。スケッチ拘束ソルバ(PlaneGCS等)の本格導入は
**Phase 12候補・後日判断**とし、Phase 9〜11では純幾何的なスナップ・軸ロック・数値駆動編集・
フィレット/面取りといった「ソルバ無しで実現できる2D CAD風の使い勝手向上」に絞る。

- **Phase 9 – スケッチ描画の基礎強化(原点・スナップ・軸ロック)**: 完了。新規依存を追加せず、
  純TS+既存Three.jsのみで実装した。
  - `src/sketch/snapping.ts`(新設、ReactにもThree.jsにも依存しない純粋TS)にスナップ・軸ロック
    エンジンを実装した。`findSnap()`は頂点(vertex)>中心(center)>中点(midpoint)>原点(origin)>
    グリッド(grid)の優先順位で、ローカルmm単位の許容距離内にある候補から最優先・最近傍の1点を
    選ぶ。`applyAxisLock()`は直前の頂点からのベクトルが水平/垂直±5度以内かを判定し、固定側座標を
    直前点に一致させる。`resolveDrawingPoint()`は両者を統合し、軸ロック中は軸上の候補のみを対象に
    する(軸から外れる候補は無視。グリッドスナップも自由座標方向のみ丸め、固定座標は直前点の値を
    保つ)。`collectSketchSnapCandidates()`でスケッチのentities(rectangle/circle/polygon)から
    候補点リストを収集する(rectangleは4頂点+4辺中点、circleは中心のみ、polygonは全頂点+各辺中点)。
    Vitestに優先順位・許容距離境界・軸ロック±5度境界・軸ロックとグリッド/点スナップの統合挙動を
    網羅する25件のテストを追加した(Shift無効化はUI側の関心事のためテスト対象外)。
  - `CadViewer`が選択中スケッチの平面上に原点マーカー(丸+十字、`depthTest:false`で常時可視)と
    X軸(赤系)/Y軸(緑系)の線分(グリッド範囲程度の長さ)を追加表示するようにした。
  - 線描画モードにスナップ・軸ロックエンジンを統合した。クリック/マウス移動のたびに、スクリーンpx
    単位の許容距離(12px)をカメラ〜ヒット点間の距離とカメラの垂直画角から概算でローカルmmへ換算し
    (`pxToMm()`。`2*tan(vFov/2)*distance / canvasHeightPx`で単位距離あたりのmm/px比を求め、
    px×mm/pxで換算する近似)、対象スケッチの既存entities+自身の描画中頂点列+原点を候補に
    `resolveDrawingPoint()`へ渡す。軸ロックが働いた方向には専用色(シアン系)のガイド線を表示する。
    Shift押下中は`event.shiftKey`を見てスナップ・軸ロックを丸ごと無効化する(完全フリー入力)。
    既存の「1mmスナップ」チェックボックスは「スナップ」に改名し、グリッド+点スナップ全体の
    ON/OFFを兼ねる(軸ロックはShift以外では独立して常時有効)。スナップ確定時は種別ごとに形の
    異なるマーカー(頂点=四角、中点=三角、原点=丸+十字、中心=丸、グリッドはマーカー無し)を表示し、
    カーソル付近のHTMLオーバーレイ(`data-testid="drawing-coord-overlay"`)で現在のローカル座標、
    2点目以降は直前点からの長さ・角度(例: `L=25.0mm ∠0°`)をライブ表示する。描画モード中は
    ツールバーにShiftのヒント(`data-testid="drawing-shift-hint"`)を表示する。
  - 実機確認(ブラウザ)で、原点マーカー・軸ロックガイド線・ラバーバンドが同じ`depthTest:false`
    かつ同一`renderOrder`のために描画順が不安定になり、赤いX軸などが動的フィードバックを隠す
    不具合を発見・修正した(動的フィードバック側に専用の`renderOrder`階層を設け、軸ロックガイドも
    `transparent:true`をやめてopaqueキューに統一することで、常に手前に安定して重なるようにした)。
  - `scripts/check-bundle-size.mjs`(新設、Node標準モジュールのみ)を追加し、`npm run size`で
    `dist/assets`配下の各JSのgzipサイズを表示、UIバンドル(`index-*.js`。Workerバンドルの
    `cad.worker-*.js`は対象外)のgzipが350KBを超えたら非ゼロ終了するようにした。WASMは表示のみ
    (閾値なし)。CI(`deploy.yml`のvalidateジョブ)のビルド後に`npm run size`を組み込んだ。
  - E2Eに、線描画モードで原点付近をクリックすると原点(0,0)にスナップする(頂点編集パネルの値で
    検証)シナリオと、水平から3度ずれた位置でクリックした辺が軸ロックにより正確に水平(直前頂点と
    y座標が厳密一致)になるシナリオの2本を追加した(既存9件は無傷)。
- **Phase 10 – 寸法駆動編集(計画中)**: スケッチ上に寸法線(長さ・半径等)を表示し、寸法をクリック
  すると数値入力欄が現れ、確定した数値をもとに決定的なルール(ソルバ不使用。例: 長さ寸法なら
  対象頂点/エンティティを指定方向に平行移動する等、拘束伝播はしない単純な幾何操作)でジオメトリを
  更新する。線描画モード中もキー入力で辺の長さを数値指定できるようにする(Phase 9のライブ座標表示
  `L=...mm ∠...°`の延長として、数値を打ち込んで確定する入力導線を想定)。
- **Phase 11 – 頂点フィレット/面取り(計画中)**: `polygon`エンティティの頂点を選択してフィレット
  (丸め)・面取り(角の斜めカット)を適用できるようにする。replicadの`customCorner`系API
  (`Drawing`/`Sketcher`のcorner操作、例: `customCorner(radius)`や`chamfer`相当)を利用する想定。
  半径・角度をエンティティのパラメータとして`model/`に保持し、evaluatorでの再構築時に反映する。

スケッチ拘束ソルバ(PlaneGCS等による寸法間の連立拘束解決)は**Phase 12候補・後日判断**とする。
Phase 10の「数値入力→決定的ルールでジオメトリ更新」は拘束ソルバとは異なり、単純な直接操作に留める。
