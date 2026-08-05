// 寸法ラベルの表示・クリック編集ポップアップ(Phase 10)。
// 選択中スケッチのentitiesから寸法一覧を作り(src/sketch/dimensions.ts、純粋関数)、
// 各ラベルの画面座標はCadViewer.onFrame()で毎フレーム直接DOMへ反映する(Reactの再レンダリングを
// 介さない。ラベル数はスケッチ1枚あたり高々数十件程度で、projectPoint()はベクトル演算のみのため
// 毎フレーム呼んでも計算コストは無視できる。既存の描画モードのライブ座標オーバーレイと同じ方針)。
import { useEffect, useMemo, useRef, useState } from "react";

import { updateSketchEntity } from "../model/document";
import type { SketchFeature } from "../model/types";
import {
  applyEdgeAngle,
  applyEdgeLength,
  computeSketchDimensions,
  dimensionKey,
  formatDimensionLabel,
  type SketchDimension,
} from "../sketch/dimensions";
import { useCadStore } from "../state/store";
import type { CadViewer, PlaneBasis } from "../viewer/CadViewer";

interface DimensionOverlayProps {
  sketch: SketchFeature;
  basis: PlaneBasis;
  viewerRef: React.RefObject<CadViewer | null>;
  /** false のときは何も描画しない(スケッチ表示OFF、または線描画モード中)。 */
  visible: boolean;
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

export function DimensionOverlay({ sketch, basis, viewerRef, visible }: DimensionOverlayProps) {
  const updateDocument = useCadStore((s) => s.updateDocument);
  const labelRefs = useRef(new Map<string, HTMLButtonElement>());
  const [editing, setEditing] = useState<EditingState | null>(null);

  const dimensions = useMemo(() => computeSketchDimensions(sketch.entities), [sketch.entities]);
  // onFrameコールバックはマウント時に一度だけ登録するため、最新の寸法一覧・平面基底はrefで参照する。
  const dimensionsRef = useRef(dimensions);
  dimensionsRef.current = dimensions;
  const basisRef = useRef(basis);
  basisRef.current = basis;

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const update = () => {
      for (const dimension of dimensionsRef.current) {
        const el = labelRefs.current.get(dimensionKey(dimension));
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

  // 選択中スケッチが切り替わったら開いていた編集ポップアップは閉じる。
  useEffect(() => {
    setEditing(null);
  }, [sketch.id]);

  if (!visible) return null;

  function openEditor(dimension: SketchDimension, el: HTMLButtonElement) {
    setEditing({
      dimension,
      screen: { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight },
    });
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
      {editing && (
        <DimensionEditPopup
          key={dimensionKey(editing.dimension)}
          dimension={editing.dimension}
          screen={editing.screen}
          onCancel={() => setEditing(null)}
          onApply={(fields) => applyDimension(editing.dimension, fields)}
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
