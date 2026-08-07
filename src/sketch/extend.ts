// 線分延長ツール(Phase 31b)の純粋幾何ロジック。ReactにもThree.jsにもReplicad(OCCT)にも依存しない
// (src/sketch/trim.ts と同じ方針)。トリムの逆の操作: 対象セグメント(targetId、直線のみ。円弧の
// 延長はv1対象外)の、クリック/ホバー位置に近い側の端点を、その線分を通る無限直線上で最初に交わる
// 相手(同一segments内の他セグメント・同一スケッチのentities輪郭(explodeEntity()で自由セグメントへ
// 一時的に分解したもの)・任意で渡す参照エッジ)まで移動する(区間を延長する)。交わる相手が無ければ
// 何もしない(nullを返す)。
//
// CadViewerはホバープレビュー用に findExtensionTarget() を、App(ドキュメント更新)は
// extendSegmentAtPoint() を呼ぶ(src/sketch/trim.ts の findClosestSegmentPiece()/trimSegmentAtPoint()
// と同じ役割分担)。
import type { SketchEntity, SketchSegment } from "../model/types";
import { arcGeometryFromBulge } from "./bulge";
import { explodeEntity } from "./explode";

export type Point2 = [number, number];

/** 交点計算の距離許容(mm)。src/sketch/intersections.ts の EPS と同じ考え方。 */
const EPS = 1e-6;

/** 境界として扱える最低限の形状(線分・参照エッジ共通)。bulgeがあれば円弧として扱う。 */
export interface ExtendBoundary {
  p1: Point2;
  p2: Point2;
  bulge?: number | null;
}

function dist(a: Point2, b: Point2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function sub(a: Point2, b: Point2): Point2 {
  return [a[0] - b[0], a[1] - b[1]];
}

function dot(a: Point2, b: Point2): number {
  return a[0] * b[0] + a[1] * b[1];
}

function cross2(a: Point2, b: Point2): number {
  return a[0] * b[1] - a[1] * b[0];
}

interface RayHit {
  /** target直線(p1 + t*d)上のパラメータ。延長側では1より大きい、または0より小さい。 */
  t: number;
  point: Point2;
}

/** target(無限直線、origin + t*d)と直線境界otherとの交点(otherは自身の範囲[0,1]内のみ有効)。 */
function rayVsLineBoundary(origin: Point2, d: Point2, other: ExtendBoundary): RayHit | null {
  const d2 = sub(other.p2, other.p1);
  const dLen = Math.hypot(d[0], d[1]);
  const d2Len = Math.hypot(d2[0], d2[1]);
  if (dLen < EPS || d2Len < EPS) return null;
  const denom = cross2(d, d2);
  if (Math.abs(denom) <= EPS * dLen * d2Len) return null; // 平行(同一線上ケースはv1では対象外)
  const w = sub(other.p1, origin);
  const t = cross2(w, d2) / denom;
  const s = cross2(w, d) / denom;
  const sTol = EPS / Math.max(d2Len, EPS);
  if (s < -sTol || s > 1 + sTol) return null;
  const point: Point2 = [origin[0] + t * d[0], origin[1] + t * d[1]];
  return { t, point };
}

/** target(無限直線)と円弧境界otherとの交点(otherの実際の弧範囲内のみ)。複数ヒットしうる。 */
function rayVsArcBoundary(origin: Point2, d: Point2, other: ExtendBoundary): RayHit[] {
  if (!other.bulge) return [];
  const geom = arcGeometryFromBulge(other.p1, other.p2, other.bulge);
  if (!geom) return [];
  const f = sub(origin, geom.center);
  const a = dot(d, d);
  const b = 2 * dot(d, f);
  const c = dot(f, f) - geom.radius * geom.radius;
  if (a <= EPS * EPS) return [];
  const disc = b * b - 4 * a * c;
  const discTol = EPS * Math.max(1, a * geom.radius);
  if (disc < -discTol) return [];
  const safeDisc = Math.max(0, disc);
  const sq = Math.sqrt(safeDisc);
  const isTangent = safeDisc <= discTol;
  const roots = isTangent ? [-b / (2 * a)] : [(-b - sq) / (2 * a), (-b + sq) / (2 * a)];
  const arcLen = geom.radius * Math.abs(geom.sweep);
  const tTolArc = EPS / Math.max(arcLen, EPS);
  const twoPi = Math.PI * 2;

  const results: RayHit[] = [];
  for (const t of roots) {
    const point: Point2 = [origin[0] + t * d[0], origin[1] + t * d[1]];
    const angle = Math.atan2(point[1] - geom.center[1], point[0] - geom.center[0]);
    let delta = angle - geom.startAngle;
    delta -= twoPi * Math.round(delta / twoPi); // (-π, π] に正規化
    if (geom.sweep > 0 && delta < 0) delta += twoPi;
    if (geom.sweep < 0 && delta > 0) delta -= twoPi;
    const frac = delta / geom.sweep;
    if (frac < -tTolArc || frac > 1 + tTolArc) continue;
    results.push({ t, point });
  }
  return results;
}

/** SketchSegmentをExtendBoundaryへ変換する(bulgeがあれば円弧境界として扱う)。 */
function segmentToBoundary(seg: SketchSegment): ExtendBoundary {
  return { p1: seg.p1, p2: seg.p2, bulge: seg.kind === "arc" ? seg.bulge : undefined };
}

/** 延長がヒットした結果: どちらの端点が、どの点まで動くか。 */
export interface ExtensionHit {
  end: "p1" | "p2";
  point: Point2;
}

/**
 * targetId のセグメント(直線のみ。円弧はv1対象外でnull)上、point(ローカル2D、mm)に近い側の端点を、
 * その線分を通る無限直線上で最初に交わる境界(同一segments内の他セグメント+同一スケッチのentities
 * 輪郭(explodeEntity())+任意のreferenceEdges)まで延長した場合のヒット情報を返す。
 * 交わる境界が無い・targetIdが見つからない・targetが円弧の場合はnull。
 */
export function findExtensionTarget(
  segments: SketchSegment[],
  entities: SketchEntity[],
  targetId: string,
  point: Point2,
  referenceEdges: ExtendBoundary[] = [],
): ExtensionHit | null {
  const target = segments.find((s) => s.id === targetId);
  if (!target) return null;
  if (target.kind === "arc" && target.bulge) return null; // 円弧の延長はv1対象外

  const d: Point2 = sub(target.p2, target.p1);
  if (Math.hypot(d[0], d[1]) < EPS) return null;

  // カーソルに近い側の端点を延長対象にする(遠い側は動かさない)。
  const near: "p1" | "p2" = dist(point, target.p1) <= dist(point, target.p2) ? "p1" : "p2";
  // near==="p2"のときはp1を原点にp2方向へ(t=1が現在のp2、t>1が延長側)。
  // near==="p1"のときも同じ直線パラメータを使い、t<0側(p1を越えた側)を延長側として扱う。
  const origin = target.p1;

  const others = segments.filter((s) => s.id !== targetId).map(segmentToBoundary);
  const entityBoundaries = entities.flatMap((entity) => explodeEntity(entity)).map(segmentToBoundary);
  const boundaries = [...others, ...entityBoundaries, ...referenceEdges];

  let bestT: number | null = null;
  let bestPoint: Point2 | null = null;
  const consider = (t: number, p: Point2) => {
    if (near === "p2") {
      if (t <= 1 + EPS) return; // 自身の区間内・既存端点は延長ではない
      if (bestT === null || t < bestT) {
        bestT = t;
        bestPoint = p;
      }
    } else {
      if (t >= -EPS) return;
      if (bestT === null || t > bestT) {
        bestT = t;
        bestPoint = p;
      }
    }
  };

  for (const boundary of boundaries) {
    if (boundary.bulge) {
      for (const hit of rayVsArcBoundary(origin, d, boundary)) consider(hit.t, hit.point);
    } else {
      const hit = rayVsLineBoundary(origin, d, boundary);
      if (hit) consider(hit.t, hit.point);
    }
  }

  if (bestPoint === null) return null;
  return { end: near, point: bestPoint };
}

/**
 * targetId のセグメントを、point(ローカル2D、mm)に近い側の端点について、その線分を通る無限直線上で
 * 最初に交わる境界まで延長した新しいsegments配列を返す(元の配列は変更しない)。延長対象が見つからない
 * 場合(交わる境界が無い・targetIdが見つからない・targetが円弧)はnullを返す。
 */
export function extendSegmentAtPoint(
  segments: SketchSegment[],
  entities: SketchEntity[],
  targetId: string,
  point: Point2,
  referenceEdges: ExtendBoundary[] = [],
): SketchSegment[] | null {
  const index = segments.findIndex((s) => s.id === targetId);
  if (index === -1) return null;
  const hit = findExtensionTarget(segments, entities, targetId, point, referenceEdges);
  if (!hit) return null;
  const target = segments[index];
  const updated: SketchSegment = { ...target, [hit.end]: hit.point };
  const next = [...segments];
  next[index] = updated;
  return next;
}
