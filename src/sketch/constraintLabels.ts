// 拘束の人間可読ラベル(拘束一覧パネルと矛盾エラーメッセージで共通表示、Phase 32)。
// 元々src/components/SketchEditor.tsxの拘束一覧パネル専用ロジックだったものを、
// solver.tsの矛盾検出メッセージ(ReactやThree.jsに依存しない純粋TSでなければならない)からも
// 使えるよう、このファイルに切り出した(constraintDimensions.tsと同じ「副作用のない純粋TS」方針)。
// SketchEditor.tsxはこのファイルの関数を再importして使う(表示は完全に従来通り、実装重複の解消)。
import type { PointRef, SketchConstraint, SketchEntity, SketchSegment } from "../model/types";
import { formatMm } from "./format";

/** セグメントidから「セグメント1」のような表示用の短いラベルを作る(順序はsketch.segments配列準拠)。 */
export function segmentLabel(segments: readonly SketchSegment[] | undefined, segmentId: string): string {
  const index = (segments ?? []).findIndex((s) => s.id === segmentId);
  return index >= 0 ? `セグメント${index + 1}` : segmentId;
}

export function pointRefLabel(segments: readonly SketchSegment[] | undefined, ref: PointRef): string {
  return `${segmentLabel(segments, ref.segmentId)}.${ref.end}`;
}

/** entityIdから「円1」のような表示用の短いラベルを作る(順序はentities配列準拠)。 */
export function entityLabel(entities: readonly SketchEntity[], entityId: string): string {
  const index = entities.findIndex((e) => e.id === entityId);
  return index >= 0 ? `円${index + 1}` : entityId;
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
  perpendicular: "垂直",
  concentric: "同心",
  tangent: "接線",
  distanceLineLine: "平行距離",
  angleLineLine: "角度",
  distanceLineRefEdge: "平行距離(参照エッジ)",
  angleLineRefEdge: "角度(参照エッジ)",
};

/** 拘束の対象・値を1行で表す説明文を作る。 */
export function describeConstraint(
  segments: readonly SketchSegment[] | undefined,
  entities: readonly SketchEntity[],
  constraint: SketchConstraint,
): string {
  switch (constraint.kind) {
    case "coincident":
      return `${pointRefLabel(segments, constraint.a)} = ${pointRefLabel(segments, constraint.b)}`;
    case "horizontal":
    case "vertical":
      return segmentLabel(segments, constraint.segmentId);
    case "length":
      return `${segmentLabel(segments, constraint.segmentId)} = ${formatMm(constraint.value)}mm`;
    case "radius":
      return `${segmentLabel(segments, constraint.segmentId)} = R${formatMm(constraint.value)}mm`;
    case "distance": {
      const axisPrefix = constraint.axis === "x" ? "X:" : constraint.axis === "y" ? "Y:" : "";
      return `${pointRefLabel(segments, constraint.a)} - ${pointRefLabel(segments, constraint.b)} = ${axisPrefix}${formatMm(constraint.value)}mm`;
    }
    case "fix":
      return pointRefLabel(segments, constraint.point);
    case "distanceEntityOrigin":
      return `${entityLabel(entities, constraint.entity.entityId)} - 原点 = ${formatMm(constraint.value)}mm`;
    case "distancePointOrigin": {
      const axisPrefix = constraint.axis === "x" ? "X:" : constraint.axis === "y" ? "Y:" : "";
      return `${pointRefLabel(segments, constraint.point)} - 原点 = ${axisPrefix}${formatMm(constraint.value)}mm`;
    }
    case "coincidentOrigin":
      return "segmentId" in constraint.point
        ? `${pointRefLabel(segments, constraint.point)} = 原点`
        : `${entityLabel(entities, constraint.point.entityId)} = 原点`;
    case "distanceEntityEntity": {
      const axisPrefix = constraint.axis === "x" ? "X:" : constraint.axis === "y" ? "Y:" : "";
      return `${entityLabel(entities, constraint.a.entityId)} - ${entityLabel(entities, constraint.b.entityId)} = ${axisPrefix}${formatMm(constraint.value)}mm`;
    }
    case "distanceEntityLine":
      return `${entityLabel(entities, constraint.entity.entityId)} - 辺 = ${formatMm(constraint.value)}mm`;
    case "distancePointLine":
      return `${pointRefLabel(segments, constraint.point)} - 辺 = ${formatMm(constraint.value)}mm`;
    case "fixEntity":
      return entityLabel(entities, constraint.entity.entityId);
    case "perpendicular":
      return `${segmentLabel(segments, constraint.a)} ⊥ ${segmentLabel(segments, constraint.b)}`;
    case "distanceLineLine":
      return `${segmentLabel(segments, constraint.a)} // ${segmentLabel(segments, constraint.b)} = ${formatMm(constraint.value)}mm`;
    case "angleLineLine":
      return `${segmentLabel(segments, constraint.a)} ∠ ${segmentLabel(segments, constraint.b)} = ${formatMm(constraint.value)}°`;
    case "distanceLineRefEdge":
      return `${segmentLabel(segments, constraint.segmentId)} // 参照エッジ = ${formatMm(constraint.value)}mm`;
    case "angleLineRefEdge":
      return `${segmentLabel(segments, constraint.segmentId)} ∠ 参照エッジ = ${formatMm(constraint.value)}°`;
    case "concentric":
      return `${entityLabel(entities, constraint.a.entityId)} = ${entityLabel(entities, constraint.b.entityId)}`;
    case "tangent": {
      const from = entityLabel(entities, constraint.entity.entityId);
      const to =
        constraint.target.kind === "segment"
          ? segmentLabel(segments, constraint.target.segmentId)
          : `${entityLabel(entities, constraint.target.entityId)}(${constraint.target.mode === "internal" ? "内接" : "外接"})`;
      return `${from} - ${to}`;
    }
  }
}

/**
 * 拘束の「種類+対象」を1つの読みやすい文字列にまとめる(矛盾エラーメッセージ用、Phase 32)。
 * 拘束一覧パネルの表記(CONSTRAINT_KIND_LABELS + describeConstraint)と完全に同じ組み立て方。
 * 例: 「接線 円2 - セグメント5」「垂直 セグメント5」
 */
export function constraintFullLabel(
  segments: readonly SketchSegment[] | undefined,
  entities: readonly SketchEntity[],
  constraint: SketchConstraint,
): string {
  return `${CONSTRAINT_KIND_LABELS[constraint.kind]} ${describeConstraint(segments, entities, constraint)}`;
}
