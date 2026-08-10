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
- **Phase 10 – 寸法駆動編集**: 完了。新規依存を追加せず、純TS+既存Three.js+HTMLオーバーレイのみで
  実装した。拘束ソルバは使わず、決定的な更新ルールのみでジオメトリを更新する。
  - `src/sketch/dimensions.ts`(新設、ReactにもThree.jsにも依存しない純粋TS)に寸法編集ロジックを
    実装した。`edgeLength()`/`edgeAngle()`はpolygonの辺(`points[i] -> points[(i+1)%length]`、
    最後の頂点から最初の頂点へ戻る辺も含む)の長さ・水平からの角度(0〜360度)を計算する。
    `applyEdgeLength()`/`applyEdgeAngle()`は**辺の始点を固定したまま終点(次頂点)のみを移動する**
    (長さ変更は方向を保って終点を伸縮、角度変更は長さを保って始点周りに終点を回転)。後続の頂点は
    一切動かさず、拘束伝播はしない。数学的に、この2関数は同じベクトルの極座標表現(長さ・角度)を
    独立に更新するだけなので、両方を続けて適用する場合は順序に依存せず最終結果が一致する
    (長さ→角度でも角度→長さでも同じ)。長さ・角度ともNaN/Infinity/0以下(長さ)は`RangeError`。
    始点と終点が一致する退化辺には適用不可。矩形の幅・高さ、円の半径は既存モデルの直接値のため
    専用関数は設けず、UIから`updateSketchEntity()`で直接更新する(中心固定のまま伸縮)。
    `computeSketchDimensions()`はスケッチのentities(rectangle/circle/polygon)から、表示すべき
    寸法(種別・値・ラベルのアンカー座標)の一覧を作る純粋関数。polygonは各辺の中点から多角形の
    重心と反対側(外向き)にオフセットした位置にラベルを置く。rectangleは上辺中点付近(幅)・
    右辺中点付近(高さ)、circleは中心付近(半径)。`formatDimensionLabel()`が表示テキスト
    (例: `25.0` / `R10.0` / `W20.0` / `H15.0`)を、`dimensionKey()`がdata-testid等に使う一意な
    キー(polygon辺は`<entityId>-<edgeIndex>`、それ以外は`-r`/`-w`/`-h`接尾辞)を返す。Vitestに
    24件のテスト(長さ/角度計算、境界・退化辺・NaN/Infinityのバリデーション、非破壊性、
    適用順序に依存しないことの確認、寸法一覧の集計、ラベル文言)を追加した。
  - 寸法ラベルの表示は`src/components/DimensionOverlay.tsx`(新設)がHTMLオーバーレイとして行う。
    選択中スケッチのentitiesから`computeSketchDimensions()`で寸法一覧を作り、各ラベル(ピル型の
    `<button>`、data-testid`dim-label-<key>`)をReactでレンダリングする。**画面座標の更新は
    Reactの再レンダリングを介さず**、`CadViewer`に追加した`onFrame()`(毎フレーム、render後に
    呼ばれるコールバック登録)で`CadViewer.localToWorld()`→`projectPoint()`によりワールド座標→
    canvas内ピクセル座標を求め、ラベルDOM要素の`style.left/top`を直接書き換える(既存の描画モード
    ライブ座標オーバーレイと同じ命令的DOM操作の方針)。ラベル数はスケッチ1枚あたり高々数十件程度、
    `projectPoint()`はベクトル演算のみで新規オブジェクト割り当ても最小限のため、毎フレーム実行して
    もコストは無視できる(orbit操作中もカクつきなく追従することを実機確認済み)。表示は「スケッチ
    表示」トグルに従い、線描画モード中は非表示にする(`visible`propで制御。非表示中も`onFrame`
    購読自体は維持し、ラベル要素が無ければ何もしないだけなので低コスト)。
    ラベルクリックで種別に応じた編集ポップアップ(`dim-edit-popup`、HTMLフォーム、ラベル直下に
    絶対配置)を開く。polygon辺は長さ・角度の2フィールド、円は半径、矩形は幅または高さの1
    フィールド。ヒントとして「始点(頂点)を固定し、終点のみを移動します」等の適用ルールを一行
    表示する。Enter(またはフォームのsubmit)で適用し`updateDocument()`経由で再評価、Escapeは
    入力ポップアップを閉じるのみ(`stopPropagation()`でCadViewer側のwindowキー入力へは伝播させ
    ない)。バリデーションエラー(0以下・非数値)はポップアップ内にインライン表示する。
  - 線描画モードに数値長さ入力を追加した(Phase 9のライブ座標表示`L=...mm ∠...°`の延長)。
    頂点を1つ以上打った状態で数字/ピリオドキーを押すと`drawing-length-input`オーバーレイが現れ、
    入力中の文字列を表示する。Enterで、直前頂点から**直近のマウス移動で解決した(スナップ・軸
    ロック適用後の)カーソル方向**へ、入力した長さぶん進めた頂点を確定する(方向は毎回の
    `mousemove`で`lastHoverLocal`として保持し、Enter時点の最新値を使うため、数字入力後にマウスを
    動かせば方向も追従する)。Backspaceで1文字削除、入力欄が開いている間のEscapeは**入力のみを
    取消し**(既存の「Escで描画中断」とは衝突しないよう分離)、マウスクリックでの頂点確定は未確定
    の入力中文字列を破棄する。方向ベクトルの長さが0(マウス未移動等)の場合はEnterを無視する。
  - E2Eに2本追加(既存11件は無傷、計13件)。①線描画モードで20mm四方の多角形を描き、下辺(辺0、
    水平)の寸法ラベルをクリックして長さのみ50に変更、始点(頂点0)が不変で終点(頂点1)のみ
    水平方向に50mm先へ再計算され、後続の頂点(頂点2)が変更されないことを頂点編集パネルの値で
    検証。②線描画モード中に原点付近クリック→水平方向へのマウス移動(軸ロック範囲内)→数字キー
    「30」+Enterで、直前頂点(0,0)から厳密に水平方向へ30mm先の頂点が確定することを検証。
  - 実機確認(ブラウザ、`npm run dev`+プリインストールChromiumをPlaywright経由で操作)で、
    寸法ラベルの表示・クリックでの編集ポップアップ表示・長さ変更後のラベル/形状の再描画・
    描画モード中の数値長さ入力オーバーレイの表示、をスクリーンショットで確認した。
- **Phase 11 – 頂点フィレット/面取り**: 完了。新規依存を追加せず実装した。
  - **ミニスパイク結果**: replicadの`DrawingPen`は`customCorner(radius, mode?)`
    (`mode`は`"fillet" | "chamfer" | "dogbone"`、既定`"fillet"`)を持ち、「直前に描いた曲線」と
    「次に描く曲線」の間のコーナーに**遅延適用**される(呼んだ時点では確定せず、次の
    `lineTo()`/`close()`でその頂点のコーナーとして実際に処理される。実装は`pendingCurves`への
    `saveCurve()`内で処理)。そのため`points[i]`(i≥1)にコーナーを付けるには、`lineTo(points[i])`の
    直後・次の`lineTo()`より前に`customCorner()`を呼ぶ。
    **頂点0(始点)は`closeWithCustomCorner(radius, mode?)`という専用APIで対応可能**と判明した
    (`_closeSketch()`で閉じた後、`_customCornerLastWithFirst()`が`pendingCurves`の先頭(始点からの
    最初の辺)と末尾(閉じる辺)を取り出してコーナー処理する実装)。これにより
    **頂点シフト等の回避策は一切不要**で、全頂点(頂点0を含む)にフィレット/面取りを適用できる
    ことをVitestの一時スパイクテスト(40×40正方形、90度コーナーでの面積減少量が
    `r²(1-π/4)`(フィレット)・`r²/2`(面取り)と一致することを実測)で確認した(スパイク自体は
    検証後に削除し、結論を本実装・恒久テストに反映した)。
  - `model/types.ts`の`polygon`エンティティに`corners?: PolygonCorner[]`
    (`PolygonCorner = null | { kind: "fillet" | "chamfer"; size: number }`、`corners[i]`が
    `points[i]`に対応)を追加した。省略可能で既存データと後方互換。`model/validation.ts`に
    `validatePolygonCorners()`(size>0、kindの妥当性、および「sizeが隣接2辺の短い方の長さの
    1/2を超える場合」の粗い事前チェック、をpolygon単位で検証する純粋関数)を追加し、
    `document.ts`に頂点1つ分のコーナーを設定/解除する`setPolygonVertexCorner()`を追加した。
  - `worker/evaluator.ts`の`polygonDrawing()`をスパイク結果通りに実装した(`lineTo()`直後に
    該当頂点のコーナーがあれば`customCorner(size, kind)`を呼び、頂点0は
    `closeWithCustomCorner(size, kind)`で閉じる)。さらに、実際のプロファイル構築(OCCT到達)
    より前に`validatePolygonCorners()`を使った事前チェックを`evaluateDocument()`のsketch処理時に
    組み込み、コーナーサイズが隣接辺に対して大きすぎる場合はfeatureId付きのわかりやすい
    エラーで早期に弾く(自己交差等の厳密な破綻判定は引き続きOCCTの例外→既存のfeatureId付き
    エラー経路に委ねる)。
  - `src/sketch/polygonOutline.ts`(新設、React/Three非依存の純粋TS)に、evaluatorが実際に
    構築するB-Rep形状と同じ幾何(接点・円弧中心・掃引角)を計算する`computeCornerGeometry()`/
    `polygonOutlinePoints()`を実装した。退化判定(前後の辺がほぼ平行)は、replicadの
    `removeCorner()`と同じ外積閾値(1e-10)を使うことで、evaluatorがコーナー処理をスキップする
    ケースとオーバーレイの描画結果を一致させている。`CadViewer`のpolygon描画をこの関数の
    出力(円弧はポリライン近似)に置き換え、選択スケッチの線(オレンジ強調)が3D形状の
    丸め・面取りと視覚的に一致するようにした(`npm run dev`+プリインストールChromiumでの
    実機確認済み。スクリーンショットでオーバーレイの丸められた輪郭と、Cut後の3D形状の
    丸め穴が正確に重なることを確認した)。
  - `SketchEditor`のpolygon頂点編集UI(`PolygonVertexEditor`)に、頂点ごとの「コーナー:
    なし/フィレット/面取り」セレクト(`entity-polygon-<i>-vertex-<j>-corner-kind`)とサイズ入力
    (`entity-polygon-<i>-vertex-<j>-corner-size`、コーナー未設定時は無効化)を追加した。
    頂点削除時は`corners`配列もインデックスを詰めて追従させる。**ビューア上でのクリックによる
    コーナー編集ポップアップは今回は省略した**(パネル編集のみ。時間対効果の観点から見送り。
    DimensionOverlayと同様の方式で将来追加は可能)。
  - Vitestに、`polygonOutlinePoints`の幾何テスト(直角コーナーの接点位置・弧の開始終了角・
    面取り長・退化ケース・頂点0の回帰テスト、10件)、evaluator統合テスト(40×40正方形の
    4頂点フィレット/面取りでの体積減少の概算検証、頂点0のみのフィレット回帰テスト、
    コーナーサイズ過大時の事前バリデーションエラー、既存のL字ポリゴン等に影響がないこと)、
    model層のバリデーション・`setPolygonVertexCorner()`のテストを追加した(Vitest合計125件)。
    E2Eに、線描画モードで多角形を描いた後に頂点へフィレットを設定して再評価が成功する
    シナリオを1本追加した(既存13件は無傷、計14件)。

スケッチ拘束ソルバ(PlaneGCS等による寸法間の連立拘束解決)は**Phase 12候補・後日判断**とする。
Phase 10の「数値入力→決定的ルールでジオメトリ更新」は拘束ソルバとは異なり、単純な直接操作に留める。

## Phase 12: 表示の立て直し(SolidWorks風シェーディング+エッジ)完了

`CadViewer`にエッジ線描画(`mesh.edges`をLineSegmentsで表示、ソリッド側にpolygonOffset)、
Hemisphere+キー+フィルライトの3灯構成、明るいグレー系ボディ色、面ホバーハイライト、
`fitToView()`(初回メッシュ受信時に自動実行・以降は視点維持)を追加した。ツールバーに
「フィット」ボタンを追加。Vitest125件は無傷。

## Phase 13: 空ドキュメント状態と基準平面完了

ボディなし(押し出し0件)を`shape:null`の正常応答として扱うようevaluatorを変更(ビューアは
古いメッシュを消去)、world平面をXY/XZ/YZに拡張しボディなし時は60x60mm半透明の基準平面3枚を
クリック選択可能に表示、押し出し追加のデフォルトoperationはボディ有無でnewBody/addを自動切替。
既存E2Eの一部(operationデフォルト変更に伴うエラー発生タイミング)を修正。Vitest127件。

## Phase 14: クリック作図ツール(矩形・円)+簡易アンドゥ/リドゥ完了

`CadViewer`の線描画モードを一般化し、ツールバーの「矩形」「円」ボタンから2クリック(コーナー1→
コーナー2、中心→半径)で`rectangle`/`circle`エンティティを作図できるようにした(既存スナップ・
グリッドスナップ・Escキャンセルを流用、幅×高さ/半径のライブ表示付き)。ストアに`CadDocument`の
JSON構造コピーによる履歴(上限50件)を追加し、`updateDocument`のたびにpush、Ctrl+Z/Ctrl+Shift+Z
とツールバーの「元に戻す/やり直す」ボタンでアンドゥ/リドゥ可能にした(選択状態は解除のみ)。
Vitest138件(履歴・2点→矩形/円変換の新規11件)。

## Phase 15: スケッチ内の入れ子プロファイル→穴(差分)押し出し完了

`src/sketch/containment.ts`を新設し、頂点ベースの点in多角形/点in円判定で同一スケッチ内の
エンティティを「外枠(outers)」「穴(holes、他のいずれかに完全包含)」の2階層に分類する関数
`classifySketchEntities`を追加(3階層以上の入れ子は既知の制限としてholeのまま扱う)。
`evaluator.ts`の`buildDrawing`をこの分類に基づき「外枠同士をfuse→穴をまとめてcut」する構成に変更
(部分交差する図形は従来どおりfuse)。Vitest149件(包含判定単体6件+分類3件+矩形内円/ドーナツの
体積検証2件が新規)。

## Phase 16: 標準ビュー切替(SolidWorks風)完了

`src/viewer/standardViews.ts`(純TS、three.js非依存)に正面/背面/左/右/上/下/等角のカメラ方向・up
ベクトル定義を新設し、`CadViewer.setStandardView()`で現在のメッシュ(無ければ原点)を注視点に
フィット距離でカメラを配置するようにした。ツールバーに短いテキストの7ボタン(正面/背面/左/右/上/
下/等角)を追加。Vitest153件(方向計算の新規4件)。

## Phase 18: スケッチフィレット/面取りの専用ツール化完了

`CadViewer`に`startCornerTool()`/`cancelCornerTool()`を追加。ツールバーの「フィレット」「面取り」
ボタンでモードに入り、サイズ入力欄(デフォルト5mm)を出しつつビューア上でpolygon頂点付近
(スクリーン距離10px以内、既存の`projectPoint`を流用)をクリックすると、既存の
`setPolygonVertexCorner`でcornersデータを更新する(同種コーナー適用済みならトグルで解除)。
連続クリック可・Escで終了。SketchEditorの既存頂点コーナーUIはそのまま残した。

## Phase 17: 円弧・スロット・正多角形完了

`slot`(直線+半円キャップ2つ)・`regularPolygon`(外接円半径・辺数・回転)エンティティを追加し、
polygonに辺ごとのふくらみ`bulges`(bulge=tan(挟角/4)、DXF互換の定義)を追加した。新設
`src/sketch/bulge.ts`がreplicadの`DrawingPen#bulgeArcTo(end, bulge)`(node_modules/replicad内の
`sagittaArcTo`実装)と同じ経由点計算を再実装し、円弧のポリライン近似(オーバーレイ)と実際の
B-Rep形状を一致させる。スロットの半円キャップはbulge=-1(半円)、evaluator/オーバーレイ両方が
同じ`bulgeArcTo`/`bulgeArcPoints`を使う。ツールバーに「スロット」(幅入力欄)「正多角形」
(辺数入力欄)ボタン(2クリック作図)、線描画モードに「円弧(A)」トグル(次セグメントを3点円弧に)
を追加。corners(フィレット/面取り)とbulgeが同じ頂点で衝突する場合はcorners優先でbulge無視
(`effectivePolygonBulges`)。containmentは頂点ベース近似のまま(slot/regularPolygonは代表点、
bulgeの膨らみは無視、既知の制限)。Vitest167件(bulge幾何6件・スロット/正多角形頂点3件・
polygon bulge輪郭2件・スロット/正多角形/bulge押し出し体積3件が新規)。

## Phase 19a: セグメントベーススケッチの幾何コア完了

`SketchFeature`に自由な線分・円弧の集まり`segments`(`SketchSegment[]`、既存`entities`とは
独立・後方互換)を追加した。新設`src/sketch/intersections.ts`が線分/円弧の交点計算
(`lineLineIntersection`/`lineArcIntersection`/`arcArcIntersection`、円弧は`bulge.ts`の
`arcGeometryFromBulge`で中心・半径・角度範囲に変換、EPS=1e-6mm、平行/同一線上/同心円の
重なり区間・接する場合の単一交点等の境界ケースに対応)と`splitSegmentAt`(円弧はbulge再計算)
を提供する。新設`src/sketch/regions.ts`の`findClosedRegions()`が本フェーズの核心: 全セグメント
対の交点でハーフエッジグラフを構築し、「twinの角度順で1つ前」を次辺とする標準的な面巡回規則
(円弧は端点接線方向)ですべてのハーフエッジを閉ループへ分解、符号付き面積(円弧はGreen's
theoremの扇形補正項)で有界面を判別し、隣接twin対のスタック除去でぶら下がり枝の往復を除去、
包含深度の偶奇ルールで外枠(反時計回り)/穴(時計回り)を`Region[]`に分類する。
`evaluator.ts`はsegments保有スケッチで`findClosedRegions`を実行し各Regionを
`draw().lineTo/bulgeArcTo().close()`でDrawing化してentities由来のDrawingとfuseする
(segments指定で閉領域0件なら「閉じた領域がありません」のフィーチャーエラー)。
`CadViewer`のスケッチ線オーバーレイにsegments描画(開いたLine、円弧はbulgeArcPoints近似)を
追加した(ツール変更なし、UI/トリムは19bで対応)。Vitest202件(交点計算21件・閉領域検出9件
[矩形/穴あき/交差2矩形→3領域/開いた線分0件/半円+直線/ぶら下がり枝2種/円弧のみループ]・
evaluator統合5件が新規)。

## Phase 19b: トリムツールとセグメント作図UI完了

ツールバーに「線分」ボタン(自由な線分・円弧チェーン作図、`CadViewer.startSegmentDrawing`)を追加した。
既存の「線描画」(polygon、閉多角形専用)は「多角形」に改名して残し、フィレット/面取りツールの対象として
維持した。線分ツールはクリックで頂点を連結し、Enter/始点付近クリック/ダブルクリックのいずれでも
(3点未満でも)チェーンを確定できる点がpolygonと異なる(確定時にpoints/bulgesから`createLineSegment`/
`createArcSegment`でsegmentsを組み立てる)。既存のスナップ・軸ロック・グリッド・数値長さ入力・円弧
セグメント(Aキー)をそのまま流用し、`collectSegmentSnapCandidates`(新設、snapping.ts)でセグメント
端点もスナップ候補にした。新設`src/sketch/trim.ts`の`trimSegmentAtPoint`(他segmentsとの交点で
`splitSegmentAt`した区間のうち、クリック位置に最も近い1区間を削除。区間が1つ(=交点なし)ならセグメント
全体を削除)を使うトリムツール(`CadViewer.startTrimTool`)を追加し、ホバー中の削除候補区間を
赤色プレビュー表示する。新設`src/sketch/explode.ts`の`explodeEntity`(rectangle→4line、circle→半円
arc×2、slot→2line+2arc、regularPolygon→line列、polygon→`computeCornerGeometry`/`effectivePolygonBulges`
を再利用した正確なarc/line、フィレット/面取り込み)でSketchEditorに各エンティティの「分解」ボタンを
追加し、分解後はトリム可能になる。SketchEditorにセグメント件数表示+「全削除」を追加した。
Vitest210件(トリム5件・分解3件が新規)。ブラウザ確認: 線分ツールで十字の交差線を描く→トリムで
右腕の交点より先を削除(赤プレビュー→クリックで実削除、残り半分は保持)→別の場所で線分ツールの
始点付近クリックによる閉チェーンで正方形を作図→押し出しが成功、を確認した。

## Phase 20a: スケッチ拘束ソルバコア(純TS)完了

寸法ドリブン編集(Phase 20b)の土台。`SketchFeature`に`SketchConstraint`(coincident/horizontal/
vertical/length/distance/radius/fix、後方互換の追加フィールド)を追加し、新設`src/sketch/solver.ts`の
`solveSketch()`が自前実装のLevenberg-Marquardt法(外部ライブラリ非依存、ヤコビアンは解析的)で
拘束残差二乗和を最小化する。全セグメント端点座標を独立変数とし(coincidentはマージせず残差で表現)、
劣拘束自由度は「初期位置からの移動量への弱い正則化」で入力形状に最も近い解を選ぶ「暖機」段階と、
正則化を外して拘束残差のみを追い込む「仕上げ」段階の2段階で解く(単一段階の重み付き最小二乗では
正則化由来の恒常的バイアスが許容誤差1e-4mmを超えることを実装検証で確認したため)。矛盾(過拘束)は
`conflicting:true`で返す。新設`src/sketch/autoConstraints.ts`が線分ツール確定時の自動拘束(連続辺の
coincident・軸ロック確定辺のhorizontal/vertical・既存セグメントへのスナップ接続のcoincident)を
組み立て、`App.tsx`の線分ツール確定経路から`addSketchSegments`のconstraints引数へ渡す(UIの見た目は
変更なし)。`store.ts`の`updateDocument`はWorker評価に回す前に`solveDocumentSketches()`でsegmentsを
解いた状態に置き換え、矛盾があれば評価をスキップしてfeatureId付きエラーを表示する。
Vitest243件(ソルバ17件[長さ/水平/垂直/coincident伝播/矩形4辺リサイズ/矛盾検出2種/distance/radius/
正則化不動/T字接合/恒等変換/空配列/fix/円弧属性保持/solveDocumentSketches2件]・自動拘束9件・
拘束バリデーション5件・addSketchSegments2件が新規)。20bへの申し送り: 拘束の追加・編集UI(SketchEditor
への拘束一覧・寸法入力パネル)、既存entities(rectangle/circle等)を拘束対象にする場合はsegments化
(分解)が前提になる点、ビューア上での拘束アイコン表示は未着手。

## Phase 20b: 寸法ドリブン編集UI完了

新設`src/sketch/constraintDimensions.ts`(純TS)に、寸法ツール・寸法ラベル編集が使う拘束の
作成/更新(`upsertLengthConstraint`/`upsertRadiusConstraint`/`upsertDistanceConstraint`、既存の
同一対象への拘束があれば値だけ差し替え)・削除(`removeConstraint`)・常時表示する拘束寸法一覧
(`computeConstraintDimensions`、length=中点/radius=弧の中央外側/distance=2点の中間)を実装した。
`CadViewer`に`startDimensionTool()`を追加し、ツールバーの「寸法」ボタンでモードに入る。クリックは
まず全segmentsの端点をスクリーン距離10px以内で優先ヒット判定し(2つ順にクリックでdistance拘束)、
無ければセグメント本体をヒット判定する(line→length、arc→radius拘束)。ヒット対象確定時は
`DimensionToolPopup`(新設、現在値をデフォルトにした単一フィールドの数値ポップアップ)で値を入力する。
`DimensionOverlay`に、選択中スケッチのlength/distance/radius拘束から常時表示する寸法ラベルを追加した
(黒背景・白太字の強調スタイルで実測ラベル=オレンジと区別、クリックで同じポップアップを開いて編集)。
`SketchEditor`に拘束一覧パネルを追加し、種類(一致/水平/垂直/長さ/距離/半径/固定)・対象(セグメント
番号・端点)・値を1行で表示、削除ボタンで個別に取り消せる(値なし拘束も表示・削除可能)。
新設`src/state/constraintUpdate.ts`の`updateDocumentWithConflictRollback()`が、拘束の追加・更新を
伴う`updateDocument()`呼び出しを共通ラップし、結果が対象sketchIdの矛盾エラーになった場合は
変更前のドキュメントへ即座に復元する(アンドゥ履歴は使わず「適用前ドキュメントを保持して復元」する
方式のため、選択状態やツールのアクティブ状態は保たれる)。復元時は「拘束が矛盾するため取り消しました」
の一時トースト(3秒で自動的に消える)を表示する。Vitest252件(拘束作成/更新ヘルパー・現在値計算・
寸法一覧構築の9件が新規)。ブラウザ確認(`npm run dev`+プリインストールChromiumをPlaywright経由で
操作、`window.__debugStore`は確認専用の一時フックでコミット前に削除済み)で、線分ツールでの矩形
(L字相当の閉チェーン)作図→寸法ツールで下辺をクリック→デフォルト値40.00が表示されること→50mm
指定で形状が実際に伸びる(セグメント端点座標が変化しlength=50を満たす)こと→拘束一覧パネルに
「一致」「長さ」等が表示されること→同じ2点にlengthと矛盾するdistance(5mm)を追加すると
「拘束が矛盾するため取り消しました」のトーストとともに直前の変更が自動的に取り消される(拘束配列が
矛盾操作前と完全一致)こと、をスクリーンショット・DOM検証の両方で確認した。

## Phase 21: 実機テストの不具合修正(進行中)

項目1(最優先バグ)を修正。根本原因は2つ重なっていた: (1) `src/sketch/containment.ts`の包含判定が
「境界にちょうど接する(タンジェント)」図形を微小マージン(CONTAINMENT_EPS)で「含まれない」と
誤判定していた(例: 幅20の矩形の中心に半径10の円=SketchEditorの「矩形/円を数値で追加」の
既定値そのもの、辺の中点にちょうど接する)。修正: `isContained(inner,outer)`を「非厳密(境界接触を
含む)包含テストを両方向で行い、両方向とも真=同一形状の場合にのみ含まれないとする」方式
(`rawContains`の両方向評価)に変更し、相互包含防止の役割を保ったままタンジェントを正しくholeとして
扱う。(2) (1)を直しても、evaluator側が穴を2D `Drawing#cut()`(押し出し前)で減算していたため、
外形と穴がちょうど接する場合にOCCTのブーリアンが縮退境界を正しく処理できず無変化の形状を返す
既知の頑健性問題が残っていた(実装検証で確認: 2D cutは失敗するが同じ寸法を3D `Shape3D#cut()`
[押し出し後]で行うと成功する)。修正: `evaluator.ts`の`buildDrawingParts()`が外形(solid)と穴(holes)を
別々のDrawingとして返すようにし、`extrudeSketchFeature()`で両方を個別に押し出してから3D側でcutする
方式に変更した(entities由来・segments由来[Phase19a領域]の両方に適用)。Vitest253件(containment.ts
の既存9件は無修正で全通過、evaluator統合に新規1件[矩形20x20+円r10のタンジェント回帰]、ドーナツ
面数比較を実装変更に追従させ円柱面カウント方式に更新)。ブラウザ確認: SketchEditorの「矩形/円を
数値で追加」既定値の組み合わせで穴が正しく貫通することを確認(修正前は無変化の直方体だった)。

項目2(寸法ツールの対象拡大+ホバー強調)を実装。寸法ツール(Phase 20b、`CadViewer.startDimensionTool`)は
segments(自由な線分・円弧)のみがヒット判定対象で、rectangle/circleのようなraw entityは対象外
だった。新設`src/sketch/entityDimensionPick.ts`(純TS、Vitest9件)の`findEntityDimensionHit()`が
circleの円周・rectangleの4辺(上下=幅、左右=高さ)への最短距離でヒット判定する。`DimensionToolTarget`に
`entity-radius`/`entity-width`/`entity-height`を追加し、ヒット時は拘束を経由せずApp.tsx側で
`updateSketchEntity()`によりentityのradius/width/heightを直接更新する(ソルバ非経由のため
矛盾巻き戻しの対象外)。ホバー強調は`handleDimensionToolMouseMove`(新設、既存のtrimツールの
ホバープレビューと同じ`drawingGroup`への一時ライン追加方式)でHOVER_COLORのプレビューを描く形にした
(セグメント・entityどちらのヒット候補も対象)。ブラウザ確認: 矩形+円のスケッチで寸法ツールを有効化し、
円周へのホバーでハイライトが表示されること・クリックで半径ポップアップ(既定値がentityの現在半径と
一致)が開き値変更で実際にradiusが更新されること、矩形の辺のホバー/クリックでも同様に幅/高さが
更新されることを確認した。既存のsegment系(length/radius/distance)ヒット判定は無修正のロジックの
まま(entityとの距離比較を追加しただけ)で、既存動作に変化がないことも確認した。

項目3(スロットツールの操作順)を実装。従来は幅を事前入力→2クリック(始点・終点)だったが、
SolidWorks式の「クリック1=始点→クリック2=終点(長さ・向き確定)→マウス移動で幅がカーソル距離に
追従(輪郭プレビュー)→クリック3=幅確定」に変更した。新設`slotWidthFromCursor()`
(src/sketch/shapeFromPoints.ts、純TS、Vitest5件)が中心線からカーソルまでの垂直距離×2を返す。
CadViewerに専用の`handleSlotClick()`(3クリックの状態遷移)を追加し、`SlotDrawingCallbacks.onComplete`
にwidthを追加(事前の幅入力欄・`startSlotDrawing()`のwidth引数は削除)。ブラウザ確認: 1クリック目で
中心線プレビュー(まだ幅なし)→2クリック目で輪郭がカーソル追従(「L30.0×W12.0mm」のライブ表示)→
3クリック目で確定、を画面キャプチャで確認した。

項目4(多角形ツールの一本化)を実装。旧「多角形」ボタン(自由な頂点列チェーン描画、`polygon`
エンティティ)を削除し(自由描画は既存の「線分」ツールが担う)、「正多角形」ボタンを「多角形」に
改名した。作図操作(2クリック: 中心→頂点、辺数はツール開始時に固定)自体は変更していないが、
確定時に作るエンティティを`regularPolygon`から、`regularPolygonVertices()`で頂点を計算した
`polygon`エンティティに変更した(既存の辺長寸法ラベル・頂点ごとのフィレット/面取り・頂点数値編集が
そのまま使える)。辺数入力は3/4/5/6/8のセレクタ(既定6)にした。`regularPolygon`型自体・evaluatorの
対応・SketchEditorの「正多角形を数値で追加」ボタン(既存の別経路)は後方互換のため変更していない。
既存E2E(polygon-drawing.spec.ts・dimension-editing.spec.ts・sketch-snapping.spec.ts)が旧・自由描画
「多角形」ツールに依存していたため、多角形ツールでの正六角形/正方形作図・線分ツールでのスナップ/
軸ロック検証に書き換えた。segmentsは頂点座標の編集UIを持たないため、新設した開発ビルド限定の
`window.__cadViewerDebug.drawingPointsSnapshot()`(描画モード中の確定済み頂点列を返す)で検証する
ようにした。Vitest267件(shapeFromPoints.tsのslotWidthFromCursor5件が新規)。E2E15件全通過
(既存12件+nested-hole.spec.ts 1件、うち3件を本フェーズで書き換え)。

## Phase 22: 円の拘束ソルバ統合+固定トグル+ボディ端面参照寸法

前回(Phase 21b)の「円の位置寸法は即時移動(positionDimensions.ts)」を、ソルバ(solver.ts)経由の
拘束(`distanceEntityOrigin`/`distanceEntityEntity`/`distanceEntityLine`/`fixEntity`、いずれも
`EntityRef`でcircleエンティティのみ対象v1)に置き換えた。solveSketch()の変数モデルにcircleの中心
(cx,cy)を追加し(半径は非変数のまま)、既存のsegment系拘束と同一のLM法で共存して解く。
`distanceEntityLine`の辺は「固定線」として扱う(rectangle/polygonの辺=`entityEdge`は毎回entities
から生値解決、ボディ端面参照=`refEdge`はピック時点のスナップショット)。SketchEditorのcircleに
「固定」チェックボックス(fixEntity拘束のon/off)を追加。

ボディ端面参照寸法: evaluator.tsがスケッチ評価時点の「現在ボディ」から`Shape.edges`
(`Edge.geomType==="LINE"`のみ)を抽出し、スケッチ平面上に載っている(両端点の平面距離<1e-4)ものを
ローカル2D座標に投影して`referenceEdges`としてWorker応答(protocol拡張)に追加した。ビューアは
これを控えめな破線でオーバーレイし、寸法ツール中は円クリック後にピック対象になる。再評価のたびに
`referenceEdgeMatch.ts`が既存の`refEdge`拘束のスナップショットを最新の座標へ幾何マッチング
(方向cos>0.999+最近傍)して追従させる(マッチ無しはスナップショット維持、既知の制限)。
Vitest284件(solver.ts循円拘束7件・evaluator.ts referenceEdges統合1件が新規)。ブラウザ確認:
円→原点拘束→矩形リサイズ後も距離維持(30.0mm→再解決後29.999...)/箱上面のfaceスケッチで
円→参照エッジ距離指定(中心が期待通り移動)/固定トグルのon・offをスクリーンショットで確認した。

## UI改善(ユーザー実機フィードバック4件)

寸法ツール中も寸法線・ラベルを表示したままにし(作図ツール中は従来通り非表示)、寸法ツールの
ピック視覚フィードバックを強化した(1つ目に選択したcircleを選択色で強調表示し続け、矩形/多角形の
辺・参照エッジ・原点マーカーもホバーで強調色になり、ツールバー付近に1点目待ちのステータスを表示)。
`distanceEntityEntity`拘束に`axis?: "direct"|"x"|"y"`を追加し円↔円のX/Y距離を指定可能にした
(ソルバ残差・寸法線グラフィックス`computeAxisDimensionGraphics`・ラベルのX/Y接頭辞、ソルバテスト3件
追加)。ツールバーをファイル/ビュー/作図/編集/右端の5グループに整理し(区切り線+ラベル、標準ビューは
主要3つ+セレクタ、アクティブツールは共通CSSクラスで強調)、SketchEditorの冗長な説明文を削除した。
Vitest293件。E2E15件全通過。

## 小修正: 参照エッジのスナップ+トリムのentities境界

作図ツールの点入力(`resolveDrawingCursor`)に、ボディ端面参照エッジ(referenceEdges)の頂点・中点を
`vertex`/`midpoint`候補として合流させた(`collectReferenceEdgeSnapCandidates`)。トリムは
`trimSegmentAtPoint`/`findClosestSegmentPiece`が同一スケッチのentities(矩形・円・多角形・スロット・
正多角形)を`explodeEntity`で一時セグメント化し交点境界に含めるようにした(entities自体は削除しない、
対象はsegmentsのみ)。Vitest296件(trim.ts entities境界3件が新規)。

## Phase 24: トリムのentity輪郭対応+フィレット/面取りの対象拡大

トリムツールでentity(円・矩形・多角形・スロット・正多角形)の輪郭自体をクリックできるようにした
(`trimEntityAtPoint`/`findClosestEntityPiece`が`explodeEntity`で対象entityを仮セグメント化し、
クリック区間だけを削除してentities→segments置換とsegments更新を1回のドキュメント更新で行う。
undo1回で戻る)。フィレット/面取りツールはrectangleエンティティの角(クリック時に同寸法のpolygonへ
自動変換してからコーナー適用)と、端点を共有する自由な線分セグメント同士の角(新設
`src/sketch/segmentCorner.ts`: 半径/サイズrに対しL=r/tan(φ/2)だけ両線分を短縮し、フィレットは
接する円弧(bulge換算)、面取りは直線を挿入)にも対応した。円弧セグメントが絡む角はv1対象外。

## バグ修正3件: 隣接フィレット破綻/線分↔参照エッジ寸法/線分↔線分の平行判定

`applySegmentCornerToSketch`がフィレット/面取り適用時に自動付与済みのcoincident拘束を更新しておらず、
短縮後の端点を古い拘束が引き戻して隣接する角を連続フィレットすると円弧が飛び出て破綻する不具合を修正
(対象の旧coincidentを削除し「線分接点↔挿入セグメント」の新coincidentに付け替え)。寸法ツールの
線分1本目→2点目に参照エッジも選べるようにし(`distanceLineRefEdge`/`angleLineRefEdge`拘束を新設)、
線分↔線分・線分↔参照エッジのポップアップに距離/角度の選択(ラジオ)を追加、平行判定はなす角を
[0,90°]へ折り畳んで判定するよう修正(逆向きに描いた平行線の誤判定バグ)。Vitest321件。
Vitest312件(trim.ts entity輪郭2件、segmentCorner.ts 7件が新規)。

## ユーザー報告4件の修正: ソルバ累積ドリフト/数値表示3桁/寸法削除ボタン/FOV緩和

`solveSketch`が既に満たされた拘束でも毎回ウォームアップ+LM反復で微小に動かしてしまい編集の度に
座標がドリフトする不具合を修正(拘束残差が1e-7未満なら入力をそのまま返す早期リターン+解いた座標を
1e-6mmグリッドに丸めて返す)。SketchEditorの数値入力・拘束一覧に共通フォーマッタ`formatMm`
(表示のみ小数3桁丸め、内部値・3桁超入力はそのまま尊重)を適用し、拘束由来の寸法ポップアップに
削除ボタンを追加した。カメラFOVを45→30度に変更(pxToMm/fitToView等は`camera.fov`参照のため自動追従、
E2Eの`verticalFractionForZ`も追従)。Vitest324件。E2E全通過。

## 寸法ツール改善2件: 矩形・多角形をソルバで動かせるように+選択順の柔軟化

`solveSketch`のentity変数をcircleからrectangle/polygon/regularPolygon/slotへ拡張(rectangle/
regularPolygonは中心、polygon/slotは剛体並進オフセット。フィレット形状・回転は変数にしない)、
`distanceEntityLine`の残差(円中心↔辺の垂直距離)が参照する辺の座標をentityEdgeなら現在の変数値から
解決するようにし(数値微分でヤコビアン近似)、円↔矩形辺のどちらを動かすかをfixEntity拘束(SketchEditorの
「固定」チェックボックスを全entity種別に拡大)で選べるようにした。寸法ツールはrectangle/polygonの辺を
1点目としてクリックできるようにし(`dimensionPendingEdgeLine`、円が2点目でも同じ`distanceEntityLine`
拘束になる)。Vitest331件。

## ユーザー報告(実機)の修正: 矩形が線分チェーンのとき円を固定すると必ず矛盾になるバグ+参照エッジを1点目に選べるように

前フェーズ(矩形・多角形をソルバで動かせるように)はrectangle/polygonエンティティの辺(entityEdge)
のみ対応しており、線分ツールで描いた矩形状の4本線分チェーン(rectangle/polygonエンティティではない、
実機でよくある描き方)を寸法ツールで「円→辺」選択すると`distanceEntityLine`の`line`が常に
`refEdge`(ピック時点の座標を凍結した固定スナップショット)になっていた。円を固定(fixEntity)すると
円・辺の双方が動けなくなり、距離を現在値から変更すると必ず矛盾(巻き戻し)になる不具合(ブラウザ実機で
再現・単体テストは新形式の拘束を直接組み立てていたため検出できていなかった)。`LineRef`に
`segmentEdge`(自由な線分本体、既にソルバの変数であるsegmentsのp1/p2をentityEdgeと同じく「今の値」
から解決)を追加し、CadViewer.tsの寸法ツールが自由な線分をヒットしたとき`refEdge`ではなく
`segmentEdge`を作るよう修正(円の固定状態に応じて辺・円のどちらかが動く。線分チェーンがvertical/
horizontal+coincident拘束を持つ通常の描画結果なら辺は平行移動として解ける)。
あわせて、寸法ツールでボディ端面参照エッジ(破線)を1点目としてクリックできるようにし
(`dimensionPendingRefEdgeLine`、2点目に円/線分を選ぶと既存の`circle-distance-refedge`/
`line-refedge`ターゲットになる。ホバー・ピック判定も保留状態に関わらず常時参照エッジを対象にした)。
Vitest336件。ブラウザ実機で「円固定→線分チェーンの辺が移動」「参照エッジ1点目→円で距離拘束」を
確認済み。

## Phase 25a: 3Dエッジ選択+フィレット/面取りフィーチャー

WorkerのmeshEdges()応答にedgeGroups(既存のlinesと同じ形の折れ線範囲)を追加転送し、B-Repから
算出したedgeInfo(edgeId=edge.hashCode、中点/両端点、`Shape.edges`/`Edge.pointAt(0.5)`等を使用)を
新設した。CadViewerに3Dエッジ選択ツールを追加し、スクリーン距離(8px)でのヒット判定によるホバー
(水色)/クリック選択トグル(複数可、オレンジ)を実装した。新設フィーチャー`fillet3d`
(kind:"fillet"|"chamfer"、選択エッジのedgeId+中点+両端点スナップショット配列)はevaluator.tsで
`resolveFilletEdges()`(第一候補hashCode一致→フォールバック中点距離最近傍+方向一致)がエッジを
再解決し、replicadの`Shape3D#fillet()`/`#chamfer()`(第2引数`EdgeFinder#inList()`で対象エッジを
絞り込み)を適用する。ツールバー「編集」グループに「3Dフィレット」「3D面取り」ボタンを追加し、
ツリー上の表示名は「フィレット1」等。Vitest341件(evaluator.ts統合5件が新規)。ブラウザ実機で
箱上面エッジのホバー/選択強調→フィレット適用(丸まり確認)→ツリーでsize編集→再評価反映→面取り
1回、をスクリーンショットで確認済み。既知の制限: エッジ再選択UIは無く、寸法変更等でエッジが
解決できなくなった場合はフィーチャーを削除して作り直す必要がある。

## Phase 25b: シェル(中抜き)+回転体(Revolve)フィーチャー

新設フィーチャー`shell`(replicadの`Shape3D#shell(thickness, finder)`、正の厚みで内側へ肉厚を残す規約。
対象面はfillet3dと同じhashCode優先+平面/法線/中心マッチングの`resolveShellFaces()`で再解決)と
`revolve`(スケッチ平面のワールド基底xDir/yDirを回転軸に使い`SketchInterface#revolve(axisDir, {origin,
angle})`を適用。newBody/add/cutの3操作は押し出しと共通のヘルパーに統合)を追加した。ツールバーに
「シェル」(3Dエッジ選択と同型の複数面選択ツール、CadViewerにFaceSelectTool新設)・「回転体」ボタンを
追加し、ShellEditor/RevolveEditorで肉厚・軸・角度・操作を編集できる。Vitest348件(evaluator.ts統合7件
[シェル3件・回転体4件]が新規)。ブラウザ実機で箱上面開口シェル(中抜き表示)→スケッチ矩形の回転体360°
(リング形状)→角度180°(半リング)確認済み。既知の制限: 面/軸再選択UIは無く、削除して作り直す運用。

## Phase 25c: ねじフィーチャー

新設フィーチャー`thread`(hand:"male"|"female"、preset:M3〜M12のISO並目テーブル
[`src/model/threadPresets.ts`]、length、配置面のhashCode+center+normalスナップショット、面基底上の
配置position、direction)。配置面はshellと同じ`resolveFaceGeometry()`で現在ボディから再解決する。
事前スパイクは「sketchHelix()のヘリックスをスパインにSketch#sweepSketch()で三角プロファイルを掃引」を
想定していたが、実装検証でこの経路(内部でtwistExtrude()を使う経路も含む)は本プロジェクトの
replicad/OpenCascade WASMの組み合わせでは幾何的に破綻する(バウンディングボックスが理論値の
2倍以上に膨らむ・体積が負値になる、半径やピッチによらず再現)ことが判明したため不採用にした。
代わりに三角プロファイル(底辺=ピッチ、根本=谷径、先端=呼び径)を1回転あたり16断面で少しずつ
回転・上昇させ、replicadの`loft()`(BRepOffsetAPI_ThruSections、ruled)で結んでリブ形状を作り、
谷径の円柱に`fuse(..., {optimisation:"sameFace"})`する方式にした(evaluator.tsの
`buildMaleThreadSolidLocal`/`orientLocalSolidToWorld`)。雄ねじは実測でM6×5mmが約10秒、
長さに比例して増えるため上限20mmのバリデーションを設けた。**雌ねじは実ねじ山を切らず、規格の
下穴径(呼び径-ピッチ)の円柱をcutする簡易表現にとどめる**(実ねじ山cutは評価時間が実用的でなくなる
ことがスパイクで判明したため)。ツールバーに「ねじ」ボタン(プリセット・雄雌・長さのミニフォーム→
平面を1クリックして配置。CadViewerに単一クリックで確定するThreadPlaceTool新設)を追加し、
ThreadEditorでpreset/length/hand編集ができる。Vitest351件(evaluator.ts統合3件が新規)。
ブラウザ実機で箱上面にM6雄ねじ(5mm、ねじ山の凹凸が見えるボス)→別位置にM6雌ねじ(穴が開く)→
パネルで雌ねじの長さ変更→評価中インジケータ表示→再評価反映を確認済み。既知の制限: 面再選択UIは
無く削除して作り直す運用、雌ねじは下穴のみ(ねじ山なし)の簡易表現、雄ねじ評価は長さに比例して
数秒〜十数秒かかる(ドキュメントにねじが含まれる限り他フィーチャーの編集でも毎回再計算されるため、
編集中はロールバックバーをねじの前に置くことを推奨)。

## Phase 26: プロジェクト保存/読み込み・自動保存・STEP出力

新設`src/project/serialization.ts`(純粋TS)でプロジェクトファイル(拡張子`.l3dcad`、
`{format:"l3dcad", schemaVersion:1, document:CadDocument}`のJSON)のserialize/deserializeを実装し、
既存の`validateDocument()`をそのまま流用してバリデーションと将来のschemaVersion移行の受け口を兼ねる。
ツールバー「ファイル」グループに「保存」(ダウンロード)・「開く」(file input、成功時はundo履歴クリア・
選択解除・再評価、失敗時はエラー表示)・「新規」(確認ダイアログ→空ドキュメント)を追加した。
ドキュメント変更のたびに500msデバウンスでlocalStorageへ自動保存し(`useCadStore.subscribe`)、起動時に
復元する(壊れていれば従来の初期ドキュメントにフォールバック)。E2Eの「毎回クリーンな初期状態」前提を
守るため、`e2e/helpers.ts`に`gotoApp()`(addInitScriptでlocalStorage.clear()してからgoto)を追加し
既存spec全ての`page.goto("/")`を置き換えた。WorkerにSTEPエクスポート(`exportStep`、replicadの
`Shape3D#blobSTEP()`)を追加し、STLボタンの隣に「STEP」ボタン(ボディなし時は無効)を追加した。
Vitest357件(serialization往復・拒否4件+STEP出力のWASM統合1件が新規)。ブラウザ実機で
形状作成→保存→新規→開くでフィーチャーツリー・拘束(円半径)が完全復元、リロードで自動保存から復元、
STEPダウンロードのファイル先頭が`ISO-10303-21;`であることを確認済み。既知の制限: プロジェクトファイルの
互換性はschemaVersion一致のみを見ており、将来のフィールド追加時のマイグレーション処理は未実装
(受け口のみ用意)。

## Phase 27a: 複数ボディ対応

evaluator.tsの単一`body`変数を`bodies: Map<FeatureId, Shape3D>`(キー=そのボディを作った
newBodyフィーチャーのid)へ置き換え、「単一ボディのみ」の制限を撤廃した。newBodyは既存ボディが
あってもエラーにせず新ボディを追加し、cut/addは新設フィールド`targetBodyId?`(省略時はMapの
挿入順で最後のキー=最後に作られたボディ)が指すボディのみに適用する。fillet3d/shell/threadは
エッジ/面の幾何マッチングを全ボディ横断で行い(各ボディで独立にマッチングを試み、全対象が
解決できたボディのうち距離合計が最小のものを採用)、最良マッチのボディに適用する。面上スケッチ・
参照エッジ用のスナップショットと最終出力(mesh/faceInfo/edges/STL/STEP)はいずれも「全ボディの
compound」(replicadの`makeCompound()`、各ボディを`clone()`してから合成)にし、Worker側の
プロトコル変更は不要だった(Compoundは他のShape3D同様mesh/faces/edges/blobSTL/blobSTEP等を
サポートするため)。ExtrudeEditor/RevolveEditorにボディが2つ以上ある場合のみ「対象ボディ」
セレクトを追加(削除等で参照先が候補から外れた場合も表示を維持して復帰できるようにした)。
Vitest368件(evaluator.ts統合6件+document.ts targetBodyId検証5件が新規、単一ボディ制限を
検証していた既存1件は新仕様に合わせて成功系に書き換え)。E2E(`error-recovery.spec.ts`の
1件目は「2つ目のNew Bodyがエラーになる」から「targetBodyIdの参照先削除で参照切れエラーになり、
対象ボディのリセットで復帰する」に書き換え、新設`multi-body.spec.ts`で離れた位置の2ボディ作成→
片方のみカット→STL出力をブラウザ実機相当で確認)。既知の制限: cutは指定ボディからのみ減算する
(v1では全ボディ横断カットは対象外)。アセンブリ機能そのもの(ボディ間の位置合わせ拘束・
部品ライブラリ等)は依然として未対応で、本フェーズは将来のアセンブリ機能への土台という位置づけ。

## Phase 27b: 簡易アセンブリ(部品配置)

新設フィーチャー`partInstance`(他の`.l3dcad`プロジェクトを丸ごと埋め込んだCadDocument+position/
rotation[度、X→Y→Z順])を追加した。evaluator.tsは埋め込みdocを`evaluateDocument()`で評価し
(part内にpartInstanceを含む入れ子は禁止、UI・model/validation.ts・evaluator.tsの3層で明確な
エラーにする)、変換後の形状をbodiesマップへ新規ボディとして追加する(newBodyと同じ扱いで、
以降のtargetBodyIdでcut/add対象にできる)。部品docのJSON文字列をキーにWorkerメモリへ変換前
compoundをLRUキャッシュ(上限5件、取り出し時にclone)し、位置・回転の変更だけでは部品の
再評価を伴わないことをVitestで確認した(実測: 未キャッシュ約79ms→キャッシュ済み約1.6ms)。
ツールバー「部品を配置」ボタン(.l3dcadを選び原点に配置)・`PartInstanceEditor`(名前/位置/回転/
削除、部品の中身は編集不可)・フィーチャーツリー「部品: <名前>」表示を追加した。Vitest379件
(model 5件+project(往復・入れ子拒否)2件+worker(位置/回転/入れ子拒否/キャッシュ)4件が新規)。
E2E新設`part-assembly.spec.ts`で、箱を保存→新規→円柱を作成→部品として配置→位置・回転編集→
保存→新規→開くで部品配置ごと完全復元、までを一気通貫でブラウザ実機相当で確認した(既存16件は
無傷、計17件)。既知の制限: 部品の中身はこのフィーチャーからは編集不可(元の`.l3dcad`を開いて
編集・保存し、削除して配置し直す運用)、配置はクリックによるドラッグ配置ではなく数値入力のみ。

## Phase 28a: 部品のドラッグ配置

Worker評価応答に`bodyGroups: { featureId; faceIds }[]`(compound化前の各ボディの面IDリスト)を追加し、
UI側でクリックした面のfaceIdから所属ボディ(featureId)を引けるようにした(evaluator.ts統合テスト2件、
2ボディでのfaceId分類・partInstanceボディの識別を検証。replicadの`Shape.clone()`/`makeCompound()`は
いずれも元のOCCT形状を再利用するだけなのでface.hashCodeがcompound化後も不変であることを前提にしている)。
ツールバー「部品移動」ボタン(`CadViewer.startPartDragTool`)でモードに入り、partInstance由来のボディの
面をmousedown+ドラッグすると部品の位置が動く(通常ドラッグ=ドラッグ開始点を通るワールドXY平行面への
レイキャスト差分、Shift+ドラッグ=スクリーン縦移動をmm換算したZ移動)。ドラッグ中はOrbitControlsを無効化し、
部品のバウンディングボックスのワイヤーフレーム(既存メッシュの頂点から算出)をカーソルに追従させ、
150msスロットルで実ドキュメント更新する(部品はキャッシュ済みのため再評価は軽い)。ドラッグ全体を
アンドゥ1回にするため、`store.ts`に`beginDragHistory`(開始時に1回だけ履歴push)と
`updateDocumentDuringDrag`(履歴を積まない直接更新)を追加した。既存の「スナップ」トグルON時は1mm
グリッドスナップを適用する。部品以外のボディはドラッグ対象外(ホバーで対象部品ボディ全体を薄い紫で強調)。
Vitest381件(bodyGroups統合2件が新規)。ブラウザ実機(Playwright経由、`npm run dev`)で、箱+部品配置→
部品移動ツール→ドラッグでXY移動しパネルの位置が実時間で更新→Shift+ドラッグでZのみ変化→アンドゥ1回で
直前のドラッグのみ取り消され2回目でその前のドラッグも取り消される(2回のドラッグ=2つのアンドゥ単位)→
部品以外(元の箱)をドラッグしても部品位置が変化しないこと、をスクリーンショット・DOM値の両方で確認した。
既知の制限: 回転(rotation)はこのツールでは変更できない(数値入力のみ)、複数部品を同時に選択しての
一括ドラッグは不可(1回のドラッグにつき1部品)。

## Phase 28c: 合致(メイト)

新設フィーチャー`mate`(2つの面参照+kind:一致/距離/同軸)を追加し、少なくとも一方がpartInstanceの
ボディである面ペアについて、関与するpartInstanceの位置・回転(6自由度)を数値ソルバ
(`src/assembly/mateSolver.ts`、Levenberg-Marquardt法・数値微分)で解くようにした。円筒面の軸は
replicadの公開APIのみで完結するUVサンプリング+3点円の外心で推定する(`face.hashCode`は
rotate/translate後に保持されないため、部品側の面参照は常に部品ローカル座標系での幾何マッチングで
再解決する)。解いた配置はevaluate応答の`solvedPlacements`経由でstore側がpartInstanceフィーチャーへ
履歴を積まずに書き戻す(2Dスケッチソルバの書き戻しと同じ設計)。ビューアに面を2つ順にクリックする
合致ツール(円筒面も選択可)を追加し、適用可能な合致の選択ポップアップから種別を選ぶUIにした。
Vitest395件(mateSolverの純粋数学ユニット5件+evaluator統合5件が新規)。E2E新設`mate.spec.ts`で、
部品配置→合致ツールで面を2つ選択→一致を適用して即座にスナップ→部品移動ツールでドラッグしても
再評価のたびにソルバが引き戻す→合致削除で自由になる、をブラウザ実機で確認した(既存17件は無傷、
計18件)。既知の制限: 合致は全フィーチャー評価後にまとめて解くため、合致より後ろのcut/add操作は
合致前の配置を基準に行われる、対応する合致は一致/距離/同軸の3種のみでパターン配置等は無い。

## Phase 29a: 堅牢性強化

Worker評価に一律120秒のタイムアウト監視+`error`イベント検知を追加し、発火時は保留中の全リクエストを
打ち切って「CADカーネルが応答しません」バナー(「カーネル再起動」ボタン、旧Worker terminate→新Worker
生成→最新docで再評価)を表示するようにした(開発ビルド限定の`window.__cadDebugCrashWorker()`で
実クラッシュを再現できる)。自動保存の復元には「復元開始マーカー」(localStorage)を追加し、初回評価
成功で解除、起動時にマーカーが残っていれば(前回クラッシュ疑い)復元をスキップして初期状態+
「再試行」バナーで起動する(自動保存自体は保持)。React ErrorBoundaryをApp全体に追加し、雄ねじの
ローカル形状(loft+fuse)を"preset:length"キーでWorkerメモリへLRUキャッシュ(上限5件、部品キャッシュと
同方式)、STL出力をバイナリ形式に変更、プロジェクトを開いた際の初回評価完了時に自動フィットするように
した。合致より後ろのcut/add(既知の制限、Phase 28c)はエラーではなくツリー・合致パネルの注意アイコンに
変更した。Vitest400件(ねじキャッシュ統合1件・STLバイナリ1件・復元マーカー純関数3件が新規)。E2E新設
`robustness.spec.ts`(クラッシュ→再起動復帰・ねじキャッシュの実速度・開く時の自動フィット)で確認し、
既存`full-flow`/`multi-body`のSTL検証をバイナリ判定に更新した(既存18件は無傷、計21件)。

## Phase 29c: 穴の縁(閉エッジ)への3Dフィレット/面取りが常に失敗するバグを修正

穴の縁のような閉じた円形エッジ(始点===終点で方向ベクトルが定義できない)は、
`matchFilletEdgesInBody`の幾何マッチングのフォールバックが方向cos判定(常に0で不一致)しか持たず、
選択直後の初回適用から「対象エッジを特定できませんでした」エラーになっていた(hashCodeは
再評価のたびに変わりうるためフォールバックが必須で、実機では毎回このエラーになっていた)。
`EdgeInfo`/`FilletEdgeRef`に`length`/`isClosed`(replicadの`edge.length`/`edge.isClosed`)を追加し、
閉エッジは中点距離+長さ一致で判定するよう分岐した(開いたエッジは従来通り方向cos判定)。
Vitest406件(穴縁フィレットの体積減少・寸法変更追従の統合2件が新規)。ブラウザ実機で、箱の上面に
円カットで貫通穴→3Dフィレット/3D面取りツールで穴の縁を選択→適用(丸め/面取りが視認できる)→
上流寸法(箱の高さ)変更後もフィレットが追従、を確認した。

## Phase 30: 頂点ベースの寸法指定

一致拘束で重なった端点群を1つの「頂点」として扱うよう寸法・拘束ツールのヒット判定を拡張し(代表点は
segmentId昇順の先頭、セグメント本体より優先・ホバーで頂点マーカー表示)、新拘束`distancePointLine`
(頂点↔線分/辺/参照エッジの垂直距離、長さ拘束の有無で線分が伸びる/平行移動する)、`distance`・
`distancePointOrigin`へのaxis(X/Y距離)対応、direct距離が幾何学的に解なしとなる典型ケースを検出して
具体的な誘導メッセージを出す巻き戻しトースト改善を追加した。Vitest430件(distancePointLine・axis付き
distance/distancePointOrigin・一致クラスタ経由の連動6件+一致クラスタのUnion-Find4件が新規)。
E2E新設`point-dimension.spec.ts`3件(一致頂点から下の線分への距離指定で線分が伸びる/複合拘束下で
X距離を指定してもエラーにならず連動する/direct距離の解なし誘導メッセージ)でブラウザ実機確認した
(既存21件は無傷)。

## Phase 31a: 寸法ラベルのドラッグ移動とトリムの拘束・寸法引き継ぎ(実機報告2件)

寸法ラベル(実測・拘束とも)をドラッグで移動できるようにした。CadViewerに新設した`screenToLocal()`
(スクリーン座標→スケッチ平面ローカル座標、raycastDrawingPlane()の応用)でドラッグ量をローカルの
オフセットベクトルへ変換し、拘束由来の寸法は該当拘束の`labelOffset`、実測寸法は`SketchFeature.
dimensionOffsets[dimensionKey]`へ永続化する(部品移動ツールと同じbeginDragHistory+
updateDocumentDuringDragでアンドゥ1回)。寸法線グラフィックス(`src/viewer/dimensionGraphics.ts`)は
新設の`offsetVec`パラメータで、引出線は測定点との接続を保ったまま寸法線側の点だけがオフセット分
ずれる(製図的な厳密さより、ラベルが図形から離れて邪魔にならないことを優先する簡易モデル)。
トリム(`src/sketch/trim.ts`)で線分が新IDの断片に置き換わり旧IDを参照する拘束・寸法が消えるバグを
修正した。新設の`trimSegmentWithConstraints()`が、削除で生じる断片のうち元の端点を含む側の1つに
元のsegmentIdを引き継がせ(splitSegmentAt()の境界順の性質を利用)、端点参照(PointRef)は座標一致
(1e-6mm)で新しい断片へ付け替える。horizontal/vertical/radius等のsegmentId直接参照はプライマリ
断片が元IDを引き継ぐため書き換え不要。length拘束は断片化で対象の長さの意味が変わるため削除し、
削除件数を一時トーストで通知する(entity輪郭のトリムは既存のtrimSketchEntityAtPoint()のまま、
拘束引き継ぎ非対応の既知の制限)。Vitest441件(trimSegmentWithConstraintsの純粋関数5件+
dimensionGraphicsのoffsetVec5件+.l3dcad往復のオフセット入りケース1件が新規)。E2E新設
`dimension-drag-and-trim.spec.ts`2件(寸法ラベルをドラッグ→寸法線ごと移動→リロード後も位置維持/
一致+水平+垂直+長さ付き線分チェーンをトリム→水平・垂直・一致・残せる長さ寸法は残り、断片化した
長さ寸法だけ通知付きで消える)でブラウザ実機確認した(既存24件は無傷、計26件)。既知の制限: 寸法線の
オフセットは製図規則(JIS等)に沿った自動整列は行わない簡易モデル、entity輪郭のトリムは拘束引き継ぎ
非対応のまま。

## Phase 32: 接線拘束の矛盾誤判定・セグメント個別削除・拘束エラーメッセージ具体化(実機報告3件)

tangent(円↔直線)のsideを拘束作成時に永続化し、収束失敗時は残差最大の拘束を狙った初期値リトライ
(一致チェーン伝播込み)で退化解を回避、矛盾メッセージには残差最大の拘束名を含めるようにした
(`src/sketch/solver.ts`/`constraintLabels.ts`)。SketchEditorのセグメント一覧を個別行+削除ボタン化し、
Deleteキーでの直接選択削除(参照拘束カスケード+件数トースト)を追加した(`removeSketchElementCascade`)。
Vitest455件、E2E新設`tangent-fix-and-segment-delete.spec.ts`4件でブラウザ実機確認した。

## Phase 33: 寸法ラベルのドラッグが効かないバグの修正と寸法値の符号仕様の明確化(実機報告2件)

Phase 31aで実装したはずのラベルドラッグが「拘束由来の寸法(寸法ツールで作る長さ・距離・X/Y距離・
半径)だけ効かない」という実機報告を再現し、根本原因を特定した:
`DimensionOverlay.commitOffset()`が`constraintDimensionKey()`の返す`"c-"+constraintId`をそのまま
`setConstraintLabelOffset()`のconstraintId引数へ渡していたため、実際の拘束id(cプレフィックス無し)
と一致せず書き込みが常に無効だった(実測寸法[矩形の幅/高さ等]は別経路[dimensionKey]で正しく動くため
気づかれにくかった)。`LabelDragTarget`にconstraintIdを別フィールドとして持たせて修正し、ラベルの
カーソルを`move`にして発見性を上げた。

寸法値の符号仕様も明確化した。X/Y距離(distance/distancePointOrigin/distanceEntityEntityの
axis:"x"/"y")は、新設の`signed`フラグ(新規作成時のみtrue、既存拘束の値だけ差し替える場合は
そのまま引き継ぐため旧データ[signed省略]は従来通り絶対値のまま解釈される後方互換)により、
残差が`|Δ|-value`(絶対値)ではなく`(座標2-座標1)-value`(符号付き、1点目→2点目のクリック順が基準、
0=軸整列)になった。あわせて距離系のバリデーション(`value>0`)を、X/Y距離・点↔線距離・線↔線距離
(参照エッジ版含む)で`value>=0`に緩和した(直線距離は0[点一致]を許可するが負は不可、X/Y距離は
負も許可)。`DimensionToolPopup`に軸選択に応じた一行ヒント(「符号は1点目→2点目の向き(0=整列)」/
「0以上(方向は現在の配置を維持)」)を追加した。Vitest450件(signed:trueの符号付き軸距離2件+0整列1件+
signed省略[旧データ]の絶対値互換1件のソルバテスト+signed付与のconstraintDimensionsテスト1件が新規)。
E2E新設2件(拘束由来の寸法ラベルのドラッグ回帰テスト[修正前は失敗することを確認済み]、円↔円のX距離が
負値で左側配置・0で垂直整列し編集ポップアップの初期値が符号付きになる/端点↔辺の距離に0を指定すると
端点が辺上に乗る)を追加し、既存の寸法ラベルドラッグE2Eは本番ビルド相当(`vite build`+`vite preview`)
でも1回確認した(既存26件は無傷、計29件)。



## Phase 35a: スケッチ拘束ソルバのPlaneGCS移行スパイク

自前実装のLevenberg-Marquardt法(Phase 20)をPlaneGCS(FreeCAD Sketcherの2D幾何拘束ソルバの
WASM移植、`@salusoft89/planegcs`、LGPL-2.1-or-later)へ置き換える実装方式を検証した(Node上の
実験スクリプト、`.claude/worktrees/.../experiments/planegcs-spike/00〜08.mjs`)。マッピング表・
剛体並進(代表点+difference拘束)・原点(fixed点)・ドラッグ(temporary拘束+DogLeg)の各方式を確認し、
自前ソルバが局所解に迷い込んで誤って「矛盾」判定していた3ケース(接線単純・一致チェーン5本複合・
長さ変更再solve)がPlaneGCSでは正しく解けることを確認した。

## Phase 35b-1: スケッチ拘束ソルバをPlaneGCSへ移行(全拘束移植)

Phase 35aの検証結果に基づき、`src/sketch/gcsAdapter.ts`を新設して全拘束種別をPlaneGCSの
primitive/constraintへ変換し、`solveSketch()`(`src/sketch/solver.ts`)の内部実装をPlaneGCS経由に
差し替えた(入出力シグネチャは維持)。WASMはViteの動的import+`?url`で別チャンク化し、メインバンドル
への影響は+0.6KB gzip(259.6KB、上限350KB)。アプリ起動時にバックグラウンドで初期化を開始し、
完了前は自前ソルバへ自動フォールバックする(旧ソルバはPhase 35cでの撤去を判断するまで維持)。
実機確認でPlaneGCSのdifference拘束が`param2-param1=difference`という(フィールド名の直感とは逆の)
規約であること、単一のDogLeg/LevenbergMarquardt(LM)だけでは劣拘束方向の解の選び方や剛体並進を
介した収束性に差があることが判明したため、LM着手→残差が許容誤差を超えればDogLegでも解き直し
より小さい方を採用するフォールバック、および低scaleのcoordinate_x/y拘束によるwarmup+仕上げの
2段階solve(旧ソルバのwarmup+finishingと同じ考え方)を実装した。矛盾検出はPlaneGCSの
`get_gcs_conflicting_constraints()`だけでは検出できない純粋な距離的矛盾があったため、解いた後の
座標から拘束ごとに残差を再計算する二重チェックを追加した。Vitest468件(既存ソルバ系67件をGCS実装で
全通過、旧ソルバフォールバック回帰2件、スパイク失敗ケースの回帰2件が新規)。ブラウザ実機で、
ユーザー報告ケース(固定R59円+接線+接続する線の長さ変更→矛盾判定にならず形状が追従)・寸法駆動
(矩形リサイズ)・ドラッグ(頂点/水平拘束付き線分)・矛盾ケース(拘束名入りメッセージ)を確認した。
既存E2E(全18ファイル、38件)をBashで同期実行し、34件は無傷。残る4件(`multi-body.spec.ts`1件、
`sketch-drag.spec.ts`のドラッグ3件)はこの変更直前のコミット(Phase 34時点)へ`git stash`で
戻した状態でも同じ場所で同じ理由により失敗することを確認済みで、本フェーズ(ソルバ移行)による
リグレッションではない既存不具合(面クリックのタイミング、原点と重なる端点のヒットテスト優先順位等)
と判断した。既知の差: rectangle補助点の並進を介した無関係軸にごくわずかな残差(1e-3mm未満、CAD実務
精度に対して無視できる)が乗ることがあり、該当テスト1件の許容精度を1桁緩めた。申し送り
(Phase 35b-2): `gcsAdapter.ts`の`getSketchDiagnostics()`(dof・conflicting/redundant拘束id取得)は
実装済みだがUIに未配線。拘束一覧パネルへのDOF表示・矛盾/冗長拘束のハイライトの検討に加え、
上記の既存不具合4件(ソルバ移行と無関係、Phase 34以前から存在)の切り分け・修正も申し送る。

## Phase 35b-2: E2E失敗4件の根本修正+拘束診断UI

前フェーズの申し送り4件を個別に再現・特定し、いずれも実際に修正した(3件は`git stash`でPhase 34の
コミットに戻しても同じ場所・理由で再現することを自分で確認済みでソルバ移行と無関係の既存不具合、
1件はGCS移行由来の新規リグレッション)。①ドラッグ編集(`addDragConstraints`)のtemporary
p2p_distance(=0)拘束が、目標点=対象点の特異点(Euclid距離の勾配が0/0)でPlaneGCSのDogLegを
NaNにする不具合(GCS移行由来)を発見し、temporary拘束をcoordinate_x/coordinate_yの2本(線形、
特異点なし)に置き換えて解消した(sketch-drag④長さ拘束付き本体ドラッグのNaN化を修正)。
②原点と線分端点が画面上で重なる場合、拘束ツールの2クリック目が常に優先度最上位の原点自身に
ヒットして選択が完了しない既存バグ(Phase 31b由来)を、2クリック目はpendingと同じ対象を除外して
次点へフォールスルーする方式で修正した(sketch-drag②)。③複数ボディが離れた位置にあるシーンで
ズームアウトすると、押し出し量の薄いボディの面がスクリーン距離的に元のスケッチ線と近接し、面ピックより
スケッチ線直接選択(Phase 31b)が常に優先されてしまう既存バグを、スケッチ平面上の交点よりボディの面が
カメラに近ければ面を優先する深度判定(`isSketchOverlayOccludedByMesh`)で修正した(multi-body)。
④円↔原点のY距離拘束(`circle-distance-origin`)にaxis(X/Y距離)指定が存在しなかった機能欠落
(既存不具合)を、`distanceEntityOrigin`拘束にaxis/signedを追加し`distancePointOrigin`と同じ
difference拘束方式で実装して埋めた(sketch-drag⑤)。Vitest468件(既存回帰なし)、E2E38件
(sketch-drag④の4件全て含む)をBashで同期実行し全通過を確認した。

拘束診断UI: `solver.ts`に`getSketchDiagnostics()`を公開し(`gcsAdapter`未初期化時はnull)、
App.tsxが選択中スケッチのsegments/constraints/entitiesから毎編集で再計算してSketchEditor
(定義状態バッジ: 完全定義=濃緑/未定義(自由度N)=青/矛盾あり=赤、拘束一覧の矛盾=赤・冗長=黄色背景+
ツールチップ)とCadViewer(選択中スケッチ線の配色をSolidWorks流に完全定義=黒っぽく/未定義=青系/
矛盾=赤へ切替、要素単位でなくスケッチ全体単位)へ渡す。実装中、`getSketchDiagnostics()`が
PlaneGCSの`get_gcs_conflicting_constraints()`だけに頼ると純粋な距離的矛盾(fixEntity+
distanceEntityEntityの直接編集による矛盾)を見逃すバグを実機確認し、`solveSketchGcs()`と同じ
残差再計算による二重チェックを追加して解消した。ブラウザ実機で未定義→完全定義→矛盾の3状態の
バッジ・拘束一覧の色分け・ドラッグ後のバッジ即時更新を確認した。

## Phase 35c: 旧ソルバ(自前LM法)の撤去

Phase 35b-1/35b-2で維持していたフォールバック用の旧ソルバ(`src/sketch/solver.ts`の自前
Levenberg-Marquardt実装、`solveSketchLegacy`とそのヤコビアン・減衰・初期値リトライ・
side-lockヒューリスティック等の内部関数一式、約1000行)を削除し、`solveSketch()`は常に
PlaneGCS(`gcsAdapter.ts`)経由で解くようにした。`src/assembly/mateSolver.ts`(3D合致ソルバ、
別実装)が再利用する`solveLinearSystem()`のみ`solver.ts`に残した。GCS初期化未完了ウィンドウは
「黙って未解決の形状を返す」旧ソルバ流のフォールバックではなく、`solveDocumentSketchesAsync()`が
初期化Promise(`ensureGcsInitialized()`)の完了を待ってから解く方式にした。呼び出し元
`src/state/store.ts`の`updateDocument()`/`updateDocumentDuringDrag()`はこれに伴い戻り値が
`Promise<void>`になった(GCS初期化済みなら実質マイクロタスク1回分の遅延で解決し、83箇所ある
呼び出し元の大半はfire-and-forgetのままで問題ない。結果を見て追加のロールバックを行う
`src/state/constraintUpdate.ts`の`updateDocumentWithConflictRollback()`と`store.ts`内の
`setRollbackIndex()`のみ、await/ローカル計算に修正して同期時の判定順序を保った)。同期呼び出しが
残る`CadViewer.ts`のドラッグ処理(毎フレーム)は`isSolverReady()`で未初期化時にそのフレームだけ
スキップするガードを追加した(次フレームで再試行、既存の「収束失敗時はスキップ」と同じ設計)。
旧ソルバの内部実装をテストしていた`tests/sketch/solverLegacyFallback.test.ts`(2件)は削除、
残りのsolver系Vitestはpublic API経由でPlaneGCSに対して引き続き通過を確認(468→466件)。
ライセンス表記の確認: `node_modules/@salusoft89/planegcs/LICENSE`の実文面はLGPL **2.1**
(「version 2.1 of the License, or (at your option) any later version」)であり、本リポジトリの
表記(README.md・`gcsAdapter.ts`・本ドキュメント、いずれも「LGPL-2.1-or-later」)は実際の
ライセンス条文と一致していることを確認した。不一致があったのは`@salusoft89/planegcs`パッケージ
自身の`package.json`の`license`フィールド(`LGPL-2.0-or-later`、上流のメタデータ誤記と見られる)
であり、本リポジトリはこのフィールドを引用・転記していないため修正は不要と判断した。
gate結果: `tsc --noEmit`(app/e2e両方)エラーなし、Vitest 466件全通過、`vite build`+
`npm run size`でUIバンドル260.5KB→256.9KB gzip(約3.6KB減、上限350KB)、E2E 38件全通過
(`npx playwright test`をBashで同期実行)。

## Phase 36: 領域結合許容0.01mm+トリム断点への一致拘束自動付与(実機報告)

実機報告バグ(線分5本+entityトリム由来の円弧1本のプロファイル+別の円entityを押し出すと、外形が
消えて円entityのディスクだけになる)の根本原因は、entityトリム(`trimEntityAtPoint`)が生む断片に
隣接セグメントへの一致拘束が一切付かず、ソルバ再実行のたびに断点が数µmドリフトして
`src/sketch/regions.ts`の頂点マージ(旧: intersections.EPS=1e-6と共用)が「別頂点」と誤判定し、
外枠ループが閉じなくなることだった。2点修正: (1) `regions.ts`に頂点マージ専用の緩い許容
`REGION_JOIN_EPS`(0.01mm、intersections.EPSとは別定数のまま)を導入し、クラスタの代表点へ
セグメント端点をスナップしてループの連続性を厳密に保つ。(2) `trim.ts`にトリム断点の自動一致拘束
付与(`coincidentsForCutPoints`、マッチング許容1e-4mm)を追加し、segment自己トリム・entityトリム
の両経路で、新しく生じた断片端点と座標一致する他セグメント端点(entity分解片同士の隣接も含む)に
coincidentを自動付与する(既存と同等の拘束があれば追加しない、point-on-curveはスコープ外で
サイレントスキップ)。`trimEntityAtPoint()`の戻り値にconstraintsを追加し、`document.ts`の
`trimSketchEntityAtPoint()`経由でsketch.constraintsへ反映されるようにした。
gate結果: `tsc --noEmit`(app/e2e両方)エラーなし、Vitest 466→475件全通過、`vite build`+
`npm run size`でUIバンドルgzip 257.1KB(上限350KB)、E2E 38件全通過(`npx playwright test`を
Bashで同期実行)。

## Phase 37: AI自然言語モデル生成(`src/ai/`)

ユーザーの日本語プロンプトからCadDocumentを生成する機能を追加した。LLMは内部`CadDocument`
(幾何スナップショットを含み生成不可)ではなく、専用の「アウソリングJSON」(`authoringSchema.ts`、
sketches/entities/segments/constraints/features)を出力し、`compile.ts`が意味検証(ID参照・
cut前提のボディ存在・寸法の正値性)を経て内部形式へ変換する。`generate.ts`が
`@anthropic-ai/sdk`(動的import、メインバンドル非同梱)で構造化出力を要求し、コンパイル→
スケッチ拘束求解→Worker経由のドライラン評価のいずれかが失敗すれば最大3回まで自己修復する。
UI(`AiGeneratePanel.tsx`)はReact.lazy()で遅延読み込みし、APIキー無しでも使えるJSON貼り付け
経路も備える。gate結果: `tsc --noEmit`(app/e2e両方)エラーなし、Vitest 475→503件全通過、
`vite build`+`npm run size`でUIバンドルgzip 257.1KB→257.6KB(SDKは別チャンク43.1KB、
AI生成パネルは別チャンク11.0KB、いずれもメインバンドル対象外)、E2E 38→40件全通過
(`npx playwright test`をBashで同期実行)。

## Phase 37b: AIモデル生成にOpenAIプロバイダを追加(`src/ai/openaiClient.ts`, `src/ai/provider.ts`)

第2のLLMプロバイダとしてOpenAIを追加した。`openaiClient.ts`がopenai SDK(動的import、メイン
バンドル非同梱)のResponses API(`text.format:{type:"json_schema",strict:true}`)で
AUTHORING_JSON_SCHEMAをそのまま構造化出力に使い(strictモード要件を既に満たしていたためスキーマ
アダプタ不要)、`provider.ts`が`Provider`("anthropic"|"openai")からcallModel実装への橋渡しを担う。
`AiGeneratePanel.tsx`にプロバイダ選択・プロバイダ別APIキー/モデル欄(Anthropicは既存キー名を
継続、OpenAIは既定候補+自由入力)を追加。gate結果: `tsc --noEmit`(app/e2e両方)エラーなし、
Vitest 503→517件全通過、`vite build`+`npm run size`でメインバンドルgzip 257.6KB(変化なし、
openai SDKは別チャンク35.6KB)、E2E 40→41件全通過(`npx playwright test`を2分割でBash同期実行)。

## Phase 38a: CommandManagerリボン+デザイントークン基盤

フラットな約40ボタンの1行ツールバーを廃止し、SolidWorks風のCommandManagerリボン
(スケッチ/フィーチャー/アセンブリ/表示の4タブ、アイコン[`src/components/ToolIcon.tsx`、
新規npm依存なしの共有インラインSVG]+ラベルのタブ内ツール群)へ置き換えた。`src/index.css`に
ニュートラルなライトテーマのデザイントークン(色・スペーシング・フォント・角丸・影のCSS変数)を
追加し、リボンとaside/入力/ボタン等の既存パネルへ共通適用した。フィット・正対・標準ビューは
本家同様タブを跨いで常時表示するヘッズアップクラスタに置き(表示タブにも同内容をラベル付きで
再掲)、押し出し・回転体はフィーチャー/スケッチ両タブに配置してスケッチ編集中でも直接実行できる
ようにした。スケッチの選択状態が変化した境界でタブが自動切替する(スケッチ選択→スケッチタブ、
解除→フィーチャータブ)ため、既存E2Eの操作順はほぼ無改修で成立し、アセンブリタブのみ`合致`実行前に
`openRibbonTab()`(新設、`e2e/helpers.ts`)での明示切替が必要だった(`e2e/mate.spec.ts`1箇所)。
gate結果: `tsc --noEmit`(app/e2e両方)エラーなし、Vitest 517件全通過、`vite build`+`npm run size`で
メインバンドルgzip 257.6KB→259.8KB(+2.2KB、アイコンSVG分)、E2E 41件全通過(2分割でBash同期実行)。

## Phase 38b: FeatureManagerツリー刷新+ビューポート polish

`FeatureTree.tsx`をSolidWorks風に刷新した(部品アイコン+「部品1」ヘッダー、行アイコン[`ToolIcon`の
既存セット流用]、~26px行・選択時アクセント左帯・ホバー時のみのアクション、ロールバックバーを
太い掴みバー風に再スキン、ダブルクリックでの名前インライン編集[新設`renameFeature()`、
`model/document.ts`])。既存のtestid・クリック/選択・ロールバック挙動・警告アイコンは全て維持した。
ビューポートはヘッズアップビュークラスタ(フィット/正対/標準ビュー、testid・ハンドラ不変)を
リボンからキャンバス上部中央の半透明フローティングバーへ移設し、`CadViewer.ts`に背景を
グラデーションテクスチャ化+左下固定の毎フレーム更新XYZ軸インジケータを追加した(新規npm依存なし)。
gate結果: `tsc --noEmit`(app/e2e両方)エラーなし、Vitest 517件全通過、`vite build`+`npm run size`で
メインバンドルgzip 259.8KB→261.0KB(+1.2KB)、E2E 41件全通過(2分割でBash同期実行)。

## Phase 38c: フィーチャーツリー常時表示+「セグメント」表記の人間可読化

スケッチ編集中にツリーへ戻れないというユーザー報告に対応した(実際はaside内に常駐していたが、
明示的な離脱導線が無くSketchEditorパネルの下に埋もれて見えた)。SketchEditorパネルヘッダ+
リボンの`スケッチ`タブ両方に「スケッチ終了」ボタン(`btn-exit-sketch-panel`/`btn-exit-sketch`、
`selectFeature(null)`)を追加し、`.feature-tree`を`position: sticky; top: 0`化してaside内で
常に最上部に留まるようにした。「セグメント」表記は`src/sketch/displayNames.ts`(新設、
`constraintLabels.ts`を置き換え)に一元化し、種類(線分/円弧/矩形/円/…)+配列内位置で
「線分1」「円1」のように表示、拘束一覧は「一致: 線分5の終点 = 線分1の始点」のような人間可読文へ
変更した(SketchEditor・gcsAdapter矛盾トースト・validation/ai-compileの診断メッセージまで横断)。
gate結果: `tsc --noEmit`(app/e2e両方)エラーなし、Vitest 517件全通過(文字列アサーション追従)、
`vite build`+`npm run size`でメインバンドルgzip 261.0KB→261.2KB(+0.2KB)、E2E 41件全通過(2分割で
Bash同期実行)。

## Phase 39: design-first生成+質問モード(ユーザー承認済み設計の採用)

AI応答を「エンベロープ」形式({design, questions, model}、`src/ai/envelopeSchema.ts`の
`AI_RESPONSE_JSON_SCHEMA`、AUTHORING_JSON_SCHEMAを`model`プロパティとして埋め込み)に変更し、
毎回設計メモ(実寸/機能要件/主要寸法表/造形方針)を先に書かせるdesign-first生成と、寸法が
一意に決まらない指示への質問モード(最大3問・セッションあたり1ラウンドのみ、`generate.ts`が
再質問を検知したら1回だけ「すべておまかせで生成してください」と自動応答)を導入した。
`promptSpec.ts`をユーザー草稿の実質(平面/押し出し方向表・サジタ表によるpolygon近似フィレット・
最小肉厚3mm・出力前チェックリスト等)を踏襲しつつ実装(authoringSchema.ts/compile.ts/
evaluator.ts)に合わせて全面刷新し、few-shot3例をcompileAuthoringModel()で実検証(リング例は
revolveのaxis:"y"がevaluator実装上ワールドZ相当になることを検証し、断面をXZ平面に描く形へ
補正)。「プロンプト仕様をコピー」用に貼り付けモード向けの素JSON出力プロンプト
(`AUTHORING_PASTE_PROMPT`)を分離した。`AiGeneratePanel`は質問をチップUI(選択肢+
「おまかせ」+自由回答上書き+「全部おまかせで生成」)で表示し、生成成功後はパネルを閉じずに
設計メモを折りたたみ表示する形へ変更した。gate結果: `tsc --noEmit`(app/e2e両方)エラーなし、
Vitest 517→534件全通過、`vite build`+`npm run size`でメインバンドルgzip 261.2KB(変化なし、
AI関連は遅延チャンク)、E2E 41→42件全通過(2分割でBash同期実行)。

## Phase 40a: モデル共有リンク(URL埋め込み共有、バックエンド不要)

現在のドキュメントをgzip圧縮(CompressionStream)+base64url化してlocation.hash(`#m=...`)に
埋め込みクリップボードへコピーする「共有リンクをコピー」ボタンをリボンのファイル群に追加した
(`src/project/shareLink.ts`、非対応環境はボタンを無効化しツールチップで案内)。起動時にhashを
検出したら復号→検証し、自動保存(localStorage)の内容と異なる場合のみconfirm()で確認してから
読み込む(自動保存の無言上書きを避ける)ことで自動保存復元より優先する。gate結果: `tsc --noEmit`
(app/e2e両方)エラーなし、Vitest 534→548件全通過、`vite build`+`npm run size`でメインバンドル
gzip 262.5KB(+1.3KB、上限350KB内)、E2E 42→43件全通過(2分割でBash同期実行)。

## Phase 40b: オープンソース公開準備(ライセンス・ドキュメント整備)

MIT License・`THIRD_PARTY_NOTICES.md`(OCCT/PlaneGCSのLGPL-2.1系WASM無改変利用の明記)・
`CONTRIBUTING.md`を新設しREADME.mdを日英構成へ刷新(src/・e2e/は無変更、履歴シークレット走査は異常無し)。

## Phase 40c: コミュニティモデルギャラリー(PR投稿・静的ビルド)

リポジトリルート`models/<slug>/`(model.l3dcad+meta.json)を正本とするコミュニティモデル投稿の
仕組みを追加した。共有リンク(Phase 40a)と共通化した`src/project/bootLoad.ts`が起動時ロード
(`?g=<slug>`、`src/project/galleryLoad.ts`)を担い、`scripts/build-gallery.mjs`+
`scripts/capture-thumbnails.mjs`(`npm run gallery:build`、Playwrightでサムネイル撮影)が
`dist/gallery/`を生成、`vite.config.ts`の`modelsGalleryAssetsPlugin`がdev配信/ビルドコピーを
担う。CIは`npm test`内の`tests/project/models.test.ts`で不正モデルを検出し、`deploy.yml`に
ギャラリービルド手順を追加した。gate結果: `tsc --noEmit`(app/e2e両方)エラーなし、Vitest
548→580件全通過、`vite build`+`npm run size`でメインバンドルgzip 263.1KB(+0.6KB、上限350KB内)、
`npm run gallery:build`でdist/gallery/index.html+サムネイル3件生成、E2E 43→46件全通過
(2分割でBash同期実行)。

## Phase 40d: アプリ内「ギャラリーに投稿」ボタン(Issue→自動PRフロー)

リボンに「ギャラリーに投稿」ボタン(`GallerySubmitDialog`、遅延読み込み)を追加し、共有リンクと
同じgzip+base64urlペイロードでGitHub Issueフォーム(`.github/ISSUE_TEMPLATE/model-submission.yml`)を
事前入力して開く(長すぎる場合はクリップボードへフォールバック)。`model-submission.yml`
ワークフローがissue本文をパース・検証し`models/<slug>/`へのPRを自動作成する(`scripts/`配下の
Node製ロジックをvitestで単体テスト、実際のAction実行はこの環境では検証不可)。

## Phase 41: ねじを簡易表示化、ロフト廃止で高速化

実機報告(雄ねじの実体が尖って見える、雌ねじが素の穴と区別できない)を受け、雄ねじの実ヘリカル
ねじ山ソリッド(loft+fuse、`buildMaleThreadSolidLocal`/`THREAD_SECTIONS_PER_TURN`/LRUキャッシュ)を
撤去し、呼び径円柱のfuseのみにした(評価は数秒〜十数秒→事実上瞬時。`MALE_THREAD_MAX_LENGTH`
[20mm上限、loft専用の制約]もUI・validation.ts・evaluator.tsから撤去)。雌ねじ(下穴cut)は変更なし。
見た目上の「ねじらしさ」はWorker評価応答に追加した`threadAnnotations`(位置・軸・呼び径・谷径・長さ)
経由でビューアが描く、JIS製図の「二重円」表現を参考にした線オーバーレイ(両端面/入口面の円+
軸方向のヘリックス線、`CadViewer#setThreadAnnotations`、実B-Repに含めずraycastの対象外)が担う。
中身の詰まったソリッド内部に埋没する線はdepthTest有効では原理的に不可視になることを実測で確認した
ため、この線オーバーレイのみdepthTest:falseの常時描画にした(referenceEdgeGroupと同じ方針)。
gate結果: `tsc --noEmit`(app/e2e両方)エラーなし、Vitest 636→638件通過+1skip(ヘリカルloft関連
テスト3件を撤去し、threadAnnotations検証2件+高速化検証1件を追加)、`vite build`+`npm run size`で
メインバンドルgzip 263.7KB(変化なし、上限350KB内)、E2E 47件全通過(2分割でBash同期実行)。

## Phase 42: entityトリムでのfixEntity/tangent等の参照切れ拘束を修正

実機報告(固定円[fixEntity]+2辺への接線[tangent]をトリム→拘束一覧に生ID表示、拘束矛盾)を
再現・修正。原因はentityトリム(`trimEntityAtPoint`)・分解(`explodeSketchEntity`)が、
削除されたentityIdを参照する拘束(fixEntity/tangent/distanceEntityLine等)をそのまま残す
バグ(gcsAdapter上は無害[残差0で無視]だが、意図した固定/接線が消えて自由度が跳ね上がり、
複雑な実データでは2段階solveが収束せず矛盾誤検出につながる)、および`trimSegmentWithConstraints`の
セグメント全体削除分岐がlength拘束以外の参照切れ(coincident/fix等)を掃除していなかったこと。
`src/sketch/trim.ts`に`migrateEntityConstraintsForReplace`(fixEntityは全断片の両端点への
`fix`拘束[既存語彙のみ、新規種別なし]へ移行、tangent等は凍結により無害化した場合のみ削除)と
`pruneDanglingConstraints`(参照切れの一括掃除、両トリム経路+分解で共通利用)を追加した。
gate結果: `tsc --noEmit`(app/e2e両方)エラーなし、Vitest 638→645件通過+1skip(entityトリムの
拘束移行・ダングリング掃除5件を追加)、`vite build`+`npm run size`でメインバンドルgzip
264.0KB(+0.3KB、上限350KB内)、E2E 47→48件全通過(2分割でBash同期実行)。

## Phase 42b: 円弧をPlaneGCSのネイティブarcプリミティに昇格(接線・一致が効かないバグの修正)

実機報告(「円弧に対して接線とか、一致が効かない。拘束メニュー時に円弧が選べなくなってる」)を
修正。`gcsAdapter.ts`の円弧を、旧来の「bulge(挟角)固定+端点2点のみ」から、PlaneGCSの
ネイティブ`arc`プリミティ(中心点+半径+start/end角、`arc_rules`で端点座標と整合)へ置き換えた
(半径・掃引角も実変数になり、`radius`拘束はarc_radius、`tangent`は円弧⇔直線に`tangent_la`を
新設、`concentric`はEntityRef|ArcRefへ拡張して円⇔円弧・円弧⇔円弧にも対応)。書き戻し時は
解いたstart/end角からbulgeを逆算するが、mm座標と同じ1e-6グリッドで丸めると無次元量である
bulgeでは接線判定を壊すほどの誤差(実機確認)になったため、専用のBULGE_ROUND_GRID(1e-9)を導入。
Phase 42のfixEntity移行(トリムでentityが円弧片へ置換)も、両端点fixではなく円弧の中心・半径のみ
固定する新設`fixArc`拘束へ改善(端点は元の円の上を自由に滑れる、より正確な意図の表現)。
CadViewerの拘束ツールピック(`findConstraintPickHit`)から円弧を除外していたガードを撤去。
gate結果: `tsc --noEmit`(app/e2e両方)エラーなし、Vitest 645→660件通過+1skip(円弧のネイティブ化・
fixArc移行の回帰含む)、`vite build`+`npm run size`でメインバンドルgzip264.5KB(+0.5KB、上限350KB内)、
E2E 48→49件全通過(2分割でBash同期実行)。

## Phase 42c: 接線拘束を解いた直後のトリムで、接点が交点として見つからず全消去されるバグを修正

実機報告(「トリムで途切れなく、全て消えてしまう」)を再現・修正。ソルバ(`gcsAdapter.ts`)は解いた
座標を1e-6mmグリッドへ丸めるため、接線拘束が厳密に満たされた解でも垂線距離と半径の差が最大
約1e-6mm(実測、半径1〜500mm・非対称な腕・接触角を広く走査)残る。`intersections.ts`の判別式
ベースの許容は代数的に整理すると常にEPS/8(≈1.25e-7mm、スケールに依らず一定)へ潰れており、
この丸め誤差を吸収できず「交点なし」を返していた。中心↔直線の垂線距離(または円弧↔円弧の
中心間距離)と半径の差を判別式を介さず直接比較する新しい接触バンド判定(`TANGENT_CONTACT_EPS`
=1e-4mm、実測ワーストケースの約100倍のマージン)を追加し、バンド内なら単一の接点(垂線の足、
線分区間・円弧角度範囲でクランプ)を返すようにした(`lineArcIntersection`/`arcArcIntersection`)。
トリム(`trim.ts`)はこの交点計算を再利用するため自動的に接点で区切られるようになる。
gate結果: `tsc --noEmit`(app/e2e両方)エラーなし、Vitest 660→674件通過+1skip(接触バンドの
単体・トリム統合テスト14件を追加)、`vite build`+`npm run size`でメインバンドルgzip264.7KB
(+0.2KB、上限350KB内)、E2E 49→50件全通過(2分割でBash同期実行)。

## Phase 43: ユーザー要望の4件のUX改善(ねじ数値配置・自由回転・スケッチ表示自動化・ビューパッド)

①ねじ配置(`ThreadFeature.position`、面ローカル2D座標)に位置X/位置Y数値入力を`ThreadEditor.tsx`へ
追加(`patchThreadPosition`新設、faceは変えず位置のみ差し替え、クリック配置→数値微調整の運用)。
②右ドラッグ回転が極付近で詰まる不具合(`OrbitControls`はconstructor時点のcamera.upを基準に
球面座標を固定するため、`setStandardView`/`lookAtPlane`での動的up切替と噛み合わなかった)を、
ワールド固定upを一切参照しないトラックボール式`FreeOrbitControls`(`src/viewer/freeOrbitControls.ts`
新設)に置き換えて解消(offsetとupを同じクォータニオンで一緒に回すため直交が常に保たれ、
極を跨いでも特異点が出ない)。③スケッチ表示を自動化: スケッチ編集モード中は自動表示・外は自動
非表示がデフォルトになり、既存の「スケッチ表示」チェックボックスは現在のモードに対する手動
オーバーライド(`sketchVisibilityOverride`)として働き、モードの出入りでリセットされる。
④ヘッズアップの標準ビューボタンを横一列からSolidWorks風の十字パッド(CSS Grid、正面中心+
上下左右、等角/背面を角、フィット/正対は左に添える小列)へ変更(testid・ハンドラは不変)。
パッドが縦に大きくなった副作用で寸法ラベル等をクリック不能にしていたため、パッド自体は
`pointer-events: none`にしボタンのみ`auto`にして空セル/隙間はクリックを素通しするよう修正。
gate結果: `tsc --noEmit`(app/e2e両方)エラーなし、Vitest 674件通過+1skip(変更なし)、
`vite build`+`npm run size`でメインバンドルgzip261.1KB(-3.6KB、上限350KB内)、
E2E 50件全通過(3分割でBash同期実行、スケッチ表示自動化に伴い`sketch-overlay.spec.ts`を
新セマンティクスへ書き換え、十字パッドとの画面座標衝突を避けるため
`dimension-drag-and-trim.spec.ts`④の作図座標を平行移動)。

## Phase 44: 地面グリッドを無限グリッド化+表示トグルを追加

有限の`THREE.GridHelper(200,20)`をカメラ追従クアッド+シェーダ(fwidthアンチエイリアス、
10mm補助線/100mm主線、距離フェード)による無限グリッドへ置き換え、「グリッド表示」トグル
(既定ON、`showGrid`)をトップバーへ追加した。gate結果: tsc/Vitest(674+1skip)/E2E(51件)
全通過、UIバンドルgzip262.0KB(+0.9KB、上限350KB内)。
