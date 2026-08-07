// スケッチ拘束ソルバの公開エントリポイント(Phase 20a〜)。ReactにもThree.jsにもReplicad(OCCT)にも
// 依存しない純粋TypeScript(src/sketch/intersections.ts等と同じ方針)。寸法ドリブン編集(Phase 20b)の土台。
//
// Phase 35b-1でPlaneGCS(FreeCADのSketcherが使う2D幾何拘束ソルバのWASM移植、LGPL-2.1-or-later、
// @salusoft89/planegcs)へ移行し、Phase 35cで自前実装のLevenberg-Marquardt法(旧ソルバ)を完全に
// 撤去した。実際の拘束solveはすべて src/sketch/gcsAdapter.ts (PlaneGCS) が行う。このファイルは
// 型定義・GCS初期化の起動/待ち合わせ・solveSketch()の薄いルーティングのみを持つ。
//
// gcsAdapter.tsは実行時コストの大きいPlaneGCS(WASM)を静的importするため、solver.ts自体からは
// 型だけをimportし(erasedなのでバンドルに影響しない)、実体は動的importで取得する
// (メインバンドル増を数KBに抑える、Phase 35b-1)。アプリ起動時の初期化はこのファイルの
// ensureGcsInitialized()が担う(src/state/store.tsのinitialize()から一度だけ呼ばれる)。
// Vitestはtests/sketch/solver.test.tsのbeforeAllで直接registerGcsAdapter()+initGcs()する。
import type { CadDocument, FeatureId, PointRef, SketchConstraint, SketchEntity, SketchSegment } from "../model/types";
import type * as GcsAdapterModule from "./gcsAdapter";

let gcsAdapter: typeof GcsAdapterModule | null = null;
let gcsInitPromise: Promise<void> | null = null;

/** テスト用: gcsAdapter.tsを直接動的importせずに登録できるようにする(tests/sketch/solver.test.tsのbeforeAll参照)。 */
export function registerGcsAdapter(mod: typeof GcsAdapterModule): void {
  gcsAdapter = mod;
}

/**
 * PlaneGCS(WASM)の初期化を開始する(アプリ起動時に一度だけ呼ぶ想定、src/state/store.tsの
 * initialize()から)。複数回呼んでも初回のPromiseを使い回す。
 * Phase 35cで旧ソルバ(自前LM法)のフォールバックを撤去したため、初期化完了前にsolveSketch()系の
 * 呼び出しが到着した場合は「黙って古い/未解決の形状を返す」のではなく、このPromiseの完了を
 * 待ってから解く(solveDocumentSketchesAsync()参照。src/state/store.tsのupdateDocument()/
 * updateDocumentDuringDrag()が使う)。
 */
export function ensureGcsInitialized(): Promise<void> {
  if (gcsInitPromise) return gcsInitPromise;
  gcsInitPromise = import("./gcsAdapter").then((mod) => {
    registerGcsAdapter(mod);
    return mod.initGcs();
  });
  return gcsInitPromise;
}

/** PlaneGCSの初期化が完了し、solveSketch()を同期的に呼べる状態かどうか。 */
export function isSolverReady(): boolean {
  return gcsAdapter?.isGcsReady() ?? false;
}

export type Point2 = [number, number];

/**
 * ソルバの成功結果。segmentsは入力と同じ順序・同じid・kind・bulgeを保ち、p1/p2のみ更新される。
 * entities(Phase 22)は入力と同じ順序・同じ内容を保つが、circleエンティティのcenterのみ
 * 解いた座標に更新される(circle以外・非circleフィールドは素通し)。呼び出し側がentitiesを
 * 渡さなかった場合は空配列を返す。
 */
export interface SolveSuccess {
  ok: true;
  segments: SketchSegment[];
  entities: SketchEntity[];
}

/** ソルバの失敗結果。conflicting:trueは「拘束が矛盾(または過拘束)していて許容誤差内に収まらなかった」ことを表す。 */
export interface SolveFailure {
  ok: false;
  conflicting: boolean;
  message: string;
}

export type SolveResult = SolveSuccess | SolveFailure;

/**
 * スケッチジオメトリのドラッグ編集(Phase 34)の一時的なドラッグ目標。既存拘束はすべて維持したまま、
 * このターゲットに応じた弱いソフト残差を追加してsolveSketch()を解く(呼び出し側=CadViewerが
 * 毎フレーム、カーソル位置に応じて新しいDragTargetを渡す想定)。
 *
 * どの種別も「デルタ(target - grabPoint)を、掴んだ対象の各変数へ初期値からの移動量として適用したい」
 * という同じ考え方(掴んだ点そのものがカーソル位置に一致するのではなく、掴んだ位置からの
 * 相対移動量をカーソル移動量に一致させる。ドラッグ開始位置がジオメトリ上の厳密な位置から
 * 多少ずれていても、ドラッグ開始時のオフセットを保ったまま追従する自然な挙動になる)。
 *
 * - kind:"point": 自由な線分(セグメント)の端点1つ(PointRef)を直接引っぱる(頂点ドラッグ)。
 *   一致拘束で他の端点と繋がっている場合はクラスタの代表点を渡すこと(呼び出し側の責務。
 *   src/sketch/pointClusters.tsのresolvePointClusterRepresentative()参照)。
 * - kind:"segment": セグメント本体をつかんだ場合。両端点(p1,p2)に同じデルタを適用し、
 *   セグメントを剛体的に動かす目標にする(既存拘束[horizontal/length等]がある分だけ実際の解は歪む)。
 * - kind:"entity": circle/rectangle/regularPolygon(中心)・polygon/slot(並進オフセット)の
 *   いずれかのエンティティ本体をつかんだ場合。中心または並進オフセット変数にデルタを適用する。
 */
export type DragTarget =
  | { kind: "point"; point: PointRef; grabPoint: Point2; target: Point2 }
  | { kind: "segment"; segmentId: string; grabPoint: Point2; target: Point2 }
  | { kind: "entity"; entityId: string; grabPoint: Point2; target: Point2 };

/** solveSketch()の追加オプション(Phase 34)。 */
export interface SolveOptions {
  /** 一時的なドラッグ目標(省略時は通常どおりの解法)。 */
  dragTarget?: DragTarget;
}

/**
 * ガウスの消去法(部分ピボット選択)でAx=bを解く。特異(ピボットが0近傍)なら null。
 * exportしているのは src/assembly/mateSolver.ts(合致ソルバの自前LM実装、Phase 28c。3D部品の
 * 位置/回転を解く、本ソルバとは別物なのでPhase 35cでは変更しない)が同じ実装を再利用するため。
 */
export function solveLinearSystem(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m: number[][] = a.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivotRow = col;
    let maxAbs = Math.abs(m[col][col]);
    for (let r = col + 1; r < n; r += 1) {
      const v = Math.abs(m[r][col]);
      if (v > maxAbs) {
        maxAbs = v;
        pivotRow = r;
      }
    }
    if (maxAbs < 1e-14) return null;
    if (pivotRow !== col) {
      const tmp = m[col];
      m[col] = m[pivotRow];
      m[pivotRow] = tmp;
    }
    const pivotVal = m[col][col];
    for (let r = col + 1; r < n; r += 1) {
      const factor = m[r][col] / pivotVal;
      if (factor === 0) continue;
      for (let c = col; c <= n; c += 1) {
        m[r][c] -= factor * m[col][c];
      }
    }
  }

  const result = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let sum = m[i][n];
    for (let j = i + 1; j < n; j += 1) sum -= m[i][j] * result[j];
    const diag = m[i][i];
    if (Math.abs(diag) < 1e-14) return null;
    result[i] = sum / diag;
  }
  return result;
}

/**
 * スケッチ拘束ソルバの公開エントリポイント(Phase 20a〜、Phase 35b-1でPlaneGCSへ移行、
 * Phase 35cで旧ソルバ[自前LM法]のフォールバックを撤去)。入出力シグネチャは移行前と完全互換。
 *
 * 常にPlaneGCS(gcsAdapter.solveSketchGcs)経由で解く。この関数自体は同期呼び出しのままにする
 * 必要がある(CadViewerのドラッグ処理[毎フレーム]・src/sketch/constraintUpdate.ts等、多数の
 * 同期呼び出し元がある)。GCS初期化が完了していない状態(アプリ起動直後のごく短い間、または
 * テストでregisterGcsAdapter()し忘れた場合)でこの関数を呼ぶのはプログラミングエラーであり、
 * 例外を投げる(黙って未解決の形状を返す旧ソルバ流のフォールバックはPhase 35cで廃止した)。
 * 通常の呼び出し元(src/state/store.tsのupdateDocument()/updateDocumentDuringDrag())は
 * solveDocumentSketchesAsync()経由でGCS初期化完了を待ってから呼ぶため、この例外には到達しない。
 */
export function solveSketch(
  segments: readonly SketchSegment[],
  constraints: readonly SketchConstraint[] = [],
  entities: readonly SketchEntity[] = [],
  options: SolveOptions = {},
): SolveResult {
  if (!gcsAdapter?.isGcsReady()) {
    throw new Error(
      "solveSketch()はPlaneGCS(WASM)の初期化完了前に呼ばれました。呼び出し元はensureGcsInitialized()/isSolverReady()で初期化完了を待つ必要があります(src/state/store.tsのupdateDocument()、src/viewer/CadViewer.tsのドラッグ処理を参照)。",
    );
  }
  return gcsAdapter.solveSketchGcs(segments, constraints, entities, options);
}

/** gcsAdapter.tsのSketchDiagnostics(dof・矛盾/冗長拘束id)を再エクスポートする(拘束診断UI、Phase 35b-2)。 */
export type SketchDiagnostics = GcsAdapterModule.SketchDiagnostics;

/**
 * スケッチの定義状態の診断(自由度[dof]・矛盾/冗長拘束id)を返す(拘束診断UI、Phase 35b-2)。
 * PlaneGCSの`get_gcs_conflicting_constraints()`/`get_gcs_redundant_constraints()`をそのまま使う。
 * GCS初期化前(isSolverReady()===false)はnullを返す(呼び出し側はバッジ非表示等、診断情報が
 * 無い状態として扱う。solveSketch()と異なり、診断はUIのおまけ表示なので例外にはしない)。
 * solveSketch()と同じくUIスレッドから同期的に呼べる想定(毎編集[doc変更]のたびにApp.tsx側が再計算する)。
 */
export function getSketchDiagnostics(
  segments: readonly SketchSegment[],
  constraints: readonly SketchConstraint[],
  entities: readonly SketchEntity[],
): SketchDiagnostics | null {
  if (!gcsAdapter?.isGcsReady()) return null;
  return gcsAdapter.getSketchDiagnostics(segments, constraints, entities);
}

/** solveDocumentSketches()が矛盾を検出したときの詳細。 */
export interface SolveConflict {
  featureId: FeatureId;
  message: string;
}

export interface SolveDocumentResult {
  doc: CadDocument;
  conflict: SolveConflict | null;
}

/**
 * ドキュメント内の全sketchフィーチャーのうちconstraintsを持つものにsolveSketch()を適用し、
 * 解けたsegmentsで置き換えたドキュメントを返す(Phase 20a、src/state/store.tsのupdateDocumentから呼ぶ)。
 * いずれかのスケッチで矛盾(conflicting)が検出された場合、ドキュメントは変更せずそのまま返し、
 * conflictに最初に見つかったフィーチャーIDとメッセージを入れる(呼び出し側は評価をスキップして
 * featureId付きのエラーとして表示する想定)。
 *
 * GCS初期化完了前に呼ぶとsolveSketch()が例外を投げる(呼び出し元はisSolverReady()を確認するか、
 * solveDocumentSketchesAsync()を使うこと)。
 */
export function solveDocumentSketches(doc: CadDocument): SolveDocumentResult {
  let conflict: SolveConflict | null = null;
  const features = doc.features.map((feature) => {
    if (conflict) return feature;
    if (feature.type !== "sketch" || !feature.constraints || feature.constraints.length === 0) return feature;
    const result = solveSketch(feature.segments ?? [], feature.constraints, feature.entities);
    if (!result.ok) {
      // 実機報告対応(Phase 32③): solveSketch()が特定した具体的な原因(残差最大の拘束名)を
      // そのまま伝播する(以前はここで汎用メッセージに握りつぶしていた)。
      conflict = { featureId: feature.id, message: result.message };
      return feature;
    }
    return { ...feature, segments: result.segments, entities: result.entities };
  });

  if (conflict) {
    return { doc, conflict };
  }
  return { doc: { ...doc, features }, conflict: null };
}

/**
 * solveDocumentSketches()を、PlaneGCS初期化完了後に必ず実行する版(Phase 35c)。
 * 既に初期化済みなら(実運用ではほぼ常にこちら)Promiseでラップして即座に結果を返す。
 * 未初期化(アプリ起動直後のごく短い初期化ウィンドウのみ)ならensureGcsInitialized()の完了を
 * 待ってから実行する。呼び出し元(src/state/store.tsのupdateDocument()/
 * updateDocumentDuringDrag())は「同期呼び出しの初期化未完了時に黙ってsolveをスキップする」
 * のではなく、この関数でGCS初期化を待ち合わせる(queue)ことで正しい解を得る。
 */
export function solveDocumentSketchesAsync(doc: CadDocument): Promise<SolveDocumentResult> {
  if (isSolverReady()) return Promise.resolve(solveDocumentSketches(doc));
  return ensureGcsInitialized().then(() => solveDocumentSketches(doc));
}
