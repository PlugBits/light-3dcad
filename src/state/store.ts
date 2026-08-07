// ドキュメント状態(正本)と派生・UI状態を1つのZustandストアで管理する。
// Three.jsシーン自体はReact stateに入れない(CadViewerが直接ストアをsubscribeする)。
import { create } from "zustand";

import {
  addExtrudeFeature,
  addFillet3DFeature,
  addPartInstanceFeature,
  addRevolveFeature,
  addShellFeature,
  addSketchFeature,
  addThreadFeature,
  createEmptyDocument,
  effectiveFeatureCount,
  findFeature,
  removeFeatureCascade,
  resolveEvaluationDocument,
  setRollbackIndex as setDocRollbackIndex,
} from "../model/document";
import { createRectangleEntity } from "../model/entity";
import { threadDrillDiameter } from "../model/threadPresets";
import type {
  CadDocument,
  ExtrudeFeature,
  FeatureId,
  FilletEdgeRef,
  ShellFaceRef,
  ThreadFaceRef,
  ThreadPreset,
  WorldPlaneName,
} from "../model/types";
import type { BodyGroup, EdgeInfo, FaceInfo, MeshData, MeshQuality, ReferenceEdgeSet, SketchPlaneInfo, WorkerResponse } from "../protocol/messages";
import { deserializeProject, serializeProject } from "../project/serialization";
import { updateReferenceEdgeSnapshots } from "../sketch/referenceEdgeMatch";
import { solveDocumentSketches } from "../sketch/solver";
import { createHistoryState, pushHistory, redoHistory, undoHistory, type HistoryState } from "./history";

/**
 * 自動保存(Phase 26)のlocalStorageキー。ドキュメント変更のたびに500msデバウンスで
 * serializeProject()した文字列を保存する(useCadStore.subscribe、本ファイル末尾参照)。
 * typeof localStorage チェックは、Vitest(environment: "node")等ブラウザAPIが無い環境で
 * モジュール読み込み時にReferenceErrorにならないようにするため(store.test.tsはこのファイルを
 * importするがWorker同様、実際のlocalStorageアクセスは行われない)。
 */
const AUTOSAVE_KEY = "light-3dcad:autosave:v1";
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

/** ドキュメント変更から500ms後にlocalStorageへ保存する(短時間の連続変更をまとめる)。 */
function scheduleAutosave(doc: CadDocument) {
  if (typeof localStorage === "undefined") return;
  if (autosaveTimer !== null) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    try {
      localStorage.setItem(AUTOSAVE_KEY, serializeProject(doc));
    } catch {
      // 容量超過・プライベートブラウジング等でlocalStorageが使えない場合は諦める(自動保存は補助機能のため)。
    }
  }, 500);
}

/** 起動時、自動保存があれば復元する。無い・壊れている場合はnull(呼び出し側が従来の初期ドキュメントにフォールバックする)。 */
function loadAutosavedDocument(): CadDocument | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY);
    if (!text) return null;
    const result = deserializeProject(text);
    return result.ok ? result.doc : null;
  } catch {
    return null;
  }
}

/** 自動保存を消去する(「新規」ボタン用)。 */
function clearAutosave() {
  if (typeof localStorage === "undefined") return;
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    // ignore
  }
}

export type EvalStatus = "initializing" | "evaluating" | "ready" | "error";

/** ビューアで選択中の面(faceInfoの1要素相当)。 */
export type SelectedFace = FaceInfo;

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

function postRequest(request: { kind: "evaluate" | "exportStl" | "exportStep"; doc: CadDocument; quality?: MeshQuality }) {
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

/**
 * undo/redo後、選択中フィーチャーが復元後のドキュメントにまだ存在するかを判定する
 * (存在すれば選択を維持したまま返し、無ければnullでクリアする)。selectedFaceは
 * トポロジカルネーミングのずれで復元後も有効か判定しづらいため、常にクリアする(呼び出し側)。
 * Workerに依存しない純粋関数として切り出し、単体テストできるようにする。
 */
export function resolveSelectionAfterHistory(doc: CadDocument, selectedFeatureId: FeatureId | null): FeatureId | null {
  if (selectedFeatureId === null) return null;
  return findFeature(doc, selectedFeatureId) ? selectedFeatureId : null;
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
  /** 各B-Repエッジの付加情報(Phase 25a、3Dフィレット/面取りのエッジ選択に使う派生状態)。 */
  edgeInfo: EdgeInfo[];
  /** 各スケッチの解決済み平面基底(origin/xDir/yDir/normal)。ビューアのスケッチ線描画に使う派生状態。 */
  sketchPlanes: SketchPlaneInfo[];
  /**
   * 各スケッチの評価時点の「現在ボディ」から抽出したスケッチ平面上の直線エッジ(Phase 22、
   * ボディ端面参照寸法のオーバーレイ・寸法ツールのピック対象に使う派生状態)。
   */
  referenceEdges: ReferenceEdgeSet[];
  /** 各ボディを構成する面IDの集合(Phase 28a、部品ドラッグ配置ツールのヒット判定に使う派生状態)。 */
  bodyGroups: BodyGroup[];
  errorMessage: string | null;
  errorFeatureId: FeatureId | null;
  /** 現在表示中のmesh/faceInfo/errorに対応する最新のevaluateリクエストID(古い応答の破棄に使う)。 */
  latestEvaluateRequestId: string | null;

  /** ビューアで現在選択中の面(未選択はnull)。 */
  selectedFace: SelectedFace | null;

  /** スケッチ線オーバーレイの表示/非表示(デフォルトON)。 */
  showSketches: boolean;
  /** スケッチ線オーバーレイの表示/非表示を切り替える。 */
  setShowSketches: (visible: boolean) => void;

  exporting: boolean;
  exportError: string | null;

  /**
   * 簡易アンドゥ/リドゥ履歴(Phase 14)。updateDocument()で変更する度に変更前のドキュメントの
   * スナップショット(JSON構造のコピー)がpastへ積まれる(上限50件)。選択状態は履歴に含めない
   * (アンドゥ/リドゥ時は選択解除するのみ)。
   */
  history: HistoryState<CadDocument>;
  /** 1つ前のドキュメント状態に戻し、再評価を要求する。履歴が無ければ何もしない。 */
  undo: () => void;
  /** undo()を取り消し、やり直す。やり直せる履歴が無ければ何もしない。 */
  redo: () => void;

  /** Workerを起動し、ready後に初期ドキュメントを評価する。複数回呼んでも安全(冪等)。 */
  initialize: () => void;
  /** ドキュメントを更新し、直ちに(デバウンスなしで)再評価を要求する。変更前の状態を履歴に積む。 */
  updateDocument: (updater: (doc: CadDocument) => CadDocument) => void;
  /**
   * ドラッグ操作(部品移動、Phase 28a)の開始時に呼ぶ。現在のドキュメントを履歴に1回だけpushする
   * (doc自体・再評価は変更しない)。以降のドラッグ中の更新は updateDocumentDuringDrag() で
   * 履歴を積まずに行うことで、ドラッグ全体(開始〜終了)がアンドゥ1回になる。
   */
  beginDragHistory: () => void;
  /**
   * ドラッグ中(部品移動、Phase 28a)の直接更新。updateDocument()と異なり履歴を積まない
   * (beginDragHistory()で開始点を1回だけpush済みの前提)。呼び出し側(CadViewerの150ms
   * スロットル)の都合で高頻度に呼ばれることを想定する。
   */
  updateDocumentDuringDrag: (updater: (doc: CadDocument) => CadDocument) => void;
  /** フィーチャーツリーの選択を変更する。 */
  selectFeature: (featureId: FeatureId | null) => void;
  /**
   * ロールバックバーの位置を移動する(SolidWorks風)。indexはfeatures配列の先頭から数えた
   * 有効フィーチャー数(null/features.length以上は「末尾」=全フィーチャー有効を表す)。
   * updateDocument()経由で行うため、アンドゥ/リドゥの対象になる。
   */
  setRollbackIndex: (index: number | null) => void;
  /** 指定平面(省略時XY)の空スケッチフィーチャーを追加し、選択状態にする。 */
  addSketch: (plane?: WorldPlaneName) => void;
  /** 指定スケッチを対象にした押し出しフィーチャーを追加し、選択状態にする。 */
  addExtrude: (sketchId: FeatureId) => void;
  /** フィーチャーを削除する(依存する後続フィーチャーもカスケード削除)。 */
  removeFeature: (featureId: FeatureId) => void;
  /** ビューアでの面選択状態を更新する(nullで選択解除)。 */
  selectFace: (face: SelectedFace | null) => void;
  /**
   * 現在選択中の平面な面を新しいスケッチ平面として、face参照スケッチフィーチャーを追加する。
   * 参照フィーチャーIDには「現在のボディを生成した履歴末尾のジオメトリ系フィーチャー」
   * (= doc.features中、最後に登場するextrudeフィーチャー)のIDを使う。
   * 平面でない面が選択されている、またはボディが存在しない場合は何もしない。
   */
  addFaceSketch: () => void;
  /** 現在のドキュメントをSTLとしてエクスポートする(exporting/exportErrorはストアで管理)。 */
  exportStl: () => Promise<Blob>;
  /** 現在のドキュメントをSTEPとしてエクスポートする(Phase 26。exporting/exportErrorはexportStlと共有)。 */
  exportStep: () => Promise<Blob>;
  /**
   * 現在選択中の3Dエッジ群(ビューアのエッジ選択ツールで確定した配列)を対象に、
   * 3Dフィレット/面取りフィーチャーを追加し、選択状態にする(Phase 25a)。
   */
  addFillet3D: (kind: "fillet" | "chamfer", size: number, edges: FilletEdgeRef[]) => void;
  /**
   * 現在選択中の面群(ビューアの面選択ツールで確定した配列)を対象に、シェル(中抜き)
   * フィーチャーを追加し、選択状態にする(Phase 25b)。
   */
  addShell3D: (thickness: number, faces: ShellFaceRef[]) => void;
  /** 指定スケッチを対象にした回転体フィーチャーを追加し、選択状態にする(Phase 25b)。 */
  addRevolve: (sketchId: FeatureId) => void;
  /**
   * ねじ配置ツール(ビューアで平面をクリックして確定した面・位置)を対象に、ねじフィーチャーを
   * 追加し、選択状態にする(Phase 25c)。directionは省略時、雄は面法線方向(+1、外側へボスが
   * 伸びる)、雌は面法線と逆方向(-1、内側へ穴が伸びる)をデフォルトにする。
   */
  addThread: (params: { preset: ThreadPreset; hand: "male" | "female"; length: number; face: ThreadFaceRef; position: [number, number] }) => void;

  /**
   * 部品配置(簡易アセンブリ、Phase 27b)フィーチャーを追加し、選択状態にする。
   * partは.l3dcadから読み込んだ(deserializeProject()で検証済みの)CadDocumentを渡す想定。
   * position/rotationは省略時は原点・無回転([0,0,0])。
   */
  addPartInstance: (params: {
    name: string;
    part: CadDocument;
    position?: [number, number, number];
    rotation?: [number, number, number];
  }) => void;

  /**
   * ドキュメントを丸ごと差し替える(プロジェクトを開く/新規作成、Phase 26)。undo()/redo()と異なり
   * アンドゥ履歴は保持しない(空にリセットする)。選択状態(フィーチャー・面)もクリアし、直ちに再評価する。
   */
  loadDocument: (doc: CadDocument) => void;
  /**
   * 新規プロジェクト(Phase 26)。空ドキュメントに差し替え、自動保存も消去する
   * (呼び出し側=UIで確認ダイアログを出してから呼ぶ想定)。
   */
  newProject: () => void;
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
    // 既存のdistanceEntityLine(refEdge)拘束のスナップショットを、最新のreferenceEdgesと
    // 幾何マッチングして追従させる(Phase 22)。ここではsolveDocumentSketches()やWorker再評価は
    // 発行しない(スナップショット更新自体は現在のジオメトリに影響しないため。マッチした新しい
    // スナップショットは次回のupdateDocument()呼び出しから反映される。既知の制限として
    // docs/PLAN.mdに記載)。
    const nextDoc = updateReferenceEdgeSnapshots(get().doc, response.referenceEdges);
    set({
      doc: nextDoc,
      status: "ready",
      mesh: response.mesh,
      faceInfo: response.faceInfo,
      edgeInfo: response.edgeInfo,
      sketchPlanes: response.sketchPlanes,
      referenceEdges: response.referenceEdges,
      bodyGroups: response.bodyGroups,
      errorMessage: null,
      errorFeatureId: null,
    });
  } else if (response.kind === "error") {
    set({
      status: "error",
      errorMessage: response.message,
      errorFeatureId: response.featureId ?? null,
    });
  }
}

export const useCadStore = create<CadStoreState>((set, get) => ({
  // 起動時、自動保存(localStorage、Phase 26)があればそれを初期ドキュメントとして復元する。
  // 無い・壊れている場合は従来どおりの初期ドキュメント(XYスケッチ矩形->押し出し)にフォールバックする。
  doc: loadAutosavedDocument() ?? createInitialDocument(),
  selectedFeatureId: null,

  status: "initializing",
  mesh: null,
  faceInfo: [],
  edgeInfo: [],
  sketchPlanes: [],
  referenceEdges: [],
  bodyGroups: [],
  errorMessage: null,
  errorFeatureId: null,
  latestEvaluateRequestId: null,

  selectedFace: null,

  showSketches: true,
  setShowSketches: (visible) => set({ showSketches: visible }),

  exporting: false,
  exportError: null,

  history: createHistoryState<CadDocument>(),

  undo: () => {
    const result = undoHistory(get().history, structuredClone(get().doc));
    if (!result) return;
    const { requestId, promise } = postRequest({ kind: "evaluate", doc: resolveEvaluationDocument(result.doc) });
    // 復元後のドキュメントに選択中フィーチャーがまだ存在するなら選択状態を維持する
    // (スケッチ編集中のCtrl+Zでスケッチから抜けてしまう問題の修正)。selectedFaceは
    // トポロジカルネーミングのずれで復元後も有効か判定しづらいため、従来どおりクリアする。
    set({
      doc: result.doc,
      status: "evaluating",
      latestEvaluateRequestId: requestId,
      history: result.state,
      selectedFeatureId: resolveSelectionAfterHistory(result.doc, get().selectedFeatureId),
      selectedFace: null,
    });
    promise.then((response) => applyEvaluated(set, get, requestId, response));
  },

  redo: () => {
    const result = redoHistory(get().history, structuredClone(get().doc));
    if (!result) return;
    const { requestId, promise } = postRequest({ kind: "evaluate", doc: resolveEvaluationDocument(result.doc) });
    // undo()と同じく、復元後のドキュメントに選択中フィーチャーがまだ存在するなら選択状態を維持する。
    set({
      doc: result.doc,
      status: "evaluating",
      latestEvaluateRequestId: requestId,
      history: result.state,
      selectedFeatureId: resolveSelectionAfterHistory(result.doc, get().selectedFeatureId),
      selectedFace: null,
    });
    promise.then((response) => applyEvaluated(set, get, requestId, response));
  },

  initialize: () => {
    // "evaluate" は Worker側で ensureOC() を経由するため、別途 "init" 往復は不要。
    const { requestId, promise } = postRequest({ kind: "evaluate", doc: resolveEvaluationDocument(get().doc) });
    set({ status: "evaluating", latestEvaluateRequestId: requestId });
    promise.then((response) => applyEvaluated(set, get, requestId, response));
  },

  updateDocument: (updater) => {
    const prevDoc = get().doc;
    const updatedDoc = updater(prevDoc);
    if (updatedDoc === prevDoc) return;
    const nextHistory = pushHistory(get().history, structuredClone(prevDoc));

    // 拘束(SketchConstraint、Phase 20a)を持つsketchがあれば、Worker評価に回す前にsolveSketch()で
    // segmentsを解いた状態に置き換える(ソルバは純粋TSでメインスレッドで完結する)。
    // いずれかのスケッチで矛盾(過拘束)が検出された場合は評価そのものをスキップし、
    // featureId付きのエラーとして表示する(既存のWorker評価エラーと同じerrorMessage/errorFeatureId経路)。
    const solved = solveDocumentSketches(updatedDoc);
    if (solved.conflict) {
      const requestId = nextRequestId(); // 実際にはWorkerへ送らないが、latestEvaluateRequestIdを進めて古い応答を無効化する。
      set({
        doc: updatedDoc,
        status: "error",
        errorMessage: solved.conflict.message,
        errorFeatureId: solved.conflict.featureId,
        latestEvaluateRequestId: requestId,
        history: nextHistory,
      });
      return;
    }

    const nextDoc = solved.doc;
    const { requestId, promise } = postRequest({ kind: "evaluate", doc: resolveEvaluationDocument(nextDoc) });
    set({ doc: nextDoc, status: "evaluating", latestEvaluateRequestId: requestId, history: nextHistory });
    promise.then((response) => applyEvaluated(set, get, requestId, response));
  },

  beginDragHistory: () => {
    const nextHistory = pushHistory(get().history, structuredClone(get().doc));
    set({ history: nextHistory });
  },

  updateDocumentDuringDrag: (updater) => {
    const prevDoc = get().doc;
    const updatedDoc = updater(prevDoc);
    if (updatedDoc === prevDoc) return;

    // updateDocument()と同じくソルバを経由する(部品移動自体は拘束を持たないが、他のスケッチとの
    // 整合性を崩さないため同じ経路を通す)。履歴(history)はここではpushしない。
    const solved = solveDocumentSketches(updatedDoc);
    if (solved.conflict) {
      const requestId = nextRequestId();
      set({
        doc: updatedDoc,
        status: "error",
        errorMessage: solved.conflict.message,
        errorFeatureId: solved.conflict.featureId,
        latestEvaluateRequestId: requestId,
      });
      return;
    }

    const nextDoc = solved.doc;
    const { requestId, promise } = postRequest({ kind: "evaluate", doc: resolveEvaluationDocument(nextDoc) });
    set({ doc: nextDoc, status: "evaluating", latestEvaluateRequestId: requestId });
    promise.then((response) => applyEvaluated(set, get, requestId, response));
  },

  selectFeature: (featureId) => set({ selectedFeatureId: featureId }),

  setRollbackIndex: (index) => {
    get().updateDocument((doc) => setDocRollbackIndex(doc, index));
    // ロールバックで選択中フィーチャーが範囲外になった場合は選択を解除する
    // (範囲外フィーチャーは選択不可の方針。インデックス比較は現在のdoc.featuresの並び順に基づく)。
    const nextDoc = get().doc;
    const selected = get().selectedFeatureId;
    if (selected) {
      const idx = nextDoc.features.findIndex((f) => f.id === selected);
      if (idx === -1 || idx >= effectiveFeatureCount(nextDoc)) {
        set({ selectedFeatureId: null });
      }
    }
  },

  addSketch: (plane = "XY") => {
    const doc = get().doc;
    const { doc: nextDoc, feature } = addSketchFeature(doc, {
      name: nextFeatureName(doc, "Sketch"),
      plane: { kind: "world", plane },
      entities: [],
    });
    get().updateDocument(() => nextDoc);
    set({ selectedFeatureId: feature.id });
  },

  addExtrude: (sketchId) => {
    const doc = get().doc;
    // ボディが既に存在する(=extrudeフィーチャーが1つ以上ある)場合は"add"、
    // 無ければ"newBody"をデフォルトにする(Phase 13)。追加直後の一時的なエラーを避けるため。
    const hasBody = doc.features.some((f) => f.type === "extrude");
    const { doc: nextDoc, feature } = addExtrudeFeature(doc, {
      name: nextFeatureName(doc, "Extrude"),
      sketchId,
      distance: 10,
      direction: 1,
      operation: hasBody ? "add" : "newBody",
    });
    get().updateDocument(() => nextDoc);
    set({ selectedFeatureId: feature.id });
  },

  addFillet3D: (kind, size, edges) => {
    if (edges.length === 0) return;
    const doc = get().doc;
    const namePrefix = kind === "fillet" ? "フィレット" : "面取り";
    const { doc: nextDoc, feature } = addFillet3DFeature(doc, {
      name: nextFeatureName(doc, namePrefix),
      kind,
      size,
      edges,
    });
    get().updateDocument(() => nextDoc);
    set({ selectedFeatureId: feature.id });
  },

  addShell3D: (thickness, faces) => {
    if (faces.length === 0) return;
    const doc = get().doc;
    const { doc: nextDoc, feature } = addShellFeature(doc, {
      name: nextFeatureName(doc, "シェル"),
      thickness,
      faces,
    });
    get().updateDocument(() => nextDoc);
    set({ selectedFeatureId: feature.id });
  },

  addRevolve: (sketchId) => {
    const doc = get().doc;
    // extrudeと同じ方針: ボディが既に存在する場合は"add"、無ければ"newBody"をデフォルトにする。
    const hasBody = doc.features.some((f) => f.type === "extrude" || f.type === "revolve");
    const { doc: nextDoc, feature } = addRevolveFeature(doc, {
      name: nextFeatureName(doc, "Revolve"),
      sketchId,
      axis: "x",
      angle: 360,
      operation: hasBody ? "add" : "newBody",
    });
    get().updateDocument(() => nextDoc);
    set({ selectedFeatureId: feature.id });
  },

  addThread: ({ preset, hand, length, face, position }) => {
    const doc = get().doc;
    const count = doc.features.filter((f) => f.type === "thread").length + 1;
    const name =
      hand === "male"
        ? `${preset}ねじ${count}`
        : `${preset}ねじ穴${count}(簡易表現・下穴φ${threadDrillDiameter(preset).toFixed(1)})`;
    const { doc: nextDoc, feature } = addThreadFeature(doc, {
      name,
      hand,
      preset,
      length,
      face,
      position,
      // 雄はボスが面から外側(法線方向)へ伸び、雌は穴が面から内側(法線と逆方向)へ伸びる。
      direction: hand === "male" ? 1 : -1,
    });
    get().updateDocument(() => nextDoc);
    set({ selectedFeatureId: feature.id });
  },

  addPartInstance: ({ name, part, position, rotation }) => {
    const doc = get().doc;
    const { doc: nextDoc, feature } = addPartInstanceFeature(doc, {
      name,
      part,
      position: position ?? [0, 0, 0],
      rotation: rotation ?? [0, 0, 0],
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

  selectFace: (face) => set({ selectedFace: face }),

  addFaceSketch: () => {
    const face = get().selectedFace;
    if (!face || !face.isPlanar) return;

    const doc = get().doc;
    // 履歴末尾から最初に見つかるextrudeフィーチャー = 現在のボディを生成したフィーチャー。
    let lastExtrude: ExtrudeFeature | null = null;
    for (let i = doc.features.length - 1; i >= 0; i -= 1) {
      const f = doc.features[i];
      if (f.type === "extrude") {
        lastExtrude = f;
        break;
      }
    }
    if (!lastExtrude) return;

    const { doc: nextDoc, feature } = addSketchFeature(doc, {
      name: nextFeatureName(doc, "FaceSketch"),
      plane: {
        kind: "face",
        featureId: lastExtrude.id,
        faceId: face.faceId,
        center: face.center,
        normal: face.normal,
      },
      entities: [],
    });
    get().updateDocument(() => nextDoc);
    set({ selectedFeatureId: feature.id, selectedFace: null });
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

  exportStep: async () => {
    set({ exporting: true, exportError: null });
    try {
      const { promise } = postRequest({ kind: "exportStep", doc: get().doc });
      const response = await promise;
      if (response.kind === "step") {
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

  loadDocument: (doc) => {
    const { requestId, promise } = postRequest({ kind: "evaluate", doc: resolveEvaluationDocument(doc) });
    // undo()/redo()と違い、履歴は空にリセットする(プロジェクトの切り替えは別の編集セッションとして扱う)。
    set({
      doc,
      status: "evaluating",
      latestEvaluateRequestId: requestId,
      history: createHistoryState<CadDocument>(),
      selectedFeatureId: null,
      selectedFace: null,
      errorMessage: null,
      errorFeatureId: null,
    });
    promise.then((response) => applyEvaluated(set, get, requestId, response));
  },

  newProject: () => {
    clearAutosave();
    get().loadDocument(createEmptyDocument());
  },
}));

// ドキュメントが変わるたびに(500msデバウンスで)自動保存する(Phase 26)。undo/redo/loadDocument等、
// updateDocument()を経由しない変更も含めてstate.docの同一性(===)比較で検知する。
useCadStore.subscribe((state, prevState) => {
  if (state.doc !== prevState.doc) {
    scheduleAutosave(state.doc);
  }
});
