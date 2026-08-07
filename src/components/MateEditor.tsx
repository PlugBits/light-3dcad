// 合致(メイト)フィーチャー選択時の編集パネル(Phase 28c)。
// v1: 種別(表示のみ)・名前・distance時のみ値を編集可能(面の再選択UIは持たない。ShellEditor等と
// 同じ「再選択が必要な場合は削除して作り直す」方針)。
import { patchMateFeature } from "../model/document";
import type { MateFeature } from "../model/types";
import { useCadStore } from "../state/store";

const KIND_LABEL: Record<MateFeature["kind"], string> = {
  coincident: "一致(面が向き合って重なる)",
  distance: "距離(面同士を法線方向に離す)",
  concentric: "同軸(円筒の軸を一致させる)",
};

export function MateEditor({ mate }: { mate: MateFeature }) {
  const updateDocument = useCadStore((s) => s.updateDocument);
  const removeFeature = useCadStore((s) => s.removeFeature);

  function patch(p: Partial<Pick<MateFeature, "name" | "value">>) {
    updateDocument((d) => patchMateFeature(d, mate.id, p));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>合致編集</h3>
      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        名前
        <input type="text" data-testid="mate-name-input" value={mate.name} onChange={(e) => patch({ name: e.target.value })} />
      </label>

      <p style={{ fontSize: 12, margin: 0 }} data-testid="mate-kind-label">
        種別: {KIND_LABEL[mate.kind]}
      </p>

      {mate.kind === "distance" && (
        <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
          距離 (mm)
          <input
            type="number"
            data-testid="mate-distance-value-input"
            value={mate.value ?? 0}
            min={0.001}
            step="any"
            onChange={(e) => {
              const num = Number(e.target.value);
              if (!Number.isFinite(num) || num <= 0) return;
              patch({ value: num });
            }}
          />
        </label>
      )}

      <p style={{ fontSize: 11, opacity: 0.6, margin: 0 }}>
        面の選び直しはできません。作り直すには削除してから合致ツールで面を選択し直してください。
      </p>

      <button type="button" data-testid="btn-delete-mate" onClick={() => removeFeature(mate.id)}>
        削除
      </button>
    </div>
  );
}
