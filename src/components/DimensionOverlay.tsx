// 寸法ラベルの表示・クリック編集ポップアップ(Phase 10)。
// 選択中スケッチのentitiesから寸法一覧を作り(src/sketch/dimensions.ts、純粋関数)、
// 各ラベルの画面座標はCadViewer.onFrame()で毎フレーム直接DOMへ反映する(Reactの再レンダリングを
// 介さない。ラベル数はスケッチ1枚あたり高々数十件程度で、projectPoint()はベクトル演算のみのため
// 毎フレーム呼んでも計算コストは無視できる。既存の描画モードのライブ座標オーバーレイと同じ方針)。
import { useEffect, useMemo, useRef, useState } from "react";

import { setConstraintLabelOffset, setDimensionOffset, setSketchConstraints, updateSketchEntity } from "../model/document";
import type { CadDocument, SketchEntity, SketchFeature, SketchSegment } from "../model/types";
import { arcGeometryFromBulge } from "../sketch/bulge";
import { resolveLineRefPoints } from "../sketch/entityEdges";
import {
  computeConstraintDimensions,
  constraintDimensionKey,
  describeAxisDistanceConflict,
  formatConstraintDimensionLabel,
  pointFromRef,
  removeConstraint,
  upsertAngleLineLineConstraint,
  upsertDistanceConstraint,
  upsertDistanceEntityEntityConstraint,
  upsertDistanceEntityLineConstraint,
  upsertDistanceEntityOriginConstraint,
  upsertDistanceLineLineConstraint,
  upsertDistancePointLineConstraint,
  upsertDistancePointOriginConstraint,
  upsertLengthConstraint,
  upsertRadiusConstraint,
  type ConstraintDimension,
} from "../sketch/constraintDimensions";
import {
  applyEdgeAngle,
  applyEdgeLength,
  computeSketchDimensions,
  dimensionKey,
  formatDimensionLabel,
  type SketchDimension,
} from "../sketch/dimensions";
import { updateDocumentWithConflictRollback } from "../state/constraintUpdate";
import { useCadStore } from "../state/store";
import type { CadViewer, PlaneBasis } from "../viewer/CadViewer";
import {
  computeAxisDimensionGraphics,
  computeLinearDimensionGraphics,
  computeRadiusDimensionGraphics,
  DEFAULT_RADIUS_LABEL_OFFSET,
  type DimensionGraphics,
  type Point2,
  type Segment,
} from "../viewer/dimensionGraphics";
import { DimensionToolPopup } from "./DimensionToolPopup";

/**
 * 実測寸法(SketchDimension、entities由来)1件分の引出線・寸法線・矢印を計算する
 * (src/viewer/dimensionGraphics.tsのプリミティブに、entityの実座標を渡すアダプタ)。
 * 対応する図形が見つからない/退化している場合はnull(その寸法は線を描かず、ラベルのみ
 * dimension.anchorにフォールバックする)。
 */
function measuredDimensionGraphics(
  dimension: SketchDimension,
  entities: SketchEntity[],
  offsetVec?: Point2,
): DimensionGraphics | null {
  const entity = entities.find((e) => e.id === dimension.entityId);
  if (!entity) return null;
  const ov = offsetVec ? { offsetVec } : {};
  if (dimension.kind === "polygon-edge" && entity.kind === "polygon") {
    const { points } = entity;
    const p1 = points[dimension.edgeIndex];
    const p2 = points[(dimension.edgeIndex + 1) % points.length];
    if (!p1 || !p2) return null;
    let cx = 0;
    let cy = 0;
    for (const [x, y] of points) {
      cx += x;
      cy += y;
    }
    const centroid: Point2 = [cx / points.length, cy / points.length];
    return computeLinearDimensionGraphics(p1, p2, { awayFrom: centroid, ...ov });
  }
  if (dimension.kind === "rect-width" && entity.kind === "rectangle") {
    const [cx, cy] = entity.center;
    const hw = entity.width / 2;
    const hh = entity.height / 2;
    return computeLinearDimensionGraphics([cx - hw, cy + hh], [cx + hw, cy + hh], { awayFrom: [cx, cy], ...ov });
  }
  if (dimension.kind === "rect-height" && entity.kind === "rectangle") {
    const [cx, cy] = entity.center;
    const hw = entity.width / 2;
    const hh = entity.height / 2;
    return computeLinearDimensionGraphics([cx + hw, cy - hh], [cx + hw, cy + hh], { awayFrom: [cx, cy], ...ov });
  }
  if (dimension.kind === "circle-radius" && entity.kind === "circle") {
    return computeRadiusDimensionGraphics(entity.center, entity.radius, { angleDeg: 90, ...ov });
  }
  return null;
}

/**
 * 拘束寸法(ConstraintDimension、segments/constraints由来)1件分の引出線・寸法線・矢印を計算する。
 * 参照先セグメントが見つからない/円弧情報が無い場合はnull。
 */
function constraintDimensionGraphics(
  dimension: ConstraintDimension,
  segments: SketchSegment[],
  entities: readonly SketchEntity[],
): DimensionGraphics | null {
  const circleCenter = (entityId: string): Point2 | null => {
    const e = entities.find((en) => en.id === entityId);
    return e && e.kind === "circle" ? e.center : null;
  };
  // ラベルのドラッグ移動オフセット(Phase 31a)。対応する拘束のlabelOffsetをそのまま各計算関数の
  // offsetVecへ渡す(未指定なら各関数の既定位置になる)。
  const ov = dimension.labelOffset ? { offsetVec: dimension.labelOffset } : {};
  if (dimension.kind === "seg-length") {
    const seg = segments.find((s) => s.id === dimension.segmentId);
    if (!seg) return null;
    return computeLinearDimensionGraphics(seg.p1, seg.p2, ov);
  }
  if (dimension.kind === "seg-distance") {
    const pa = pointFromRef(segments, dimension.a);
    const pb = pointFromRef(segments, dimension.b);
    if (!pa || !pb) return null;
    if (dimension.axis === "x" || dimension.axis === "y") return computeAxisDimensionGraphics(pa, pb, dimension.axis, ov);
    return computeLinearDimensionGraphics(pa, pb, ov);
  }
  if (dimension.kind === "entity-distance-origin") {
    const c = circleCenter(dimension.entityId);
    if (!c) return null;
    return computeLinearDimensionGraphics(c, dimension.origin, ov);
  }
  if (dimension.kind === "point-distance-origin") {
    const p = pointFromRef(segments, dimension.point);
    if (!p) return null;
    if (dimension.axis === "x" || dimension.axis === "y") return computeAxisDimensionGraphics(p, dimension.origin, dimension.axis, ov);
    return computeLinearDimensionGraphics(p, dimension.origin, ov);
  }
  if (dimension.kind === "entity-distance-entity") {
    const a = circleCenter(dimension.aEntityId);
    const b = circleCenter(dimension.bEntityId);
    if (!a || !b) return null;
    if (dimension.axis === "x" || dimension.axis === "y") return computeAxisDimensionGraphics(a, b, dimension.axis, ov);
    return computeLinearDimensionGraphics(a, b, ov);
  }
  if (dimension.kind === "entity-distance-line") {
    const c = circleCenter(dimension.entityId);
    const line = resolveLineRefPoints(dimension.line, entities);
    if (!c || !line) return null;
    // 中心から直線への垂線の足を寸法のもう一端にする(辺からの垂直距離の可視化)。
    const [a, b] = line;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-12) return null;
    const t = ((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / lenSq;
    const foot: Point2 = [a[0] + t * dx, a[1] + t * dy];
    return computeLinearDimensionGraphics(c, foot, ov);
  }
  if (dimension.kind === "point-distance-line") {
    const p = pointFromRef(segments, dimension.point);
    const line = resolveLineRefPoints(dimension.line, entities, segments);
    if (!p || !line) return null;
    // 端点から直線への垂線の足を寸法のもう一端にする(entity-distance-lineと同じ考え方)。
    const [a, b] = line;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-12) return null;
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
    const foot: Point2 = [a[0] + t * dx, a[1] + t * dy];
    return computeLinearDimensionGraphics(p, foot, ov);
  }
  if (dimension.kind === "seg-distance-line-line") {
    const segA = segments.find((s) => s.id === dimension.a);
    const segB = segments.find((s) => s.id === dimension.b);
    if (!segA || !segB) return null;
    // 線分aの中点から線分b(無限直線扱い)への垂線の足までを寸法線にする(両線分間の垂直寸法線)。
    const mid: Point2 = [(segA.p1[0] + segA.p2[0]) / 2, (segA.p1[1] + segA.p2[1]) / 2];
    const dx = segB.p2[0] - segB.p1[0];
    const dy = segB.p2[1] - segB.p1[1];
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-12) return null;
    const t = ((mid[0] - segB.p1[0]) * dx + (mid[1] - segB.p1[1]) * dy) / lenSq;
    const foot: Point2 = [segB.p1[0] + t * dx, segB.p1[1] + t * dy];
    return computeLinearDimensionGraphics(mid, foot, ov);
  }
  // seg-angle-line-line(Phase 24)は弧の描画をv1では省略し、ラベルのみ表示する(既知の制限)。
  // labelOffset(Phase 31a)はDimensionOverlayのonFrameがd.anchorへ直接加算する形で反映する。
  if (dimension.kind === "seg-angle-line-line") return null;
  const seg = segments.find((s) => s.id === dimension.segmentId);
  if (!seg || seg.kind !== "arc" || !seg.bulge) return null;
  const geo = arcGeometryFromBulge(seg.p1, seg.p2, seg.bulge);
  if (!geo) return null;
  const angleDeg = ((geo.startAngle + geo.sweep / 2) * 180) / Math.PI;
  return computeRadiusDimensionGraphics(geo.center, geo.radius, { angleDeg, labelOffset: DEFAULT_RADIUS_LABEL_OFFSET, ...ov });
}

/** base(スケッチローカル座標)にオフセット(スケッチローカルのベクトル)を加算する。未指定ならbaseそのまま。 */
function applyOffsetPoint(base: Point2, offset?: Point2): Point2 {
  return offset ? [base[0] + offset[0], base[1] + offset[1]] : base;
}

/** 寸法ラベルのドラッグ判定の閾値(画面px)。この距離未満の移動はドラッグ扱いせず、クリック(編集ポップアップ)として扱う。 */
const DRAG_THRESHOLD_PX = 4;
/** ドラッグ中、ドキュメント更新(ソルバ+Worker評価リクエスト)を間引く最小間隔(ms)。部品移動ツールの150msスロットルより短いが、寸法ソルバ+再評価は軽量なため許容する。 */
const DRAG_EMIT_INTERVAL_MS = 50;

/**
 * ドラッグ対象の寸法ラベル1件を指す(measured=実測寸法[dimensionKey]、constraint=拘束寸法)。
 * constraint scopeは2つのIDを別々に持つ: key(="c-"+constraintId、constraintGraphicsRef/
 * constraintDimensionsRefのMapキー・検索に使う表示用キー)と、constraintId(setConstraintLabelOffset
 * へそのまま渡す実際の拘束ID)。実機報告バグの修正(Phase 33): 以前はkey(cプレフィックス付き)を
 * そのままsetConstraintLabelOffsetのconstraintId引数に渡してしまい、"c-"+idがどの拘束のidとも
 * 一致しないため書き込みが常に無効(=拘束由来の寸法ラベルは一切ドラッグできなかった)。
 */
type LabelDragTarget = { scope: "measured"; key: string } | { scope: "constraint"; key: string; constraintId: string };

interface DimensionOverlayProps {
  sketch: SketchFeature;
  basis: PlaneBasis;
  viewerRef: React.RefObject<CadViewer | null>;
  /** false のときは何も描画しない(スケッチ表示OFF、または線描画モード中)。 */
  visible: boolean;
  /** 拘束編集で矛盾が検出され自動的に巻き戻したときに呼ばれる(一時メッセージ表示用、Phase 20b)。 */
  onConflictRollback: (message: string) => void;
}

interface EditingState {
  dimension: SketchDimension;
  /** ポップアップの表示位置(オーバーレイコンテナ基準のpx)。 */
  screen: { x: number; y: number };
}

const labelStyle: React.CSSProperties = {
  position: "absolute",
  transform: "translate(-50%, -50%)",
  pointerEvents: "auto",
  background: "rgba(30, 30, 35, 0.85)",
  color: "#ffe0b2",
  border: "1px solid #ff9800",
  borderRadius: 999,
  padding: "1px 6px",
  fontSize: 11,
  fontFamily: "monospace",
  // ドラッグで移動できることの発見性向上(実機報告対応、Phase 33)。クリックでも編集ポップアップが
  // 開くが、ホバー時のカーソルは主要操作(ドラッグ)を示すmoveにする(titleのツールチップと合わせて)。
  cursor: "move",
  lineHeight: 1.5,
  whiteSpace: "nowrap",
};

/** 拘束駆動の寸法ラベルの色(実測ラベルのオレンジと区別する黒/強調系、Phase 20b)。 */
const constraintLabelStyle: React.CSSProperties = {
  ...labelStyle,
  background: "#000",
  color: "#fff",
  border: "2px solid #e0e0e0",
  fontWeight: "bold",
};

interface ConstraintEditingState {
  dimension: ConstraintDimension;
  screen: { x: number; y: number };
}

/**
 * 拘束寸法ラベルの編集ポップアップで軸(距離/X距離/Y距離)選択肢を出すべき種別かどうか
 * (X/Y距離、寸法値の符号仕様の明確化、Phase 33)。
 */
function isAxisDistanceDimensionKind(kind: ConstraintDimension["kind"]): boolean {
  return kind === "entity-distance-entity" || kind === "seg-distance" || kind === "point-distance-origin";
}

/**
 * 拘束寸法ラベルの編集ポップアップでvalue=0を許容すべき種別かどうか(寸法値の符号仕様の明確化、
 * Phase 33)。X/Y距離の3種(axis:"x"/"y"時は符号付きで負も許容、axis:"direct"時は0のみ許容)・
 * 端点↔辺の距離(point-distance-line)・線↔線の距離(seg-distance-line-line)が対象。
 * 長さ・半径・中心↔原点/辺の距離・角度は対象外(従来通り正の数のみ)。
 */
function isZeroAllowedDimensionKind(kind: ConstraintDimension["kind"]): boolean {
  return isAxisDistanceDimensionKind(kind) || kind === "point-distance-line" || kind === "seg-distance-line-line";
}

const CONSTRAINT_DIMENSION_LABELS: Record<ConstraintDimension["kind"], string> = {
  "seg-length": "長さ (mm)",
  "seg-radius": "半径 (mm)",
  "seg-distance": "距離 (mm)",
  "entity-distance-origin": "中心↔原点の距離 (mm)",
  "point-distance-origin": "端点↔原点の距離 (mm)",
  "entity-distance-entity": "中心間の距離 (mm)",
  "entity-distance-line": "中心↔辺の距離 (mm)",
  "point-distance-line": "端点↔辺の距離 (mm)",
  "seg-distance-line-line": "距離 (mm)",
  "seg-angle-line-line": "角度 (°)",
};

export function DimensionOverlay({ sketch, basis, viewerRef, visible, onConflictRollback }: DimensionOverlayProps) {
  const updateDocument = useCadStore((s) => s.updateDocument);
  const labelRefs = useRef(new Map<string, HTMLButtonElement>());
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [editingConstraint, setEditingConstraint] = useState<ConstraintEditingState | null>(null);
  // 直前のmousedown〜mouseupがドラッグ(閾値以上の移動)だった場合、後続のclickイベントで
  // 編集ポップアップを開かないようにする一時フラグ(ドラッグ終了時にtrue、onClickの先頭で読んでリセット)。
  const justDraggedRef = useRef(false);

  const dimensions = useMemo(() => computeSketchDimensions(sketch.entities), [sketch.entities]);
  const constraintDimensions = useMemo(
    () => computeConstraintDimensions(sketch.segments ?? [], sketch.constraints ?? [], sketch.entities),
    [sketch.segments, sketch.constraints, sketch.entities],
  );

  // 各寸法の引出線・寸法線・矢印(Phase 22)。ラベル位置(labelPos)は寸法線中央で、
  // 図形が見つからない/退化している場合はnull(その寸法は線を描かず、ラベルはdimension.anchorに
  // フォールバックする)。
  const measuredGraphics = useMemo(() => {
    const map = new Map<string, DimensionGraphics>();
    for (const d of dimensions) {
      const key = dimensionKey(d);
      const g = measuredDimensionGraphics(d, sketch.entities, sketch.dimensionOffsets?.[key]);
      if (g) map.set(key, g);
    }
    return map;
  }, [dimensions, sketch.entities, sketch.dimensionOffsets]);
  const constraintGraphics = useMemo(() => {
    const map = new Map<string, DimensionGraphics>();
    for (const d of constraintDimensions) {
      const g = constraintDimensionGraphics(d, sketch.segments ?? [], sketch.entities);
      if (g) map.set(constraintDimensionKey(d), g);
    }
    return map;
  }, [constraintDimensions, sketch.segments]);

  // onFrameコールバックはマウント時に一度だけ登録するため、最新の寸法一覧・平面基底はrefで参照する。
  const dimensionsRef = useRef(dimensions);
  dimensionsRef.current = dimensions;
  const constraintDimensionsRef = useRef(constraintDimensions);
  constraintDimensionsRef.current = constraintDimensions;
  const measuredGraphicsRef = useRef(measuredGraphics);
  measuredGraphicsRef.current = measuredGraphics;
  const constraintGraphicsRef = useRef(constraintGraphics);
  constraintGraphicsRef.current = constraintGraphics;
  const basisRef = useRef(basis);
  basisRef.current = basis;
  // ラベルのドラッグ移動オフセット(Phase 31a)。graphicsが無い寸法(seg-angle-line-line等)の
  // アンカー計算に使う(onFrameコールバックはマウント時に一度だけ登録するため、他のrefと同じく
  // 常に最新値を読めるようにrefで持つ)。
  const dimensionOffsetsRef = useRef(sketch.dimensionOffsets);
  dimensionOffsetsRef.current = sketch.dimensionOffsets;

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const update = () => {
      const allDims: { key: string; anchor: [number, number] }[] = [
        ...dimensionsRef.current.map((d) => {
          const key = dimensionKey(d);
          const g = measuredGraphicsRef.current.get(key);
          return { key, anchor: g?.labelPos ?? applyOffsetPoint(d.anchor, dimensionOffsetsRef.current?.[key]) };
        }),
        ...constraintDimensionsRef.current.map((d) => {
          const key = constraintDimensionKey(d);
          const g = constraintGraphicsRef.current.get(key);
          return { key, anchor: g?.labelPos ?? applyOffsetPoint(d.anchor, d.labelOffset) };
        }),
      ];
      for (const dimension of allDims) {
        const el = labelRefs.current.get(dimension.key);
        if (!el) continue;
        const world = viewer.localToWorld(basisRef.current, dimension.anchor[0], dimension.anchor[1]);
        const screen = viewer.projectPoint(world);
        if (!screen) {
          el.style.display = "none";
          continue;
        }
        el.style.display = "";
        el.style.left = `${screen.x}px`;
        el.style.top = `${screen.y}px`;
      }
    };
    return viewer.onFrame(update);
  }, [viewerRef]);

  // 寸法線(引出線・寸法線・矢印)の3D描画を最新の状態に反映する(選択中スケッチのみ、
  // 「スケッチ表示」トグルに従う)。既存のスケッチ線オーバーレイ(setSketchOverlay)と同じく、
  // 変更のたびに全体を作り直す。
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const measuredLines: Segment[] = [];
    measuredGraphics.forEach((g) => measuredLines.push(...g.lines));
    const constraintLines: Segment[] = [];
    constraintGraphics.forEach((g) => constraintLines.push(...g.lines));
    viewer.setDimensionOverlay(measuredLines, constraintLines, basis, visible);
  }, [viewerRef, measuredGraphics, constraintGraphics, basis, visible]);

  // アンマウント時(選択スケッチが切り替わる等)は寸法線を消す。
  useEffect(() => {
    return () => {
      viewerRef.current?.setDimensionOverlay([], [], null, false);
    };
  }, [viewerRef]);

  // 選択中スケッチが切り替わったら開いていた編集ポップアップは閉じる。
  useEffect(() => {
    setEditing(null);
    setEditingConstraint(null);
  }, [sketch.id]);

  if (!visible) return null;

  function openEditor(dimension: SketchDimension, el: HTMLButtonElement) {
    setEditing({
      dimension,
      screen: { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight },
    });
  }

  function openConstraintEditor(dimension: ConstraintDimension, el: HTMLButtonElement) {
    setEditingConstraint({
      dimension,
      screen: { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight },
    });
  }

  /** 拘束寸法ラベルの編集(既存拘束の値の差し替え)。矛盾したら自動的に巻き戻す(Phase 20b)。 */
  function applyConstraintDimension(dimension: ConstraintDimension, value: number, axis?: "direct" | "x" | "y") {
    // 矛盾巻き戻しの誘導メッセージ(頂点ベースの寸法指定、Phase 30新設): 寸法ツール新規作成時
    // (App.tsx側)と同じロジックを、既存ラベルの値編集にも適用する。
    const describeConflict = (before: CadDocument): string | null => {
      const feature = before.features.find((f) => f.id === sketch.id);
      if (feature?.type !== "sketch") return null;
      const beforeSegments = feature.segments ?? [];
      if (dimension.kind === "seg-distance") {
        const pa = pointFromRef(beforeSegments, dimension.a);
        const pb = pointFromRef(beforeSegments, dimension.b);
        if (!pa || !pb) return null;
        return describeAxisDistanceConflict(pa, pb, value, axis);
      }
      if (dimension.kind === "point-distance-origin") {
        const p = pointFromRef(beforeSegments, dimension.point);
        if (!p) return null;
        return describeAxisDistanceConflict(p, dimension.origin, value, axis);
      }
      return null;
    };
    updateDocumentWithConflictRollback(
      sketch.id,
      (doc) => {
        const feature = doc.features.find((f) => f.id === sketch.id);
        if (feature?.type !== "sketch") return doc;
        const constraints = feature.constraints ?? [];
        const next =
          dimension.kind === "seg-length"
            ? upsertLengthConstraint(constraints, dimension.segmentId, value)
            : dimension.kind === "seg-radius"
              ? upsertRadiusConstraint(constraints, dimension.segmentId, value)
              : dimension.kind === "seg-distance"
                ? upsertDistanceConstraint(constraints, dimension.a, dimension.b, value, axis)
                : dimension.kind === "entity-distance-origin"
                  ? upsertDistanceEntityOriginConstraint(constraints, dimension.entityId, value, dimension.origin)
                  : dimension.kind === "point-distance-origin"
                    ? upsertDistancePointOriginConstraint(constraints, dimension.point, value, dimension.origin, axis)
                    : dimension.kind === "entity-distance-entity"
                    ? upsertDistanceEntityEntityConstraint(constraints, dimension.aEntityId, dimension.bEntityId, value, axis)
                    : dimension.kind === "entity-distance-line"
                      ? upsertDistanceEntityLineConstraint(constraints, dimension.entityId, dimension.line, value)
                      : dimension.kind === "point-distance-line"
                        ? upsertDistancePointLineConstraint(constraints, dimension.point, dimension.line, value)
                        : dimension.kind === "seg-distance-line-line"
                          ? upsertDistanceLineLineConstraint(constraints, dimension.a, dimension.b, value)
                          : upsertAngleLineLineConstraint(constraints, dimension.a, dimension.b, value);
        return setSketchConstraints(doc, sketch.id, next);
      },
      onConflictRollback,
      describeConflict,
    );
    setEditingConstraint(null);
  }

  /**
   * 拘束寸法ラベルの編集ポップアップの「削除」ボタン(ユーザー報告対応)。該当拘束を削除して閉じる。
   * 拘束一覧パネル(SketchEditor.tsxのConstraintListPanel)の削除ボタンと同じremoveConstraint経路
   * を使う。削除は拘束を緩めるだけなので矛盾を新たに生むことはなく、巻き戻しは不要。
   */
  function deleteConstraintDimension(dimension: ConstraintDimension) {
    updateDocument((doc) => {
      const feature = doc.features.find((f) => f.id === sketch.id);
      if (feature?.type !== "sketch") return doc;
      const constraints = feature.constraints ?? [];
      return setSketchConstraints(doc, sketch.id, removeConstraint(constraints, dimension.constraintId));
    });
    setEditingConstraint(null);
  }

  function applyDimension(dimension: SketchDimension, fields: { length?: number; angleDeg?: number; value?: number }) {
    updateDocument((doc) => {
      if (dimension.kind === "polygon-edge") {
        const feature = doc.features.find((f) => f.id === sketch.id);
        const entity = feature?.type === "sketch" ? feature.entities.find((e) => e.id === dimension.entityId) : undefined;
        if (!entity || entity.kind !== "polygon") return doc;
        let points = entity.points;
        if (fields.length !== undefined) points = applyEdgeLength(points, dimension.edgeIndex, fields.length);
        if (fields.angleDeg !== undefined) points = applyEdgeAngle(points, dimension.edgeIndex, fields.angleDeg);
        return updateSketchEntity(doc, sketch.id, dimension.entityId, { points });
      }
      if (dimension.kind === "circle-radius") {
        return updateSketchEntity(doc, sketch.id, dimension.entityId, { radius: fields.value });
      }
      if (dimension.kind === "rect-width") {
        return updateSketchEntity(doc, sketch.id, dimension.entityId, { width: fields.value });
      }
      return updateSketchEntity(doc, sketch.id, dimension.entityId, { height: fields.value });
    });
    setEditing(null);
  }

  /**
   * 現在表示中のoffsetVec(スケッチローカル、mm)を返す(ドラッグ開始時の基準値)。
   * graphicsが存在すればそこから読む(既定オフセットも含めて常に埋まっている)。graphicsが無い
   * (seg-angle-line-line等)場合は、既存の永続化済みlabelOffsetがあればそれを、無ければ[0,0]を返す
   * (=このケースの「既定位置」はd.anchorそのもの、オフセット無しに相当)。
   */
  function currentOffsetVecFor(target: LabelDragTarget): Point2 {
    if (target.scope === "measured") {
      return measuredGraphicsRef.current.get(target.key)?.offsetVec ?? dimensionOffsetsRef.current?.[target.key] ?? [0, 0];
    }
    const g = constraintGraphicsRef.current.get(target.key);
    if (g) return g.offsetVec;
    const dim = constraintDimensionsRef.current.find((d) => constraintDimensionKey(d) === target.key);
    return dim?.labelOffset ?? [0, 0];
  }

  /** ドラッグ中/終了時の永続化(履歴を積まないupdateDocumentDuringDrag経由、部品移動ツールと同じパターン)。 */
  function commitOffset(target: LabelDragTarget, offset: Point2) {
    if (target.scope === "measured") {
      useCadStore.getState().updateDocumentDuringDrag((d) => setDimensionOffset(d, sketch.id, target.key, offset));
    } else {
      // constraintId(cプレフィックス無し)を渡す。target.key("c-"+constraintId)を誤って渡すと
      // setConstraintLabelOffset内のc.id === constraintId比較が常に不一致になり無効化される(上記の
      // LabelDragTarget型コメント参照、実機報告バグの根本原因)。
      useCadStore.getState().updateDocumentDuringDrag((d) => setConstraintLabelOffset(d, sketch.id, target.constraintId, offset));
    }
  }

  /**
   * 寸法ラベルのドラッグ移動(実機報告対応、Phase 31a)。mousedown後、画面上でDRAG_THRESHOLD_PX以上
   * 動いたら初めてドラッグとみなす(beginDragHistory()を1回だけ呼び、アンドゥ1回にまとめる。動かなければ
   * 通常のclickイベントが後続し、既存の編集ポップアップが開く[justDraggedRefで判定・抑止])。
   * window全体でmousemove/mouseupを監視する(ボタン外に出てもドラッグを継続するため)。
   */
  function handleLabelMouseDown(e: React.MouseEvent<HTMLButtonElement>, target: LabelDragTarget) {
    if (e.button !== 0) return;
    const viewer = viewerRef.current;
    if (!viewer) return;
    const startLocal = viewer.screenToLocal(basisRef.current, e.clientX, e.clientY);
    if (!startLocal) return;
    const startOffsetVec = currentOffsetVecFor(target);
    const state = {
      dragging: false,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startLocal,
      startOffsetVec,
      lastEmitAt: 0,
    };

    const computeNextOffset = (clientX: number, clientY: number): Point2 | null => {
      const v = viewerRef.current;
      if (!v) return null;
      const currentLocal = v.screenToLocal(basisRef.current, clientX, clientY);
      if (!currentLocal) return null;
      return [state.startOffsetVec[0] + (currentLocal[0] - state.startLocal[0]), state.startOffsetVec[1] + (currentLocal[1] - state.startLocal[1])];
    };

    const handleMove = (ev: MouseEvent) => {
      const dxScreen = ev.clientX - state.startClientX;
      const dyScreen = ev.clientY - state.startClientY;
      if (!state.dragging) {
        if (Math.hypot(dxScreen, dyScreen) < DRAG_THRESHOLD_PX) return;
        state.dragging = true;
        useCadStore.getState().beginDragHistory();
      }
      const now = performance.now();
      if (now - state.lastEmitAt < DRAG_EMIT_INTERVAL_MS) return;
      state.lastEmitAt = now;
      const next = computeNextOffset(ev.clientX, ev.clientY);
      if (next) commitOffset(target, next);
    };

    const handleUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      if (!state.dragging) return;
      // 間引きで最後の移動が未反映の可能性があるため、最終位置を必ずコミットする。
      const next = computeNextOffset(ev.clientX, ev.clientY);
      if (next) commitOffset(target, next);
      justDraggedRef.current = true;
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  }

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <style>{`
        .cad-dim-label { transition: background-color 0.1s ease, border-color 0.1s ease; }
        .cad-dim-label:hover { background-color: rgba(255, 152, 0, 0.35); border-color: #ffd54f; }
      `}</style>
      {dimensions.map((dimension) => {
        const key = dimensionKey(dimension);
        return (
          <button
            key={key}
            type="button"
            className="cad-dim-label"
            ref={(el) => {
              if (el) labelRefs.current.set(key, el);
              else labelRefs.current.delete(key);
            }}
            data-testid={`dim-label-${key}`}
            title="クリックして数値を編集(ドラッグで移動)"
            onMouseDown={(e) => handleLabelMouseDown(e, { scope: "measured", key })}
            onClick={(e) => {
              if (justDraggedRef.current) {
                justDraggedRef.current = false;
                return;
              }
              openEditor(dimension, e.currentTarget);
            }}
            style={labelStyle}
          >
            {formatDimensionLabel(dimension)}
          </button>
        );
      })}
      {constraintDimensions.map((dimension) => {
        const key = constraintDimensionKey(dimension);
        return (
          <button
            key={key}
            type="button"
            className="cad-dim-label"
            ref={(el) => {
              if (el) labelRefs.current.set(key, el);
              else labelRefs.current.delete(key);
            }}
            data-testid={`dim-label-${key}`}
            title="拘束による寸法(クリックして数値を編集、ドラッグで移動)"
            onMouseDown={(e) => handleLabelMouseDown(e, { scope: "constraint", key, constraintId: dimension.constraintId })}
            onClick={(e) => {
              if (justDraggedRef.current) {
                justDraggedRef.current = false;
                return;
              }
              openConstraintEditor(dimension, e.currentTarget);
            }}
            style={constraintLabelStyle}
          >
            {formatConstraintDimensionLabel(dimension)}
          </button>
        );
      })}
      {editing && (
        <DimensionEditPopup
          key={dimensionKey(editing.dimension)}
          dimension={editing.dimension}
          screen={editing.screen}
          onCancel={() => setEditing(null)}
          onApply={(fields) => applyDimension(editing.dimension, fields)}
        />
      )}
      {editingConstraint && (
        <DimensionToolPopup
          key={constraintDimensionKey(editingConstraint.dimension)}
          titleLabel={CONSTRAINT_DIMENSION_LABELS[editingConstraint.dimension.kind]}
          initialValue={editingConstraint.dimension.value}
          screen={editingConstraint.screen}
          axisOptions={isAxisDistanceDimensionKind(editingConstraint.dimension.kind)}
          allowZero={isZeroAllowedDimensionKind(editingConstraint.dimension.kind)}
          initialAxis={
            isAxisDistanceDimensionKind(editingConstraint.dimension.kind)
              ? ((editingConstraint.dimension as { axis?: "direct" | "x" | "y" }).axis ?? "direct")
              : undefined
          }
          onCancel={() => setEditingConstraint(null)}
          onDelete={() => deleteConstraintDimension(editingConstraint.dimension)}
          onApply={(value, axis) => applyConstraintDimension(editingConstraint.dimension, value, axis)}
        />
      )}
    </div>
  );
}

function DimensionEditPopup({
  dimension,
  screen,
  onApply,
  onCancel,
}: {
  dimension: SketchDimension;
  screen: { x: number; y: number };
  onApply: (fields: { length?: number; angleDeg?: number; value?: number }) => void;
  onCancel: () => void;
}) {
  const [length, setLength] = useState(dimension.kind === "polygon-edge" ? dimension.length.toFixed(2) : "");
  const [angle, setAngle] = useState(dimension.kind === "polygon-edge" ? dimension.angleDeg.toFixed(2) : "");
  const [radius, setRadius] = useState(dimension.kind === "circle-radius" ? dimension.radius.toFixed(2) : "");
  const [value, setValue] = useState(
    dimension.kind === "rect-width" || dimension.kind === "rect-height" ? dimension.value.toFixed(2) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    firstInputRef.current?.focus();
    firstInputRef.current?.select();
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (dimension.kind === "polygon-edge") {
        const lengthNum = Number(length);
        const angleNum = Number(angle);
        if (!Number.isFinite(lengthNum) || lengthNum <= 0) throw new Error("長さは正の数で入力してください");
        if (!Number.isFinite(angleNum)) throw new Error("角度は数値で入力してください");
        onApply({ length: lengthNum, angleDeg: angleNum });
        return;
      }
      if (dimension.kind === "circle-radius") {
        const radiusNum = Number(radius);
        if (!Number.isFinite(radiusNum) || radiusNum <= 0) throw new Error("半径は正の数で入力してください");
        onApply({ value: radiusNum });
        return;
      }
      const valueNum = Number(value);
      if (!Number.isFinite(valueNum) || valueNum <= 0) throw new Error("寸法は正の数で入力してください");
      onApply({ value: valueNum });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      // window.keydownリスナー(CadViewer)まで伝播させない(選択解除等の副作用を避ける)。
      e.stopPropagation();
      onCancel();
    }
  }

  const hint =
    dimension.kind === "polygon-edge"
      ? "始点(頂点)を固定し、終点のみを移動します"
      : dimension.kind === "circle-radius"
        ? "中心を固定したまま半径を変更します"
        : "中心を固定したまま伸縮します";

  return (
    <form
      data-testid="dim-edit-popup"
      onSubmit={handleSubmit}
      onKeyDown={handleKeyDown}
      style={{
        position: "absolute",
        left: screen.x,
        top: screen.y,
        transform: "translate(-50%, 6px)",
        pointerEvents: "auto",
        background: "#2a2f3a",
        border: "1px solid #555",
        borderRadius: 6,
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontSize: 12,
        zIndex: 20,
        boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
        minWidth: 160,
      }}
    >
      {dimension.kind === "polygon-edge" && (
        <>
          <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            長さ (mm)
            <input
              ref={firstInputRef}
              data-testid="dim-edit-length"
              type="number"
              step="any"
              value={length}
              onChange={(e) => setLength(e.target.value)}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            角度 (度、水平から)
            <input
              data-testid="dim-edit-angle"
              type="number"
              step="any"
              value={angle}
              onChange={(e) => setAngle(e.target.value)}
            />
          </label>
        </>
      )}
      {dimension.kind === "circle-radius" && (
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          半径 (mm)
          <input
            ref={firstInputRef}
            data-testid="dim-edit-radius"
            type="number"
            step="any"
            value={radius}
            onChange={(e) => setRadius(e.target.value)}
          />
        </label>
      )}
      {(dimension.kind === "rect-width" || dimension.kind === "rect-height") && (
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {dimension.kind === "rect-width" ? "幅 (mm)" : "高さ (mm)"}
          <input
            ref={firstInputRef}
            data-testid="dim-edit-value"
            type="number"
            step="any"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
      )}
      <p style={{ margin: 0, fontSize: 10, opacity: 0.7 }}>{hint}</p>
      {error && (
        <p data-testid="dim-edit-error" role="alert" style={{ margin: 0, fontSize: 10, color: "#ff6b6b" }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button type="button" onClick={onCancel} style={{ fontSize: 11 }}>
          キャンセル
        </button>
        <button type="submit" data-testid="dim-edit-apply" style={{ fontSize: 11 }}>
          適用
        </button>
      </div>
    </form>
  );
}
