// シェル(中抜き)フィーチャー選択時の編集パネル(Phase 25b、Phase 29bで面再選択UIを追加)。
// 肉厚編集に加え、「面を選び直す」ボタンでビューアの面選択ツールを再選択モードで起動し、
// 適用でfacesスナップショットを差し替えられる(Fillet3DEditorと同じ方針)。
import { patchShellFeature } from "../model/document";
import type { ShellFeature } from "../model/types";
import { useCadStore } from "../state/store";

export interface ShellEditorProps {
  shell: ShellFeature;
  /** このフィーチャーが評価エラー中(store.errorFeatureId一致)かどうか。ボタンを目立たせる。 */
  hasError: boolean;
  /** 面再選択モード中かどうか(App.tsx側のshellReselectTargetIdがこのフィーチャーと一致)。 */
  isReselecting: boolean;
  /** 再選択モード中、ビューアで現在選択済みの面数。 */
  reselectCount: number;
  onStartReselect: () => void;
  onApplyReselect: () => void;
  onCancelReselect: () => void;
}

export function ShellEditor({
  shell,
  hasError,
  isReselecting,
  reselectCount,
  onStartReselect,
  onApplyReselect,
  onCancelReselect,
}: ShellEditorProps) {
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

      {hasError && !isReselecting && (
        <p data-testid="shell-error-hint" style={{ fontSize: 12, color: "#ff6b6b", margin: 0 }}>
          参照が解決できません。面を選び直してください。
        </p>
      )}

      {!isReselecting && (
        <>
          <p style={{ fontSize: 11, opacity: 0.6, margin: 0 }}>開口面: {shell.faces.length}面</p>
          <button
            type="button"
            data-testid="btn-reselect-shell-faces"
            onClick={onStartReselect}
            style={
              hasError
                ? { background: "#5c1f1f", color: "#fff", border: "1px solid #ff6b6b", fontWeight: "bold" }
                : undefined
            }
          >
            面を選び直す
          </button>
        </>
      )}

      {isReselecting && (
        <div data-testid="shell-reselect-panel" style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
          <p style={{ margin: 0 }}>ビューア上で面をクリックして選択(複数可)。Escでキャンセルします。</p>
          <p data-testid="shell-reselect-count" style={{ margin: 0, fontWeight: "bold" }}>
            選択中: {reselectCount}面
          </p>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" data-testid="btn-apply-shell-reselect" onClick={onApplyReselect} disabled={reselectCount === 0}>
              適用
            </button>
            <button type="button" data-testid="btn-cancel-shell-reselect" onClick={onCancelReselect}>
              キャンセル
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
