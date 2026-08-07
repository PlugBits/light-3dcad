// 回転体(Revolve)フィーチャー選択時の編集パネル。ExtrudeEditorを踏襲する(Phase 25b)。
import { patchRevolveFeature } from "../model/document";
import type { CadDocument, ExtrudeFeature, RevolveFeature, SketchFeature } from "../model/types";
import { useCadStore } from "../state/store";

export function RevolveEditor({ revolve, doc }: { revolve: RevolveFeature; doc: CadDocument }) {
  const updateDocument = useCadStore((s) => s.updateDocument);

  const sketches = doc.features.filter((f): f is SketchFeature => f.type === "sketch");

  // 対象ボディ選択(Phase 27a複数ボディ対応)。ExtrudeEditorと同じ方針(このフィーチャーより前の
  // newBodyフィーチャーのみを候補にし、削除等で候補から外れた既存targetBodyIdがあれば選択欄を残す)。
  const featureIndex = doc.features.findIndex((f) => f.id === revolve.id);
  const precedingFeatures = featureIndex === -1 ? doc.features : doc.features.slice(0, featureIndex);
  const bodyFeatures = precedingFeatures.filter(
    (f): f is ExtrudeFeature | RevolveFeature =>
      (f.type === "extrude" || f.type === "revolve") && f.operation === "newBody",
  );
  const showTargetBodySelect =
    revolve.operation !== "newBody" && (bodyFeatures.length >= 2 || revolve.targetBodyId !== undefined);

  function patch(
    p: Partial<Pick<RevolveFeature, "name" | "sketchId" | "axis" | "angle" | "operation" | "targetBodyId">>,
  ) {
    updateDocument((d) => patchRevolveFeature(d, revolve.id, p));
  }

  function toOperation(value: string): RevolveFeature["operation"] {
    if (value === "cut") return "cut";
    if (value === "add") return "add";
    return "newBody";
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>回転体編集</h3>
      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        名前
        <input type="text" value={revolve.name} onChange={(e) => patch({ name: e.target.value })} />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        対象スケッチ
        <select
          value={revolve.sketchId}
          data-testid="revolve-sketch-select"
          onChange={(e) => patch({ sketchId: e.target.value })}
        >
          {sketches.length === 0 && <option value="">(スケッチがありません)</option>}
          {sketches.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        軸
        <select
          value={revolve.axis}
          data-testid="revolve-axis-select"
          onChange={(e) => patch({ axis: e.target.value === "y" ? "y" : "x" })}
        >
          <option value="x">スケッチX軸</option>
          <option value="y">スケッチY軸</option>
        </select>
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        角度 (度)
        <input
          type="number"
          value={revolve.angle}
          data-testid="revolve-angle-input"
          min={0.1}
          max={360}
          step="any"
          onChange={(e) => {
            const num = Number(e.target.value);
            if (!Number.isFinite(num) || num <= 0 || num > 360) return;
            patch({ angle: num });
          }}
        />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        操作
        <select
          value={revolve.operation}
          data-testid="revolve-operation-select"
          onChange={(e) => patch({ operation: toOperation(e.target.value) })}
        >
          <option value="newBody">New Body</option>
          <option value="cut">Cut</option>
          <option value="add">Add</option>
        </select>
      </label>

      {showTargetBodySelect && (
        <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
          対象ボディ
          <select
            value={revolve.targetBodyId ?? ""}
            data-testid="revolve-target-body-select"
            onChange={(e) => patch({ targetBodyId: e.target.value === "" ? undefined : e.target.value })}
          >
            <option value="">(最新のボディ)</option>
            {bodyFeatures.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
