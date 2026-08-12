// UI <-> Worker で共有するメッセージ型。
// このファイルは副作用のない純粋TypeScript(Replicad等の重い依存はimportしない)。

import type { CadDocument, FeatureId } from "../model/types";

/** mesh() / exportSTL() の許容誤差設定。省略時はWorker側のデフォルトを使う。 */
export interface MeshQuality {
  tolerance: number;
  angularTolerance: number;
}

/** UI -> Worker のリクエスト */
export type UiRequest =
  | { kind: "init"; requestId: string }
  | { kind: "evaluate"; requestId: string; doc: CadDocument; quality?: MeshQuality }
  | { kind: "exportStl"; requestId: string; doc: CadDocument; quality?: MeshQuality }
  /** STEPエクスポート(Phase 26)。replicadのblobSTEP()はメッシュ許容誤差を取らないためqualityは無い。 */
  | { kind: "exportStep"; requestId: string; doc: CadDocument }
  /**
   * 干渉チェック(Phase 28b)。全ボディ(部品配置による追加ボディも含む)をペアごとに交差判定する。
   * オンデマンド実行のみ(自動実行はしない、重くなるため)。qualityは交差領域のメッシュ化に使う。
   */
  | { kind: "checkInterference"; requestId: string; doc: CadDocument; quality?: MeshQuality }
  /**
   * 開発ビルド限定のデバッグ用リクエスト(Phase 29a)。Workerのグローバルスコープで
   * 捕捉されない例外を意図的に発生させ、実際のWorkerクラッシュ(Workerのerrorイベント)を
   * 再現する(devtoolsから実際にWorkerを強制終了する操作がテスト環境では難しいため)。
   * window.__cadDebugCrashWorker()(src/state/store.ts、import.meta.env.DEV時のみ公開)から送る。
   * このリクエスト自体はrequestIdに対する応答を返さない(意図的に無応答のまま=呼び出し元は
   * Worker側の"error"イベントかタイムアウト監視で気づく設計)。
   */
  | { kind: "debugCrash"; requestId: string };

/**
 * 三角形メッシュ(Transferable化のためTypedArray化済み)。
 * positions/normals は3成分/頂点、indices は頂点インデックス(3個で1三角形)。
 */
export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** 三角形インデックス範囲(indices配列基準、頂点単位ではなく [start, start+count) )とB-Rep面IDの対応 */
  faceGroups: FaceGroup[];
  /** エッジの線分頂点列(2点で1線分、3成分/点)。省略可(未計算時は空配列)。 */
  edges: Float32Array;
  /**
   * edges配列中の各B-Repエッジの範囲(Phase 25a、3Dエッジ選択のスクリーン距離ヒット判定用)。
   * start/countは頂点単位(edges配列は3成分/点なのでfloatオフセットは*3)。
   * replicadのShape.meshEdges()がそのまま返す形をprotocol型として転送する。
   */
  edgeGroups: EdgeGroup[];
}

export interface FaceGroup {
  /** indices 配列中の開始インデックス(3の倍数) */
  start: number;
  /** indices 配列中の要素数(3の倍数) */
  count: number;
  /** B-Rep面ID(replicadの face.hashCode。再評価で値が変わりうる一時的なID) */
  faceId: number;
}

/**
 * 1ボディ(bodies Mapの1要素)を構成する面IDの集合(Phase 28a、部品ドラッグ配置の
 * ヒット判定用)。featureIdはそのボディを作ったフィーチャーのid(newBody操作のextrude/revolve、
 * またはpartInstance)。UI側はクリックした面のfaceId(FaceGroup.faceId)からこの配列を引いて
 * 所属ボディのfeatureIdを特定し、それがpartInstanceフィーチャーかどうかでドラッグ対象を判定する。
 * mesh(全ボディのcompound)のfaceIdと同じ値になる(src/worker/evaluator.tsのコメント参照:
 * replicadのShape.clone()・makeCompound()はいずれも元のOCCT形状を再利用するだけなので
 * face.hashCodeは変化しない)。
 */
export interface BodyGroup {
  featureId: FeatureId;
  faceIds: number[];
}

/** 各B-Rep面の付加情報。面選択→スケッチ平面化に使う。 */
export interface FaceInfo {
  faceId: number;
  center: [number, number, number];
  normal: [number, number, number];
  isPlanar: boolean;
  /**
   * 面の種別(平面/円筒/その他、Phase 28c)。isPlanarはgeomType==="PLANE"と同値の後方互換フィールドで
   * 残す(既存コードとの互換のため)。合致(メイト)ツールは円筒面も選択対象にするため、
   * isPlanarだけでは平面以外を一括りにしか判定できず、"cylinder"かどうかを個別に判定する必要がある。
   */
  surface: "plane" | "cylinder" | "other";
}

/**
 * 各B-Repエッジの付加情報(Phase 25a、3Dフィレット/面取りのエッジ選択に使う)。
 * edgeIdはreplicadのedge.hashCode(meshEdges()のedgeGroups.edgeIdと同じ値、再評価で変わりうる
 * 一時的なID)。midpoint/p1/p2はワールド座標(mm)で、edge.pointAt(0.5)/startPoint/endPointから
 * 算出する(曲線エッジも含め常に取得できる。円弧の場合pointAt(0.5)は弧長中点に相当)。
 * length/isClosedはedge.length/edge.isClosedから取得する(Phase 29c)。穴の縁のような閉じた円形
 * エッジはp1===p2(始点=終点)となり方向ベクトルが定義できないため、幾何マッチングのフォールバック
 * (src/worker/evaluator.tsのmatchFilletEdgesInBody参照)で閉エッジ専用の判定(中点距離+長さ一致)
 * に使う。
 */
export interface EdgeInfo {
  edgeId: number;
  midpoint: [number, number, number];
  p1: [number, number, number];
  p2: [number, number, number];
  length: number;
  isClosed: boolean;
}

/** MeshData.edgeGroups の1要素。B-Repエッジ1本に対応するedges配列中の頂点範囲。 */
export interface EdgeGroup {
  start: number;
  count: number;
  edgeId: number;
}

/**
 * 解決済みのスケッチ平面基底(ワールド座標系)。
 * origin/xDir/yDir/normal はevaluatorがスケッチのDrawingを乗せる際に実際に使う
 * Plane(replicad)の基底と厳密に一致する(evaluator.tsのbuildFacePlane/buildFacePlaneBasisを参照)。
 * スケッチのローカル2D座標 (u, v) のワールド座標は origin + u*xDir + v*yDir。
 * 面参照の解決に失敗したスケッチはこの配列に含まれない。
 */
export interface SketchPlaneInfo {
  sketchId: FeatureId;
  origin: [number, number, number];
  xDir: [number, number, number];
  yDir: [number, number, number];
  normal: [number, number, number];
}

/**
 * 1本の直線参照線(スケッチローカル2D座標、Phase 22。追加項目でsourceを追加)。
 * source:"edge"はスケッチ平面上に載っている(両端点の平面距離<1e-4)ボディの直線エッジそのもの(v1、
 * 円弧等は非対応)。source:"faceIntersection"はスケッチ平面と垂直な平面フェイスとスケッチ平面との
 * 交線(範囲はその面のバウンディング内にクリップ)で、スケッチ外オブジェクトの側面等からの寸法指定を
 * 可能にする(追加項目)。表示・ピック挙動はいずれも同じ(破線グレー統一)なので、寸法ツール側の
 * ハンドリングはsourceを区別しない。省略はレガシーデータ用のフォールバックとして"edge"扱い。
 */
export interface ReferenceEdgeLine {
  p1: [number, number];
  p2: [number, number];
  source?: "edge" | "faceIntersection";
}

/**
 * 1スケッチ分のボディ端面参照エッジ集合(Phase 22)。そのスケッチが評価された時点の「現在ボディ」
 * (そのスケッチより前のフィーチャーで組み立てられたボディのスナップショット)から抽出する
 * (src/worker/evaluator.ts参照)。ボディが存在しない時点のスケッチは含まれない。
 */
export interface ReferenceEdgeSet {
  sketchId: FeatureId;
  edges: ReferenceEdgeLine[];
}

/**
 * ねじフィーチャー1件分の簡易表示(コスメティック表示)用メタデータ(Phase 41)。
 * Phase 40までは雄ねじは実ヘリカルねじ山ソリッド(loft+fuse)を生成していたが、評価が重く
 * (数秒〜十数秒)見た目も破綻しやすいため、Phase 41で雄ねじも呼び径円柱(majorRadius)の
 * 単純ソリッドへ簡素化した。その代わり、ビューア側が実際のB-Repに描く「二重円+ヘリックス線」の
 * オーバーレイ描画に必要な情報をここに集約する(src/viewer/CadViewer.tsが読む)。
 * position/axisDirはワールド座標(evaluator.tsのapplyThreadToBodies()が実際のソリッド配置に
 * 使うのと同じposition/axisDir、position=ねじ開始点、axisDir=ねじが伸びる方向の単位ベクトル)。
 * majorRadius=呼び径/2。minorRadiusは種別で意味が異なる:
 *   - male: ISO実用値の谷径相当(nominal/2 - THREAD_ENGAGEMENT_FACTOR*pitch)。実ソリッドは
 *     majorRadius円柱のままなので、minorRadiusはあくまで表示専用の線の半径。
 *   - female: 実際に穴として削られている下穴半径(threadDrillDiameter/2)と同じ値。
 *     majorRadius(呼び径/2)の円をエントランス面に描くことで、実穴の縁(minorRadius)に対する
 *     「二重円」効果になる。
 */
export interface ThreadAnnotation {
  /** 元になったthreadフィーチャーのid(Phase 46追加。UI側がthreadAnnotations[]から特定のねじを引くために使う)。 */
  featureId: FeatureId;
  kind: "male" | "female";
  position: [number, number, number];
  axisDir: [number, number, number];
  majorRadius: number;
  minorRadius: number;
  length: number;
}

/**
 * positionRef(Phase 46: ねじのスケッチ参照配置)が設定されたthreadフィーチャー1件分の、
 * 評価で解決した配置位置(面ローカル2D座標、mm)の書き戻し情報。合致(メイト)ソルバの
 * SolvedPlacementと同じ設計(履歴を積まない直接のdoc反映、src/state/store.tsの
 * applyThreadPositionUpdates参照)。positionRefが無いthreadフィーチャーは含まれない。
 */
export interface ThreadPositionUpdate {
  featureId: FeatureId;
  position: [number, number];
}

/**
 * threadフィーチャー1件が今回の評価で実際に解決した配置面のcenter/normal(Phase 47)。
 * ThreadFeature.face.center/normal(ユーザーが最初にねじを配置した時点のクリック値、以後
 * evaluator.tsが再解決しても書き戻されない)とは別物。listThreadPositionRefCandidates()の
 * 「配置基準スケッチと同じ面かどうか」判定はこちら(evaluator.tsが実際に使った、SketchPlaneInfoと
 * 同じ解決経路[resolveFaceGeometry系のhashCode優先+幾何フォールバック]で得た値)を使うことで、
 * ねじ配置後に上流フィーチャー(箱の寸法変更等)で面が動いても判定がずれない。
 * threadフィーチャーが無い、またはその評価が対象ボディ無しで失敗した場合はエントリを作らない。
 */
export interface ThreadFacePlaneInfo {
  threadId: FeatureId;
  center: [number, number, number];
  normal: [number, number, number];
}

/**
 * extrude/revolveフィーチャー1件が実際に作用したボディのfeatureId(Phase 46: 押し出し選択時の
 * 対象ハイライト用)。bodyFeatureIdはbodyGroups[].featureIdと同じ値(そのボディを作ったnewBody
 * フィーチャーのid)で、operation:"newBody"ならfeatureId自身、"cut"/"add"ならevaluator.tsの
 * applyBodyOperation()が実際に解決した対象ボディ(targetBodyId省略時はlastBodyId())になる。
 * ビューアは選択中フィーチャーのidからこの配列を引いてbodyFeatureIdを特定し、bodyGroupsで
 * 該当ボディの面群を強調表示する。
 */
export interface BodyOperationTarget {
  featureId: FeatureId;
  bodyFeatureId: FeatureId;
}

/**
 * 干渉ペア1件の情報(Phase 28b)。a/bはボディを作ったフィーチャー(newBody操作のextrude/revolve、
 * またはpartInstance)のid・名前。volumeは交差体積(mm³、1e-6mm³超のペアのみ報告される。
 * src/worker/evaluator.tsのINTERFERENCE_VOLUME_THRESHOLD参照)。
 */
export interface InterferencePairInfo {
  aFeatureId: FeatureId;
  aName: string;
  bFeatureId: FeatureId;
  bName: string;
  volume: number;
}

/**
 * 干渉チェック(Phase 28b)の応答本体。pairsとmeshesは同じ順序・長さで対応する
 * (meshes[i]がpairs[i]の交差領域のメッシュ、ハイライト表示用)。ボディが1個以下、または
 * 干渉ペアが1つも無い場合はいずれも空配列。
 */
export interface InterferenceResult {
  pairs: InterferencePairInfo[];
  meshes: MeshData[];
}

/**
 * 合致(メイト、Phase 28c)ソルバが解いたpartInstanceの配置1件。position/rotationは
 * PartInstanceFeatureと同じ意味・単位(mm/度)。Worker応答(evaluate)経由でsrc/state/store.tsが
 * 該当partInstanceフィーチャーへ書き戻す(履歴は積まない)。
 */
export interface SolvedPlacement {
  featureId: FeatureId;
  position: [number, number, number];
  rotation: [number, number, number];
}

/** Worker -> UI のレスポンス */
export type WorkerResponse =
  | { kind: "ready"; requestId: string }
  | {
      kind: "evaluated";
      requestId: string;
      mesh: MeshData;
      faceInfo: FaceInfo[];
      /** 各B-Repエッジの付加情報(Phase 25a)。ボディが無い場合は空配列。 */
      edgeInfo: EdgeInfo[];
      sketchPlanes: SketchPlaneInfo[];
      referenceEdges: ReferenceEdgeSet[];
      /** 各ボディを構成する面IDの集合(Phase 28a)。ボディが無い場合は空配列。 */
      bodyGroups: BodyGroup[];
      /** 合致(メイト、Phase 28c)ソルバが解いた配置(合致が無ければ空配列)。 */
      solvedPlacements: SolvedPlacement[];
      /** ねじフィーチャーの簡易表示用メタデータ(Phase 41)。ねじが無ければ空配列。 */
      threadAnnotations: ThreadAnnotation[];
      /** positionRef(Phase 46)で解決した配置位置の書き戻し。対象のthreadフィーチャーが無ければ空配列。 */
      threadPositionUpdates: ThreadPositionUpdate[];
      /** 各threadフィーチャーが今回の評価で実際に解決した配置面(Phase 47)。ねじが無ければ空配列。 */
      threadFacePlanes: ThreadFacePlaneInfo[];
      /** extrude/revolveフィーチャー→実際に作用したボディのfeatureId対応(Phase 46)。フィーチャーが無ければ空配列。 */
      bodyOperationTargets: BodyOperationTarget[];
    }
  | { kind: "stl"; requestId: string; blob: Blob }
  /** STEPエクスポート応答(Phase 26)。 */
  | { kind: "step"; requestId: string; blob: Blob }
  /** 干渉チェック応答(Phase 28b)。 */
  | { kind: "interference"; requestId: string; interference: InterferenceResult }
  | { kind: "error"; requestId: string; featureId?: FeatureId; message: string }
  | { kind: "progress"; requestId: string; message: string };
