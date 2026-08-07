// ドキュメント状態(正本)と派生・UI状態を1つのZustandストアで管理する。
// Three.jsシーン自体はReact stateに入れない(CadViewerが直接ストアをsubscribeする)。
import { create } from "zustand";

import {
  addExtrudeFeature,
  addFillet3DFeature,
  addMateFeature,
  addPartInstanceFeature,
  addRevolveFeature,
  addShellFeature,
  addSketchFeature,
  addThreadFeature,
  createEmptyDocument,
  effectiveFeatureCount,
  findFeature,
  patchPartInstanceFeature,
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
  MateFaceRef,
  MateFeature,
  ShellFaceRef,
  ThreadFaceRef,
  ThreadPreset,
  WorldPlaneName,
} from "../model/types";
import type {
  BodyGroup,
  EdgeInfo,
  FaceInfo,
  InterferenceResult,
  MeshData,
  MeshQuality,
  ReferenceEdgeSet,
  SketchPlaneInfo,
  SolvedPlacement,
  WorkerResponse,
} from "../protocol/messages";
import { deserializeProject, serializeProject } from "../project/serialization";
import { updateOriginSnapshots } from "../sketch/originSnapshot";
import { updateReferenceEdgeSnapshots } from "../sketch/referenceEdgeMatch";
import { ensureGcsInitialized, solveDocumentSketchesAsync } from "../sketch/solver";
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

/**
 * 起動クラッシュループ防止(Phase 29a)の「復元開始マーカー」のlocalStorageキー。
 * 自動保存(AUTOSAVE_KEY)を復元しようとする直前に立て、その復元ドキュメントの初回評価が
 * 成功した時点で解除する(applyEvaluated参照)。次回起動時にこのマーカーが残っていれば、
 * 「前回、復元ドキュメントの評価中に(Workerクラッシュ・タブクラッシュ等で)アプリごと
 * 落ちた」とみなし、自動保存の復元をスキップして初期ドキュメントで起動する
 * (自動保存自体は消さない。ユーザーは「再試行」で明示的に読み込み直せる)。
 */
const RESTORE_MARKER_KEY = "light-3dcad:autosave:restoring:v1";

function hasRestoreMarker(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(RESTORE_MARKER_KEY) !== null;
  } catch {
    return false;
  }
}

function markRestoreStarted() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(RESTORE_MARKER_KEY, "1");
  } catch {
    // ignore
  }
}

function markRestoreFinished() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(RESTORE_MARKER_KEY);
  } catch {
    // ignore
  }
}

/**
 * 自動保存を復元するかどうかの判定(Phase 29a)。Workerを一切使わない純粋関数として切り出し、
 * 単体テストできるようにする(tests/state/store.test.ts参照)。
 */
export interface AutosaveRestoreDecision {
  /** 復元に使うドキュメント。復元しない場合はnull(呼び出し側が初期ドキュメントにフォールバックする)。 */
  doc: CadDocument | null;
  /** 前回の復元ドキュメント評価が完了しなかった(マーカーが残っていた)ためスキップした場合true。 */
  skippedDueToPriorFailure: boolean;
}

export function decideAutosaveRestore(markerPresent: boolean, autosavedDoc: CadDocument | null): AutosaveRestoreDecision {
  if (autosavedDoc === null) {
    return { doc: null, skippedDueToPriorFailure: false };
  }
  if (markerPresent) {
    return { doc: null, skippedDueToPriorFailure: true };
  }
  return { doc: autosavedDoc, skippedDueToPriorFailure: false };
}

/**
 * 起動時の初期ドキュメントを決定する(Phase 29a)。自動保存を復元する場合は復元開始マーカーを
 * 立てる(このタイミングで立てないと、initialize()が呼ばれる前にアプリがクラッシュした
 * ケースを検知できない)。
 */
function resolveInitialDocument(): { doc: CadDocument; autosaveRestoreSkipped: boolean } {
  const decision = decideAutosaveRestore(hasRestoreMarker(), loadAutosavedDocument());
  if (decision.doc) {
    markRestoreStarted();
    return { doc: decision.doc, autosaveRestoreSkipped: false };
  }
  return { doc: createInitialDocument(), autosaveRestoreSkipped: decision.skippedDueToPriorFailure };
}

export type EvalStatus = "initializing" | "evaluating" | "ready" | "error";

/** ビューアで選択中の面(faceInfoの1要素相当)。 */
export type SelectedFace = FaceInfo;

interface PendingEntry {
  resolve: (response: WorkerResponse) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * Worker評価リクエストのタイムアウト(Phase 29a、堅牢性強化)。Workerがクラッシュせず
 * 応答も返さない(ハング)場合の保険。通常評価は数百ms〜数秒だが、ねじ入りドキュメントの
 * 評価は数十秒かかることがあるため、種別による使い分けはせず一律120秒にする
 * (仕様: 「通常評価60秒、ねじ入りは重いので一律120秒でよい」)。
 */
const EVALUATE_TIMEOUT_MS = 120_000;

let worker: Worker | null = null;
let requestCounter = 0;
const pending = new Map<string, PendingEntry>();

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/**
 * 保留中の全リクエストを打ち切り、カーネルクラッシュ状態にする(Phase 29a)。
 * Workerの'error'イベント(実クラッシュ・デバッグフック双方)、および個々のリクエストの
 * タイムアウトの両方から呼ぶ(タイムアウトも「Workerが応答しない」という点で実質的に
 * クラッシュと同じ扱いにする。単一Workerはリクエストを順番に処理するため、1件がハングすれば
 * それ以降にキューされた保留中のリクエストも同様に応答が来ない)。
 * 保留中のPromiseは{kind:"error"}応答で解決する(reject にすると呼び出し側全箇所で
 * catch/rejectハンドリングを増やす必要があるため、既存の「Worker応答のkindで分岐する」設計に
 * 合わせる。exportStl/exportStep/checkInterferenceは元々response.kind==="error"を処理済み)。
 * status/errorMessage/errorFeatureIdもここで直接設定する(保留中リクエストが無い状態
 * [アイドル中にデバッグフックでクラッシュさせた場合等]でもUIにカーネルクラッシュを反映するため、
 * applyEvaluated経由の反映だけに頼らない)。
 */
function failAllPendingRequests(message: string) {
  for (const [requestId, entry] of pending) {
    clearTimeout(entry.timeoutId);
    entry.resolve({ kind: "error", requestId, message });
  }
  pending.clear();
  useCadStore.setState({ kernelCrashed: true, status: "error", errorMessage: message, errorFeatureId: null });
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("../worker/cad.worker.ts", import.meta.url), { type: "module" });
  w.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const entry = pending.get(response.requestId);
    if (entry) {
      pending.delete(response.requestId);
      clearTimeout(entry.timeoutId);
      entry.resolve(response);
    }
  });
  // Workerのグローバルスコープで捕捉されない例外が起きると発火する(実クラッシュ、または
  // window.__cadDebugCrashWorker()による意図的な再現、Phase 29a)。既定の動作(コンソールへの
  // エラー出力のみ)に加えて、保留中のリクエストを打ち切りUIにカーネル復旧手段を出す。
  w.addEventListener("error", (event) => {
    event.preventDefault();
    failAllPendingRequests("CADカーネルが応答しません(内部エラーが発生しました)");
  });
  worker = w;
  return w;
}

function postRequest(request: {
  kind: "evaluate" | "exportStl" | "exportStep" | "checkInterference";
  doc: CadDocument;
  quality?: MeshQuality;
}) {
  const w = ensureWorker();
  const requestId = nextRequestId();
  return {
    requestId,
    promise: new Promise<WorkerResponse>((resolve) => {
      const timeoutId = setTimeout(() => {
        failAllPendingRequests("CADカーネルが応答しません(評価がタイムアウトしました)");
      }, EVALUATE_TIMEOUT_MS);
      pending.set(requestId, { resolve, timeoutId });
      w.postMessage({ ...request, requestId });
    }),
  };
}

/**
 * 開発ビルド限定のデバッグフック(Phase 29a)。Workerへ「故意にthrowする」メッセージ
 * (kind:"debugCrash")を送るだけで、応答は待たない(cad.worker.ts側がsetTimeout()内でthrowし、
 * Workerの'error'イベントとして非同期にensureWorker()のリスナーへ届く)。
 * devtoolsから実際にWorkerを強制終了する操作が自動テスト環境では難しいため、E2Eからクラッシュ
 * 復帰(カーネル再起動)を再現・検証するために用意する。
 */
declare global {
  interface Window {
    __cadDebugCrashWorker?: () => void;
  }
}

if (typeof window !== "undefined" && import.meta.env.DEV) {
  window.__cadDebugCrashWorker = () => {
    const w = ensureWorker();
    w.postMessage({ kind: "debugCrash", requestId: nextRequestId() });
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
 * 起動時の初期ドキュメントをモジュール読み込み時に一度だけ決定する(自動保存の復元・
 * 復元開始マーカーの付与はこの1回のみで完結させる。store作成時のdoc初期値、および
 * autosaveRestoreSkippedの初期値の両方でこの結果を使う)。
 */
const initialDocResolution = resolveInitialDocument();

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
  /**
   * ビューアで選択中のスケッチエンティティ/セグメントのid(Phase 31b)。未選択はnull。
   * ツール未使用時にビューア上のスケッチ線を直接クリックした際の強調表示・SketchEditorパネルの
   * 該当欄への自動スクロール&一時ハイライトに使う。selectedFeatureIdが指すスケッチ内のid
   * (entities/segmentsどちらのidも入りうる)を想定する。
   */
  selectedEntityId: string | null;
  /**
   * ビューア上のスケッチ線直接クリック(Phase 31b)による選択。対象スケッチをselectedFeatureIdに、
   * クリックしたentity/segmentのidをselectedEntityIdに設定する。
   */
  selectSketchEntity: (sketchId: FeatureId, entityId: string) => void;

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

  /**
   * Workerがクラッシュ・ハングした状態かどうか(Phase 29a)。trueの間、UIは通常の評価エラー表示
   * ではなく「CADカーネルが応答しません」+「カーネル再起動」ボタンを表示する。errorMessage自体は
   * 通常の評価エラーと同じ経路(response.kind==="error")で設定されるため、この専用フラグで
   * 表示を出し分ける。restartKernel()の成功、または新しい評価が正常に完了すると false に戻る。
   */
  kernelCrashed: boolean;
  /** カーネルを再起動する(旧Workerをterminate→新Workerを起動→最新docで再評価、Phase 29a)。 */
  restartKernel: () => void;

  /**
   * 起動クラッシュループ防止(Phase 29a)。前回、自動保存の復元ドキュメントの評価中にアプリごと
   * 落ちたと判断し(復元開始マーカーが残っていた)、自動保存の復元をスキップして初期ドキュメントで
   * 起動した場合にtrue(自動保存自体は保持されている)。retryAutosaveRestore()の呼び出しでfalseに戻す。
   */
  autosaveRestoreSkipped: boolean;
  /** スキップした自動保存を明示的に読み込み直す(「再試行」ボタン、Phase 29a)。 */
  retryAutosaveRestore: () => void;

  /** ビューアで現在選択中の面(未選択はnull)。 */
  selectedFace: SelectedFace | null;

  /** スケッチ線オーバーレイの表示/非表示(デフォルトON)。 */
  showSketches: boolean;
  /** スケッチ線オーバーレイの表示/非表示を切り替える。 */
  setShowSketches: (visible: boolean) => void;

  exporting: boolean;
  exportError: string | null;

  /**
   * 干渉チェック(Phase 28b)の直近の結果。オンデマンド実行のみ(自動実行はしない)。
   * 未実行・クリア後はnull。ドキュメントが変更されると(doc参照が変わるたびに)結果が古くなるため
   * 自動的にnullへクリアされる(本ファイル末尾のuseCadStore.subscribe参照)。
   */
  interferenceResult: InterferenceResult | null;
  /** 干渉チェックのWorker往復中かどうか(ツールバーの実行中インジケータに使う)。 */
  interferenceChecking: boolean;
  /** 干渉チェックがエラーになった場合のメッセージ(未発生・クリア後はnull)。 */
  interferenceError: string | null;

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
  /**
   * ドキュメントを更新し、直ちに(デバウンスなしで)再評価を要求する。変更前の状態を履歴に積む。
   * 戻り値のPromiseは、スケッチ拘束solve(PlaneGCS)+状態反映(set())が完了した時点で解決する
   * (Phase 35c。呼び出し側の大半はfire-and-forgetで結果を待たないが、
   * src/state/constraintUpdate.tsのupdateDocumentWithConflictRollback()のように「solve結果を見て
   * 追加のロールバックを行う」呼び出し元はawaitする)。PlaneGCS初期化が完了していれば
   * マイクロタスク1回分の遅延で解決し、アプリ起動直後の初期化未完了ウィンドウのみ実際に待つ。
   */
  updateDocument: (updater: (doc: CadDocument) => CadDocument) => Promise<void>;
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
  updateDocumentDuringDrag: (updater: (doc: CadDocument) => CadDocument) => Promise<void>;
  /** フィーチャーツリーの選択を変更する(selectedEntityId[Phase 31b]はクリアする)。 */
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
   * 合致(メイト、Phase 28c)フィーチャーを追加し、選択状態にする。追加直後、Worker評価が
   * (他のフィーチャー追加と同じ経路で)自動的に発行され、evaluator.ts側のソルバが解いた配置が
   * evaluate応答経由でこのfeature.a/bが参照するpartInstanceへ書き戻される(即ソルブ)。
   */
  addMate: (params: { name: string; kind: MateFeature["kind"]; value?: number; a: MateFaceRef; b: MateFaceRef }) => void;

  /**
   * 干渉チェック(Phase 28b)を実行する。全ボディ(部品配置による追加ボディも含む)をペアごとに
   * 交差判定し、結果をinterferenceResultに反映する(オンデマンド実行のみ、ドキュメント評価の
   * たびに自動実行はしない)。呼び出し側(UI)は戻り値のpairs件数で「干渉なし」トースト表示等を
   * 判断できる(エラー時はnullを返し、interferenceErrorに詳細が入る)。
   */
  checkInterference: () => Promise<InterferenceResult | null>;
  /** 干渉チェック結果(赤ハイライト・一覧)をクリアする(「クリア」ボタン、ドキュメント編集時の自動クリア)。 */
  clearInterference: () => void;

  /**
   * ドキュメントを丸ごと差し替える(プロジェクトを開く/新規作成、Phase 26)。undo()/redo()と異なり
   * アンドゥ履歴は保持しない(空にリセットする)。選択状態(フィーチャー・面)もクリアし、直ちに再評価する。
   */
  loadDocument: (doc: CadDocument) => void;

  /**
   * 参照切れ時の再選択UI(Phase 29b)用のプレビュー: featureIdの「直前」まで(featureId自体・
   * それ以降は除く)だけを評価した結果を、mesh/faceInfo/edgeInfo/bodyGroupsとして一時的に
   * ビューアへ反映する。doc・history・errorMessage/errorFeatureId・latestEvaluateRequestIdは
   * 一切変更しない、fire-and-forgetの補助リクエスト(通常の評価フローの結果と競合しない)。
   *
   * fillet3d/shell/thread/mateフィーチャーが参照切れでエラーになっている間、
   * ストアのmesh/faceInfo/edgeInfoは「最後に成功した評価」のまま止まっている(直前の編集
   * [ボディ寸法変更等]が反映されていない)。エッジ/面選択ツール・ねじ配置ツール・合致ツールは
   * ビューア側が保持するmesh由来のデータ(edgeGroups等)をクリック時点でライブ参照するため、
   * 再選択を始める前にこれを呼んで「対象フィーチャーを適用する直前の、今の最新ボディ」を
   * 一度だけ取り直しておくことで、選び直しが最新のジオメトリに対して行われるようにする
   * (truncated評価も失敗した場合は何もしない=現在表示中のmesh/faceInfo/edgeInfoのままにする)。
   */
  previewFeatureContext: (featureId: FeatureId) => void;
  /**
   * 新規プロジェクト(Phase 26)。空ドキュメントに差し替え、自動保存も消去する
   * (呼び出し側=UIで確認ダイアログを出してから呼ぶ想定)。
   */
  newProject: () => void;
}

/**
 * 合致(メイト、Phase 28c)ソルバが解いた配置を、対応するpartInstanceフィーチャーへ書き戻す。
 * src/sketch/solver.tsの拘束ソルバの書き戻し(updateDocument内でsolveDocumentSketches()の結果を
 * そのままdocに反映する)と異なり、こちらはWorker評価応答(非同期)を受け取った後に反映するため、
 * applyEvaluated()内でupdateReferenceEdgeSnapshots()と同じく「Worker再評価もアンドゥ履歴への
 * pushも行わない、直接のdoc置き換え」として行う(解いた配置自体は既にジオメトリに反映済みの
 * meshで表示されているため、doc側の数値を合わせるだけで再評価は不要)。
 */
function applyMateSolvedPlacements(doc: CadDocument, placements: SolvedPlacement[]): CadDocument {
  let next = doc;
  for (const placement of placements) {
    next = patchPartInstanceFeature(next, placement.featureId, {
      position: placement.position,
      rotation: placement.rotation,
    });
  }
  return next;
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
    const withReferenceEdges = updateReferenceEdgeSnapshots(get().doc, response.referenceEdges);
    // 原点系拘束(distanceEntityOrigin/distancePointOrigin/coincidentOrigin)のoriginLocalスナップショットを
    // 最新のsketchPlanesから追従させる(仕様変更対応、updateReferenceEdgeSnapshotsと同じくWorker再評価は
    // 発行しない)。
    const withOrigin = updateOriginSnapshots(withReferenceEdges, response.sketchPlanes);
    // 合致(メイト、Phase 28c)ソルバが解いた配置を書き戻す(履歴は積まない、上記コメント参照)。
    const nextDoc = applyMateSolvedPlacements(withOrigin, response.solvedPlacements);
    // 起動クラッシュループ防止(Phase 29a): 評価が成功した時点で復元開始マーカーを解除する
    // (マーカーが立っていなければ no-op)。「初回評価が成功したら」という仕様どおり、
    // 実際には毎回の成功評価で呼ぶ(冪等なので安全、かつ通常の編集中の評価成功でも解除されて
    // いなければならない値ではない)。
    markRestoreFinished();
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
      kernelCrashed: false,
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
  // 無い・壊れている・前回その復元中に落ちた(復元開始マーカーが残っている、Phase 29a)場合は
  // 従来どおりの初期ドキュメント(XYスケッチ矩形->押し出し)にフォールバックする
  // (resolveInitialDocument()参照。モジュール読み込み時に一度だけ計算済み)。
  doc: initialDocResolution.doc,
  selectedFeatureId: null,
  selectedEntityId: null,
  selectSketchEntity: (sketchId, entityId) => set({ selectedFeatureId: sketchId, selectedEntityId: entityId }),

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

  kernelCrashed: false,
  restartKernel: () => {
    // 旧Workerを破棄する(以後のensureWorker()は新しいWorkerを生成する)。
    if (worker) {
      worker.terminate();
      worker = null;
    }
    // pending中のPromiseは破棄する(念のため解決だけしておく。通常はfailAllPendingRequests()で
    // 既に解決済みのはずだが、タイムアウト前にユーザーが手動で再起動した場合等に備える)。
    for (const [requestId, entry] of pending) {
      clearTimeout(entry.timeoutId);
      entry.resolve({ kind: "error", requestId, message: "カーネル再起動のため中断されました" });
    }
    pending.clear();

    // 新Workerを生成("evaluate"は内部でensureOC()を経由するため、別途"init"往復は不要。
    // initialize()と同じ考え方)し、最新のドキュメントで再評価する。
    const { requestId, promise } = postRequest({ kind: "evaluate", doc: resolveEvaluationDocument(get().doc) });
    set({
      status: "evaluating",
      latestEvaluateRequestId: requestId,
      kernelCrashed: false,
      errorMessage: null,
      errorFeatureId: null,
    });
    promise.then((response) => applyEvaluated(set, get, requestId, response));
  },

  autosaveRestoreSkipped: initialDocResolution.autosaveRestoreSkipped,
  retryAutosaveRestore: () => {
    const autosaved = loadAutosavedDocument();
    if (!autosaved) return;
    // 復元を試みる直前に再度マーカーを立てる(この読み込み中にまた落ちた場合、次回起動時にも
    // スキップされるようにする)。loadDocument()の評価が成功すればapplyEvaluated()が解除する。
    markRestoreStarted();
    set({ autosaveRestoreSkipped: false });
    get().loadDocument(autosaved);
  },

  selectedFace: null,

  showSketches: true,
  setShowSketches: (visible) => set({ showSketches: visible }),

  exporting: false,
  exportError: null,

  interferenceResult: null,
  interferenceChecking: false,
  interferenceError: null,

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

    // PlaneGCSソルバの初期化(Phase 35b-1、Phase 35cで旧ソルバのフォールバックを撤去)。
    // src/sketch/solver.tsのensureGcsInitialized()がgcsAdapter.tsを動的importすることで、
    // メインバンドルにはPlaneGCSのJSラッパー・WASMを含めない(npm run sizeの許容増分数KB以内)。
    // 完了までのsolveSketch()呼び出し(updateDocument()/updateDocumentDuringDrag()経由)は
    // このPromiseの完了を待ってから解く(solveDocumentSketchesAsync()参照)。
    void ensureGcsInitialized();
  },

  updateDocument: (updater) => {
    const prevDoc = get().doc;
    const updatedDoc = updater(prevDoc);
    if (updatedDoc === prevDoc) return Promise.resolve();
    const nextHistory = pushHistory(get().history, structuredClone(prevDoc));

    // 拘束(SketchConstraint、Phase 20a)を持つsketchがあれば、Worker評価に回す前にsolveSketch()で
    // segmentsを解いた状態に置き換える(ソルバは純粋TSでメインスレッドで完結する)。
    // いずれかのスケッチで矛盾(過拘束)が検出された場合は評価そのものをスキップし、
    // featureId付きのエラーとして表示する(既存のWorker評価エラーと同じerrorMessage/errorFeatureId経路)。
    // solveDocumentSketchesAsync()はPlaneGCS(WASM)初期化が完了していれば実質同期的に(マイクロ
    // タスク1回分だけ遅れて)解決し、アプリ起動直後の初期化未完了ウィンドウでは初期化完了を
    // 待ってから解く(Phase 35c、旧ソルバのフォールバックを撤去したため)。
    return solveDocumentSketchesAsync(updatedDoc).then((solved) => {
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
    });
  },

  beginDragHistory: () => {
    const nextHistory = pushHistory(get().history, structuredClone(get().doc));
    set({ history: nextHistory });
  },

  updateDocumentDuringDrag: (updater) => {
    const prevDoc = get().doc;
    const updatedDoc = updater(prevDoc);
    if (updatedDoc === prevDoc) return Promise.resolve();

    // updateDocument()と同じくソルバを経由する(部品移動自体は拘束を持たないが、他のスケッチとの
    // 整合性を崩さないため同じ経路を通す)。履歴(history)はここではpushしない。GCS初期化未完了時の
    // 待ち合わせもupdateDocument()と同じ(solveDocumentSketchesAsync()参照)。
    return solveDocumentSketchesAsync(updatedDoc).then((solved) => {
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
    });
  },

  selectFeature: (featureId) => set({ selectedFeatureId: featureId, selectedEntityId: null }),

  setRollbackIndex: (index) => {
    // nextDocはここでローカルに計算する(updateDocument()はPhase 35cでGCS初期化待ちのため
    // 非同期になったので、直後にget().doc を読んでも更新後の値が反映されているとは限らない)。
    // rollbackIndex・features配列の並びはsolveDocumentSketches()では変わらない(segments/entities
    // の座標のみ更新される)ため、選択解除の判定はこのローカルなnextDocで行って問題ない。
    const nextDoc = setDocRollbackIndex(get().doc, index);
    get().updateDocument(() => nextDoc);
    // ロールバックで選択中フィーチャーが範囲外になった場合は選択を解除する
    // (範囲外フィーチャーは選択不可の方針。インデックス比較は現在のdoc.featuresの並び順に基づく)。
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

  addMate: ({ name, kind, value, a, b }) => {
    const doc = get().doc;
    const { doc: nextDoc, feature } = addMateFeature(doc, { name, kind, value, a, b });
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

  checkInterference: async () => {
    set({ interferenceChecking: true, interferenceError: null });
    try {
      const { promise } = postRequest({ kind: "checkInterference", doc: resolveEvaluationDocument(get().doc) });
      const response = await promise;
      if (response.kind === "interference") {
        set({ interferenceChecking: false, interferenceResult: response.interference, interferenceError: null });
        return response.interference;
      }
      const message = response.kind === "error" ? response.message : `予期しない応答: ${response.kind}`;
      set({ interferenceChecking: false, interferenceResult: null, interferenceError: message });
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ interferenceChecking: false, interferenceResult: null, interferenceError: message });
      return null;
    }
  },

  clearInterference: () => set({ interferenceResult: null, interferenceError: null }),

  loadDocument: (doc) => {
    const { requestId, promise } = postRequest({ kind: "evaluate", doc: resolveEvaluationDocument(doc) });
    // undo()/redo()と違い、履歴は空にリセットする(プロジェクトの切り替えは別の編集セッションとして扱う)。
    set({
      doc,
      status: "evaluating",
      latestEvaluateRequestId: requestId,
      history: createHistoryState<CadDocument>(),
      selectedFeatureId: null,
      selectedEntityId: null,
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

  previewFeatureContext: (featureId) => {
    const doc = get().doc;
    const idx = doc.features.findIndex((f) => f.id === featureId);
    if (idx === -1) return;
    const truncated: CadDocument = { ...doc, features: doc.features.slice(0, idx) };
    const { promise } = postRequest({ kind: "evaluate", doc: resolveEvaluationDocument(truncated) });
    promise.then((response) => {
      if (response.kind !== "evaluated") return;
      // 通常の評価フロー(applyEvaluated)とは独立: latestEvaluateRequestId等は変更しない。
      set({
        mesh: response.mesh,
        faceInfo: response.faceInfo,
        edgeInfo: response.edgeInfo,
        bodyGroups: response.bodyGroups,
      });
    });
  },
}));

// ドキュメントが変わるたびに(500msデバウンスで)自動保存する(Phase 26)。undo/redo/loadDocument等、
// updateDocument()を経由しない変更も含めてstate.docの同一性(===)比較で検知する。
// 干渉チェック結果(Phase 28b)もここで自動クリアする: checkInterference()自体はdocを変更しない
// (Worker往復のみ)ため、この購読はundo/redo/updateDocument/loadDocument等の「実際のドキュメント
// 変更」でのみ発火し、干渉チェックを実行しただけでは結果は消えない。
useCadStore.subscribe((state, prevState) => {
  if (state.doc !== prevState.doc) {
    scheduleAutosave(state.doc);
    if (state.interferenceResult !== null || state.interferenceError !== null) {
      useCadStore.setState({ interferenceResult: null, interferenceError: null });
    }
  }
});
