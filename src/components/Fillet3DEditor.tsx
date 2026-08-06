// 3Dフィレット/面取りフィーチャー選択時の編集パネル(Phase 25a)。
// v1: サイズのみ編集可能(エッジ再選択UIは持たない。エッジが解決できなくなった場合は
// 評価エラーになるため、フィーチャーを削除して作り直す運用)。
import { patchFillet3DFeature } from "../model/document";
import type { Fillet3DFeature } from "../model/types";
import { useCadStore } from "../state/store";

export function Fillet3DEditor({ fillet }: { fillet: Fillet3DFeature }) {
  const updateDocument = useCadStore((s) => s.updateDocument);

  function patch(p: Partial<Pick<Fillet3DFeature, "name" | "size">>) {
    updateDocument((d) => patchFillet3DFeature(d, fillet.id, p));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>{fillet.kind === "fillet" ? "3Dフィレット編集" : "3D面取り編集"}</h3>
      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        名前
        <input type="text" value={fillet.name} onChange={(e) => patch({ name: e.target.value })} />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        サイズ (mm)
        <input
          type="number"
          value={fillet.size}
          data-testid="fillet3d-size-input"
          min={0.1}
          step="any"
          onChange={(e) => {
            const num = Number(e.target.value);
            if (!Number.isFinite(num) || num <= 0) return;
            patch({ size: num });
          }}
        />
      </label>

      <p style={{ fontSize: 11, opacity: 0.6, margin: 0 }}>
        対象エッジ: {fillet.edges.length}本(エッジの選び直しはできません。削除して作り直してください)
      </p>
    </div>
  );
}
