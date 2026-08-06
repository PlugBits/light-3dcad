// 寸法ラベルの表示・クリック編集ポップアップ(Phase 10)。
// 選択中スケッチのentitiesから寸法一覧を作り(src/sketch/dimensions.ts、純粋関数)、
// 各ラベルの画面座標はCadViewer.onFrame()で毎フレーム直接DOMへ反映する(Reactの再レンダリングを
// 介さない。ラベル数はスケッチ1枚あたり高々数十件程度で、projectPoint()はベクトル演算のみのため
// 毎フレーム呼んでも計算コストは無視できる。既存の描画モードのライブ座標オーバーレイと同じ方針)。
import { useEffect, useMemo, useRef, useState } from "react";

import { setSketchConstraints, updateSketchEntity } from "../model/document";
import type { PointRef, SketchEntity, SketchFeature, SketchSegment } from "../model/types";
import { arcGeometryFromBulge } from "../sketch/bulge";
import { resolveLineRefPoints } from "../sketch/entityEdges";
import {
  computeConstraintDimensions,
  constraintDimensionKey,
  formatConstraintDimensionLabel,
  upsertDistanceConstraint,
  upsertDistanceEntityEntityConstraint,
  upsertDistanceEntityLineConstraint,
  upsertDistanceEntityOriginConstraint,
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
function measuredDimensionGraphics(dimension: SketchDimension, entities: SketchEntity[]): DimensionGraphics | null {
  const entity = entities.find((e) => e.id === dimension.entityId);
  if (!entity) return null;
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
    return computeLinearDimensionGraphics(p1, p2, { awayFrom: centroid });
  }
  if (dimension.kind === "rect-width" && entity.kind === "rectangle") {
    const [cx, cy] = entity.center;
    const hw = entity.width / 2;
    const hh = entity.height / 2;
    return computeLinearDimensionGraphics([cx - hw, cy + hh], [cx + hw, cy + hh], { awayFrom: [cx, cy] });
  }
  if (dimension.kind === "rect-height" && entity.kind === "rectangle") {
    const [cx, cy] = entity.center;
    const hw = entity.width / 2;
    const hh = entity.height / 2;
    return computeLinearDimensionGraphics([cx + hw, cy - hh], [cx + hw, cy + hh], { awayFrom: [cx, cy] });
  }
  if (dimension.kind === "circle-radius" && entity.kind === "circle") {
    return computeRadiusDimensionGraphics(entity.center, entity.radius, { angleDeg: 90 });
  }
  return null;
}

function pointFromRef(segments: readonly SketchSegment[], ref: PointRef): Point2 | null {
  const seg = segments.find((s) => s.id === ref.segmentId);
  if (!seg) return null;
  return ref.end === "p1" ? seg.p1 : seg.p2;
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
  if (dimension.kind === "seg-length") {
    const seg = segments.find((s) => s.id === dimension.segmentId);
    if (!seg) return null;
    return computeLinearDimensionGraphics(seg.p1, seg.p2);
  }
  if (dimension.kind === "seg-distance") {
    const pa = pointFromRef(segments, dimension.a);
    const pb = pointFromRef(segments, dimension.b);
    if (!pa || !pb) return null;
    return computeLinearDimensionGraphics(pa, pb);
  }
  if (dimension.kind === "entity-distance-origin") {
    const c = circleCenter(dimension.entityId);
    if (!c) return null;
    return computeLinearDimensionGraphics(c, [0, 0]);
  }
  if (dimension.kind === "entity-distance-entity") {
    const a = circleCenter(dimension.aEntityId);
    const b = circleCenter(dimension.bEntityId);
    if (!a || !b) return null;
    if (dimension.axis === "x" || dimension.axis === "y") return computeAxisDimensionGraphics(a, b, dimension.axis);
    return computeLinearDimensionGraphics(a, b);
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
    return computeLinearDimensionGraphics(c, foot);
  }
  const seg = segments.find((s) => s.id === dimension.segmentId);
  if (!seg || seg.kind !== "arc" || !seg.bulge) return null;
  const geo = arcGeometryFromBulge(seg.p1, seg.p2, seg.bulge);
  if (!geo) return null;
  const angleDeg = ((geo.startAngle + geo.sweep / 2) * 180) / Math.PI;
  return computeRadiusDimensionGraphics(geo.center, geo.radius, { angleDeg, labelOffset: DEFAULT_RADIUS_LABEL_OFFSET });
}

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
  cursor: "pointer",
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

const CONSTRAINT_DIMENSION_LABELS: Record<ConstraintDimension["kind"], string> = {
  "seg-length": "長さ (mm)",
  "seg-radius": "半径 (mm)",
  "seg-distance": "距離 (mm)",
  "entity-distance-origin": "中心↔原点の距離 (mm)",
  "entity-distance-entity": "中心間の距離 (mm)",
  "entity-distance-line": "中心↔辺の距離 (mm)",
};

export function DimensionOverlay({ sketch, basis, viewerRef, visible, onConflictRollback }: DimensionOverlayProps) {
  const updateDocument = useCadStore((s) => s.updateDocument);
  const labelRefs = useRef(new Map<string, HTMLButtonElement>());
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [editingConstraint, setEditingConstraint] = useState<ConstraintEditingState | null>(null);

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
      const g = measuredDimensionGraphics(d, sketch.entities);
      if (g) map.set(dimensionKey(d), g);
    }
    return map;
  }, [dimensions, sketch.entities]);
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

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const update = () => {
      const allDims: { key: string; anchor: [number, number] }[] = [
        ...dimensionsRef.current.map((d) => ({
          key: dimensionKey(d),
          anchor: measuredGraphicsRef.current.get(dimensionKey(d))?.labelPos ?? d.anchor,
        })),
        ...constraintDimensionsRef.current.map((d) => ({
          key: constraintDimensionKey(d),
          anchor: constraintGraphicsRef.current.get(constraintDimensionKey(d))?.labelPos ?? d.anchor,
        })),
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
                ? upsertDistanceConstraint(constraints, dimension.a, dimension.b, value)
                : dimension.kind === "entity-distance-origin"
                  ? upsertDistanceEntityOriginConstraint(constraints, dimension.entityId, value)
                  : dimension.kind === "entity-distance-entity"
                    ? upsertDistanceEntityEntityConstraint(constraints, dimension.aEntityId, dimension.bEntityId, value, axis)
                    : upsertDistanceEntityLineConstraint(constraints, dimension.entityId, dimension.line, value);
        return setSketchConstraints(doc, sketch.id, next);
      },
      onConflictRollback,
    );
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
            title="クリックして数値を編集"
            onClick={(e) => openEditor(dimension, e.currentTarget)}
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
            title="拘束による寸法(クリックして数値を編集)"
            onClick={(e) => openConstraintEditor(dimension, e.currentTarget)}
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
          axisOptions={editingConstraint.dimension.kind === "entity-distance-entity"}
          initialAxis={
            editingConstraint.dimension.kind === "entity-distance-entity"
              ? (editingConstraint.dimension.axis ?? "direct")
              : undefined
          }
          onCancel={() => setEditingConstraint(null)}
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
