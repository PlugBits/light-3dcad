// エンティティ(rectangle/circle/polygon/slot/regularPolygon)を等価な自由セグメント(line/arc、
// Phase 19a)へ変換する「分解」ロジック(Phase 19b)。ReactにもThree.jsにもReplicad(OCCT)にも
// 依存しない純粋TypeScript(src/sketch/polygonOutline.ts, shapeFromPoints.ts と同じ方針)。
// 分解結果はトリムツール(src/sketch/trim.ts)の対象になる。
import { generateId } from "../model/id";
import type { PolygonCorner, SketchEntity, SketchSegment } from "../model/types";
import { effectivePolygonBulges } from "./bulge";
import { computeCornerGeometry } from "./polygonOutline";
import { regularPolygonVertices, slotAxisNormal, SLOT_CAP_BULGE } from "./shapeFromPoints";

type Point2 = [number, number];

function lineSeg(p1: Point2, p2: Point2): SketchSegment {
  return { id: generateId("segment"), kind: "line", p1, p2 };
}

function arcSeg(p1: Point2, p2: Point2, bulge: number): SketchSegment {
  return { id: generateId("segment"), kind: "arc", p1, p2, bulge };
}

/** 閉ループの頂点列(points)から、隣接する頂点同士を結ぶ直線セグメント列を返す(最後→最初も結ぶ)。 */
function loopToLineSegments(points: Point2[]): SketchSegment[] {
  const n = points.length;
  const segments: SketchSegment[] = [];
  for (let i = 0; i < n; i += 1) {
    segments.push(lineSeg(points[i], points[(i + 1) % n]));
  }
  return segments;
}

/** rectangleエンティティを4本の直線セグメント(閉ループ)に展開する。 */
function explodeRectangle(entity: Extract<SketchEntity, { kind: "rectangle" }>): SketchSegment[] {
  const [cx, cy] = entity.center;
  const hw = entity.width / 2;
  const hh = entity.height / 2;
  const points: Point2[] = [
    [cx - hw, cy - hh],
    [cx + hw, cy - hh],
    [cx + hw, cy + hh],
    [cx - hw, cy + hh],
  ];
  return loopToLineSegments(points);
}

/**
 * circleエンティティを半円弧2本(閉ループ)に展開する。
 * bulge=-1 は src/sketch/shapeFromPoints.ts の SLOT_CAP_BULGE と同じ規約(このモジュールの
 * sagPointForBulge()経由で、p1→p2の左手法線と逆方向に膨らむ)。左端→右端(上半分)・
 * 右端→左端(下半分)いずれもbulge=-1で正しく上下の半円になる(src/sketch/bulge.tsのsagPointForBulge参照)。
 */
function explodeCircle(entity: Extract<SketchEntity, { kind: "circle" }>): SketchSegment[] {
  const [cx, cy] = entity.center;
  const r = entity.radius;
  const left: Point2 = [cx - r, cy];
  const right: Point2 = [cx + r, cy];
  return [arcSeg(left, right, -1), arcSeg(right, left, -1)];
}

/** slotエンティティを直線2本+半円弧2本(閉ループ)に展開する(src/sketch/shapeFromPoints.tsのslotOutlinePoints相当)。 */
function explodeSlot(entity: Extract<SketchEntity, { kind: "slot" }>): SketchSegment[] {
  const r = entity.width / 2;
  const n = slotAxisNormal(entity.start, entity.end);
  const a: Point2 = [entity.start[0] + n[0] * r, entity.start[1] + n[1] * r];
  const b: Point2 = [entity.end[0] + n[0] * r, entity.end[1] + n[1] * r];
  const c: Point2 = [entity.end[0] - n[0] * r, entity.end[1] - n[1] * r];
  const d: Point2 = [entity.start[0] - n[0] * r, entity.start[1] - n[1] * r];
  return [lineSeg(a, b), arcSeg(b, c, SLOT_CAP_BULGE), lineSeg(c, d), arcSeg(d, a, SLOT_CAP_BULGE)];
}

/** regularPolygonエンティティを直線セグメント列(閉ループ)に展開する(コーナー指定は持たないため常に直線)。 */
function explodeRegularPolygon(entity: Extract<SketchEntity, { kind: "regularPolygon" }>): SketchSegment[] {
  const points = regularPolygonVertices(entity.center, entity.radius, entity.sides, entity.rotation ?? 0);
  return loopToLineSegments(points);
}

/**
 * polygonエンティティを直線・円弧セグメント列(閉ループ)に展開する。頂点のフィレット/面取り
 * (corners)は接点間を正確な円弧/直線に、辺のふくらみ(bulges)は正確な円弧に変換する
 * (src/sketch/polygonOutline.ts の polygonOutlinePoints() と同じ幾何計算を再利用し、
 * ポリライン近似ではなく厳密なarc/lineセグメントとして出力する点のみ異なる)。
 */
function explodePolygon(entity: Extract<SketchEntity, { kind: "polygon" }>): SketchSegment[] {
  const points = entity.points;
  const n = points.length;
  if (n < 3) return [];
  const corners: PolygonCorner[] | undefined = entity.corners;
  const effectiveBulges = effectivePolygonBulges(n, corners, entity.bulges);

  // 各頂点の「出口点」(前の辺から見た終端、通常はcurrそのものだが、フィレット/面取りがあれば
  // その接点tangent2)と「入口点」(次の辺から見た始端、通常はcurr、コーナーがあればtangent1)、
  // およびコーナー自体のセグメント(fillet=円弧/chamfer=直線、コーナー無し・退化はnull)。
  const exitPoints: Point2[] = new Array(n);
  const entryPoints: Point2[] = new Array(n);
  const cornerSegmentAt: (SketchSegment | null)[] = new Array(n).fill(null);

  for (let i = 0; i < n; i += 1) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    const corner = corners?.[i] ?? null;
    if (!corner) {
      exitPoints[i] = curr;
      entryPoints[i] = curr;
      continue;
    }
    const geometry = computeCornerGeometry(prev, curr, next, corner);
    if (!geometry) {
      // replicad同様、退化(スパイク/直線状)は角処理なしで頂点をそのまま使う。
      exitPoints[i] = curr;
      entryPoints[i] = curr;
      continue;
    }
    entryPoints[i] = geometry.tangent1;
    exitPoints[i] = geometry.tangent2;
    if (corner.kind === "chamfer") {
      cornerSegmentAt[i] = lineSeg(geometry.tangent1, geometry.tangent2);
    } else {
      const { startAngle, endAngle } = geometry;
      const bulge = Math.tan((endAngle! - startAngle!) / 4);
      cornerSegmentAt[i] = arcSeg(geometry.tangent1, geometry.tangent2, bulge);
    }
  }

  // 頂点順に「(あれば)コーナーセグメント→次頂点への辺セグメント」を並べる。
  const result: SketchSegment[] = [];
  for (let i = 0; i < n; i += 1) {
    if (cornerSegmentAt[i]) result.push(cornerSegmentAt[i]!);
    const from = exitPoints[i];
    const to = entryPoints[(i + 1) % n];
    const bulge = effectiveBulges[i];
    result.push(bulge ? arcSeg(from, to, bulge) : lineSeg(from, to));
  }
  return result;
}

/**
 * エンティティを等価な自由セグメント(line/arc、Phase 19a)の集まりに変換する(「分解」、Phase 19b)。
 * 返るセグメントは新規ID付きで、常に閉ループを構成する(元のエンティティが閉図形のため)。
 */
export function explodeEntity(entity: SketchEntity): SketchSegment[] {
  if (entity.kind === "rectangle") return explodeRectangle(entity);
  if (entity.kind === "circle") return explodeCircle(entity);
  if (entity.kind === "slot") return explodeSlot(entity);
  if (entity.kind === "regularPolygon") return explodeRegularPolygon(entity);
  // 点(Phase 47)は閉図形ではない位置決め専用マーカーのため分解対象外(呼び出し元がボタンを隠す)。
  if (entity.kind === "point") return [];
  return explodePolygon(entity);
}
