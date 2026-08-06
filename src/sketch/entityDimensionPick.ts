// 寸法ツール(Phase 20b)でrectangle/circleエンティティ本体をクリック対象にするためのヒット判定
// (Phase 21)。ReactにもThree.jsにもReplicad(OCCT)にも依存しない純粋TypeScript
// (src/sketch/snapping.ts, trim.ts と同じ方針)。
//
// 背景: 寸法ツールは元々(Phase 20b)segments(自由な線分・円弧チェーン)のみをヒット判定対象にしており、
// rectangle/circleのようなraw entityは対象外だった(SketchEditorの「矩形/円を数値で追加」・
// 矩形/円ツールで作った図形はentitiesであり、拘束(segments前提)には乗らないため)。
// entityは拘束を持たないので、寸法ツールでのヒット対象にする場合は「拘束の作成/更新」ではなく
// entity自身のフィールド(radius/width/height)を直接更新する形にする(CadViewer.tsのコメント・
// App.tsxのhandleApplyDimensionTarget参照)。
import type { SketchEntity } from "../model/types";

export type Point2 = [number, number];

/**
 * entityヒット時のターゲット種別。circleは半径、rectangleは辺の向きに応じて幅/高さ、
 * polygonは辺そのもの("entity-edge"、UI改善: circle-distance-edgeの2点目候補として
 * ホバー/ピックできるようにするための追加。includePolygon:trueのときのみ返る)。
 */
export type EntityDimensionTargetKind = "entity-radius" | "entity-width" | "entity-height" | "entity-edge";

export interface EntityDimensionHit {
  entityId: string;
  kind: EntityDimensionTargetKind;
  /** クリック/ホバー位置から境界(円周・矩形の辺)までの最短距離(ローカルmm)。許容判定・最近傍選定に使う。 */
  dist: number;
  /** ホバーハイライト用の境界ポリライン(ローカル2D)。circleは円周の近似、rectangleは該当辺の2点。 */
  highlightPoints: Point2[];
  /** rectangleの辺ヒットの場合、その辺のインデックス(0=下,1=右,2=上,3=左、Phase 22)。circleはundefined。 */
  edgeIndex?: number;
}

const CIRCLE_HIGHLIGHT_SEGMENTS = 48;

function circleBoundaryPolyline(center: Point2, radius: number): Point2[] {
  const points: Point2[] = [];
  for (let i = 0; i <= CIRCLE_HIGHLIGHT_SEGMENTS; i += 1) {
    const t = (i / CIRCLE_HIGHLIGHT_SEGMENTS) * Math.PI * 2;
    points.push([center[0] + Math.cos(t) * radius, center[1] + Math.sin(t) * radius]);
  }
  return points;
}

/** 点pから線分[a,b]への最短距離(src/sketch/trim.tsの同名ローカル関数と同じ実装)。 */
function distPointToSegment(p: Point2, a: Point2, b: Point2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a[0] + t * dx;
  const cy = a[1] + t * dy;
  return Math.hypot(p[0] - cx, p[1] - cy);
}

/**
 * rectangleの4辺のうち点に最も近い辺を求める。上下の辺(水平、長さ=width)は"entity-width"、
 * 左右の辺(垂直、長さ=height)は"entity-height"に対応する
 * (src/sketch/dimensions.tsのcomputeSketchDimensions: 上辺付近にwidthラベル、右辺付近に
 * heightラベルを置く既存の慣習と対応関係を揃えた)。
 */
function nearestRectangleEdgeHit(
  point: Point2,
  entity: Extract<SketchEntity, { kind: "rectangle" }>,
): EntityDimensionHit {
  const [cx, cy] = entity.center;
  const hw = entity.width / 2;
  const hh = entity.height / 2;
  const corners: Point2[] = [
    [cx - hw, cy - hh],
    [cx + hw, cy - hh],
    [cx + hw, cy + hh],
    [cx - hw, cy + hh],
  ];
  const edges: { a: Point2; b: Point2; kind: "entity-width" | "entity-height"; edgeIndex: number }[] = [
    { a: corners[0], b: corners[1], kind: "entity-width", edgeIndex: 0 },
    { a: corners[1], b: corners[2], kind: "entity-height", edgeIndex: 1 },
    { a: corners[2], b: corners[3], kind: "entity-width", edgeIndex: 2 },
    { a: corners[3], b: corners[0], kind: "entity-height", edgeIndex: 3 },
  ];
  let best: { dist: number; kind: "entity-width" | "entity-height"; a: Point2; b: Point2; edgeIndex: number } = {
    dist: Infinity,
    kind: "entity-width",
    a: edges[0].a,
    b: edges[0].b,
    edgeIndex: 0,
  };
  for (const edge of edges) {
    const d = distPointToSegment(point, edge.a, edge.b);
    if (d < best.dist) best = { dist: d, kind: edge.kind, a: edge.a, b: edge.b, edgeIndex: edge.edgeIndex };
  }
  return {
    entityId: entity.id,
    kind: best.kind,
    dist: best.dist,
    highlightPoints: [best.a, best.b],
    edgeIndex: best.edgeIndex,
  };
}

/**
 * polygonの辺のうち点に最も近いものを求める(nearestRectangleEdgeHitのpolygon版)。
 * kind は常に"entity-edge"(rectangleのwidth/height区別と違い、polygonは辺ごとの向きが
 * 一定でないため)。
 */
function nearestPolygonEdgeHit(point: Point2, entity: Extract<SketchEntity, { kind: "polygon" }>): EntityDimensionHit {
  const pts = entity.points;
  const n = pts.length;
  let best = { dist: Infinity, a: pts[0], b: pts[n > 1 ? 1 : 0], edgeIndex: 0 };
  for (let i = 0; i < n; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const d = distPointToSegment(point, a, b);
    if (d < best.dist) best = { dist: d, a, b, edgeIndex: i };
  }
  return {
    entityId: entity.id,
    kind: "entity-edge",
    dist: best.dist,
    highlightPoints: [best.a, best.b],
    edgeIndex: best.edgeIndex,
  };
}

/**
 * entities(rectangle/circle、includePolygon指定時はpolygonの辺も。他の種別は対象外)の中から、
 * 点に最も近いヒット対象を1つ返す(許容距離の判定は呼び出し側でdistを見て行う。距離が最小の
 * ものを常に1件返す。対象が1つも無ければnull)。
 * includePolygon(既定false、UI改善対応): circle-distance-edgeの2点目候補としてpolygonの辺も
 * ヒット対象にしたいのは「circleを1点目としてクリック済み」の間だけなので、呼び出し側
 * (CadViewer)がdimensionPendingCircleIdの有無で切り替える。falseのままだと従来通りpolygonは
 * 対象外(単独クリックでpolygonの辺を拾って未定義のターゲット種別を発行しないための安全策)。
 */
export function findEntityDimensionHit(
  point: Point2,
  entities: SketchEntity[],
  includePolygon = false,
): EntityDimensionHit | null {
  let best: EntityDimensionHit | null = null;
  for (const entity of entities) {
    let hit: EntityDimensionHit;
    if (entity.kind === "circle") {
      const dist = Math.abs(Math.hypot(point[0] - entity.center[0], point[1] - entity.center[1]) - entity.radius);
      hit = {
        entityId: entity.id,
        kind: "entity-radius",
        dist,
        highlightPoints: circleBoundaryPolyline(entity.center, entity.radius),
      };
    } else if (entity.kind === "rectangle") {
      hit = nearestRectangleEdgeHit(point, entity);
    } else if (entity.kind === "polygon" && includePolygon && entity.points.length >= 2) {
      hit = nearestPolygonEdgeHit(point, entity);
    } else {
      continue;
    }
    if (!best || hit.dist < best.dist) best = hit;
  }
  return best;
}
