// スケッチ内エンティティ(rectangle/circle/polygon)の「包含」判定(Phase 15)。
// ReactにもThree.jsにもReplicad(OCCT)にも依存しない純粋TypeScript
// (src/sketch/snapping.ts, dimensions.ts, polygonOutline.ts と同じ方針)。
//
// 目的: 外枠プロファイルの内側に完全に含まれるエンティティを「穴」として分類し、
// evaluator(src/worker/evaluator.ts)が「外枠同士はfuse、穴は最後にまとめてcut」できるようにする。
//
// 判定は各エンティティの「代表点列」に基づく(頂点ベース。フィレット/面取りcornersは無視する):
//   - rectangle: 4頂点(center±width/2, height/2)
//   - polygon: points をそのまま使う(corners は無視)
//   - circle: 中心点 + 半径
//
// 包含の意味: エンティティA(inner)がエンティティB(outer)に完全に含まれる、とは
//   - outerが円の場合: innerの全代表点が outer の中心からouter.radius以内にある
//     (innerが円の場合はさらに厳密に「中心間距離 + inner.radius <= outer.radius」で判定する。
//     代表点=中心点だけでは半径を考慮できないための特別扱い)。
//   - outerが多角形(rectangle/polygon)の場合: innerの全代表点が outer の多角形の内部(境界含む)にある
//     (innerが円の場合はさらに「円の中心から多角形の各辺までの最短距離 >= inner.radius」も満たす必要がある。
//     中心点だけでは半径分のはみ出しを検出できないための特別扱い)。
//
// 同一形状・同一サイズの相互包含(A⊆B かつ B⊆A)を避けるため、判定には微小マージン(CONTAINMENT_EPS)を
// 設けている。inner が outer よりわずかにでも小さくないと「含まれる」とは判定しない
// (ちょうど同じ大きさ・同じ位置の2つの図形は互いにholeと判定されない=どちらもtop-levelのまま)。
//
// ネストの階層: このモジュールが提供する分類は「outer(外枠)」と「hole(穴)」の2階層のみ。
// 「他のいずれかのエンティティに含まれる」エンティティは無条件でholeとして扱う。そのため、
// 穴の中にさらに島(3階層目=本来はfuseすべき突起)がある場合、その島は「holeであるエンティティに
// 含まれるhole」として扱われ、誤ってholeのまま(削れてしまう)になる既知の制限がある
// (真の偶奇ネストにするには階層の深さを数える必要があるが、Phase 15スコープでは対応しない)。
import type { SketchEntity } from "../model/types";

export type Point2 = [number, number];

/** 包含判定の微小マージン(mm)。ほぼ同一サイズの図形同士を相互包含と誤判定しないためのバッファ。 */
const CONTAINMENT_EPS = 1e-6;
/** 点が多角形の辺上にあるとみなす距離許容(mm)。 */
const BOUNDARY_EPS = 1e-7;

/** エンティティの代表点列(頂点ベース。円は中心点のみ)。corners は無視する。 */
function entityVertices(entity: SketchEntity): Point2[] {
  if (entity.kind === "rectangle") {
    const [cx, cy] = entity.center;
    const hw = entity.width / 2;
    const hh = entity.height / 2;
    return [
      [cx - hw, cy - hh],
      [cx + hw, cy - hh],
      [cx + hw, cy + hh],
      [cx - hw, cy + hh],
    ];
  }
  if (entity.kind === "circle") {
    return [entity.center];
  }
  return entity.points;
}

function distancePointToSegment(p: Point2, a: Point2, b: Point2): number {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** 点が多角形(閉ループ、polygon.length>=3)の内部または境界上にあるか(ray casting + 境界許容)。 */
function pointInPolygon(point: Point2, polygon: Point2[]): boolean {
  const [px, py] = point;
  const n = polygon.length;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (distancePointToSegment(point, a, b) <= BOUNDARY_EPS) return true;
    const [xi, yi] = a;
    const [xj, yj] = b;
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** 点から多角形の全辺までの最短距離。 */
function minDistanceToPolygonEdges(point: Point2, polygon: Point2[]): number {
  const n = polygon.length;
  let min = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    min = Math.min(min, distancePointToSegment(point, polygon[i], polygon[j]));
  }
  return min;
}

/**
 * 点が多角形の内部に「余裕を持って(境界からCONTAINMENT_EPS以上離れて)」あるか。
 * polygon-in-polygonの包含判定に使う。単なる pointInPolygon(境界接触もtrue) だと
 * 同一サイズ・同一位置の図形同士(頂点が完全一致=距離0で境界上)を互いに含む/含まれると
 * 誤判定してしまうため、境界からの最短距離がマージン未満なら「含まれない」とする。
 */
function isPointWellInsidePolygon(point: Point2, polygon: Point2[]): boolean {
  if (minDistanceToPolygonEdges(point, polygon) < CONTAINMENT_EPS) return false;
  return pointInPolygon(point, polygon);
}

function distance(a: Point2, b: Point2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * inner が outer に完全に含まれるか(頂点ベース。境界接触は「含まれる」とみなす。
 * ただし inner と outer がほぼ同一サイズ・同一位置の場合は CONTAINMENT_EPS 分のマージンにより
 * 「含まれない」と判定される=相互包含を防ぐ)。
 */
export function isContained(inner: SketchEntity, outer: SketchEntity): boolean {
  if (inner === outer || inner.id === outer.id) return false;

  if (outer.kind === "circle") {
    if (inner.kind === "circle") {
      return distance(inner.center, outer.center) + inner.radius <= outer.radius - CONTAINMENT_EPS;
    }
    const [ocx, ocy] = outer.center;
    return entityVertices(inner).every((p) => {
      const d = Math.hypot(p[0] - ocx, p[1] - ocy);
      return d <= outer.radius - CONTAINMENT_EPS;
    });
  }

  // outer は rectangle/polygon(多角形の頂点列として扱う)。
  const outerPoly = entityVertices(outer);
  if (outerPoly.length < 3) return false;

  if (inner.kind === "circle") {
    if (!pointInPolygon(inner.center, outerPoly)) return false;
    return minDistanceToPolygonEdges(inner.center, outerPoly) >= inner.radius + CONTAINMENT_EPS;
  }

  return entityVertices(inner).every((p) => isPointWellInsidePolygon(p, outerPoly));
}

export interface ContainmentClassification {
  /** 他のどのエンティティにも含まれないエンティティ(トップレベル。互いにfuseされる)。 */
  outers: SketchEntity[];
  /** いずれかのエンティティに含まれるエンティティ(穴。fuse後にまとめてcutされる)。 */
  holes: SketchEntity[];
}

/**
 * エンティティ集合を「外枠(outers)」と「穴(holes)」に分類する。
 * 分類基準は単純: 他のいずれか1つ以上のエンティティに完全に含まれていれば hole、それ以外は outer。
 * これにより2階層(外枠/穴)の分類になる。穴の中の島(3階層目)は既知の制限としてholeのまま扱われる
 * (モジュール先頭のコメント参照)。
 * 元の entities 配列内の順序を保ったまま outers/holes に振り分ける。
 */
export function classifySketchEntities(entities: SketchEntity[]): ContainmentClassification {
  const outers: SketchEntity[] = [];
  const holes: SketchEntity[] = [];
  for (const entity of entities) {
    const containedByAny = entities.some((other) => other.id !== entity.id && isContained(entity, other));
    if (containedByAny) {
      holes.push(entity);
    } else {
      outers.push(entity);
    }
  }
  return { outers, holes };
}
