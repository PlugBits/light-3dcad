// LineRef(Phase 22、src/model/types.ts)を実際の2点(スケッチローカル2D)に解決する純関数群。
// ReactにもThree.jsにもReplicad(OCCT)にも依存しない(src/sketch/entityDimensionPick.tsと同じ方針)。
// entityEdge(rectangle/polygon)は常に「今のentitiesの値」から解決するため、エンティティが動けば
// 辺も追従する。segmentEdge(自由な線分)も同様に「今のsegmentsの値」から解決するため、線分自体が
// 動けば辺も追従する。refEdge(ボディ端面参照)はピック時点の座標を凍結したスナップショットなので、
// entities/segments配列に関わらずline.p1/line.p2をそのまま返す。
import type { EntityVertexRef, LineRef, MovableLineRef, PointRef, SketchEntity, SketchSegment } from "../model/types";
import { regularPolygonVertices, slotAxisNormal } from "./shapeFromPoints";

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

/** regularPolygonエンティティの辺edgeIndex(頂点i→頂点i+1 mod sides)の両端点を返す(Phase 48)。 */
export function regularPolygonEdgePoints(entity: Extract<SketchEntity, { kind: "regularPolygon" }>, edgeIndex: number): [Point2, Point2] {
  const verts = regularPolygonVertices(entity.center, entity.radius, entity.sides, entity.rotation ?? 0);
  const n = verts.length;
  if (n === 0) return [[0, 0], [0, 0]];
  const i = ((edgeIndex % n) + n) % n;
  return [verts[i], verts[(i + 1) % n]];
}

/**
 * slotエンティティの2本の直線辺(edgeIndex 0/1、Phase 48)の両端点を返す。中心線と垂直な
 * オフセット(半幅=width/2)だけ離れた2本の直線のみを対象にする(両端の半円キャップは
 * LineRef[直線のみ]で表現できないため対象外、src/sketch/explode.tsのexplodeSlotと同じ幾何)。
 * edgeIndex 0 = start側オフセット→end側オフセット(explodeSlotのa→b)、
 * edgeIndex 1 = start側逆オフセット→end側逆オフセット(explodeSlotのd→c)。
 */
export function slotEdgePoints(entity: Extract<SketchEntity, { kind: "slot" }>, edgeIndex: number): [Point2, Point2] {
  const r = entity.width / 2;
  const n = slotAxisNormal(entity.start, entity.end);
  const a: Point2 = [entity.start[0] + n[0] * r, entity.start[1] + n[1] * r];
  const b: Point2 = [entity.end[0] + n[0] * r, entity.end[1] + n[1] * r];
  const c: Point2 = [entity.end[0] - n[0] * r, entity.end[1] - n[1] * r];
  const d: Point2 = [entity.start[0] - n[0] * r, entity.start[1] - n[1] * r];
  return ((edgeIndex % 2) + 2) % 2 === 0 ? [a, b] : [d, c];
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
  // regularPolygon/slot(Phase 48): 以前はrectangle/polygonのみ対象だったため、これらの辺は
  // 寸法ツールで参照エッジ・他の線・circle等から選べなかった(ユーザー報告対応)。
  if (entity.kind === "regularPolygon") return regularPolygonEdgePoints(entity, line.edgeIndex);
  if (entity.kind === "slot") return slotEdgePoints(entity, line.edgeIndex);
  return null;
}

/**
 * MovableLineRef(entityEdge/segmentEdge)の後方互換正規化(Phase 48)。
 * distanceLineLine/angleLineLine(a/b)・distanceLineRefEdge/angleLineRefEdge(segmentId)は、
 * 旧データでは素の文字列(segmentId)のみを持つ。素の文字列は`{kind:"segmentEdge",segmentId}`と
 * 同じ意味として扱う。
 */
export function normalizeMovableLineRef(ref: string | MovableLineRef): MovableLineRef {
  return typeof ref === "string" ? { kind: "segmentEdge", segmentId: ref } : ref;
}

/** 2つの`string | MovableLineRef`が同じ辺を指すかどうか(normalizeMovableLineRef()を通してからsameLineRef()に委ねる)。 */
export function sameMovableLineRef(a: string | MovableLineRef, b: string | MovableLineRef): boolean {
  return sameLineRef(normalizeMovableLineRef(a), normalizeMovableLineRef(b));
}

/**
 * エンティティが持つ「頂点」(角/端点)の個数(Phase 48)。EntityVertexRef.vertexIndexの
 * 有効範囲は0〜(この値-1)。頂点の概念を持たないエンティティ(circle)は0。
 * - rectangle: 4(角) / polygon: points.length / regularPolygon: sides
 * - slot: 2(中心線の始点・終点=両端キャップの中心) / point: 1(そのposition自体)
 */
export function entityVertexCount(entity: SketchEntity): number {
  if (entity.kind === "rectangle") return 4;
  if (entity.kind === "polygon") return entity.points.length;
  if (entity.kind === "regularPolygon") return entity.sides;
  if (entity.kind === "slot") return 2;
  if (entity.kind === "point") return 1;
  return 0;
}

/**
 * エンティティの頂点vertexIndex(0始まり、entityVertexCount()の範囲)の実座標を返す(Phase 48)。
 * 範囲外・頂点を持たないエンティティ(circle)はnull。rectangleの角の順序はrectangleEdgePoints等と
 * 揃えた反時計回り(0=左下/1=右下/2=右上/3=左上、types.tsのEntityVertexRefコメント参照)。
 */
export function entityVertexPoint(entity: SketchEntity, vertexIndex: number): Point2 | null {
  if (entity.kind === "rectangle") {
    const [cx, cy] = entity.center;
    const hw = entity.width / 2;
    const hh = entity.height / 2;
    const corners: Point2[] = [
      [cx - hw, cy - hh],
      [cx + hw, cy - hh],
      [cx + hw, cy + hh],
      [cx - hw, cy + hh],
    ];
    return corners[((vertexIndex % 4) + 4) % 4] ?? null;
  }
  if (entity.kind === "polygon") {
    const n = entity.points.length;
    if (n === 0) return null;
    return entity.points[((vertexIndex % n) + n) % n];
  }
  if (entity.kind === "regularPolygon") {
    const verts = regularPolygonVertices(entity.center, entity.radius, entity.sides, entity.rotation ?? 0);
    const n = verts.length;
    if (n === 0) return null;
    return verts[((vertexIndex % n) + n) % n];
  }
  if (entity.kind === "slot") {
    if (vertexIndex === 0) return entity.start;
    if (vertexIndex === 1) return entity.end;
    return null;
  }
  if (entity.kind === "point") {
    return vertexIndex === 0 ? entity.position : null;
  }
  return null;
}

/**
 * PointRef(セグメント端点)、またはEntityVertexRef(entityの頂点、Phase 48)を実座標に解決する。
 * distancePointOrigin.point・distancePointLine.point・distance.a/bが受け付ける2種の判別は
 * `"segmentId" in ref`で行う(PointRef判定、既存の慣習と同じ)。
 */
export function resolvePointOrVertexRefPoint(
  ref: PointRef | EntityVertexRef,
  entities: readonly SketchEntity[],
  segments: readonly SketchSegment[],
): Point2 | null {
  if ("segmentId" in ref) {
    const seg = segments.find((s) => s.id === ref.segmentId);
    return seg ? (ref.end === "p1" ? seg.p1 : seg.p2) : null;
  }
  const entity = entities.find((e) => e.id === ref.entityId);
  return entity ? entityVertexPoint(entity, ref.vertexIndex) : null;
}

/** 2つのPointRef|EntityVertexRefが同じ点を指しているか(拘束の重複判定・upsertの同一性判定に使う)。 */
export function samePointOrVertexRef(a: PointRef | EntityVertexRef, b: PointRef | EntityVertexRef): boolean {
  const aIsPoint = "segmentId" in a;
  const bIsPoint = "segmentId" in b;
  if (aIsPoint !== bIsPoint) return false;
  if (aIsPoint) return (a as PointRef).segmentId === (b as PointRef).segmentId && (a as PointRef).end === (b as PointRef).end;
  return (a as EntityVertexRef).entityId === (b as EntityVertexRef).entityId && (a as EntityVertexRef).vertexIndex === (b as EntityVertexRef).vertexIndex;
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
