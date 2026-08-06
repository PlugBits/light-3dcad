// polygonの辺の「ふくらみ(bulge)」およびスロットの半円キャップを表す3点円弧の純粋幾何計算(Phase 17)。
// ReactにもThree.jsにもReplicad(OCCT)にも依存しない(src/sketch/polygonOutline.ts等と同じ方針)。
//
// 「bulge」の定義はDXF等で使われる標準的なもの: 辺の始点p1から終点p2への円弧について
//   bulge = tan(θ/4)  (θ = p1→p2 を辺の始点を基準に反時計回り(標準的な数学のx-y平面でCCW正)に
//                       測った符号付き中心角。円弧が始点から終点まで実際に掃引する角度)
// null/0 は直線(円弧なし)を表す。
//
// evaluatorはreplicadの DrawingPen#bulgeArcTo(end, bulge) を使って実際のB-Rep形状を作る
// (node_modules/replicad/dist/replicad.js の BaseSketcher2d#bulgeArcTo/#sagittaArcTo を参照)。
// bulgeArcToの内部実装は次の通り:
//   halfChord = |end - start| / 2
//   bulgeAsSagitta = -bulge * halfChord
//   sagPoint = midpoint(start, end) + normalize(leftPerp(end - start)) * bulgeAsSagitta
//   (leftPerp([dx,dy]) = [-dy, dx]。これは start→end 方向を反時計回りに90度回したベクトル)
//   その後 start, sagPoint, end の3点円弧(makeThreePointArc相当)を作る。
// このモジュールの sagPointForBulge() はこの計算をそのまま再実装しており、bulgeArcPoints() が
// 生成する近似ポリラインが実際のB-Rep形状と(数値誤差の範囲で)一致するようにしている。
export type Point2 = [number, number];

/** polygonOutlinePoints() 等の弧分割数のデフォルト(polygonOutline.tsのDEFAULT_SEGMENTS_PER_ARCと同値)。 */
export const DEFAULT_BULGE_SEGMENTS = 16;

/**
 * bulge値から、replicadのbulgeArcTo()が内部的に使う「経由点(sagPoint)」を計算する。
 * この点はp1・p2とともに実際の円弧を一意に定める3点円弧の第2点になる。
 */
export function sagPointForBulge(p1: Point2, p2: Point2, bulge: number): Point2 {
  const mid: Point2 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const halfChord = Math.hypot(dx, dy) / 2;
  const leftPerp: Point2 = [-dy, dx];
  const len = Math.hypot(leftPerp[0], leftPerp[1]);
  if (len < 1e-12) return mid;
  const norm: Point2 = [leftPerp[0] / len, leftPerp[1] / len];
  const bulgeAsSagitta = -bulge * halfChord;
  return [mid[0] + norm[0] * bulgeAsSagitta, mid[1] + norm[1] * bulgeAsSagitta];
}

/** 3点(a,b,c)の外接円の中心・半径。3点がほぼ一直線上にある場合はnull(円が定まらない)。 */
function circumcircle(a: Point2, b: Point2, c: Point2): { center: Point2; radius: number } | null {
  const [ax, ay] = a;
  const [bx, by] = b;
  const [cx, cy] = c;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const aSq = ax * ax + ay * ay;
  const bSq = bx * bx + by * by;
  const cSq = cx * cx + cy * cy;
  const ux = (aSq * (by - cy) + bSq * (cy - ay) + cSq * (ay - by)) / d;
  const uy = (aSq * (cx - bx) + bSq * (ax - cx) + cSq * (bx - ax)) / d;
  const center: Point2 = [ux, uy];
  const radius = Math.hypot(ax - ux, ay - uy);
  return { center, radius };
}

function normalizeAngle0to2pi(angle: number): number {
  const twoPi = Math.PI * 2;
  let a = angle % twoPi;
  if (a < 0) a += twoPi;
  return a;
}

/**
 * 円の中心centerを基準に、p1からp2まで、via(3点円弧の経由点)を通る向きに掃引したときの
 * 符号付き中心角(ラジアン、反時計回りが正)を返す。p1→p2の2方向の弧のうちviaを含む方を選ぶ。
 */
function sweepThroughPoint(center: Point2, p1: Point2, p2: Point2, via: Point2): number {
  const a1 = Math.atan2(p1[1] - center[1], p1[0] - center[0]);
  const a2 = Math.atan2(p2[1] - center[1], p2[0] - center[0]);
  const aVia = Math.atan2(via[1] - center[1], via[0] - center[0]);
  const deltaCCW = normalizeAngle0to2pi(a2 - a1);
  const viaCCW = normalizeAngle0to2pi(aVia - a1);
  if (viaCCW <= deltaCCW) return deltaCCW;
  return deltaCCW - Math.PI * 2;
}

/** bulgeから換算した円弧の中心・半径・角度範囲(Phase 19a、src/sketch/intersections.ts・regions.tsが再利用)。 */
export interface ArcGeometry {
  center: Point2;
  radius: number;
  /** p1における角度(atan2、ラジアン)。 */
  startAngle: number;
  /** p1からp2までの符号付き掃引角(ラジアン、反時計回りが正)。p2における角度は startAngle+sweep。 */
  sweep: number;
}

/**
 * bulge値(p1→p2の円弧)を中心・半径・角度範囲に変換する(Phase 19a)。
 * p1・p2・経由点(sagPointForBulge)から circumcircle() で中心・半径を求め、
 * sweepThroughPoint() で経由点を通る側の符号付き掃引角を求める。
 * 3点がほぼ一直線上にある場合(円が定まらない)は null を返す(bulgeが実質0に近い場合など)。
 */
export function arcGeometryFromBulge(p1: Point2, p2: Point2, bulge: number): ArcGeometry | null {
  const via = sagPointForBulge(p1, p2, bulge);
  const circle = circumcircle(p1, via, p2);
  if (!circle) return null;
  const { center, radius } = circle;
  const startAngle = Math.atan2(p1[1] - center[1], p1[0] - center[0]);
  const sweep = sweepThroughPoint(center, p1, p2, via);
  return { center, radius, startAngle, sweep };
}

/**
 * 3点(始点p1・経由点via・終点p2)を通る円弧のbulge値(tan(θ/4))を計算する。
 * 3点がほぼ一直線上にある場合は0(直線)を返す。
 * ユーザーがビューア上でクリックした3点(線描画モードの円弧セグメント、Phase 17)を
 * SketchEntity(polygon.bulges)に保存する値へ変換するために使う。
 */
export function bulgeFromThreePoints(p1: Point2, via: Point2, p2: Point2): number {
  const circle = circumcircle(p1, via, p2);
  if (!circle) return 0;
  const theta = sweepThroughPoint(circle.center, p1, p2, via);
  return Math.tan(theta / 4);
}

/**
 * p1からp2までの、bulge値で定義された円弧を、segments分割のポリラインで近似した点列を返す
 * (p1・p2の両端を含む、長さ segments+1)。bulgeが falsy(0/null/undefined)の場合は
 * 直線とみなし [p1, p2] を返す。
 */
export function bulgeArcPoints(
  p1: Point2,
  p2: Point2,
  bulge: number | null | undefined,
  segments: number = DEFAULT_BULGE_SEGMENTS,
): Point2[] {
  if (!bulge) return [p1, p2];
  const via = sagPointForBulge(p1, p2, bulge);
  const circle = circumcircle(p1, via, p2);
  if (!circle) return [p1, p2];
  const { center, radius } = circle;
  const a1 = Math.atan2(p1[1] - center[1], p1[0] - center[0]);
  const theta = sweepThroughPoint(center, p1, p2, via);
  const segs = Math.max(1, segments);
  const points: Point2[] = [];
  for (let s = 0; s <= segs; s += 1) {
    const angle = a1 + (theta * s) / segs;
    points.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
  }
  return points;
}

/**
 * polygonの頂点コーナー(corners、fillet/chamfer)と辺のふくらみ(bulges)が同じ頂点で衝突する場合、
 * corners を優先しbulgeを無視した配列を返す(Phase 17。型ドキュメント参照)。
 * 辺i(points[i]→points[(i+1)%n])は、points[i]またはpoints[(i+1)%n]にcornerが設定されていれば
 * bulgeがnullに強制される。戻り値は常に points と同じ長さ。
 */
export function effectivePolygonBulges(
  pointsLength: number,
  corners: (unknown | null | undefined)[] | undefined,
  bulges: (number | null)[] | undefined,
): (number | null)[] {
  const n = pointsLength;
  const result: (number | null)[] = new Array(n).fill(null);
  if (bulges) {
    for (let i = 0; i < n; i += 1) {
      result[i] = bulges[i] ?? null;
    }
  }
  if (corners) {
    for (let i = 0; i < n; i += 1) {
      const next = (i + 1) % n;
      if (corners[i] || corners[next]) {
        result[i] = null;
      }
    }
  }
  return result;
}
