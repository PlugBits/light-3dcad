// polygonエンティティの頂点フィレット/面取り(Phase 11)の純粋幾何計算。
// ReactにもThree.jsにも依存しない(src/sketch/snapping.ts, dimensions.ts と同じ方針)。
//
// evaluator(src/worker/evaluator.ts)はreplicadの DrawingPen#customCorner() /
// #closeWithCustomCorner() を使って実際のB-Rep形状を作る。この2つのAPIは、頂点の
// コーナーを「隣接する2直線を size だけオフセットしてできる交点」を中心とする円弧(fillet)、
// または「その交点に接する2つの接点を直線で結ぶ」(chamfer)として処理する
// (node_modules/replicad/dist/replicad.js の removeCorner/filletCurves/chamferCurves を参照)。
// これは2直線の場合、標準的な「フィレット半径」の幾何(頂点から接点までの距離
// t = size / tan(interiorAngle/2)、頂点から中心までの距離 L = size / sin(interiorAngle/2))と
// 数学的に同一である。このモジュールはその同じ公式をJSで再実装し、スケッチ線オーバーレイが
// 実際のB-Rep形状と(数値誤差の範囲で)完全に一致するようにする。
//
// 「size」の意味は fillet/chamfer で共通(接点までの距離を決めるオフセット値)であり、
// chamferの「脚の長さ」は直角(90度)の頂点でのみ size と一致する(それ以外の角度では
// t = size / tan(interiorAngle/2) が脚の長さになる)。
import type { PolygonCorner } from "../model/types";

export type Point2 = [number, number];

/** 円弧・直線の接点や中心などの詳細幾何。テストで個別に検証しやすいよう公開する。 */
export interface CornerGeometry {
  /** 前の頂点側の辺(prev→curr)上の接点。 */
  tangent1: Point2;
  /** 次の頂点側の辺(curr→next)上の接点。 */
  tangent2: Point2;
  /** fillet のみ: 円弧の中心。 */
  center?: Point2;
  /** fillet のみ: 円弧の開始角(center基準、ラジアン、tangent1の角度)。 */
  startAngle?: number;
  /** fillet のみ: 円弧の終了角(center基準、ラジアン、tangent2の角度)。tangent1→tangent2の向きに符号付き。 */
  endAngle?: number;
}

// replicadのremoveCorner()(node_modules/replicad/dist/replicad.js)は、辺の接線方向同士の
// 外積(cross)がこの程度以下ならフィレット/面取りを行わず素通しする(コーナーとして扱わない)。
// 同じ閾値を使うことで「evaluatorが実際にコーナー処理をスキップするケース」と
// 「オーバーレイが頂点をそのまま描くケース」を一致させる。
const DEGENERATE_CROSS_EPS = 1e-10;

function unit(v: Point2): Point2 {
  const len = Math.hypot(v[0], v[1]);
  if (len < 1e-12) return [0, 0];
  return [v[0] / len, v[1] / len];
}

/**
 * 頂点 curr のコーナー幾何(接点・中心・角度)を計算する。
 * 前後の辺がほぼ平行(内角がほぼ0度=スパイク、またはほぼ180度=直線状で角が実質存在しない)場合は
 * replicadのremoveCorner()と同じ基準(辺の接線方向の外積がほぼ0)で退化とみなし null を返す
 * (呼び出し側は頂点をそのまま使う=角処理なしで素通しする)。
 */
export function computeCornerGeometry(prev: Point2, curr: Point2, next: Point2, corner: { kind: "fillet" | "chamfer"; size: number }): CornerGeometry | null {
  const d1 = unit([prev[0] - curr[0], prev[1] - curr[1]]);
  const d2 = unit([next[0] - curr[0], next[1] - curr[1]]);
  if ((d1[0] === 0 && d1[1] === 0) || (d2[0] === 0 && d2[1] === 0)) return null;

  // 辺の接線方向(edge1: prev->curr、edge2: curr->next。d1はcurr->prevなのでedge1方向は-d1)の外積。
  const edge1Dir: Point2 = [-d1[0], -d1[1]];
  const edgeCross = edge1Dir[0] * d2[1] - edge1Dir[1] * d2[0];
  if (Math.abs(edgeCross) < DEGENERATE_CROSS_EPS) {
    return null; // 前後の辺がほぼ平行(スパイクまたは直線状)で角処理の意味がない
  }

  const dot = Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1]));
  const phi = Math.acos(dot); // 内角の「くさび角」(0, π)
  const half = phi / 2;

  const size = corner.size;
  const t = size / Math.tan(half);
  const tangent1: Point2 = [curr[0] + d1[0] * t, curr[1] + d1[1] * t];
  const tangent2: Point2 = [curr[0] + d2[0] * t, curr[1] + d2[1] * t];

  if (corner.kind === "chamfer") {
    return { tangent1, tangent2 };
  }

  const bisector = unit([d1[0] + d2[0], d1[1] + d2[1]]);
  const distanceToCenter = size / Math.sin(half);
  const center: Point2 = [curr[0] + bisector[0] * distanceToCenter, curr[1] + bisector[1] * distanceToCenter];

  const startAngle = Math.atan2(tangent1[1] - center[1], tangent1[0] - center[0]);
  const rawEnd = Math.atan2(tangent2[1] - center[1], tangent2[0] - center[0]);
  // tangent1→tangent2 の掃引角(| |=π-φ)になるよう、endAngleを(startAngle-π, startAngle+π]に正規化する。
  let delta = rawEnd - startAngle;
  while (delta <= -Math.PI) delta += Math.PI * 2;
  while (delta > Math.PI) delta -= Math.PI * 2;
  const endAngle = startAngle + delta;

  return { tangent1, tangent2, center, startAngle, endAngle };
}

/**
 * points[i] のコーナー処理後の出力点列(頂点そのもの、または接点+弧/直線)を返す。
 * corner が null/未指定、または計算が退化した場合は頂点をそのまま1点で返す。
 */
function cornerOutputPoints(prev: Point2, curr: Point2, next: Point2, corner: PolygonCorner, segmentsPerArc: number): Point2[] {
  if (!corner) return [curr];
  const geometry = computeCornerGeometry(prev, curr, next, corner);
  if (!geometry) return [curr];

  if (corner.kind === "chamfer") {
    return [geometry.tangent1, geometry.tangent2];
  }

  const { center, startAngle, endAngle } = geometry;
  if (center === undefined || startAngle === undefined || endAngle === undefined) return [curr];
  const radius = corner.size;
  const points: Point2[] = [];
  const segments = Math.max(1, segmentsPerArc);
  for (let s = 0; s <= segments; s += 1) {
    const angle = startAngle + ((endAngle - startAngle) * s) / segments;
    points.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
  }
  return points;
}

/** polygonOutlinePoints() の弧分割数のデフォルト。 */
export const DEFAULT_SEGMENTS_PER_ARC = 16;

/**
 * polygonの頂点列(points)+頂点ごとのコーナー指定(corners)から、フィレット/面取り適用後の
 * 輪郭を近似する閉ポリライン(頂点列)を返す。points.length < 3 の場合は points をそのまま返す
 * (呼び出し側のバリデーションに委ねる)。
 * 戻り値は「閉じた輪郭」を表す頂点列であり、最後の点と最初の点の間の辺は暗黙(LineLoop等で
 * 描画する呼び出し側が閉じる)。
 */
export function polygonOutlinePoints(
  points: Point2[],
  corners: PolygonCorner[] | undefined,
  segmentsPerArc: number = DEFAULT_SEGMENTS_PER_ARC,
): Point2[] {
  const n = points.length;
  if (n < 3) return points.slice();

  const result: Point2[] = [];
  for (let i = 0; i < n; i += 1) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    const corner = corners?.[i] ?? null;
    result.push(...cornerOutputPoints(prev, curr, next, corner, segmentsPerArc));
  }
  return result;
}
