// スケッチ内エンティティ(rectangle/circle/polygon)の「包含」判定(Phase 15、Phase 21で境界接触バグ修正)。
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
//   - outerが円の場合: innerの全代表点が outer の中心からouter.radius以内にある(境界接触=含まれる)
//     (innerが円の場合はさらに「中心間距離 + inner.radius <= outer.radius」で判定する。
//     代表点=中心点だけでは半径を考慮できないための特別扱い)。
//   - outerが多角形(rectangle/polygon)の場合: innerの全代表点が outer の多角形の内部(境界含む)にある
//     (innerが円の場合はさらに「円の中心から多角形の各辺までの最短距離 >= inner.radius」も満たす必要がある。
//     中心点だけでは半径分のはみ出しを検出できないための特別扱い)。
//   境界にちょうど接する(タンジェント)場合も「含まれる」とみなす(Phase 21で修正: 以前は微小マージンで
//   除外していたため、たとえば「幅20の矩形の中心に半径10の円」のような、辺の中点にちょうど接する
//   ごく普通の寸法の組み合わせがholeとして分類されず、押し出し結果から穴が消える不具合があった)。
//
// 同一形状・同一サイズの相互包含(A⊆B かつ B⊆A)を避けるための処理: 2つの閉領域が互いを包含し合う
// (A⊆B かつ B⊆A)のは、集合として完全に一致する場合に限られる(凸/非凸を問わない一般的な事実)。
// そのため isContained(inner, outer) は「非厳密(境界接触を含む)包含テスト」を両方向で行い、
// 両方向とも真になる(=同一形状の相互包含)場合にのみ「含まれない」と判定する(rawContains参照)。
// これにより、境界に接するだけの真に異なるサイズの図形(上記の例)は正しくholeと判定されつつ、
// ちょうど同じ大きさ・同じ位置の2つの図形は従来どおり互いにholeと判定されない(どちらもtop-levelのまま)。
//
// ネストの階層: このモジュールが提供する分類は「outer(外枠)」と「hole(穴)」の2階層のみ。
// 「他のいずれかのエンティティに含まれる」エンティティは無条件でholeとして扱う。そのため、
// 穴の中にさらに島(3階層目=本来はfuseすべき突起)がある場合、その島は「holeであるエンティティに
// 含まれるhole」として扱われ、誤ってholeのまま(削れてしまう)になる既知の制限がある
// (真の偶奇ネストにするには階層の深さを数える必要があるが、Phase 15スコープでは対応しない)。
import type { SketchEntity } from "../model/types";
import { regularPolygonVertices, slotAxisNormal } from "./shapeFromPoints";

export type Point2 = [number, number];

/**
 * 浮動小数点誤差を吸収するための微小許容(mm)。境界接触(タンジェント)は「含まれる」側として扱うため、
 * 各種の比較で許容側(緩める方向)にのみ加える(誤ってfalse negativeにしないため)。
 * 設計上の「相互包含防止」の役割はもう持たない(rawContainsの両方向テストに置き換えた、モジュール
 * 先頭のコメント参照)。
 */
const FLOAT_EPS = 1e-9;
/** 点が多角形の辺上にあるとみなす距離許容(mm)。 */
const BOUNDARY_EPS = 1e-7;

/**
 * エンティティの代表点列(頂点ベース。円は中心点のみ)。corners/bulges(円弧のふくらみ)は無視する
 * (モジュール先頭のコメント参照。既知の近似)。
 * slot は4つの角(直線部の頂点、半円キャップの膨らみは無視)、regularPolygon は正確な頂点列を使う。
 */
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
  if (entity.kind === "slot") {
    const r = entity.width / 2;
    const n = slotAxisNormal(entity.start, entity.end);
    const [sx, sy] = entity.start;
    const [ex, ey] = entity.end;
    return [
      [sx + n[0] * r, sy + n[1] * r],
      [ex + n[0] * r, ey + n[1] * r],
      [ex - n[0] * r, ey - n[1] * r],
      [sx - n[0] * r, sy - n[1] * r],
    ];
  }
  if (entity.kind === "regularPolygon") {
    return regularPolygonVertices(entity.center, entity.radius, entity.sides, entity.rotation ?? 0);
  }
  // 点(Phase 47)は呼び出し元(evaluator.tsのbuildDrawingParts)が常に除外するため実際には
  // 渡されないはずだが、型を満たすためのフォールバック(面積ゼロの1点として扱う)。
  if (entity.kind === "point") {
    return [entity.position];
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

function distance(a: Point2, b: Point2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * inner が outer に「非厳密に(境界接触を含めて)」完全に含まれるか(頂点ベース)。
 * isContained()の実装用ヘルパーで、単体では相互包含(同一形状同士)を区別しない
 * (両方向とも true になりうる。呼び出し側のisContained()がその場合を後処理する)。
 */
function rawContains(inner: SketchEntity, outer: SketchEntity): boolean {
  if (outer.kind === "circle") {
    if (inner.kind === "circle") {
      return distance(inner.center, outer.center) + inner.radius <= outer.radius + FLOAT_EPS;
    }
    const [ocx, ocy] = outer.center;
    return entityVertices(inner).every((p) => {
      const d = Math.hypot(p[0] - ocx, p[1] - ocy);
      return d <= outer.radius + FLOAT_EPS;
    });
  }

  // outer は rectangle/polygon(多角形の頂点列として扱う)。
  const outerPoly = entityVertices(outer);
  if (outerPoly.length < 3) return false;

  if (inner.kind === "circle") {
    if (!pointInPolygon(inner.center, outerPoly)) return false;
    return minDistanceToPolygonEdges(inner.center, outerPoly) >= inner.radius - FLOAT_EPS;
  }

  return entityVertices(inner).every((p) => pointInPolygon(p, outerPoly));
}

/**
 * inner が outer に完全に含まれるか(頂点ベース。境界接触=ちょうど内接・タンジェントも「含まれる」と
 * みなす、Phase 21)。
 * rawContains()を両方向で評価し、両方向とも真(=inner と outer が集合として一致する、同一形状・
 * 同一サイズ・同一位置の場合に限られる)であれば「含まれない」とする(相互包含の防止。
 * モジュール先頭のコメント参照)。
 */
export function isContained(inner: SketchEntity, outer: SketchEntity): boolean {
  if (inner === outer || inner.id === outer.id) return false;
  if (!rawContains(inner, outer)) return false;
  return !rawContains(outer, inner);
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
