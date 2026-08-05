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
  | { kind: "exportStl"; requestId: string; doc: CadDocument; quality?: MeshQuality };

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
}

export interface FaceGroup {
  /** indices 配列中の開始インデックス(3の倍数) */
  start: number;
  /** indices 配列中の要素数(3の倍数) */
  count: number;
  /** B-Rep面ID(replicadの face.hashCode。再評価で値が変わりうる一時的なID) */
  faceId: number;
}

/** 各B-Rep面の付加情報。面選択→スケッチ平面化に使う。 */
export interface FaceInfo {
  faceId: number;
  center: [number, number, number];
  normal: [number, number, number];
  isPlanar: boolean;
}

/** Worker -> UI のレスポンス */
export type WorkerResponse =
  | { kind: "ready"; requestId: string }
  | { kind: "evaluated"; requestId: string; mesh: MeshData; faceInfo: FaceInfo[] }
  | { kind: "stl"; requestId: string; blob: Blob }
  | { kind: "error"; requestId: string; featureId?: FeatureId; message: string }
  | { kind: "progress"; requestId: string; message: string };
