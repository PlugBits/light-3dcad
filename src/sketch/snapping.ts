// スナップ・軸ロックエンジン(Phase 9)。
// ReactにもThree.jsにも依存しない純粋関数のみで構成する(テスト容易性最優先)。
// 呼び出し側(CadViewer)はスクリーンpx単位の許容距離をスケッチのローカルmm単位に換算してから
// tolerance として渡すこと(このモジュール自体はmm単位の値しか扱わない)。
import type { SketchEntity, SketchSegment } from "../model/types";
import { bulgeArcPoints } from "./bulge";
import { regularPolygonVertices } from "./shapeFromPoints";

/** スナップ候補の種別。優先順位は SNAP_PRIORITY の定義順(数値が小さいほど優先)。 */
export type SnapKind = "vertex" | "center" | "midpoint" | "origin" | "grid";

/** スナップ判定の1候補点。スケッチのローカル2D座標(mm)+種別。 */
export interface SnapCandidate {
  point: [number, number];
  kind: SnapKind;
}

/** findSnap() の結果。 */
export interface SnapResult {
  point: [number, number];
  kind: SnapKind;
}

/** 軸ロックの判定結果種別。ロックしなかった場合は null。 */
export type AxisLockKind = "horizontal" | "vertical" | null;

/** applyAxisLock() の結果。 */
export interface AxisLockResult {
  point: [number, number];
  axis: AxisLockKind;
}

/** resolveDrawingPoint() の結果。スナップしなかった場合 snapKind は null、ロックしなかった場合 axis は null。 */
export interface ResolvedDrawingPoint {
  point: [number, number];
  snapKind: SnapKind | null;
  axis: AxisLockKind;
}

/** スケッチ原点(0,0)のスナップ候補。常に固定なので定数として提供する。 */
export const ORIGIN_CANDIDATE: SnapCandidate = { point: [0, 0], kind: "origin" };

/** 種別ごとの優先順位(値が小さいほど優先)。vertex > center > midpoint > origin > grid。 */
const SNAP_PRIORITY: Record<SnapKind, number> = {
  vertex: 0,
  center: 1,
  midpoint: 2,
  origin: 3,
  grid: 4,
};

function distance(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * カーソル位置に最も適したスナップ点を求める。
 * candidates には vertex/center/midpoint/origin 種別の候補を渡す(grid は gridSpacing から
 * このカーソル位置に対して内部で1個生成する。gridSpacing<=0 ならグリッド候補は生成しない)。
 * 許容距離(tolerance、ローカルmm)内にある候補のうち、最優先種別、同種別内では最近傍のものを返す。
 * 該当なしなら null。
 */
export function findSnap(
  cursor: [number, number],
  candidates: SnapCandidate[],
  gridSpacing: number,
  tolerance: number,
): SnapResult | null {
  const all: SnapCandidate[] = gridSpacing > 0
    ? [
        ...candidates,
        {
          point: [Math.round(cursor[0] / gridSpacing) * gridSpacing, Math.round(cursor[1] / gridSpacing) * gridSpacing],
          kind: "grid",
        },
      ]
    : candidates;

  let bestCandidate: SnapCandidate | null = null;
  let bestDist = Infinity;
  for (const candidate of all) {
    const dist = distance(cursor, candidate.point);
    if (dist > tolerance) continue;
    if (
      !bestCandidate ||
      SNAP_PRIORITY[candidate.kind] < SNAP_PRIORITY[bestCandidate.kind] ||
      (SNAP_PRIORITY[candidate.kind] === SNAP_PRIORITY[bestCandidate.kind] && dist < bestDist)
    ) {
      bestCandidate = candidate;
      bestDist = dist;
    }
  }

  return bestCandidate ? { point: bestCandidate.point, kind: bestCandidate.kind } : null;
}

/**
 * 直前の頂点(from)からカーソル(cursor)へのベクトルが水平/垂直から±toleranceDeg以内なら、
 * その軸に吸着した位置を返す(固定される側の座標をfromの値に一致させる)。
 * from と cursor が一致する(ベクトル長0)場合は方向を判定できないため axis: null を返す。
 */
export function applyAxisLock(
  from: [number, number],
  cursor: [number, number],
  toleranceDeg: number = 5,
): AxisLockResult {
  const dx = cursor[0] - from[0];
  const dy = cursor[1] - from[1];
  if (dx === 0 && dy === 0) {
    return { point: [cursor[0], cursor[1]], axis: null };
  }

  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI; // (-180, 180]
  const nearestMultipleOf90 = Math.round(angleDeg / 90) * 90;
  const diff = Math.abs(angleDeg - nearestMultipleOf90);
  if (diff > toleranceDeg) {
    return { point: [cursor[0], cursor[1]], axis: null };
  }

  const normalized = ((nearestMultipleOf90 % 360) + 360) % 360; // 0 | 90 | 180 | 270
  if (normalized === 0 || normalized === 180) {
    return { point: [cursor[0], from[1]], axis: "horizontal" };
  }
  return { point: [from[0], cursor[1]], axis: "vertical" };
}

/**
 * 軸ロック+点スナップ+グリッドスナップを統合し、描画中のクリック/マウス移動位置を1点に解決する。
 *
 * - axisLockEnabled が false(Shift押下中相当)、または lastPoint が null(まだ1点も打っていない)
 *   場合は軸ロックをかけず、findSnap() の結果(なければ生のcursor)を返す。
 * - 軸ロックが働かなかった場合(±toleranceDeg以内でない)も同様にfindSnap()にフォールバックする。
 * - 軸ロックが働いた場合は、ロック軸上(固定される側の座標がfromの値からtolerance以内)にある候補
 *   と、自由座標方向のみをグリッド間隔に丸めたグリッド候補、の中からfindSnap()で選ぶ。
 *   固定座標が軸から外れる候補は最初から対象外にする(「軸から外れるスナップ点は無視」)。
 *   該当候補が無ければ軸ロック後の位置(固定座標=fromの値)をそのまま返す。
 */
export function resolveDrawingPoint(input: {
  cursor: [number, number];
  lastPoint: [number, number] | null;
  candidates: SnapCandidate[];
  gridSpacing: number;
  tolerance: number;
  axisLockEnabled: boolean;
  axisToleranceDeg?: number;
}): ResolvedDrawingPoint {
  const { cursor, lastPoint, candidates, gridSpacing, tolerance, axisLockEnabled } = input;

  const freeSnap = (): ResolvedDrawingPoint => {
    const snap = findSnap(cursor, candidates, gridSpacing, tolerance);
    return snap
      ? { point: snap.point, snapKind: snap.kind, axis: null }
      : { point: [cursor[0], cursor[1]], snapKind: null, axis: null };
  };

  if (!axisLockEnabled || !lastPoint) {
    return freeSnap();
  }

  const locked = applyAxisLock(lastPoint, cursor, input.axisToleranceDeg ?? 5);
  if (!locked.axis) {
    return freeSnap();
  }

  const fixedIndex = locked.axis === "horizontal" ? 1 : 0;
  const freeIndex = fixedIndex === 0 ? 1 : 0;
  const fixedValue = lastPoint[fixedIndex];

  const onAxisCandidates = candidates.filter((c) => Math.abs(c.point[fixedIndex] - fixedValue) <= tolerance);
  if (gridSpacing > 0) {
    const roundedFree = Math.round(locked.point[freeIndex] / gridSpacing) * gridSpacing;
    const gridPoint: [number, number] = [0, 0];
    gridPoint[fixedIndex] = fixedValue;
    gridPoint[freeIndex] = roundedFree;
    onAxisCandidates.push({ point: gridPoint, kind: "grid" });
  }

  const snap = findSnap(locked.point, onAxisCandidates, 0, tolerance);
  if (snap) {
    return { point: snap.point, snapKind: snap.kind, axis: locked.axis };
  }
  return { point: locked.point, snapKind: null, axis: locked.axis };
}

/** 頂点列(描画中の自分自身の頂点列など)を vertex 種別の候補列に変換する。 */
export function pointsToVertexCandidates(points: [number, number][]): SnapCandidate[] {
  return points.map((point) => ({ point, kind: "vertex" as const }));
}

function midpoint(a: [number, number], b: [number, number]): [number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/**
 * スケッチの既存entities(rectangle/circle/polygon)からスナップ候補点リストを収集する。
 * - rectangle: 4頂点(vertex)+4辺の中点(midpoint)
 * - circle: 中心(center)のみ(頂点・辺を持たない滑らかな曲線のため)
 * - polygon: 全頂点(vertex)+各辺の中点(midpoint)
 * 原点(origin)は含まない。呼び出し側で ORIGIN_CANDIDATE を別途候補列に加えること。
 */
export function collectSketchSnapCandidates(entities: SketchEntity[]): SnapCandidate[] {
  const candidates: SnapCandidate[] = [];
  for (const entity of entities) {
    if (entity.kind === "rectangle") {
      const [cx, cy] = entity.center;
      const hw = entity.width / 2;
      const hh = entity.height / 2;
      const corners: [number, number][] = [
        [cx - hw, cy - hh],
        [cx + hw, cy - hh],
        [cx + hw, cy + hh],
        [cx - hw, cy + hh],
      ];
      corners.forEach((p) => candidates.push({ point: p, kind: "vertex" }));
      for (let i = 0; i < corners.length; i += 1) {
        candidates.push({ point: midpoint(corners[i], corners[(i + 1) % corners.length]), kind: "midpoint" });
      }
    } else if (entity.kind === "circle") {
      candidates.push({ point: entity.center, kind: "center" });
    } else if (entity.kind === "slot") {
      candidates.push({ point: entity.start, kind: "vertex" });
      candidates.push({ point: entity.end, kind: "vertex" });
      candidates.push({ point: midpoint(entity.start, entity.end), kind: "midpoint" });
    } else if (entity.kind === "regularPolygon") {
      candidates.push({ point: entity.center, kind: "center" });
      const vertices = regularPolygonVertices(entity.center, entity.radius, entity.sides, entity.rotation ?? 0);
      vertices.forEach((p) => candidates.push({ point: p, kind: "vertex" }));
    } else {
      const points: [number, number][] = entity.points;
      points.forEach((p) => candidates.push({ point: p, kind: "vertex" }));
      for (let i = 0; i < points.length; i += 1) {
        candidates.push({ point: midpoint(points[i], points[(i + 1) % points.length]), kind: "midpoint" });
      }
    }
  }
  return candidates;
}

/**
 * スケッチの自由な線分・円弧セグメント(Phase 19a)からスナップ候補点リストを収集する(Phase 19b)。
 * 各セグメントの両端点(vertex)+中点(midpoint、円弧は弦の中点でなくbulgeArcPointsで求めた弧上の
 * 中点)を候補にする。線分作図ツール・トリムツールの対象スケッチの既存segmentsを渡す想定。
 */
export function collectSegmentSnapCandidates(segments: SketchSegment[]): SnapCandidate[] {
  const candidates: SnapCandidate[] = [];
  for (const segment of segments) {
    candidates.push({ point: segment.p1, kind: "vertex" });
    candidates.push({ point: segment.p2, kind: "vertex" });
    if (segment.kind === "arc" && segment.bulge) {
      const pts = bulgeArcPoints(segment.p1, segment.p2, segment.bulge, 16);
      candidates.push({ point: pts[Math.floor(pts.length / 2)], kind: "midpoint" });
    } else {
      candidates.push({ point: midpoint(segment.p1, segment.p2), kind: "midpoint" });
    }
  }
  return candidates;
}
