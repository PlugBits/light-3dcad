// UI <-> Worker で共有するメッセージ型。
// このファイルは副作用のない純粋TypeScript(Replicad等の重い依存はimportしない)。

/** 矩形押し出しボックスのパラメータ(mm単位)。Phase 0ではこれだけをハードコード形状として扱う。 */
export interface BoxParams {
  width: number;
  height: number;
  distance: number;
}

/** UI -> Worker のリクエスト */
export type UiRequest =
  | { kind: "init"; requestId: string }
  | { kind: "generateBox"; requestId: string; params: BoxParams }
  | { kind: "exportStl"; requestId: string; params: BoxParams };

/** 三角形メッシュ。頂点数(vertices)・法線(normals)は3成分/頂点、triangles は頂点インデックス。 */
export interface MeshData {
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
  /** 三角形インデックス範囲(indices配列基準、頂点単位ではなく [start, start+count) )とB-Rep面IDの対応 */
  faceGroups: FaceGroup[];
}

export interface FaceGroup {
  /** triangles 配列中の開始インデックス(3の倍数) */
  start: number;
  /** triangles 配列中の要素数(3の倍数) */
  count: number;
  /** B-Rep面ID(replicadのfaceIndex) */
  faceId: number;
}

/** Worker -> UI のレスポンス */
export type WorkerResponse =
  | { kind: "ready"; requestId: string }
  | { kind: "boxGenerated"; requestId: string; mesh: MeshData }
  | { kind: "stlReady"; requestId: string; blob: Blob }
  | { kind: "error"; requestId: string; message: string };
