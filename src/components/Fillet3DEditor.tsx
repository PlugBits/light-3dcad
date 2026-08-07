// 3Dフィレット/面取りフィーチャー選択時の編集パネル(Phase 25a、Phase 29bでエッジ再選択UIを追加)。
// サイズ編集に加え、「エッジを選び直す」ボタンでビューアのエッジ選択ツールを再選択モードで起動し、
// 適用でedgesスナップショットを差し替えられる(参照切れエラーからの復旧を、削除して作り直さずに行える)。
import { patchFillet3DFeature } from "../model/document";
import type { Fillet3DFeature } from "../model/types";
import { useCadStore } from "../state/store";

export interface Fillet3DEditorProps {
  fillet: Fillet3DFeature;
  /** このフィーチャーが評価エラー中(store.errorFeatureId一致)かどうか。ボタンを目立たせる。 */
  hasError: boolean;
  /** エッジ再選択モード中かどうか(App.tsx側のedgeReselectTargetIdがこのフィーチャーと一致)。 */
  isReselecting: boolean;
  /** 再選択モード中、ビューアで現在選択済みのエッジ数。 */
  reselectCount: number;
  onStartReselect: () => void;
  onApplyReselect: () => void;
  onCancelReselect: () => void;
}

export function Fillet3DEditor({
  fillet,
  hasError,
  isReselecting,
  reselectCount,
  onStartReselect,
  onApplyReselect,
  onCancelReselect,
}: Fillet3DEditorProps) {
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

      {hasError && !isReselecting && (
        <p data-testid="fillet3d-error-hint" style={{ fontSize: 12, color: "#ff6b6b", margin: 0 }}>
          参照が解決できません。エッジを選び直してください。
        </p>
      )}

      {!isReselecting && (
        <>
          <p style={{ fontSize: 11, opacity: 0.6, margin: 0 }}>対象エッジ: {fillet.edges.length}本</p>
          <button
            type="button"
            data-testid="btn-reselect-fillet-edges"
            onClick={onStartReselect}
            style={
              hasError
                ? { background: "#5c1f1f", color: "#fff", border: "1px solid #ff6b6b", fontWeight: "bold" }
                : undefined
            }
          >
            エッジを選び直す
          </button>
        </>
      )}

      {isReselecting && (
        <div
          data-testid="fillet3d-reselect-panel"
          style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}
        >
          <p style={{ margin: 0 }}>ビューア上でエッジをクリックして選択(複数可)。Escでキャンセルします。</p>
          <p data-testid="fillet3d-reselect-count" style={{ margin: 0, fontWeight: "bold" }}>
            選択中: {reselectCount}本
          </p>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" data-testid="btn-apply-edge-reselect" onClick={onApplyReselect} disabled={reselectCount === 0}>
              適用
            </button>
            <button type="button" data-testid="btn-cancel-edge-reselect" onClick={onCancelReselect}>
              キャンセル
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
