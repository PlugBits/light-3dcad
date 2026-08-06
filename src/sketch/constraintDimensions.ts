// 拘束ドリブン編集(Phase 20b)の純粋ロジック。ReactにもThree.jsにもReplicad(OCCT)にも依存しない
// (src/sketch/dimensions.ts, autoConstraints.ts と同じ方針)。
//
// 2つの役割を持つ:
// 1. 寸法ツール(CadViewer.startDimensionTool)がヒットしたsegmentId/PointRefから、既存拘束の
//    流用または新規作成を行うupsert系関数(値は呼び出し側がポップアップで確定させたものを渡す)。
// 2. 選択中スケッチのlength/distance/radius拘束から、常時表示する寸法ラベル(アンカー座標込み)を
//    作るcomputeConstraintDimensions()(src/sketch/dimensions.tsのcomputeSketchDimensions()と対になる、
//    entities由来ではなくconstraints/segments由来のラベル一覧)。
import { generateId } from "../model/id";
import type { PointRef, SketchConstraint, SketchSegment } from "../model/types";
import { arcGeometryFromBulge } from "./bulge";

export type Point2 = [number, number];

/** 寸法ラベルを図形本体から離すオフセット距離(mm)。src/sketch/dimensions.tsと同じ値。 */
const LABEL_OFFSET = 3;

function findSegment(segments: readonly SketchSegment[], segmentId: string): SketchSegment | undefined {
  return segments.find((s) => s.id === segmentId);
}

function pointFromRef(segments: readonly SketchSegment[], ref: PointRef): Point2 | null {
  const seg = findSegment(segments, ref.segmentId);
  if (!seg) return null;
  return ref.end === "p1" ? seg.p1 : seg.p2;
}

/** セグメントの端点間ユークリッド距離(mm、寸法ツールの初期値・length拘束の値と同じ定義)。 */
export function segmentLength(segment: SketchSegment): number {
  return Math.hypot(segment.p2[0] - segment.p1[0], segment.p2[1] - segment.p1[1]);
}

/** 円弧セグメントの現在の半径(mm)。直線、またはbulgeが定まらない場合はnull。 */
export function segmentRadius(segment: SketchSegment): number | null {
  if (segment.kind !== "arc" || !segment.bulge) return null;
  const geo = arcGeometryFromBulge(segment.p1, segment.p2, segment.bulge);
  return geo ? geo.radius : null;
}

/** 2つのPointRef間の現在の距離(mm)。参照先セグメントが見つからない場合はnull。 */
export function distanceBetweenRefs(segments: readonly SketchSegment[], a: PointRef, b: PointRef): number | null {
  const pa = pointFromRef(segments, a);
  const pb = pointFromRef(segments, b);
  if (!pa || !pb) return null;
  return Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
}

function samePointRef(a: PointRef, b: PointRef): boolean {
  return a.segmentId === b.segmentId && a.end === b.end;
}

function sameDistancePair(constraint: SketchConstraint, a: PointRef, b: PointRef): constraint is Extract<SketchConstraint, { kind: "distance" }> {
  if (constraint.kind !== "distance") return false;
  return (samePointRef(constraint.a, a) && samePointRef(constraint.b, b)) || (samePointRef(constraint.a, b) && samePointRef(constraint.b, a));
}

/** segmentIdへのlength拘束を追加/更新する(既存があれば値だけ差し替え、無ければ新規作成)。 */
export function upsertLengthConstraint(constraints: readonly SketchConstraint[], segmentId: string, value: number): SketchConstraint[] {
  const idx = constraints.findIndex((c) => c.kind === "length" && c.segmentId === segmentId);
  if (idx >= 0) {
    const next = constraints.slice();
    next[idx] = { ...next[idx], value } as SketchConstraint;
    return next;
  }
  return [...constraints, { id: generateId("constraint"), kind: "length", segmentId, value }];
}

/** segmentId(円弧)へのradius拘束を追加/更新する(既存があれば値だけ差し替え、無ければ新規作成)。 */
export function upsertRadiusConstraint(constraints: readonly SketchConstraint[], segmentId: string, value: number): SketchConstraint[] {
  const idx = constraints.findIndex((c) => c.kind === "radius" && c.segmentId === segmentId);
  if (idx >= 0) {
    const next = constraints.slice();
    next[idx] = { ...next[idx], value } as SketchConstraint;
    return next;
  }
  return [...constraints, { id: generateId("constraint"), kind: "radius", segmentId, value }];
}

/** 2点間のdistance拘束を追加/更新する(a/bの順序は問わず一致を判定。既存があれば値だけ差し替え)。 */
export function upsertDistanceConstraint(
  constraints: readonly SketchConstraint[],
  a: PointRef,
  b: PointRef,
  value: number,
): SketchConstraint[] {
  const idx = constraints.findIndex((c) => sameDistancePair(c, a, b));
  if (idx >= 0) {
    const next = constraints.slice();
    next[idx] = { ...next[idx], value } as SketchConstraint;
    return next;
  }
  return [...constraints, { id: generateId("constraint"), kind: "distance", a, b, value }];
}

/** 指定IDの拘束を削除する(見つからない場合は元の配列と等価な新しい配列を返す)。 */
export function removeConstraint(constraints: readonly SketchConstraint[], constraintId: string): SketchConstraint[] {
  return constraints.filter((c) => c.id !== constraintId);
}

// ---- 常時表示する拘束寸法ラベル(表示用、ReactにもThree.jsにも依存しない) ----

export interface SegLengthDimension {
  kind: "seg-length";
  constraintId: string;
  segmentId: string;
  value: number;
  anchor: Point2;
}
export interface SegRadiusDimension {
  kind: "seg-radius";
  constraintId: string;
  segmentId: string;
  value: number;
  anchor: Point2;
}
export interface SegDistanceDimension {
  kind: "seg-distance";
  constraintId: string;
  a: PointRef;
  b: PointRef;
  value: number;
  anchor: Point2;
}
export type ConstraintDimension = SegLengthDimension | SegRadiusDimension | SegDistanceDimension;

/**
 * スケッチのsegments/constraintsから、常時表示すべき拘束寸法(length/distance/radius)の
 * アンカー座標込み一覧を作る。参照先セグメントが見つからない拘束(不整合データ)は無視する。
 * - length: セグメント中点
 * - distance: 2点の中間点
 * - radius: 円弧の中央(掃引角の中点)からLABEL_OFFSETぶん外側
 */
export function computeConstraintDimensions(
  segments: readonly SketchSegment[],
  constraints: readonly SketchConstraint[],
): ConstraintDimension[] {
  const dims: ConstraintDimension[] = [];
  for (const c of constraints) {
    if (c.kind === "length") {
      const seg = findSegment(segments, c.segmentId);
      if (!seg) continue;
      const anchor: Point2 = [(seg.p1[0] + seg.p2[0]) / 2, (seg.p1[1] + seg.p2[1]) / 2];
      dims.push({ kind: "seg-length", constraintId: c.id, segmentId: c.segmentId, value: c.value, anchor });
    } else if (c.kind === "radius") {
      const seg = findSegment(segments, c.segmentId);
      if (!seg || seg.kind !== "arc" || !seg.bulge) continue;
      const geo = arcGeometryFromBulge(seg.p1, seg.p2, seg.bulge);
      const anchor: Point2 = geo
        ? [
            geo.center[0] + (geo.radius + LABEL_OFFSET) * Math.cos(geo.startAngle + geo.sweep / 2),
            geo.center[1] + (geo.radius + LABEL_OFFSET) * Math.sin(geo.startAngle + geo.sweep / 2),
          ]
        : [(seg.p1[0] + seg.p2[0]) / 2, (seg.p1[1] + seg.p2[1]) / 2];
      dims.push({ kind: "seg-radius", constraintId: c.id, segmentId: c.segmentId, value: c.value, anchor });
    } else if (c.kind === "distance") {
      const pa = pointFromRef(segments, c.a);
      const pb = pointFromRef(segments, c.b);
      if (!pa || !pb) continue;
      const anchor: Point2 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
      dims.push({ kind: "seg-distance", constraintId: c.id, a: c.a, b: c.b, value: c.value, anchor });
    }
  }
  return dims;
}

/** 拘束寸法ラベルの表示テキストを返す(小数第1位まで)。半径はR接頭辞。 */
export function formatConstraintDimensionLabel(dimension: ConstraintDimension): string {
  if (dimension.kind === "seg-radius") return `R${dimension.value.toFixed(1)}`;
  return dimension.value.toFixed(1);
}

/** ConstraintDimensionをdata-testid等に使う一意なキーに変換する(拘束idベース)。 */
export function constraintDimensionKey(dimension: ConstraintDimension): string {
  return `c-${dimension.constraintId}`;
}
