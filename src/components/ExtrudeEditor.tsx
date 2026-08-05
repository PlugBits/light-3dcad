// 押し出しフィーチャー選択時の編集パネル。対象スケッチ・距離・方向・操作を編集する。
import { patchExtrudeFeature } from "../model/document";
import type { CadDocument, ExtrudeFeature, SketchFeature } from "../model/types";
import { useCadStore } from "../state/store";

export function ExtrudeEditor({ extrude, doc }: { extrude: ExtrudeFeature; doc: CadDocument }) {
  const updateDocument = useCadStore((s) => s.updateDocument);

  const sketches = doc.features.filter((f): f is SketchFeature => f.type === "sketch");

  function patch(p: Partial<Pick<ExtrudeFeature, "name" | "sketchId" | "distance" | "direction" | "operation">>) {
    updateDocument((d) => patchExtrudeFeature(d, extrude.id, p));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>押し出し編集</h3>
      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        名前
        <input type="text" value={extrude.name} onChange={(e) => patch({ name: e.target.value })} />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        対象スケッチ
        <select
          value={extrude.sketchId}
          data-testid="extrude-sketch-select"
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
        距離 (mm)
        <input
          type="number"
          value={extrude.distance}
          data-testid="extrude-distance-input"
          onChange={(e) => {
            const num = Number(e.target.value);
            if (Number.isNaN(num)) return;
            patch({ distance: num });
          }}
        />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        方向
        <select
          value={extrude.direction}
          data-testid="extrude-direction-select"
          onChange={(e) => patch({ direction: Number(e.target.value) === -1 ? -1 : 1 })}
        >
          <option value={1}>順方向</option>
          <option value={-1}>逆方向</option>
        </select>
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        操作
        <select
          value={extrude.operation}
          data-testid="extrude-operation-select"
          onChange={(e) => patch({ operation: e.target.value === "cut" ? "cut" : "newBody" })}
        >
          <option value="newBody">New Body</option>
          <option value="cut">Cut</option>
        </select>
      </label>
    </div>
  );
}
