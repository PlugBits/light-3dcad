// ねじの配置基準参照(positionRef、Phase 46: スケッチの円を参照した配置)に関する純粋ロジック。
// src/worker/evaluator.ts(評価時の解決・「同じ面かどうか」の検証)と
// src/components/ThreadEditor.tsx(候補一覧のUI表示)の両方から参照するため、
// replicad等の重い依存を持たない(src/sketch/facePlaneBasis.tsと同じ方針)。
import type { CadDocument, FeatureId, SketchFeature, ThreadFeature } from "./types";
import { entityDisplayName } from "../sketch/displayNames";

export type Tuple3 = [number, number, number];

/** 面の法線一致とみなす角度許容(cos値)。src/worker/evaluator.tsのFACE_NORMAL_COS_TOLERANCEと同じ値。 */
const FACE_NORMAL_COS_TOLERANCE = 0.999;
/**
 * 面中心の距離許容(mm)。positionRefの「同じ面」判定は、既に解決済みの2つの平面スナップショット
 * (未変化なら同一のB-Rep面から取得した値でほぼ完全一致するはず)を比較するだけなので、
 * resolveFaceGeometry()系が使う「バウンディングボックス対角長に対する比率」の緩い許容ではなく、
 * 固定の小さな絶対値でよい。
 */
const FACE_CENTER_DISTANCE_TOLERANCE = 1e-3;

function dot(a: Tuple3, b: Tuple3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function distance(a: Tuple3, b: Tuple3): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/**
 * 2つの平面(中心・法線)がほぼ同じ面とみなせるか(法線がほぼ平行かつ中心がほぼ一致)。
 * positionRefの「配置基準スケッチはねじの配置面と同じ面である必要がある」検証・候補一覧の
 * 両方が使う唯一の判定関数(evaluator.tsとThreadEditor.tsxで基準がずれないようにするため)。
 */
export function sameFacePlane(a: { center: Tuple3; normal: Tuple3 }, b: { center: Tuple3; normal: Tuple3 }): boolean {
  return dot(a.normal, b.normal) >= FACE_NORMAL_COS_TOLERANCE && distance(a.center, b.center) <= FACE_CENTER_DISTANCE_TOLERANCE;
}

/** positionRefの候補(面上スケッチ内の円)1件。labelはドロップダウン表示用(例:「FaceSketch1 の 円1」)。 */
export interface ThreadPositionRefCandidate {
  sketchId: FeatureId;
  entityId: string;
  label: string;
}

/**
 * このthreadフィーチャーの配置基準として選べる候補一覧を返す(Phase 46、ThreadEditorのドロップダウン用。
 * Phase 47でpointエンティティも対象に追加)。対象はplane.kind==="face"のスケッチが持つcircle/point
 * エンティティのうち、そのスケッチの平面がthreadの配置面とほぼ同じ面であるもの。sketchPlanesはWorker評価応答由来の解決済み平面
 * (src/protocol/messages.tsのSketchPlaneInfo、origin=面の中心)。thread自身が参照するスケッチ
 * (positionRef.sketchId、選択済みなら候補にも含める。切り替え直後に一覧から消えて選び直しになる
 * ことを避けるため)も対象に含む。
 *
 * threadFacePlane(Phase 47): 「同じ面かどうか」の比較対象は、thread.face.center/normal
 * (ユーザーが最初にねじを配置した時点のクリック値。evaluator.tsは配置面を毎回再解決するが、
 * この値自体は書き戻されないため、上流フィーチャー[箱の寸法変更等]で面が動くと古びる)ではなく、
 * 直近の評価でevaluator.tsが実際に解決した配置面(src/protocol/messages.tsのThreadFacePlaneInfo、
 * sketchPlanesのoriginと同じ解決経路[resolveFaceGeometry系のhashCode優先+幾何フォールバック]で
 * 得た値)を優先して使う。これにより、面自体は動いていないのに「クリック時点の値」と「再解決した値」の
 * ずれ(異なるタイミング・経路で取得した2つのスナップショットを素朴に比較することによる本質的な
 * 脆さ)で候補が消える不具合を避ける。まだ一度も解決されていない(評価未完了)場合のみthread.faceへ
 * フォールバックする。
 */
export function listThreadPositionRefCandidates(
  doc: CadDocument,
  thread: ThreadFeature,
  sketchPlanes: readonly { sketchId: FeatureId; origin: Tuple3; normal: Tuple3 }[],
  threadFacePlane?: { center: Tuple3; normal: Tuple3 },
): ThreadPositionRefCandidate[] {
  const planeById = new Map(sketchPlanes.map((p) => [p.sketchId, p]));
  const threadFace = threadFacePlane ?? thread.face;
  const candidates: ThreadPositionRefCandidate[] = [];
  for (const feature of doc.features) {
    if (feature.type !== "sketch" || feature.plane.kind !== "face") continue;
    const plane = planeById.get(feature.id);
    if (!plane) continue;
    if (!sameFacePlane({ center: plane.origin, normal: plane.normal }, { center: threadFace.center, normal: threadFace.normal })) continue;
    feature.entities.forEach((entity, index) => {
      if (entity.kind !== "circle" && entity.kind !== "point") return;
      candidates.push({
        sketchId: feature.id,
        entityId: entity.id,
        label: `${feature.name} の ${entityDisplayName(entity, index)}`,
      });
    });
  }
  return candidates;
}

/**
 * threadの配置面と同じ面上にある、最初のface参照スケッチを返す(Phase 47、ThreadEditorの
 * 「配置スケッチを編集」ガイド付きフロー用)。listThreadPositionRefCandidates()と異なり
 * circle/pointエンティティの有無を問わない(スケッチ自体が同じ面にあるかどうかだけを見る。
 * まだ何も図形が無い空のスケッチも対象に含む)。見つからなければnull。
 */
export function findFaceSketchOnFace(
  doc: CadDocument,
  threadFace: { center: Tuple3; normal: Tuple3 },
  sketchPlanes: readonly { sketchId: FeatureId; origin: Tuple3; normal: Tuple3 }[],
): SketchFeature | null {
  const planeById = new Map(sketchPlanes.map((p) => [p.sketchId, p]));
  for (const feature of doc.features) {
    if (feature.type !== "sketch" || feature.plane.kind !== "face") continue;
    const plane = planeById.get(feature.id);
    if (!plane) continue;
    if (!sameFacePlane({ center: plane.origin, normal: plane.normal }, threadFace)) continue;
    return feature;
  }
  return null;
}

/** ThreadEditorの「配置スケッチを編集」ガイド付きフロー(Phase 47)の保留リンク。 */
export interface PendingThreadPlacementLink {
  threadId: FeatureId;
  sketchId: FeatureId;
}

/**
 * 保留リンク(PendingThreadPlacementLink)を、スケッチ退出時に消費できるかどうかを判定する
 * 純粋ロジック(Phase 47、src/state/store.tsのselectFeature()から呼ぶ)。
 * 消費条件:
 *   - 対象のthreadフィーチャーが現存し、positionRefがまだ未設定であること(手動で既に別の基準を
 *     設定済みなら上書きしない。ガイド付きフローの「配置スケッチを編集」→スケッチを開いたまま
 *     手動でpositionRefを設定した、といったケースを尊重する)。
 *   - 対象のsketchフィーチャーが現存し、pointエンティティを1件以上持つこと。
 * 満たせば、そのスケッチ内で最後(=最新、点ツールは常に末尾へ追加するため)のpointエンティティを
 * 新しいpositionRefとして返す(呼び出し側がpatchThreadPositionRef()で書き戻し、labelをトースト
 * メッセージに使う)。満たさなければnull(呼び出し側は何もしない)。
 */
export function resolvePendingThreadPlacementLink(
  doc: CadDocument,
  pending: PendingThreadPlacementLink,
): { entityId: string; label: string } | null {
  const thread = doc.features.find((f) => f.id === pending.threadId);
  if (!thread || thread.type !== "thread" || thread.positionRef) return null;
  const sketch = doc.features.find((f) => f.id === pending.sketchId);
  if (!sketch || sketch.type !== "sketch") return null;
  let newest: { entityId: string; index: number } | null = null;
  sketch.entities.forEach((entity, index) => {
    if (entity.kind === "point") newest = { entityId: entity.id, index };
  });
  if (!newest) return null;
  const { entityId, index } = newest as { entityId: string; index: number };
  const entity = sketch.entities.find((e) => e.id === entityId)!;
  return { entityId, label: entityDisplayName(entity, index) };
}
