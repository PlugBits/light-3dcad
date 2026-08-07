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
  | { kind: "checkInterference"; requestId: string; doc: CadDocument; quality?: MeshQuality };

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
}

/**
 * 各B-Repエッジの付加情報(Phase 25a、3Dフィレット/面取りのエッジ選択に使う)。
 * edgeIdはreplicadのedge.hashCode(meshEdges()のedgeGroups.edgeIdと同じ値、再評価で変わりうる
 * 一時的なID)。midpoint/p1/p2はワールド座標(mm)で、edge.pointAt(0.5)/startPoint/endPointから
 * 算出する(曲線エッジも含め常に取得できる。円弧の場合pointAt(0.5)は弧長中点に相当)。
 */
export interface EdgeInfo {
  edgeId: number;
  midpoint: [number, number, number];
  p1: [number, number, number];
  p2: [number, number, number];
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
 * 1本の直線エッジ(スケッチローカル2D座標、Phase 22)。
 * スケッチ平面上に載っている(両端点の平面距離<1e-4)直線エッジのみを対象とする(v1、円弧等は非対応)。
 */
export interface ReferenceEdgeLine {
  p1: [number, number];
  p2: [number, number];
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
    }
  | { kind: "stl"; requestId: string; blob: Blob }
  /** STEPエクスポート応答(Phase 26)。 */
  | { kind: "step"; requestId: string; blob: Blob }
  /** 干渉チェック応答(Phase 28b)。 */
  | { kind: "interference"; requestId: string; interference: InterferenceResult }
  | { kind: "error"; requestId: string; featureId?: FeatureId; message: string }
  | { kind: "progress"; requestId: string; message: string };
