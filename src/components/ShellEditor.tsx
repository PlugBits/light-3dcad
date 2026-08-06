// シェル(中抜き)フィーチャー選択時の編集パネル(Phase 25b)。
// v1: 肉厚のみ編集可能(対象面の再選択UIは持たない。面が解決できなくなった場合は
// 評価エラーになるため、フィーチャーを削除して作り直す運用。Fillet3DEditorと同じ方針)。
import { patchShellFeature } from "../model/document";
import type { ShellFeature } from "../model/types";
import { useCadStore } from "../state/store";

export function ShellEditor({ shell }: { shell: ShellFeature }) {
  const updateDocument = useCadStore((s) => s.updateDocument);

  function patch(p: Partial<Pick<ShellFeature, "name" | "thickness">>) {
    updateDocument((d) => patchShellFeature(d, shell.id, p));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>シェル編集</h3>
      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        名前
        <input type="text" value={shell.name} onChange={(e) => patch({ name: e.target.value })} />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        肉厚 (mm)
        <input
          type="number"
          value={shell.thickness}
          data-testid="shell-thickness-input"
          min={0.1}
          step="any"
          onChange={(e) => {
            const num = Number(e.target.value);
            if (!Number.isFinite(num) || num <= 0) return;
            patch({ thickness: num });
          }}
        />
      </label>

      <p style={{ fontSize: 11, opacity: 0.6, margin: 0 }}>
        開口面: {shell.faces.length}面(面の選び直しはできません。削除して作り直してください)
      </p>
    </div>
  );
}
