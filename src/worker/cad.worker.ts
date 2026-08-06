/// <reference lib="webworker" />

// Replicad(opencascade.js WASM)のimportはこのファイル内(および evaluator.ts)に限定する。
// UI側バンドルにOpenCascadeを含めないため。
import initOpenCascadeUntyped from "replicad-opencascadejs/src/replicad_single.js";
import wasmUrl from "replicad-opencascadejs/src/replicad_single.wasm?url";
import { setOC, type Shape3D } from "replicad";
import type { OpenCascadeInstance } from "replicad-opencascadejs/src/replicad_single.js";

import type { CadDocument, FeatureId } from "../model/types";
import type { EdgeInfo, FaceGroup, FaceInfo, MeshData, MeshQuality, UiRequest, WorkerResponse } from "../protocol/messages";
import { evaluateDocument } from "./evaluator";

// replicad-opencascadejsのd.tsは引数なしの署名しか宣言していないが、実装(emscripten生成の
// モジュールファクトリ)は `{ locateFile }` などのModuleオーバーライドを受け取れる。
// 実物は node_modules/replicad-opencascadejs/src/replicad_single.js の末尾で
// `function(Module) { Module = Module || {}; ... }` という形のファクトリになっている。
const initOpenCascade = initOpenCascadeUntyped as unknown as (moduleOverrides: {
  locateFile: (path: string) => string;
}) => Promise<OpenCascadeInstance>;

const DEFAULT_QUALITY: MeshQuality = { tolerance: 0.1, angularTolerance: 30 };

let ocReady: Promise<void> | null = null;

function ensureOC(): Promise<void> {
  if (!ocReady) {
    ocReady = initOpenCascade({ locateFile: () => wasmUrl }).then((OC) => {
      setOC(OC);
    });
  }
  return ocReady;
}

/** shape.mesh() の結果をTransferable用のTypedArrayに変換する。 */
function toMeshData(shape: Shape3D, quality: MeshQuality): MeshData {
  const shapeMesh = shape.mesh({ tolerance: quality.tolerance, angularTolerance: quality.angularTolerance });
  const edgeMesh = shape.meshEdges({ tolerance: quality.tolerance, angularTolerance: quality.angularTolerance });

  const faceGroups: FaceGroup[] = shapeMesh.faceGroups.map((g) => ({
    start: g.start,
    count: g.count,
    faceId: g.faceId,
  }));

  return {
    positions: Float32Array.from(shapeMesh.vertices),
    normals: Float32Array.from(shapeMesh.normals),
    indices: Uint32Array.from(shapeMesh.triangles),
    faceGroups,
    edges: Float32Array.from(edgeMesh.lines),
    edgeGroups: edgeMesh.edgeGroups,
  };
}

/**
 * shapeの各B-Repエッジについて中点・両端点を集めた配列を作る(Phase 25a、3Dエッジ選択・
 * フィレット/面取りフィーチャーのスナップショット用)。
 * edgeId は edge.hashCode(= meshEdges()のedgeGroups.edgeIdと同じ値)。
 * 使用したreplicad API: Shape.edges / Edge.hashCode / Edge.startPoint / Edge.endPoint /
 * Edge.pointAt(0.5)(_1DShape.pointAt()のデフォルト値。曲線に沿った弧長中点)。
 */
function computeEdgeInfo(shape: Shape3D): EdgeInfo[] {
  const infos: EdgeInfo[] = [];
  for (const edge of shape.edges) {
    const startVec = edge.startPoint;
    const endVec = edge.endPoint;
    const midVec = edge.pointAt(0.5);
    infos.push({
      edgeId: edge.hashCode,
      p1: startVec.toTuple(),
      p2: endVec.toTuple(),
      midpoint: midVec.toTuple(),
    });
    startVec.delete();
    endVec.delete();
    midVec.delete();
    edge.delete();
  }
  return infos;
}

/**
 * shapeの各面(B-Rep face)について中心・法線・平面判定を集めた配列を作る。
 * faceId は face.hashCode(= mesh()のfaceGroups.faceIdと同じ値)。
 * 使用したreplicad API: Shape.faces / Face.center / Face.normalAt() / Face.geomType。
 */
function computeFaceInfo(shape: Shape3D): FaceInfo[] {
  const infos: FaceInfo[] = [];
  for (const face of shape.faces) {
    const center = face.center;
    const normal = face.normalAt();
    infos.push({
      faceId: face.hashCode,
      center: center.toTuple(),
      normal: normal.toTuple(),
      isPlanar: face.geomType === "PLANE",
    });
    center.delete();
    normal.delete();
    face.delete();
  }
  return infos;
}

function postResponse(response: WorkerResponse, transfer: Transferable[] = []) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(response, transfer);
}

/** ボディが存在しない(押し出しフィーチャーが無い)場合の空メッシュ。ビューア側は既存メッシュ・エッジを消去する。 */
function emptyMeshData(): MeshData {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
    faceGroups: [],
    edges: new Float32Array(0),
    edgeGroups: [],
  };
}

function evaluateAndRespond(requestId: string, doc: CadDocument, quality: MeshQuality) {
  const result = evaluateDocument(doc);
  if (!result.ok) {
    postResponse({
      kind: "error",
      requestId,
      featureId: result.featureId as FeatureId | undefined,
      message: result.message,
    });
    return;
  }

  const { shape, sketchPlanes, referenceEdges } = result;
  if (!shape) {
    // ボディなし(Phase 13): 正常ケースとして空メッシュ+空faceInfo/edgeInfoを返す。
    // sketchPlanesは解決済みのため、スケッチだけの状態でもスケッチ線表示は継続する。
    postResponse({
      kind: "evaluated",
      requestId,
      mesh: emptyMeshData(),
      faceInfo: [],
      edgeInfo: [],
      sketchPlanes,
      referenceEdges,
    });
    return;
  }
  try {
    const mesh = toMeshData(shape, quality);
    const faceInfo = computeFaceInfo(shape);
    const edgeInfo = computeEdgeInfo(shape);
    postResponse(
      { kind: "evaluated", requestId, mesh, faceInfo, edgeInfo, sketchPlanes, referenceEdges },
      [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, mesh.edges.buffer],
    );
  } finally {
    shape.delete();
  }
}

function exportStlAndRespond(requestId: string, doc: CadDocument, quality: MeshQuality) {
  const result = evaluateDocument(doc);
  if (!result.ok) {
    postResponse({
      kind: "error",
      requestId,
      featureId: result.featureId as FeatureId | undefined,
      message: result.message,
    });
    return;
  }

  const { shape } = result;
  if (!shape) {
    // STLエクスポートにはボディが必要(ボディなしは表示上は正常だが、出力対象が無い)。
    postResponse({
      kind: "error",
      requestId,
      message: "ドキュメントに有効なボディがありません(押し出しフィーチャーがありません)",
    });
    return;
  }
  try {
    const blob = shape.blobSTL({ tolerance: quality.tolerance, angularTolerance: quality.angularTolerance });
    postResponse({ kind: "stl", requestId, blob });
  } finally {
    shape.delete();
  }
}

self.addEventListener("message", (event: MessageEvent<UiRequest>) => {
  const request = event.data;

  (async () => {
    try {
      switch (request.kind) {
        case "init": {
          await ensureOC();
          postResponse({ kind: "ready", requestId: request.requestId });
          break;
        }
        case "evaluate": {
          await ensureOC();
          evaluateAndRespond(request.requestId, request.doc, request.quality ?? DEFAULT_QUALITY);
          break;
        }
        case "exportStl": {
          await ensureOC();
          exportStlAndRespond(request.requestId, request.doc, request.quality ?? DEFAULT_QUALITY);
          break;
        }
      }
    } catch (err) {
      postResponse({
        kind: "error",
        requestId: request.requestId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});
