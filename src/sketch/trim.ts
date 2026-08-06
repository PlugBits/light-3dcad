// トリムツール(Phase 19b)の純粋幾何ロジック。ReactにもThree.jsにもReplicad(OCCT)にも依存しない
// (src/sketch/intersections.ts, regions.ts と同じ方針)。CadViewerはホバープレビュー用に
// findClosestSegmentPiece()を、App(ドキュメント更新)はtrimSegmentAtPoint()を呼ぶ。
//
// 考え方: 対象セグメント(targetId)を、同一スケッチ内の他のsegmentsとの交点(自身の端点は
// 暗黙の境界として扱われる。src/sketch/intersections.ts の splitSegmentAt() が両者を統合する)
// で「区間」に分割し、クリック/ホバー位置に最も近い区間を求める(削除候補として提示・実削除する)。
// 区間が1つしかできない(=他セグメントとの有効な交点が無い)場合は、区間全体=セグメント全体を削除する。
import type { SketchSegment } from "../model/types";
import { bulgeArcPoints } from "./bulge";
import {
  arcArcIntersection,
  lineArcIntersection,
  lineLineIntersection,
  splitSegmentAt,
  type SegIntersection,
} from "./intersections";

export type Point2 = [number, number];

function isArcWithBulge(seg: SketchSegment): boolean {
  return seg.kind === "arc" && !!seg.bulge;
}

/** target(基準)とother(相手)の交点を、種別(直線/円弧)に応じて適切なintersections.ts関数へディスパッチする。戻り値のtAはtarget上のパラメータ。 */
function intersectWithTarget(target: SketchSegment, other: SketchSegment): SegIntersection[] {
  const targetIsArc = isArcWithBulge(target);
  const otherIsArc = isArcWithBulge(other);
  if (!targetIsArc && !otherIsArc) return lineLineIntersection(target, other);
  if (!targetIsArc && otherIsArc) return lineArcIntersection(target, other);
  if (targetIsArc && !otherIsArc) {
    return lineArcIntersection(other, target).map((r) => ({ point: r.point, tA: r.tB, tB: r.tA }));
  }
  return arcArcIntersection(target, other);
}

/** セグメントのポリライン近似(直線はそのまま2点、円弧はbulgeArcPointsで近似)。距離計算・プレビュー描画用。 */
function segmentToPolyline(seg: SketchSegment, segs = 24): Point2[] {
  if (seg.kind === "arc" && seg.bulge) return bulgeArcPoints(seg.p1, seg.p2, seg.bulge, segs);
  return [seg.p1, seg.p2];
}

/** 点pから線分[a,b]への最短距離。 */
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

/** 点pからポリライン(折れ線)への最短距離。 */
export function distPointToPolyline(p: Point2, points: Point2[]): number {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    best = Math.min(best, distPointToSegment(p, points[i], points[i + 1]));
  }
  return best;
}

/** 点pからセグメント(直線/円弧)への最短距離(ポリライン近似)。CadViewerのホバー対象選定に使う。 */
export function distPointToSegmentShape(p: Point2, seg: SketchSegment): number {
  return distPointToPolyline(p, segmentToPolyline(seg));
}

/**
 * targetId のセグメントを、同一segments内の他セグメントとの交点で区切った「区間」に分割し、
 * その配列を返す(交点が無ければ元のセグメント1個だけの配列)。トリムの削除候補選定・実削除の両方の
 * 土台となる共通ヘルパー。
 */
function splitTargetIntoPieces(segments: SketchSegment[], targetId: string): { target: SketchSegment; others: SketchSegment[]; pieces: SketchSegment[] } | null {
  const target = segments.find((s) => s.id === targetId);
  if (!target) return null;
  const others = segments.filter((s) => s.id !== targetId);
  const ts = new Set<number>();
  for (const other of others) {
    for (const hit of intersectWithTarget(target, other)) {
      ts.add(hit.tA);
    }
  }
  const pieces = splitSegmentAt(target, Array.from(ts));
  return { target, others, pieces };
}

/**
 * targetId のセグメント上、point(ローカル2D、mm)に最も近い「区間」を返す(トリムのホバー
 * プレビュー用)。targetIdが見つからない場合はnull。区間は他セグメントとの交点(無ければ
 * セグメント全体そのもの)で区切られる。
 */
export function findClosestSegmentPiece(segments: SketchSegment[], targetId: string, point: Point2): SketchSegment | null {
  const split = splitTargetIntoPieces(segments, targetId);
  if (!split) return null;
  let best = split.pieces[0];
  let bestDist = Infinity;
  for (const piece of split.pieces) {
    const d = distPointToSegmentShape(point, piece);
    if (d < bestDist) {
      bestDist = d;
      best = piece;
    }
  }
  return best;
}

/**
 * targetId のセグメント上、clickPoint(ローカル2D、mm)に最も近い区間を削除した新しいsegments配列を
 * 返す(元の配列は変更しない)。
 * - 区間が2つ以上(=他セグメントとの交点で分割できた)場合: クリックに最も近い区間だけを削除し、
 *   残りの区間(セグメント分割済み)を保持する。
 * - 区間が1つしかない(交点なし、または全交点が端点近傍で実質分割できない)場合:
 *   セグメント全体を削除する。
 * targetId が見つからない場合は元の配列をそのまま返す。
 */
export function trimSegmentAtPoint(segments: SketchSegment[], targetId: string, clickPoint: Point2): SketchSegment[] {
  const split = splitTargetIntoPieces(segments, targetId);
  if (!split) return segments;
  const { others, pieces } = split;
  if (pieces.length <= 1) {
    return others;
  }
  let removeIndex = 0;
  let bestDist = Infinity;
  pieces.forEach((piece, i) => {
    const d = distPointToSegmentShape(clickPoint, piece);
    if (d < bestDist) {
      bestDist = d;
      removeIndex = i;
    }
  });
  const kept = pieces.filter((_, i) => i !== removeIndex);
  return [...others, ...kept];
}
