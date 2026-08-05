// ドキュメント状態(正本)と派生・UI状態を1つのZustandストアで管理する。
// Three.jsシーン自体はReact stateに入れない(CadViewerが直接ストアをsubscribeする)。
import { create } from "zustand";

import {
  addExtrudeFeature,
  addSketchFeature,
  createEmptyDocument,
  findFeature,
  removeFeatureCascade,
} from "../model/document";
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
function createInitialDocument(): CadDocument {
  const empty = createEmptyDocument();
  const rect = createRectangleEntity({ width: 60, height: 40 });
  const { doc: docWithSketch, feature: sketch } = addSketchFeature(empty, {
    name: "Sketch1",
    plane: { kind: "world", plane: "XY" },
    entities: [rect],
  });
  const { doc } = addExtrudeFeature(docWithSketch, {
    name: "Extrude1",
    sketchId: sketch.id,
    distance: 20,
    direction: 1,
    operation: "newBody",
  });
  return doc;
}

/** name が prefix+数字の形式である既存フィーチャーの最大番号+1を返す(例: "Sketch" -> 既存Sketch1,Sketch2があれば3)。 */
function nextFeatureName(doc: CadDocument, prefix: string): string {
  let max = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  for (const f of doc.features) {
    const m = re.exec(f.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

interface CadStoreState {
  doc: CadDocument;
  /** フィーチャーツリーで選択中のフィーチャー(編集パネルの対象)。未選択はnull。 */
  selectedFeatureId: FeatureId | null;

  status: EvalStatus;
  mesh: MeshData | null;
  faceInfo: FaceInfo[];
  errorMessage: string | null;
  errorFeatureId: FeatureId | null;
  /** 現在表示中のmesh/faceInfo/errorに対応する最新のevaluateリクエストID(古い応答の破棄に使う)。 */
  latestEvaluateRequestId: string | null;

  exporting: boolean;
  exportError: string | null;

  /** Workerを起動し、ready後に初期ドキュメントを評価する。複数回呼んでも安全(冪等)。 */
  initialize: () => void;
  /** ドキュメントを更新し、直ちに(デバウンスなしで)再評価を要求する。 */
  updateDocument: (updater: (doc: CadDocument) => CadDocument) => void;
  /** フィーチャーツリーの選択を変更する。 */
  selectFeature: (featureId: FeatureId | null) => void;
  /** XY平面固定の空スケッチフィーチャーを追加し、選択状態にする。 */
  addSketch: () => void;
  /** 指定スケッチを対象にした押し出しフィーチャーを追加し、選択状態にする。 */
  addExtrude: (sketchId: FeatureId) => void;
  /** フィーチャーを削除する(依存する後続フィーチャーもカスケード削除)。 */
  removeFeature: (featureId: FeatureId) => void;
  /** 現在のドキュメントをSTLとしてエクスポートする(exporting/exportErrorはストアで管理)。 */
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
  doc: createInitialDocument(),
  selectedFeatureId: null,

  status: "initializing",
  mesh: null,
  faceInfo: [],
  errorMessage: null,
  errorFeatureId: null,
  latestEvaluateRequestId: null,

  exporting: false,
  exportError: null,

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

  selectFeature: (featureId) => set({ selectedFeatureId: featureId }),

  addSketch: () => {
    const doc = get().doc;
    const { doc: nextDoc, feature } = addSketchFeature(doc, {
      name: nextFeatureName(doc, "Sketch"),
      plane: { kind: "world", plane: "XY" },
      entities: [],
    });
    get().updateDocument(() => nextDoc);
    set({ selectedFeatureId: feature.id });
  },

  addExtrude: (sketchId) => {
    const doc = get().doc;
    const { doc: nextDoc, feature } = addExtrudeFeature(doc, {
      name: nextFeatureName(doc, "Extrude"),
      sketchId,
      distance: 10,
      direction: 1,
      operation: "newBody",
    });
    get().updateDocument(() => nextDoc);
    set({ selectedFeatureId: feature.id });
  },

  removeFeature: (featureId) => {
    const doc = get().doc;
    const nextDoc = removeFeatureCascade(doc, featureId);
    if (nextDoc === doc) return;
    get().updateDocument(() => nextDoc);
    const selected = get().selectedFeatureId;
    if (selected && !findFeature(nextDoc, selected)) {
      set({ selectedFeatureId: null });
    }
  },

  exportStl: async () => {
    set({ exporting: true, exportError: null });
    try {
      const { promise } = postRequest({ kind: "exportStl", doc: get().doc });
      const response = await promise;
      if (response.kind === "stl") {
        set({ exporting: false });
        return response.blob;
      }
      const message = response.kind === "error" ? response.message : `予期しない応答: ${response.kind}`;
      throw new Error(message);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ exporting: false, exportError: message });
      throw err;
    }
  },
}));
