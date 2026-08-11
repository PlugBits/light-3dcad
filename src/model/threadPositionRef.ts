// ねじの配置基準参照(positionRef、Phase 46: スケッチの円を参照した配置)に関する純粋ロジック。
// src/worker/evaluator.ts(評価時の解決・「同じ面かどうか」の検証)と
// src/components/ThreadEditor.tsx(候補一覧のUI表示)の両方から参照するため、
// replicad等の重い依存を持たない(src/sketch/facePlaneBasis.tsと同じ方針)。
import type { CadDocument, FeatureId, ThreadFeature } from "./types";
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
 * このthreadフィーチャーの配置基準として選べる候補一覧を返す(Phase 46、ThreadEditorのドロップダウン用)。
 * 対象はplane.kind==="face"のスケッチが持つcircleエンティティのうち、そのスケッチの平面がthreadの
 * 配置面(thread.face)とほぼ同じ面であるもの。sketchPlanesはWorker評価応答由来の解決済み平面
 * (src/protocol/messages.tsのSketchPlaneInfo、origin=面の中心)。thread自身が参照するスケッチ
 * (positionRef.sketchId、選択済みなら候補にも含める。切り替え直後に一覧から消えて選び直しになる
 * ことを避けるため)も対象に含む。
 */
export function listThreadPositionRefCandidates(
  doc: CadDocument,
  thread: ThreadFeature,
  sketchPlanes: readonly { sketchId: FeatureId; origin: Tuple3; normal: Tuple3 }[],
): ThreadPositionRefCandidate[] {
  const planeById = new Map(sketchPlanes.map((p) => [p.sketchId, p]));
  const candidates: ThreadPositionRefCandidate[] = [];
  for (const feature of doc.features) {
    if (feature.type !== "sketch" || feature.plane.kind !== "face") continue;
    const plane = planeById.get(feature.id);
    if (!plane) continue;
    if (!sameFacePlane({ center: plane.origin, normal: plane.normal }, { center: thread.face.center, normal: thread.face.normal })) continue;
    feature.entities.forEach((entity, index) => {
      if (entity.kind !== "circle") return;
      candidates.push({
        sketchId: feature.id,
        entityId: entity.id,
        label: `${feature.name} の ${entityDisplayName(entity, index)}`,
      });
    });
  }
  return candidates;
}
