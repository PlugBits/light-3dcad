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
import type { EntityRef, LineRef, PointRef, SketchConstraint, SketchEntity, SketchSegment } from "../model/types";
import { arcGeometryFromBulge } from "./bulge";
import { resolveLineRefPoints, sameLineRef } from "./entityEdges";

/** point(PointRef)とentity(EntityRef)を判別するタイプガード(coincidentOrigin拘束のpointフィールド、追加項目)。 */
function isPointRef(ref: PointRef | EntityRef): ref is PointRef {
  return "segmentId" in ref;
}

export type Point2 = [number, number];

/** 寸法ラベルを図形本体から離すオフセット距離(mm)。src/sketch/dimensions.tsと同じ値。 */
const LABEL_OFFSET = 3;

function findSegment(segments: readonly SketchSegment[], segmentId: string): SketchSegment | undefined {
  return segments.find((s) => s.id === segmentId);
}

/** PointRefの現在座標を返す(参照先セグメントが見つからなければnull)。 */
export function pointFromRef(segments: readonly SketchSegment[], ref: PointRef): Point2 | null {
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

/**
 * 巻き戻しトーストの誘導メッセージ(頂点ベースの寸法指定、Phase 30新設)。distance/distancePointOrigin
 * (axis省略/"direct")の値が、既にX方向またはY方向に離れている量(適用前の2点の座標差)より小さい
 * 典型的な解なしケース(直線距離は|Δx|・|Δy|それぞれ以上でなければ幾何学的に成立しない)を検出し、
 * 具体的な誘導メッセージを返す。検出できなければnull(呼び出し側は既定の汎用メッセージにフォールバック)。
 * 「既に固定されている」かどうかまでは判定しない簡易チェックだが、direct距離が解なしになる典型例は
 * ほぼこのケースであるため実用上十分(仕様: 適用前の座標から|Δy|等と入力値を比較するだけでよい)。
 */
export function describeAxisDistanceConflict(a: Point2, b: Point2, value: number, axis?: "direct" | "x" | "y"): string | null {
  if (axis === "x" || axis === "y") return null; // 軸距離指定自体は各軸1本の残差のみで解なしになりにくい。
  const dx = Math.abs(b[0] - a[0]);
  const dy = Math.abs(b[1] - a[1]);
  const violateX = dx > value;
  const violateY = dy > value;
  if (!violateX && !violateY) return null;
  const useY = violateY && (!violateX || dy >= dx);
  const axisLabel = useY ? "Y" : "X";
  const otherLabel = useY ? "X" : "Y";
  const required = useY ? dy : dx;
  return `${axisLabel}方向の位置が${required.toFixed(1)}mmに拘束されているため直線距離は${required.toFixed(1)}mm以上が必要です。${otherLabel}距離指定も使えます`;
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

/**
 * 2点間のdistance拘束を追加/更新する(a/bの順序は問わず一致を判定。既存があれば値だけ差し替え)。
 * axis(頂点ベースの寸法指定、Phase 30。省略=direct・後方互換)はupsertDistanceEntityEntityConstraintの
 * axisと同じ意味。
 * 新規作成時のみ signed:true を付ける(寸法値の符号仕様の明確化、Phase 33)。既存拘束の値だけを
 * 差し替える場合(idx>=0)はsignedフィールドに触れない(スプレッドでそのまま引き継がれる)ため、
 * 旧データ(signed省略=絶対値時代の拘束)は編集後も絶対値のまま解釈され続ける(後方互換)。
 */
export function upsertDistanceConstraint(
  constraints: readonly SketchConstraint[],
  a: PointRef,
  b: PointRef,
  value: number,
  axis?: "direct" | "x" | "y",
): SketchConstraint[] {
  const idx = constraints.findIndex((c) => sameDistancePair(c, a, b));
  if (idx >= 0) {
    const next = constraints.slice();
    next[idx] = { ...next[idx], value, axis } as SketchConstraint;
    return next;
  }
  return [...constraints, { id: generateId("constraint"), kind: "distance", a, b, value, axis, signed: true }];
}

/** 指定IDの拘束を削除する(見つからない場合は元の配列と等価な新しい配列を返す)。 */
export function removeConstraint(constraints: readonly SketchConstraint[], constraintId: string): SketchConstraint[] {
  return constraints.filter((c) => c.id !== constraintId);
}

// ---- 円の位置寸法(Phase 22、circleエンティティの中心を対象にした拘束のupsert) ----

/**
 * circleエンティティの中心↔原点のdistanceEntityOrigin拘束を追加/更新する。originLocal(仕様変更対応)は
 * 拘束作成時点のスケッチ平面基底から求めたワールド原点の投影位置(呼び出し側=App.tsxがselectedSketchPlane
 * から計算して渡す想定、省略時はローカル原点[0,0]扱い)。既存拘束を更新する場合もoriginLocalを渡せば
 * 最新値に差し替える(渡さなければ既存のスナップショットを保つ)。
 */
export function upsertDistanceEntityOriginConstraint(
  constraints: readonly SketchConstraint[],
  entityId: string,
  value: number,
  originLocal?: [number, number],
): SketchConstraint[] {
  const idx = constraints.findIndex((c) => c.kind === "distanceEntityOrigin" && c.entity.entityId === entityId);
  if (idx >= 0) {
    const next = constraints.slice();
    next[idx] = { ...next[idx], value, ...(originLocal ? { originLocal } : {}) } as SketchConstraint;
    return next;
  }
  return [...constraints, { id: generateId("constraint"), kind: "distanceEntityOrigin", entity: { entityId }, value, originLocal }];
}

/**
 * セグメント端点↔原点のdistancePointOrigin拘束を追加/更新する(追加項目)。
 * upsertDistanceEntityOriginConstraintのPointRef版。originLocalの意味・扱いは同じ。
 * axis(頂点ベースの寸法指定、Phase 30。省略=direct・後方互換)はupsertDistanceConstraintと同じ意味。
 * signed(Phase 33)の付与規則もupsertDistanceConstraintと同じ(新規作成時のみtrue)。
 */
export function upsertDistancePointOriginConstraint(
  constraints: readonly SketchConstraint[],
  point: PointRef,
  value: number,
  originLocal?: [number, number],
  axis?: "direct" | "x" | "y",
): SketchConstraint[] {
  const idx = constraints.findIndex((c) => c.kind === "distancePointOrigin" && samePointRef(c.point, point));
  if (idx >= 0) {
    const next = constraints.slice();
    next[idx] = { ...next[idx], value, axis, ...(originLocal ? { originLocal } : {}) } as SketchConstraint;
    return next;
  }
  return [...constraints, { id: generateId("constraint"), kind: "distancePointOrigin", point, value, originLocal, axis, signed: true }];
}

/**
 * セグメント端点、またはcircleエンティティの中心を原点に一致させるcoincidentOrigin拘束を追加する
 * (追加項目、値を持たない拘束なので他のadd*系と同じく「無ければ追加、既にあれば何もしない」)。
 */
export function addCoincidentOriginConstraint(
  constraints: readonly SketchConstraint[],
  point: PointRef | EntityRef,
  originLocal?: [number, number],
): SketchConstraint[] {
  const exists = constraints.some((c) => {
    if (c.kind !== "coincidentOrigin") return false;
    if (isPointRef(point) !== isPointRef(c.point)) return false;
    return isPointRef(point) && isPointRef(c.point) ? samePointRef(c.point, point) : (c.point as EntityRef).entityId === (point as EntityRef).entityId;
  });
  if (exists) return constraints.slice();
  return [...constraints, { id: generateId("constraint"), kind: "coincidentOrigin", point, originLocal }];
}

function sameEntityPair(constraint: SketchConstraint, a: EntityRef, b: EntityRef): constraint is Extract<SketchConstraint, { kind: "distanceEntityEntity" }> {
  if (constraint.kind !== "distanceEntityEntity") return false;
  return (
    (constraint.a.entityId === a.entityId && constraint.b.entityId === b.entityId) ||
    (constraint.a.entityId === b.entityId && constraint.b.entityId === a.entityId)
  );
}

/**
 * 2つのcircleエンティティの中心間のdistanceEntityEntity拘束を追加/更新する(a/bの順序は問わず一致を判定)。
 * axis(UI改善対応、省略=direct・後方互換)は"x"/"y"のとき片方の軸成分のみを距離として扱う。
 * signed(Phase 33)の付与規則はupsertDistanceConstraintと同じ(新規作成時のみtrue)。fromEntityId(a)が
 * 「1点目」、toEntityId(b、後にクリックした[=移動する]方)が「2点目」になる。
 */
export function upsertDistanceEntityEntityConstraint(
  constraints: readonly SketchConstraint[],
  fromEntityId: string,
  toEntityId: string,
  value: number,
  axis?: "direct" | "x" | "y",
): SketchConstraint[] {
  const a: EntityRef = { entityId: fromEntityId };
  const b: EntityRef = { entityId: toEntityId };
  const idx = constraints.findIndex((c) => sameEntityPair(c, a, b));
  if (idx >= 0) {
    const next = constraints.slice();
    next[idx] = { ...next[idx], value, axis } as SketchConstraint;
    return next;
  }
  return [...constraints, { id: generateId("constraint"), kind: "distanceEntityEntity", a, b, value, axis, signed: true }];
}

/** circleエンティティの中心↔辺(LineRef)のdistanceEntityLine拘束を追加/更新する(entityId+同一のlineが既にあれば値だけ差し替え)。 */
export function upsertDistanceEntityLineConstraint(
  constraints: readonly SketchConstraint[],
  entityId: string,
  line: LineRef,
  value: number,
): SketchConstraint[] {
  const idx = constraints.findIndex(
    (c) => c.kind === "distanceEntityLine" && c.entity.entityId === entityId && sameLineRef(c.line, line),
  );
  if (idx >= 0) {
    const next = constraints.slice();
    next[idx] = { ...next[idx], value } as SketchConstraint;
    return next;
  }
  return [...constraints, { id: generateId("constraint"), kind: "distanceEntityLine", entity: { entityId }, line, value }];
}

/**
 * セグメント端点↔線(LineRef)のdistancePointLine拘束を追加/更新する(頂点ベースの寸法指定、
 * Phase 30新設)。upsertDistanceEntityLineConstraintのPointRef版(pointRef+同一のlineが既にあれば
 * 値だけ差し替え)。
 */
export function upsertDistancePointLineConstraint(
  constraints: readonly SketchConstraint[],
  point: PointRef,
  line: LineRef,
  value: number,
): SketchConstraint[] {
  const idx = constraints.findIndex(
    (c) => c.kind === "distancePointLine" && samePointRef(c.point, point) && sameLineRef(c.line, line),
  );
  if (idx >= 0) {
    const next = constraints.slice();
    next[idx] = { ...next[idx], value } as SketchConstraint;
    return next;
  }
  return [...constraints, { id: generateId("constraint"), kind: "distancePointLine", point, line, value }];
}

/** エンティティが固定(fixEntity拘束を持つ)かどうか。circle/rectangle/polygon/regularPolygon/slotいずれも対象。 */
export function isEntityFixed(constraints: readonly SketchConstraint[], entityId: string): boolean {
  return constraints.some((c) => c.kind === "fixEntity" && c.entity.entityId === entityId);
}

/**
 * エンティティのfixEntity拘束をon/offする(固定トグル、Phase 22。矩形・多角形をソルバで動かせる
 * ようにする改善でcircle以外のkindにも対応)。fixed:trueで無ければ追加、fixed:falseで有れば削除する
 * (既に望む状態なら元の配列と等価な新しい配列を返す)。
 */
export function setEntityFixed(constraints: readonly SketchConstraint[], entityId: string, fixed: boolean): SketchConstraint[] {
  const idx = constraints.findIndex((c) => c.kind === "fixEntity" && c.entity.entityId === entityId);
  if (fixed) {
    if (idx >= 0) return constraints.slice();
    return [...constraints, { id: generateId("constraint"), kind: "fixEntity", entity: { entityId } }];
  }
  if (idx < 0) return constraints.slice();
  return constraints.filter((_, i) => i !== idx);
}

// ---- 幾何拘束(垂直・同心・接線、Phase 23)の追加ヘルパー ----
// 値を持たない(常に満たすかどうかだけの)拘束のため、upsertではなく「無ければ追加、既にあれば
// 何もしない(冪等)」のadd系関数にする(値の差し替えが不要なため、他のupsert*とは呼び分ける)。

function samePerpendicularPair(constraint: SketchConstraint, a: string, b: string): boolean {
  if (constraint.kind !== "perpendicular") return false;
  return (constraint.a === a && constraint.b === b) || (constraint.a === b && constraint.b === a);
}

/** 2直線セグメントのperpendicular拘束を追加する(同じ組み合わせが既にあれば何もしない)。 */
export function addPerpendicularConstraint(
  constraints: readonly SketchConstraint[],
  segmentIdA: string,
  segmentIdB: string,
): SketchConstraint[] {
  if (constraints.some((c) => samePerpendicularPair(c, segmentIdA, segmentIdB))) return constraints.slice();
  return [...constraints, { id: generateId("constraint"), kind: "perpendicular", a: segmentIdA, b: segmentIdB }];
}

function sameConcentricPair(constraint: SketchConstraint, a: string, b: string): boolean {
  if (constraint.kind !== "concentric") return false;
  return (
    (constraint.a.entityId === a && constraint.b.entityId === b) ||
    (constraint.a.entityId === b && constraint.b.entityId === a)
  );
}

/** 2つのcircleエンティティのconcentric拘束を追加する(同じ組み合わせが既にあれば何もしない)。 */
export function addConcentricConstraint(
  constraints: readonly SketchConstraint[],
  entityIdA: string,
  entityIdB: string,
): SketchConstraint[] {
  if (constraints.some((c) => sameConcentricPair(c, entityIdA, entityIdB))) return constraints.slice();
  return [
    ...constraints,
    { id: generateId("constraint"), kind: "concentric", a: { entityId: entityIdA }, b: { entityId: entityIdB } },
  ];
}

/**
 * circleエンティティ↔直線セグメントのtangent拘束を追加する(既に同じ組み合わせがあれば何もしない)。
 * side(実機報告対応、Phase 32: 接線拘束が解けるのに「矛盾」になるバグの修正)は、円の中心が
 * 直線のどちら側にあるかを拘束作成時点の現在の形状(entities/segments)から一度だけ決めて
 * 保存する(以後solveSketch()を何度呼んでもここで決めたsideをそのまま使い、都度initXから
 * 符号を再計算しない。src/sketch/solver.tsのlineSideSign()と全く同じ規約(外積が負なら-1、
 * それ以外は+1)で計算するため、solver.ts側のフォールバック計算[side省略時]と常に整合する)。
 * entities/segmentsが渡されない(または対象が見つからない)場合はside省略で作成し、
 * solveSketch()側の後方互換フォールバックに委ねる。
 */
export function addTangentSegmentConstraint(
  constraints: readonly SketchConstraint[],
  entityId: string,
  segmentId: string,
  entities: readonly SketchEntity[] = [],
  segments: readonly SketchSegment[] = [],
): SketchConstraint[] {
  const exists = constraints.some(
    (c) => c.kind === "tangent" && c.entity.entityId === entityId && c.target.kind === "segment" && c.target.segmentId === segmentId,
  );
  if (exists) return constraints.slice();

  const circle = entities.find((e) => e.id === entityId && e.kind === "circle");
  const segment = findSegment(segments, segmentId);
  let side: 1 | -1 | undefined;
  if (circle && circle.kind === "circle" && segment) {
    const [ax, ay] = segment.p1;
    const [bx, by] = segment.p2;
    const cross = (circle.center[0] - ax) * (by - ay) - (circle.center[1] - ay) * (bx - ax);
    side = cross < 0 ? -1 : 1;
  }

  return [
    ...constraints,
    {
      id: generateId("constraint"),
      kind: "tangent",
      entity: { entityId },
      target: side !== undefined ? { kind: "segment", segmentId, side } : { kind: "segment", segmentId },
    },
  ];
}

/**
 * circleエンティティ↔circleエンティティのtangent拘束を追加する(既に同じ組み合わせがあれば何もしない)。
 * mode(外接/内接)は現在の中心間距離が外接目標(r1+r2)・内接目標(|r1-r2|)のどちらに近いかで自動選択する
 * (拘束作成時点の形状から意図を推定する。以後は固定値として保存され、動かない)。
 */
export function addTangentEntityConstraint(
  constraints: readonly SketchConstraint[],
  entities: readonly SketchEntity[],
  entityIdA: string,
  entityIdB: string,
): SketchConstraint[] {
  const exists = constraints.some(
    (c) => c.kind === "tangent" && c.target.kind === "entity" &&
      ((c.entity.entityId === entityIdA && c.target.entityId === entityIdB) ||
        (c.entity.entityId === entityIdB && c.target.entityId === entityIdA)),
  );
  if (exists) return constraints.slice();

  const a = entities.find((e) => e.id === entityIdA);
  const b = entities.find((e) => e.id === entityIdB);
  let mode: "external" | "internal" = "external";
  if (a?.kind === "circle" && b?.kind === "circle") {
    const d = Math.hypot(b.center[0] - a.center[0], b.center[1] - a.center[1]);
    const external = a.radius + b.radius;
    const internal = Math.abs(a.radius - b.radius);
    mode = Math.abs(d - internal) < Math.abs(d - external) ? "internal" : "external";
  }
  return [
    ...constraints,
    {
      id: generateId("constraint"),
      kind: "tangent",
      entity: { entityId: entityIdA },
      target: { kind: "entity", entityId: entityIdB, mode },
    },
  ];
}

// ---- 線分↔線分の寸法(Phase 24) ----
// 平行(方向のなす角<5度)ならdistanceLineLine、非平行ならangleLineLineをupsertする。
// どちらのkindになるかは呼び出し側(CadViewer/App)が方向ベクトルから判定して選ぶ想定で、
// このモジュールはkindに応じたupsertのみを提供する(既存があれば値だけ差し替え)。

function sameSegmentPair(constraint: SketchConstraint, kind: "distanceLineLine" | "angleLineLine", a: string, b: string): boolean {
  if (constraint.kind !== kind) return false;
  return (constraint.a === a && constraint.b === b) || (constraint.a === b && constraint.b === a);
}

/** 2直線セグメントのdistanceLineLine拘束(平行距離)を追加/更新する。 */
export function upsertDistanceLineLineConstraint(
  constraints: readonly SketchConstraint[],
  segmentIdA: string,
  segmentIdB: string,
  value: number,
): SketchConstraint[] {
  const idx = constraints.findIndex((c) => sameSegmentPair(c, "distanceLineLine", segmentIdA, segmentIdB));
  if (idx >= 0) {
    const next = constraints.slice();
    next[idx] = { ...next[idx], value } as SketchConstraint;
    return next;
  }
  return [...constraints, { id: generateId("constraint"), kind: "distanceLineLine", a: segmentIdA, b: segmentIdB, value }];
}

/** 2直線セグメントのangleLineLine拘束(方向のなす角、度)を追加/更新する。 */
export function upsertAngleLineLineConstraint(
  constraints: readonly SketchConstraint[],
  segmentIdA: string,
  segmentIdB: string,
  value: number,
): SketchConstraint[] {
  const idx = constraints.findIndex((c) => sameSegmentPair(c, "angleLineLine", segmentIdA, segmentIdB));
  if (idx >= 0) {
    const next = constraints.slice();
    next[idx] = { ...next[idx], value } as SketchConstraint;
    return next;
  }
  return [...constraints, { id: generateId("constraint"), kind: "angleLineLine", a: segmentIdA, b: segmentIdB, value }];
}

// ---- 線分↔参照エッジの寸法(Phase 24項目2: 寸法ツールの2点目として参照エッジも選べるように) ----
// distanceLineLine/angleLineLineと同じ役割だが、b側がsegmentIdではなくLineRef(固定線)。

function sameSegmentLinePair(
  constraint: SketchConstraint,
  kind: "distanceLineRefEdge" | "angleLineRefEdge",
  segmentId: string,
  line: LineRef,
): boolean {
  if (constraint.kind !== kind) return false;
  return constraint.segmentId === segmentId && sameLineRef(constraint.line, line);
}

/** 直線セグメント↔参照エッジのdistanceLineRefEdge拘束(平行距離)を追加/更新する。 */
export function upsertDistanceLineRefEdgeConstraint(
  constraints: readonly SketchConstraint[],
  segmentId: string,
  line: LineRef,
  value: number,
): SketchConstraint[] {
  const idx = constraints.findIndex((c) => sameSegmentLinePair(c, "distanceLineRefEdge", segmentId, line));
  if (idx >= 0) {
    const next = constraints.slice();
    next[idx] = { ...next[idx], value } as SketchConstraint;
    return next;
  }
  return [...constraints, { id: generateId("constraint"), kind: "distanceLineRefEdge", segmentId, line, value }];
}

/** 直線セグメント↔参照エッジのangleLineRefEdge拘束(方向のなす角、度)を追加/更新する。 */
export function upsertAngleLineRefEdgeConstraint(
  constraints: readonly SketchConstraint[],
  segmentId: string,
  line: LineRef,
  value: number,
): SketchConstraint[] {
  const idx = constraints.findIndex((c) => sameSegmentLinePair(c, "angleLineRefEdge", segmentId, line));
  if (idx >= 0) {
    const next = constraints.slice();
    next[idx] = { ...next[idx], value } as SketchConstraint;
    return next;
  }
  return [...constraints, { id: generateId("constraint"), kind: "angleLineRefEdge", segmentId, line, value }];
}

/**
 * 2本の直線セグメントの方向ベクトルのなす角(度、0〜180)を返す。平行判定
 * (<5度)・angleLineLine拘束の初期値計算の両方に使う。どちらかが退化(長さ0近傍)の場合はnull。
 */
export function angleBetweenSegments(a: SketchSegment, b: SketchSegment): number | null {
  const dax = a.p2[0] - a.p1[0];
  const day = a.p2[1] - a.p1[1];
  const dbx = b.p2[0] - b.p1[0];
  const dby = b.p2[1] - b.p1[1];
  const la = Math.hypot(dax, day);
  const lb = Math.hypot(dbx, dby);
  if (la < 1e-9 || lb < 1e-9) return null;
  const cross = dax * dby - day * dbx;
  const dot = dax * dbx + day * dby;
  return (Math.atan2(Math.abs(cross), dot) * 180) / Math.PI;
}

/**
 * 直線セグメントの方向ベクトルと、固定線(lineP1→lineP2)の方向ベクトルのなす角(度、0〜180)。
 * angleBetweenSegmentsと同形だが、b側がセグメントでなく固定の2点である点のみが異なる
 * (line-refedgeターゲットの初期値計算、Phase 24)。
 */
export function angleBetweenSegmentAndLine(seg: SketchSegment, lineP1: Point2, lineP2: Point2): number | null {
  const dax = seg.p2[0] - seg.p1[0];
  const day = seg.p2[1] - seg.p1[1];
  const dbx = lineP2[0] - lineP1[0];
  const dby = lineP2[1] - lineP1[1];
  const la = Math.hypot(dax, day);
  const lb = Math.hypot(dbx, dby);
  if (la < 1e-9 || lb < 1e-9) return null;
  const cross = dax * dby - day * dbx;
  const dot = dax * dbx + day * dby;
  return (Math.atan2(Math.abs(cross), dot) * 180) / Math.PI;
}

/**
 * angleBetweenSegments/angleBetweenSegmentAndLineが返す0〜180度の「なす角」を、直線には
 * 向きの区別が無いことを踏まえて0〜90度に折り畳む(逆向きに描いた平行線はなす角≈180度になり、
 * そのままでは「ほぼ平行」の判定[<5度]を素通りしてしまうバグの修正、Phase 24)。
 * 距離/角度どちらの拘束にすべきかの判定・角度の表示値(170度ではなく10度)の両方に使う。
 */
export function foldToAcuteAngle(angleDeg: number): number {
  return angleDeg > 90 ? 180 - angleDeg : angleDeg;
}

/** 折り畳み角(foldToAcuteAngle)が5度未満なら「ほぼ平行」とみなす(距離/角度どちらをデフォルト選択するかの閾値)。 */
export const LINE_LINE_PARALLEL_ANGLE_DEG = 5;

/** 2本の直線セグメント(または線↔参照エッジ)の折り畳み角(0〜90度)から、ほぼ平行かどうかを返す。 */
export function isNearlyParallelAngle(angleDeg: number | null): boolean {
  return angleDeg !== null && foldToAcuteAngle(angleDeg) < LINE_LINE_PARALLEL_ANGLE_DEG;
}

// ---- 常時表示する拘束寸法ラベル(表示用、ReactにもThree.jsにも依存しない) ----

export interface SegLengthDimension {
  kind: "seg-length";
  constraintId: string;
  segmentId: string;
  value: number;
  anchor: Point2;
  /** ラベルのドラッグ移動オフセット(Phase 31a)。対応する拘束のlabelOffsetをそのまま持つ。 */
  labelOffset?: Point2;
}
export interface SegRadiusDimension {
  kind: "seg-radius";
  constraintId: string;
  segmentId: string;
  value: number;
  anchor: Point2;
  labelOffset?: Point2;
}
export interface SegDistanceDimension {
  kind: "seg-distance";
  constraintId: string;
  a: PointRef;
  b: PointRef;
  /** 省略/"direct"は2点間の直線距離、"x"/"y"は片方の軸成分のみ(頂点ベースの寸法指定、Phase 30)。 */
  axis?: "direct" | "x" | "y";
  value: number;
  anchor: Point2;
  labelOffset?: Point2;
}
export interface EntityOriginDimension {
  kind: "entity-distance-origin";
  constraintId: string;
  entityId: string;
  value: number;
  anchor: Point2;
  /** 「原点」の実座標(ワールド原点のスケッチローカル投影、仕様変更対応)。寸法線の描画に使う。 */
  origin: Point2;
  labelOffset?: Point2;
}
/** セグメント端点↔原点の距離ラベル(追加項目)。EntityOriginDimensionのPointRef版。 */
export interface PointOriginDimension {
  kind: "point-distance-origin";
  constraintId: string;
  point: PointRef;
  /** 省略/"direct"は原点までの直線距離、"x"/"y"は片方の軸成分のみ(頂点ベースの寸法指定、Phase 30)。 */
  axis?: "direct" | "x" | "y";
  value: number;
  anchor: Point2;
  /** 「原点」の実座標(ワールド原点のスケッチローカル投影、仕様変更対応)。寸法線の描画に使う。 */
  origin: Point2;
  labelOffset?: Point2;
}
export interface EntityEntityDimension {
  kind: "entity-distance-entity";
  constraintId: string;
  aEntityId: string;
  bEntityId: string;
  /** 省略/"direct"は中心間の直線距離、"x"/"y"は片方の軸成分のみ(UI改善対応)。 */
  axis?: "direct" | "x" | "y";
  value: number;
  anchor: Point2;
  labelOffset?: Point2;
}
export interface EntityLineDimension {
  kind: "entity-distance-line";
  constraintId: string;
  entityId: string;
  line: LineRef;
  value: number;
  anchor: Point2;
  labelOffset?: Point2;
}
/** 端点↔線の垂直距離(mm、頂点ベースの寸法指定、Phase 30新設)。EntityLineDimensionのPointRef版。 */
export interface PointLineDimension {
  kind: "point-distance-line";
  constraintId: string;
  point: PointRef;
  line: LineRef;
  value: number;
  anchor: Point2;
  labelOffset?: Point2;
}
/** 2直線の平行距離(mm、Phase 24)。寸法線は両線分間の垂直寸法線(src/components/DimensionOverlay.tsx参照)。 */
export interface SegDistanceLineLineDimension {
  kind: "seg-distance-line-line";
  constraintId: string;
  a: string;
  b: string;
  value: number;
  anchor: Point2;
  labelOffset?: Point2;
}
/** 2直線の方向のなす角(度、Phase 24)。v1は弧を描かずラベルのみ表示する(既知の制限)。 */
export interface SegAngleLineLineDimension {
  kind: "seg-angle-line-line";
  constraintId: string;
  a: string;
  b: string;
  value: number;
  anchor: Point2;
  labelOffset?: Point2;
}
export type ConstraintDimension =
  | SegLengthDimension
  | SegRadiusDimension
  | SegDistanceDimension
  | EntityOriginDimension
  | PointOriginDimension
  | EntityEntityDimension
  | EntityLineDimension
  | PointLineDimension
  | SegDistanceLineLineDimension
  | SegAngleLineLineDimension;

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
  entities: readonly SketchEntity[] = [],
): ConstraintDimension[] {
  const dims: ConstraintDimension[] = [];
  const entityCenter = (entityId: string): Point2 | null => {
    const e = entities.find((x) => x.id === entityId);
    return e && e.kind === "circle" ? e.center : null;
  };
  for (const c of constraints) {
    if (c.kind === "distanceEntityOrigin") {
      const center = entityCenter(c.entity.entityId);
      if (!center) continue;
      const origin: Point2 = c.originLocal ?? [0, 0];
      const anchor: Point2 = [(center[0] + origin[0]) / 2, (center[1] + origin[1]) / 2];
      dims.push({ kind: "entity-distance-origin", constraintId: c.id, entityId: c.entity.entityId, value: c.value, anchor, origin, labelOffset: c.labelOffset });
      continue;
    }
    if (c.kind === "distancePointOrigin") {
      const p = pointFromRef(segments, c.point);
      if (!p) continue;
      const origin: Point2 = c.originLocal ?? [0, 0];
      const anchor: Point2 = [(p[0] + origin[0]) / 2, (p[1] + origin[1]) / 2];
      dims.push({ kind: "point-distance-origin", constraintId: c.id, point: c.point, axis: c.axis, value: c.value, anchor, origin, labelOffset: c.labelOffset });
      continue;
    }
    if (c.kind === "distancePointLine") {
      const p = pointFromRef(segments, c.point);
      const line = resolveLineRefPoints(c.line, entities, segments);
      if (!p || !line) continue;
      const [a, b] = line;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const lenSq = dx * dx + dy * dy;
      const foot: Point2 =
        lenSq < 1e-18 ? a : [a[0] + (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq) * dx, a[1] + (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq) * dy];
      const anchor: Point2 = [(p[0] + foot[0]) / 2, (p[1] + foot[1]) / 2];
      dims.push({ kind: "point-distance-line", constraintId: c.id, point: c.point, line: c.line, value: c.value, anchor, labelOffset: c.labelOffset });
      continue;
    }
    if (c.kind === "distanceEntityEntity") {
      const a = entityCenter(c.a.entityId);
      const b = entityCenter(c.b.entityId);
      if (!a || !b) continue;
      const anchor: Point2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      dims.push({
        kind: "entity-distance-entity",
        constraintId: c.id,
        aEntityId: c.a.entityId,
        bEntityId: c.b.entityId,
        axis: c.axis,
        value: c.value,
        anchor,
        labelOffset: c.labelOffset,
      });
      continue;
    }
    if (c.kind === "distanceEntityLine") {
      const center = entityCenter(c.entity.entityId);
      const line = resolveLineRefPoints(c.line, entities);
      if (!center || !line) continue;
      const [a, b] = line;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const lenSq = dx * dx + dy * dy;
      const foot: Point2 =
        lenSq < 1e-18 ? a : [a[0] + (((center[0] - a[0]) * dx + (center[1] - a[1]) * dy) / lenSq) * dx, a[1] + (((center[0] - a[0]) * dx + (center[1] - a[1]) * dy) / lenSq) * dy];
      const anchor: Point2 = [(center[0] + foot[0]) / 2, (center[1] + foot[1]) / 2];
      dims.push({ kind: "entity-distance-line", constraintId: c.id, entityId: c.entity.entityId, line: c.line, value: c.value, anchor, labelOffset: c.labelOffset });
      continue;
    }
    if (c.kind === "distanceLineLine" || c.kind === "angleLineLine") {
      const segA = findSegment(segments, c.a);
      const segB = findSegment(segments, c.b);
      if (!segA || !segB) continue;
      const midA: Point2 = [(segA.p1[0] + segA.p2[0]) / 2, (segA.p1[1] + segA.p2[1]) / 2];
      const midB: Point2 = [(segB.p1[0] + segB.p2[0]) / 2, (segB.p1[1] + segB.p2[1]) / 2];
      const anchor: Point2 = [(midA[0] + midB[0]) / 2, (midA[1] + midB[1]) / 2];
      if (c.kind === "distanceLineLine") {
        dims.push({ kind: "seg-distance-line-line", constraintId: c.id, a: c.a, b: c.b, value: c.value, anchor, labelOffset: c.labelOffset });
      } else {
        dims.push({ kind: "seg-angle-line-line", constraintId: c.id, a: c.a, b: c.b, value: c.value, anchor, labelOffset: c.labelOffset });
      }
      continue;
    }
    if (c.kind === "length") {
      const seg = findSegment(segments, c.segmentId);
      if (!seg) continue;
      const anchor: Point2 = [(seg.p1[0] + seg.p2[0]) / 2, (seg.p1[1] + seg.p2[1]) / 2];
      dims.push({ kind: "seg-length", constraintId: c.id, segmentId: c.segmentId, value: c.value, anchor, labelOffset: c.labelOffset });
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
      dims.push({ kind: "seg-radius", constraintId: c.id, segmentId: c.segmentId, value: c.value, anchor, labelOffset: c.labelOffset });
    } else if (c.kind === "distance") {
      const pa = pointFromRef(segments, c.a);
      const pb = pointFromRef(segments, c.b);
      if (!pa || !pb) continue;
      const anchor: Point2 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
      dims.push({ kind: "seg-distance", constraintId: c.id, a: c.a, b: c.b, axis: c.axis, value: c.value, anchor, labelOffset: c.labelOffset });
    }
  }
  return dims;
}

/**
 * 拘束寸法ラベルの表示テキストを返す(小数第1位まで)。半径はR接頭辞、円↔円のX/Y距離
 * (UI改善対応)はX/Y接頭辞(例: "X30.0" "Y15.0")で通常の直線距離と区別する。
 */
export function formatConstraintDimensionLabel(dimension: ConstraintDimension): string {
  if (dimension.kind === "seg-radius") return `R${dimension.value.toFixed(1)}`;
  if (dimension.kind === "seg-angle-line-line") return `${dimension.value.toFixed(1)}°`;
  if (dimension.kind === "entity-distance-entity" || dimension.kind === "seg-distance" || dimension.kind === "point-distance-origin") {
    if (dimension.axis === "x") return `X${dimension.value.toFixed(1)}`;
    if (dimension.axis === "y") return `Y${dimension.value.toFixed(1)}`;
  }
  return dimension.value.toFixed(1);
}

/** ConstraintDimensionをdata-testid等に使う一意なキーに変換する(拘束idベース)。 */
export function constraintDimensionKey(dimension: ConstraintDimension): string {
  return `c-${dimension.constraintId}`;
}
