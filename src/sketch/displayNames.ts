// スケッチ要素・拘束の人間可読な表示名(ユーザー報告対応、Phase 38c)。
// 元々src/sketch/constraintLabels.tsにあった「セグメント1」「entity-xxxx」のような分かりにくい
// 表記を、種類(線分/円弧/矩形/円/…)+配列内の位置(1始まり)ベースの表示名に置き換える一元管理
// モジュール。内部データ・モデル・コード上の識別子(segment.id、entityId等)自体は変更しない
// (このファイルは表示専用の変換のみを担う)。
//
// SketchEditor(セグメント一覧・拘束一覧パネル)・gcsAdapter.ts(拘束矛盾時のトーストメッセージ)の
// 両方から使う(solver.ts自体はReact非依存の純粋TSでなければならないため、この切り出しは従来通り
// 維持する)。
import type { ArcRef, EntityRef, PointRef, SketchConstraint, SketchEntity, SketchSegment } from "../model/types";
import { formatMm } from "./format";

/** EntityRef|ArcRef判別(Phase 42b、concentric/tangentの円弧対応)。"entityId"の有無で判定する。 */
function isArcRef(ref: EntityRef | ArcRef): ref is ArcRef {
  return "segmentId" in ref;
}

/** EntityRef|ArcRefの表示名(circleエンティティ名、または円弧セグメント名)。 */
function curveRefDisplayName(segments: readonly SketchSegment[] | undefined, entities: readonly SketchEntity[], ref: EntityRef | ArcRef): string {
  return isArcRef(ref) ? segmentDisplayNameById(segments, ref.segmentId) : entityDisplayNameById(entities, ref.entityId);
}

/** entityのkindごとの日本語ラベル(SketchEditorの図形カードの見出しと同じ語彙)。 */
const ENTITY_KIND_LABELS: Record<SketchEntity["kind"], string> = {
  rectangle: "矩形",
  circle: "円",
  point: "点",
  slot: "スロット",
  polygon: "多角形",
  regularPolygon: "正多角形",
};

/**
 * セグメント(線分・円弧)の表示名。種類(線分/円弧、kindで判定)+配列内の位置(1始まり)。
 * 例: 「線分1」「円弧6」(線分・円弧は同じsegments配列内で共存するが、番号はその要素自身の
 * 配列内位置であり、種類ごとに数え直さない)。
 */
export function segmentDisplayName(segment: Pick<SketchSegment, "kind">, index: number): string {
  const kindLabel = segment.kind === "arc" ? "円弧" : "線分";
  return `${kindLabel}${index + 1}`;
}

/** セグメントidから表示名を作る(indexはsegments配列から検索する)。見つからなければidをそのまま返す。 */
function segmentDisplayNameById(segments: readonly SketchSegment[] | undefined, segmentId: string): string {
  const index = (segments ?? []).findIndex((s) => s.id === segmentId);
  if (index < 0) return segmentId;
  return segmentDisplayName((segments ?? [])[index], index);
}

/** セグメント表示名+端点(p1=始点/p2=終点)の表示名。例: 「線分5の終点」。 */
export function pointDisplayName(segmentLabel: string, end: "p1" | "p2"): string {
  return `${segmentLabel}の${end === "p1" ? "始点" : "終点"}`;
}

function pointRefDisplayName(segments: readonly SketchSegment[] | undefined, ref: PointRef): string {
  return pointDisplayName(segmentDisplayNameById(segments, ref.segmentId), ref.end);
}

/**
 * エンティティ(矩形・円・スロット・多角形・正多角形)の表示名。種類+entities配列内の位置(1始まり)。
 * 例: 「円1」「矩形2」。
 */
export function entityDisplayName(entity: Pick<SketchEntity, "kind">, index: number): string {
  return `${ENTITY_KIND_LABELS[entity.kind]}${index + 1}`;
}

/** entityIdから表示名を作る(indexはentities配列から検索する)。見つからなければidをそのまま返す。 */
function entityDisplayNameById(entities: readonly SketchEntity[], entityId: string): string {
  const index = entities.findIndex((e) => e.id === entityId);
  if (index < 0) return entityId;
  return entityDisplayName(entities[index], index);
}

/** 拘束種別の日本語ラベル。 */
export const CONSTRAINT_KIND_LABELS: Record<SketchConstraint["kind"], string> = {
  coincident: "一致",
  horizontal: "水平",
  vertical: "垂直",
  length: "長さ",
  distance: "距離",
  radius: "半径",
  fix: "固定",
  distanceEntityOrigin: "中心↔原点距離",
  distancePointOrigin: "端点↔原点距離",
  coincidentOrigin: "原点一致",
  distanceEntityEntity: "中心間距離",
  distanceEntityLine: "中心↔辺距離",
  distancePointLine: "端点↔辺距離",
  fixEntity: "円の固定",
  fixArc: "円弧の固定",
  perpendicular: "垂直",
  concentric: "同心",
  tangent: "接線",
  distanceLineLine: "平行距離",
  angleLineLine: "角度",
  distanceLineRefEdge: "平行距離(参照エッジ)",
  angleLineRefEdge: "角度(参照エッジ)",
};

/**
 * 拘束の対象・値を1行で表す説明文を作る(種別ラベルは含まない、対象+値のみ)。
 * 例: 「線分5の終点 = 線分1の始点」「線分3 = 156mm」「円1 ↔ 線分4」。
 */
export function describeConstraint(
  segments: readonly SketchSegment[] | undefined,
  entities: readonly SketchEntity[],
  constraint: SketchConstraint,
): string {
  switch (constraint.kind) {
    case "coincident":
      return `${pointRefDisplayName(segments, constraint.a)} = ${pointRefDisplayName(segments, constraint.b)}`;
    case "horizontal":
    case "vertical":
      return segmentDisplayNameById(segments, constraint.segmentId);
    case "length":
      return `${segmentDisplayNameById(segments, constraint.segmentId)} = ${formatMm(constraint.value)}mm`;
    case "radius":
      return `${segmentDisplayNameById(segments, constraint.segmentId)} = R${formatMm(constraint.value)}mm`;
    case "distance": {
      const axisPrefix = constraint.axis === "x" ? "X:" : constraint.axis === "y" ? "Y:" : "";
      return `${pointRefDisplayName(segments, constraint.a)} ↔ ${pointRefDisplayName(segments, constraint.b)} = ${axisPrefix}${formatMm(constraint.value)}mm`;
    }
    case "fix":
      return pointRefDisplayName(segments, constraint.point);
    case "distanceEntityOrigin": {
      const axisPrefix = constraint.axis === "x" ? "X:" : constraint.axis === "y" ? "Y:" : "";
      return `${entityDisplayNameById(entities, constraint.entity.entityId)} ↔ 原点 = ${axisPrefix}${formatMm(constraint.value)}mm`;
    }
    case "distancePointOrigin": {
      const axisPrefix = constraint.axis === "x" ? "X:" : constraint.axis === "y" ? "Y:" : "";
      return `${pointRefDisplayName(segments, constraint.point)} ↔ 原点 = ${axisPrefix}${formatMm(constraint.value)}mm`;
    }
    case "coincidentOrigin":
      return "segmentId" in constraint.point
        ? `${pointRefDisplayName(segments, constraint.point)} = 原点`
        : `${entityDisplayNameById(entities, constraint.point.entityId)} = 原点`;
    case "distanceEntityEntity": {
      const axisPrefix = constraint.axis === "x" ? "X:" : constraint.axis === "y" ? "Y:" : "";
      return `${entityDisplayNameById(entities, constraint.a.entityId)} ↔ ${entityDisplayNameById(entities, constraint.b.entityId)} = ${axisPrefix}${formatMm(constraint.value)}mm`;
    }
    case "distanceEntityLine":
      return `${entityDisplayNameById(entities, constraint.entity.entityId)} ↔ 辺 = ${formatMm(constraint.value)}mm`;
    case "distancePointLine":
      return `${pointRefDisplayName(segments, constraint.point)} ↔ 辺 = ${formatMm(constraint.value)}mm`;
    case "fixEntity":
      return entityDisplayNameById(entities, constraint.entity.entityId);
    case "fixArc":
      return segmentDisplayNameById(segments, constraint.segmentId);
    case "perpendicular":
      return `${segmentDisplayNameById(segments, constraint.a)} ⊥ ${segmentDisplayNameById(segments, constraint.b)}`;
    case "distanceLineLine":
      return `${segmentDisplayNameById(segments, constraint.a)} // ${segmentDisplayNameById(segments, constraint.b)} = ${formatMm(constraint.value)}mm`;
    case "angleLineLine":
      return `${segmentDisplayNameById(segments, constraint.a)} ∠ ${segmentDisplayNameById(segments, constraint.b)} = ${formatMm(constraint.value)}°`;
    case "distanceLineRefEdge":
      return `${segmentDisplayNameById(segments, constraint.segmentId)} // 参照エッジ = ${formatMm(constraint.value)}mm`;
    case "angleLineRefEdge":
      return `${segmentDisplayNameById(segments, constraint.segmentId)} ∠ 参照エッジ = ${formatMm(constraint.value)}°`;
    case "concentric":
      return `${curveRefDisplayName(segments, entities, constraint.a)} = ${curveRefDisplayName(segments, entities, constraint.b)}`;
    case "tangent": {
      const from = curveRefDisplayName(segments, entities, constraint.entity);
      const to =
        constraint.target.kind === "segment"
          ? segmentDisplayNameById(segments, constraint.target.segmentId)
          : `${entityDisplayNameById(entities, constraint.target.entityId)}(${constraint.target.mode === "internal" ? "内接" : "外接"})`;
      return `${from} ↔ ${to}`;
    }
  }
}

/**
 * 拘束の「種類: 対象」を1つの読みやすい文字列にまとめる(拘束一覧パネル・矛盾エラーメッセージの
 * 両方で共通利用、Phase 32→38cで表記を人間可読化)。
 * 例: 「一致: 線分5の終点 = 線分1の始点」「水平: 線分3」「接線: 円1 ↔ 線分4」。
 */
export function constraintDisplayText(
  segments: readonly SketchSegment[] | undefined,
  entities: readonly SketchEntity[],
  constraint: SketchConstraint,
): string {
  return `${CONSTRAINT_KIND_LABELS[constraint.kind]}: ${describeConstraint(segments, entities, constraint)}`;
}
