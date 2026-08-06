// 端点を共有する2本の自由な直線セグメント(kind:"line")同士の角に、フィレット(丸め)/面取りを
// 適用する純粋幾何ロジック(Phase 24)。ReactにもThree.jsにもReplicad(OCCT)にも依存しない
// (src/sketch/polygonOutline.ts, trim.ts 等と同じ方針)。
//
// 幾何: 共有端点V(許容1e-6で一致判定)で2本の線分a・bが交わっているとき、Vにおける内角
// (Vからそれぞれの遠端へ向かう単位ベクトルのなす角)をphiとする。半径/面取りサイズsizeに対する
// V→接点の距離Lは L = size / tan(phi/2)。これは仕様上の「r・tan(θ/2)」(θ=π-phi、辺の
// 折れ角=外角)と等価(tan(phi/2) = tan(π/2 - θ/2) = 1/tan(θ/2) より size/tan(phi/2) = size・tan(θ/2))。
// フィレットの円弧はsrc/sketch/bulge.tsのbulgeFromThreePoints()に、接点2つと弧の頂点
// (V側に最も近い弧上の点)を渡して求める(3点円弧の一般式を再利用し、符号付きbulgeを正しく得る)。
//
// 円弧セグメント(kind:"arc")が絡む角はv1では非対応(null を返す)。
import { generateId } from "../model/id";
import type { SketchSegment } from "../model/types";
import { bulgeFromThreePoints } from "./bulge";

type Point2 = [number, number];

const EPS = 1e-6;

function samePoint(p: Point2, q: Point2): boolean {
  return Math.hypot(p[0] - q[0], p[1] - q[1]) < EPS;
}

export interface SharedEndpoint {
  aEnd: "p1" | "p2";
  bEnd: "p1" | "p2";
  point: Point2;
}

/**
 * 2本の線分セグメントa・bが端点を共有しているか調べる(許容1e-6)。共有していればどちらの端点同士か
 * (aEnd/bEnd)と共有点座標を返す。共有していなければnull(複数の組み合わせが一致する場合は
 * p1/p2の探索順で最初に見つかったものを返す)。
 */
export function findSharedEndpoint(a: SketchSegment, b: SketchSegment): SharedEndpoint | null {
  const ends: ("p1" | "p2")[] = ["p1", "p2"];
  for (const aEnd of ends) {
    for (const bEnd of ends) {
      if (samePoint(a[aEnd], b[bEnd])) return { aEnd, bEnd, point: a[aEnd] };
    }
  }
  return null;
}

export interface SegmentCornerResult {
  /** 共有端点側が接点まで短縮されたa(idはaのまま)。 */
  a: SketchSegment;
  /** 共有端点側が接点まで短縮されたb(idはbのまま)。 */
  b: SketchSegment;
  /** 2つの接点を結ぶ新規セグメント(fillet=円弧、chamfer=直線、新規id)。 */
  corner: SketchSegment;
}

/**
 * 線分a・bが共有端点(findSharedEndpoint)で作る角に、フィレット/面取りを適用する。
 * 両線分を共有端点側からL=size/tan(phi/2)だけ短縮し(phi=共有端点における2線分の内角)、
 * 短縮後の端点間を接続するセグメント(fillet:円弧、chamfer:直線)を返す。
 * 以下の場合はnull(適用不可、呼び出し側は何もしない想定):
 * - a・bのいずれかがkind:"line"でない(円弧が絡む角、v1対象外)
 * - size<=0
 * - 共有端点が見つからない
 * - 内角phiが退化(ほぼ0=同一方向に重なる、ほぼπ=一直線上、角が定まらない)
 * - 短縮長Lが元の線分長以上(サイズが大きすぎて線分内に収まらない)
 */
export function applySegmentCorner(
  a: SketchSegment,
  b: SketchSegment,
  kind: "fillet" | "chamfer",
  size: number,
): SegmentCornerResult | null {
  if (a.kind !== "line" || b.kind !== "line") return null;
  if (!(size > 0)) return null;
  const shared = findSharedEndpoint(a, b);
  if (!shared) return null;
  const { aEnd, bEnd, point } = shared;
  const aFar: Point2 = aEnd === "p1" ? a.p2 : a.p1;
  const bFar: Point2 = bEnd === "p1" ? b.p2 : b.p1;
  const lenA = Math.hypot(aFar[0] - point[0], aFar[1] - point[1]);
  const lenB = Math.hypot(bFar[0] - point[0], bFar[1] - point[1]);
  if (lenA < EPS || lenB < EPS) return null;
  const dirA: Point2 = [(aFar[0] - point[0]) / lenA, (aFar[1] - point[1]) / lenA];
  const dirB: Point2 = [(bFar[0] - point[0]) / lenB, (bFar[1] - point[1]) / lenB];
  const dot = Math.max(-1, Math.min(1, dirA[0] * dirB[0] + dirA[1] * dirB[1]));
  const phi = Math.acos(dot);
  if (phi < 1e-6 || phi > Math.PI - 1e-6) return null;
  const L = size / Math.tan(phi / 2);
  if (!Number.isFinite(L) || L <= 0) return null;
  if (L >= lenA || L >= lenB) return null;

  const tA: Point2 = [point[0] + dirA[0] * L, point[1] + dirA[1] * L];
  const tB: Point2 = [point[0] + dirB[0] * L, point[1] + dirB[1] * L];
  const nextA: SketchSegment = { ...a, p1: aEnd === "p1" ? tA : a.p1, p2: aEnd === "p2" ? tA : a.p2 };
  const nextB: SketchSegment = { ...b, p1: bEnd === "p1" ? tB : b.p1, p2: bEnd === "p2" ? tB : b.p2 };

  if (kind === "chamfer") {
    return { a: nextA, b: nextB, corner: { id: generateId("segment"), kind: "line", p1: tA, p2: tB } };
  }

  // fillet: 半径sizeの円弧。中心はVからの角の二等分線上、Vからの距離 = size / sin(phi/2)。
  const bisectorRaw: Point2 = [dirA[0] + dirB[0], dirA[1] + dirB[1]];
  const bisectorLen = Math.hypot(bisectorRaw[0], bisectorRaw[1]);
  if (bisectorLen < 1e-9) return null;
  const u: Point2 = [bisectorRaw[0] / bisectorLen, bisectorRaw[1] / bisectorLen];
  const distToCenter = size / Math.sin(phi / 2);
  // via: 弧上でVに最も近い点(中心からV方向に半径size分戻った点)。3点円弧(tA, via, tB)からbulgeを求める。
  const via: Point2 = [point[0] + u[0] * (distToCenter - size), point[1] + u[1] * (distToCenter - size)];
  const bulge = bulgeFromThreePoints(tA, via, tB);
  return { a: nextA, b: nextB, corner: { id: generateId("segment"), kind: "arc", p1: tA, p2: tB, bulge } };
}
