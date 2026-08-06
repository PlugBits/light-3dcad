// 回転体(Revolve)フィーチャー選択時の編集パネル。ExtrudeEditorを踏襲する(Phase 25b)。
import { patchRevolveFeature } from "../model/document";
import type { CadDocument, RevolveFeature, SketchFeature } from "../model/types";
import { useCadStore } from "../state/store";

export function RevolveEditor({ revolve, doc }: { revolve: RevolveFeature; doc: CadDocument }) {
  const updateDocument = useCadStore((s) => s.updateDocument);

  const sketches = doc.features.filter((f): f is SketchFeature => f.type === "sketch");

  function patch(p: Partial<Pick<RevolveFeature, "name" | "sketchId" | "axis" | "angle" | "operation">>) {
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
    </div>
  );
}
