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

/** entityヒット時のターゲット種別。circleは半径、rectangleは辺の向きに応じて幅/高さ。 */
export type EntityDimensionTargetKind = "entity-radius" | "entity-width" | "entity-height";

export interface EntityDimensionHit {
  entityId: string;
  kind: EntityDimensionTargetKind;
  /** クリック/ホバー位置から境界(円周・矩形の辺)までの最短距離(ローカルmm)。許容判定・最近傍選定に使う。 */
  dist: number;
  /** ホバーハイライト用の境界ポリライン(ローカル2D)。circleは円周の近似、rectangleは該当辺の2点。 */
  highlightPoints: Point2[];
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
  const edges: { a: Point2; b: Point2; kind: "entity-width" | "entity-height" }[] = [
    { a: corners[0], b: corners[1], kind: "entity-width" },
    { a: corners[1], b: corners[2], kind: "entity-height" },
    { a: corners[2], b: corners[3], kind: "entity-width" },
    { a: corners[3], b: corners[0], kind: "entity-height" },
  ];
  let best: { dist: number; kind: "entity-width" | "entity-height"; a: Point2; b: Point2 } = {
    dist: Infinity,
    kind: "entity-width",
    a: edges[0].a,
    b: edges[0].b,
  };
  for (const edge of edges) {
    const d = distPointToSegment(point, edge.a, edge.b);
    if (d < best.dist) best = { dist: d, kind: edge.kind, a: edge.a, b: edge.b };
  }
  return {
    entityId: entity.id,
    kind: best.kind,
    dist: best.dist,
    highlightPoints: [best.a, best.b],
  };
}

/**
 * entities(rectangle/circle。他の種別は対象外)の中から、点に最も近いヒット対象を1つ返す
 * (許容距離の判定は呼び出し側でdistを見て行う。距離が最小のものを常に1件返す。entitiesが
 * 空、またはrectangle/circleが1つも無ければnull)。
 */
export function findEntityDimensionHit(point: Point2, entities: SketchEntity[]): EntityDimensionHit | null {
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
    } else {
      continue;
    }
    if (!best || hit.dist < best.dist) best = hit;
  }
  return best;
}
