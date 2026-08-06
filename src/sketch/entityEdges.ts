// LineRef(Phase 22、src/model/types.ts)を実際の2点(スケッチローカル2D)に解決する純関数群。
// ReactにもThree.jsにもReplicad(OCCT)にも依存しない(src/sketch/entityDimensionPick.tsと同じ方針)。
// entityEdge(rectangle/polygon)は常に「今のentitiesの値」から解決するため、エンティティが動けば
// 辺も追従する。segmentEdge(自由な線分)も同様に「今のsegmentsの値」から解決するため、線分自体が
// 動けば辺も追従する。refEdge(ボディ端面参照)はピック時点の座標を凍結したスナップショットなので、
// entities/segments配列に関わらずline.p1/line.p2をそのまま返す。
import type { LineRef, SketchEntity, SketchSegment } from "../model/types";

export type Point2 = [number, number];

/**
 * rectangleエンティティの辺edgeIndex(0=下,1=右,2=上,3=左、中心・幅・高さから求めた4隅を
 * 反時計回りに巡る順序)の両端点を返す。src/sketch/entityDimensionPick.tsのnearestRectangleEdgeHit
 * と同じ頂点順序(4隅の並び)を使う。
 */
export function rectangleEdgePoints(
  entity: Extract<SketchEntity, { kind: "rectangle" }>,
  edgeIndex: number,
): [Point2, Point2] {
  return rectangleEdgePointsAtCenter(entity.center, entity.width, entity.height, edgeIndex);
}

/**
 * rectangleEdgePointsの中心指定版(src/sketch/solver.tsが、ソルバの現在の変数値[中心]から辺を
 * 解決するために使う。中心が動けば辺も追従することをソルバの残差計算でも成立させるため)。
 */
export function rectangleEdgePointsAtCenter(center: Point2, width: number, height: number, edgeIndex: number): [Point2, Point2] {
  const [cx, cy] = center;
  const hw = width / 2;
  const hh = height / 2;
  const corners: Point2[] = [
    [cx - hw, cy - hh],
    [cx + hw, cy - hh],
    [cx + hw, cy + hh],
    [cx - hw, cy + hh],
  ];
  const n = corners.length;
  const i = ((edgeIndex % n) + n) % n;
  return [corners[i], corners[(i + 1) % n]];
}

/** polygonエンティティの辺edgeIndex(points[i]→points[i+1 mod n])の両端点を返す。 */
export function polygonEdgePoints(entity: Extract<SketchEntity, { kind: "polygon" }>, edgeIndex: number): [Point2, Point2] {
  return polygonEdgePointsWithOffset(entity.points, [0, 0], edgeIndex);
}

/**
 * polygonEdgePointsの並進オフセット指定版(src/sketch/solver.tsが、ソルバの現在の変数値
 * [剛体並進オフセットdx,dy]から辺を解決するために使う。offset=[0,0]ならpolygonEdgePointsと同じ)。
 */
export function polygonEdgePointsWithOffset(points: readonly Point2[], offset: Point2, edgeIndex: number): [Point2, Point2] {
  const n = points.length;
  if (n === 0) return [[0, 0], [0, 0]];
  const i = ((edgeIndex % n) + n) % n;
  const a = points[i];
  const b = points[(i + 1) % n];
  return [
    [a[0] + offset[0], a[1] + offset[1]],
    [b[0] + offset[0], b[1] + offset[1]],
  ];
}

/**
 * LineRefを実際の2点に解決する。entityEdgeが参照するentityが見つからない・rectangle/polygon
 * 以外、またはsegmentEdgeが参照するsegmentが見つからない場合はnullを返す
 * (呼び出し側は防御的にこの拘束の残差を無視する)。segmentsはsegmentEdge解決にのみ使う
 * (省略可、entityEdge/refEdgeのみ扱う既存呼び出し元との後方互換のためデフォルト空配列)。
 */
export function resolveLineRefPoints(
  line: LineRef,
  entities: readonly SketchEntity[],
  segments: readonly SketchSegment[] = [],
): [Point2, Point2] | null {
  if (line.kind === "refEdge") return [line.p1, line.p2];
  if (line.kind === "segmentEdge") {
    const seg = segments.find((s) => s.id === line.segmentId);
    return seg ? [seg.p1, seg.p2] : null;
  }
  const entity = entities.find((e) => e.id === line.entityId);
  if (!entity) return null;
  if (entity.kind === "rectangle") return rectangleEdgePoints(entity, line.edgeIndex);
  if (entity.kind === "polygon") return polygonEdgePoints(entity, line.edgeIndex);
  return null;
}

/**
 * 2つのLineRefが「同じ辺」を指すかどうか(拘束のupsert時の同一判定に使う)。refEdge同士は座標一致、
 * segmentEdge同士はsegmentId一致で判定する。
 */
export function sameLineRef(a: LineRef, b: LineRef): boolean {
  if (a.kind === "entityEdge" && b.kind === "entityEdge") {
    return a.entityId === b.entityId && a.edgeIndex === b.edgeIndex;
  }
  if (a.kind === "segmentEdge" && b.kind === "segmentEdge") {
    return a.segmentId === b.segmentId;
  }
  if (a.kind === "refEdge" && b.kind === "refEdge") {
    const closeEnough = (p: Point2, q: Point2) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6;
    return closeEnough(a.p1, b.p1) && closeEnough(a.p2, b.p2);
  }
  return false;
}
