// ドキュメント状態(正本)と派生・UI状態を1つのZustandストアで管理する。
// Three.jsシーン自体はReact stateに入れない(CadViewerが直接ストアをsubscribeする)。
import { create } from "zustand";

import { addExtrudeFeature, addSketchFeature, createEmptyDocument } from "../model/document";
import { createRectangleEntity } from "../model/entity";
import type { CadDocument, FeatureId } from "../model/types";
import type { FaceInfo, MeshData, MeshQuality, WorkerResponse } from "../protocol/messages";

export type EvalStatus = "initializing" | "evaluating" | "ready" | "error";

interface PendingEntry {
  resolve: (response: WorkerResponse) => void;
}

let worker: Worker | null = null;
let requestCounter = 0;
const pending = new Map<string, PendingEntry>();

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("../worker/cad.worker.ts", import.meta.url), { type: "module" });
  w.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const entry = pending.get(response.requestId);
    if (entry) {
      pending.delete(response.requestId);
      entry.resolve(response);
    }
  });
  worker = w;
  return w;
}

function postRequest(request: { kind: "evaluate" | "exportStl"; doc: CadDocument; quality?: MeshQuality }) {
  const w = ensureWorker();
  const requestId = nextRequestId();
  return {
    requestId,
    promise: new Promise<WorkerResponse>((resolve) => {
      pending.set(requestId, { resolve });
      w.postMessage({ ...request, requestId });
    }),
  };
}

/** 初期ドキュメント: XYスケッチ(矩形60x40) -> 押し出し20mm(newBody)。 */
function createInitialDocument(): { doc: CadDocument; sketchId: FeatureId; entityId: string; extrudeId: FeatureId } {
  const empty = createEmptyDocument();
  const rect = createRectangleEntity({ width: 60, height: 40 });
  const { doc: docWithSketch, feature: sketch } = addSketchFeature(empty, {
    name: "Sketch1",
    plane: { kind: "world", plane: "XY" },
    entities: [rect],
  });
  const { doc, feature: extrude } = addExtrudeFeature(docWithSketch, {
    name: "Extrude1",
    sketchId: sketch.id,
    distance: 20,
    direction: 1,
    operation: "newBody",
  });
  return { doc, sketchId: sketch.id, entityId: rect.id, extrudeId: extrude.id };
}

const initial = createInitialDocument();

interface CadStoreState {
  doc: CadDocument;
  /** 初期ドキュメントの主要フィーチャーID(Phase1の簡易UIが直接編集する対象)。 */
  initialSketchId: FeatureId;
  initialEntityId: string;
  initialExtrudeId: FeatureId;

  status: EvalStatus;
  mesh: MeshData | null;
  faceInfo: FaceInfo[];
  errorMessage: string | null;
  errorFeatureId: FeatureId | null;
  /** 現在表示中のmesh/faceInfo/errorに対応する最新のevaluateリクエストID(古い応答の破棄に使う)。 */
  latestEvaluateRequestId: string | null;

  /** Workerを起動し、ready後に初期ドキュメントを評価する。複数回呼んでも安全(冪等)。 */
  initialize: () => void;
  /** ドキュメントを更新し、直ちに(デバウンスなしで)再評価を要求する。 */
  updateDocument: (updater: (doc: CadDocument) => CadDocument) => void;
  /** 現在のドキュメントをSTLとしてエクスポートする。 */
  exportStl: () => Promise<Blob>;
}

function applyEvaluated(
  set: (partial: Partial<CadStoreState>) => void,
  get: () => CadStoreState,
  requestId: string,
  response: WorkerResponse,
) {
  // 新しいドキュメント変更が先に発行されていれば、この応答は古いので破棄する。
  if (get().latestEvaluateRequestId !== requestId) return;

  if (response.kind === "evaluated") {
    set({ status: "ready", mesh: response.mesh, faceInfo: response.faceInfo, errorMessage: null, errorFeatureId: null });
  } else if (response.kind === "error") {
    set({
      status: "error",
      errorMessage: response.message,
      errorFeatureId: response.featureId ?? null,
    });
  }
}

export const useCadStore = create<CadStoreState>((set, get) => ({
  doc: initial.doc,
  initialSketchId: initial.sketchId,
  initialEntityId: initial.entityId,
  initialExtrudeId: initial.extrudeId,

  status: "initializing",
  mesh: null,
  faceInfo: [],
  errorMessage: null,
  errorFeatureId: null,
  latestEvaluateRequestId: null,

  initialize: () => {
    // "evaluate" は Worker側で ensureOC() を経由するため、別途 "init" 往復は不要。
    const { requestId, promise } = postRequest({ kind: "evaluate", doc: get().doc });
    set({ status: "evaluating", latestEvaluateRequestId: requestId });
    promise.then((response) => applyEvaluated(set, get, requestId, response));
  },

  updateDocument: (updater) => {
    const nextDoc = updater(get().doc);
    const { requestId, promise } = postRequest({ kind: "evaluate", doc: nextDoc });
    set({ doc: nextDoc, status: "evaluating", latestEvaluateRequestId: requestId });
    promise.then((response) => applyEvaluated(set, get, requestId, response));
  },

  exportStl: () => {
    const { promise } = postRequest({ kind: "exportStl", doc: get().doc });
    return promise.then((response) => {
      if (response.kind === "stl") return response.blob;
      if (response.kind === "error") {
        throw new Error(response.message);
      }
      throw new Error(`予期しない応答: ${response.kind}`);
    });
  },
}));
