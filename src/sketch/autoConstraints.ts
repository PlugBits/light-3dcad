// 線分・円弧チェーン作図(線分ツール、Phase 19b)の確定時に自動付与する拘束を組み立てる純関数(Phase 20a)。
// ReactにもThree.jsにもReplicad(OCCT)にも依存しない(src/sketch/intersections.ts等と同じ方針)。
// CadViewerはUI/描画のみを担当し、実際の拘束データ生成はここで行う(ドキュメントの正本はApp/store側)。
import { generateId } from "../model/id";
import type { PointRef, SketchConstraint, SketchSegment } from "../model/types";
import type { AxisLockKind } from "./snapping";

/** 端点一致(coincident)とみなす距離許容(mm)。src/sketch/intersections.tsのEPSと同じ値。 */
const COINCIDENT_EPS = 1e-6;

function dist(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function pairKey(a: PointRef, b: PointRef): string {
  const k1 = `${a.segmentId}:${a.end}`;
  const k2 = `${b.segmentId}:${b.end}`;
  return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
}

export interface AutoConstraintParams {
  /** 今回のチェーン描画で新規作成されたセグメント(順序付き、segments[i].p2がsegments[i+1].p1に接続する)。 */
  newSegments: SketchSegment[];
  /**
   * 辺i(newSegments[i])が軸ロック(水平/垂直)で確定していたか。CadViewerの描画状態から渡す
   * (省略された添字・配列自体の省略はロックなし扱い)。円弧辺(kind:"arc"かつbulgeが非0)は無視する。
   */
  axisLocks?: (AxisLockKind | undefined)[];
  /** 追加前に既にスケッチに存在していたセグメント(端点一致でのcoincident検出の対象、省略可)。 */
  existingSegments?: SketchSegment[];
}

/**
 * チェーン確定時の自動拘束を組み立てる。
 * 1. チェーン内の連続セグメントの接続端点(segments[i].p2 <-> segments[i+1].p1)にcoincidentを付ける。
 * 2. 軸ロックで確定した直線辺にhorizontal/verticalを付ける。
 * 3. チェーンの自己閉合(始点付近クリックで閉じた場合の終端と始点)、および既存セグメントの端点との
 *    一致(スナップで繋がった場合)にcoincidentを付ける(1で既に繋いだペアは重複させない)。
 * 生成される拘束の順序は決定的(1→2→3、各ステップ内は入力順)。
 */
export function buildAutoConstraintsForChain(params: AutoConstraintParams): SketchConstraint[] {
  const { newSegments, axisLocks = [], existingSegments = [] } = params;
  const constraints: SketchConstraint[] = [];
  const linkedPairs = new Set<string>();

  const addCoincident = (a: PointRef, b: PointRef) => {
    const key = pairKey(a, b);
    if (linkedPairs.has(key)) return;
    linkedPairs.add(key);
    constraints.push({ id: generateId("constraint"), kind: "coincident", a, b });
  };

  // 1) チェーン内の連続セグメントの接続端点。
  for (let i = 0; i < newSegments.length - 1; i += 1) {
    addCoincident({ segmentId: newSegments[i].id, end: "p2" }, { segmentId: newSegments[i + 1].id, end: "p1" });
  }

  // 2) 軸ロックで確定した直線辺のhorizontal/vertical(円弧辺は対象外)。
  newSegments.forEach((seg, i) => {
    if (seg.kind === "arc" && seg.bulge) return;
    const axis = axisLocks[i];
    if (axis === "horizontal") {
      constraints.push({ id: generateId("constraint"), kind: "horizontal", segmentId: seg.id });
    } else if (axis === "vertical") {
      constraints.push({ id: generateId("constraint"), kind: "vertical", segmentId: seg.id });
    }
  });

  // 3) 端点の一致(自己閉合・既存セグメントへのスナップ接続)。少なくとも一方が新規チェーンの
  //    セグメントである組のみを対象にする(既存セグメント同士は今回の描画と無関係なので対象外)。
  type PointEntry = { ref: PointRef; point: [number, number] };
  const newPoints: PointEntry[] = newSegments.flatMap((seg) => [
    { ref: { segmentId: seg.id, end: "p1" as const }, point: seg.p1 },
    { ref: { segmentId: seg.id, end: "p2" as const }, point: seg.p2 },
  ]);
  const existingPoints: PointEntry[] = existingSegments.flatMap((seg) => [
    { ref: { segmentId: seg.id, end: "p1" as const }, point: seg.p1 },
    { ref: { segmentId: seg.id, end: "p2" as const }, point: seg.p2 },
  ]);
  // allPoints は newPoints が先頭に並ぶため、newPoints[i] のallPoints内インデックスは i と一致する。
  // j を i+1 から回すことで「newPoints同士の組(自己閉合)」と「newPoints×existingPoints の組
  // (既存セグメントへのスナップ接続)」の両方を、既存同士の組み合わせを生成せずに走査できる。
  const allPoints = [...newPoints, ...existingPoints];
  for (let i = 0; i < newPoints.length; i += 1) {
    for (let j = i + 1; j < allPoints.length; j += 1) {
      const pi = newPoints[i];
      const pj = allPoints[j];
      if (pi.ref.segmentId === pj.ref.segmentId) continue; // 同一セグメントのp1/p2は対象外。
      if (dist(pi.point, pj.point) > COINCIDENT_EPS) continue;
      addCoincident(pi.ref, pj.ref);
    }
  }

  return constraints;
}
