// 部品配置(簡易アセンブリ)フィーチャー選択時の編集パネル(Phase 27b)。
// v1: 名前・位置(X/Y/Z)・回転(X/Y/Z、度、X→Y→Z順)のみ編集可能。部品の中身(part、埋め込みdoc)は
// このパネルから編集できない(再配置したい場合は元の.l3dcadを開いて編集・保存し、削除して配置し直す運用。
// ShellEditor/Fillet3DEditor等と同じ「再選択UIは持たない」方針)。
import { patchPartInstanceFeature } from "../model/document";
import type { PartInstanceFeature } from "../model/types";
import { useCadStore } from "../state/store";

const AXES: { label: "X" | "Y" | "Z"; index: 0 | 1 | 2 }[] = [
  { label: "X", index: 0 },
  { label: "Y", index: 1 },
  { label: "Z", index: 2 },
];

export function PartInstanceEditor({ instance }: { instance: PartInstanceFeature }) {
  const updateDocument = useCadStore((s) => s.updateDocument);
  const removeFeature = useCadStore((s) => s.removeFeature);

  function patch(p: Partial<Pick<PartInstanceFeature, "name" | "position" | "rotation">>) {
    updateDocument((d) => patchPartInstanceFeature(d, instance.id, p));
  }

  function patchAxis(field: "position" | "rotation", index: 0 | 1 | 2, value: number) {
    if (!Number.isFinite(value)) return;
    const next = [...instance[field]] as [number, number, number];
    next[index] = value;
    patch({ [field]: next } as Partial<Pick<PartInstanceFeature, "position" | "rotation">>);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>部品配置編集</h3>
      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        名前
        <input
          type="text"
          data-testid="part-instance-name-input"
          value={instance.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </label>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 12, opacity: 0.8 }}>位置 (mm)</span>
        <div style={{ display: "flex", gap: 6 }}>
          {AXES.map(({ label, index }) => (
            <label key={label} style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, flex: 1 }}>
              {label}
              <input
                type="number"
                data-testid={`part-instance-position-${label.toLowerCase()}`}
                value={instance.position[index]}
                step="any"
                onChange={(e) => patchAxis("position", index, Number(e.target.value))}
              />
            </label>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 12, opacity: 0.8 }}>回転 (度、X→Y→Z順)</span>
        <div style={{ display: "flex", gap: 6 }}>
          {AXES.map(({ label, index }) => (
            <label key={label} style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, flex: 1 }}>
              {label}
              <input
                type="number"
                data-testid={`part-instance-rotation-${label.toLowerCase()}`}
                value={instance.rotation[index]}
                step="any"
                onChange={(e) => patchAxis("rotation", index, Number(e.target.value))}
              />
            </label>
          ))}
        </div>
      </div>

      <p style={{ fontSize: 11, opacity: 0.6, margin: 0 }}>
        部品の中身は編集できません。部品を編集するには元の.l3dcadファイルを開いて編集・保存し、
        このフィーチャーを削除してから配置し直してください。
      </p>

      <button type="button" data-testid="btn-delete-part-instance" onClick={() => removeFeature(instance.id)}>
        削除
      </button>
    </div>
  );
}
