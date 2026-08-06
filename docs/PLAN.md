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
