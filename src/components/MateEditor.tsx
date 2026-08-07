// 合致(メイト)フィーチャー選択時の編集パネル(Phase 28c、Phase 29bで面再選択UIを追加)。
// 名前・distance時のみ値の編集に加え、「面を選び直す」ボタンで合致ツールを再選択モードで
// 起動できる(2面をピックすると即座にa/bを差し替える。kindは変更しない)。
// 合致より後ろのcut/addには注意アイコンを表示する(Phase 29a、mateHasSubsequentBodyEdit)。
import { mateHasSubsequentBodyEdit, patchMateFeature } from "../model/document";
import type { CadDocument, MateFeature } from "../model/types";
import { useCadStore } from "../state/store";

const KIND_LABEL: Record<MateFeature["kind"], string> = {
  coincident: "一致(面が向き合って重なる)",
  distance: "距離(面同士を法線方向に離す)",
  concentric: "同軸(円筒の軸を一致させる)",
};

export interface MateEditorProps {
  mate: MateFeature;
  doc: CadDocument;
  /** このフィーチャーが評価エラー中(store.errorFeatureId一致)かどうか。ボタンを目立たせる。 */
  hasError: boolean;
  /** 面再選択モード中かどうか(App.tsx側のmateReselectTargetIdがこのフィーチャーと一致)。 */
  isReselecting: boolean;
  /** 再選択モード中、1つ目の面を選択済みで2つ目待ちの状態表示(未保留はnull)。 */
  reselectPendingLabel: string | null;
  onStartReselect: () => void;
  onCancelReselect: () => void;
}

export function MateEditor({
  mate,
  doc,
  hasError,
  isReselecting,
  reselectPendingLabel,
  onStartReselect,
  onCancelReselect,
}: MateEditorProps) {
  const updateDocument = useCadStore((s) => s.updateDocument);
  const removeFeature = useCadStore((s) => s.removeFeature);
  const hasSubsequentBodyEdit = mateHasSubsequentBodyEdit(doc, mate.id);

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

      {hasError && !isReselecting && (
        <p data-testid="mate-error-hint" style={{ fontSize: 12, color: "#ff6b6b", margin: 0 }}>
          参照が解決できません。面を選び直してください。
        </p>
      )}

      {!isReselecting && (
        <button
          type="button"
          data-testid="btn-reselect-mate-faces"
          onClick={onStartReselect}
          style={
            hasError
              ? { background: "#5c1f1f", color: "#fff", border: "1px solid #ff6b6b", fontWeight: "bold" }
              : undefined
          }
        >
          面を選び直す
        </button>
      )}

      {isReselecting && (
        <div data-testid="mate-reselect-panel" style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
          <p style={{ margin: 0 }}>ビューア上で面を2つ順にクリックすると即座にa/bを差し替えます。Escでキャンセルします。</p>
          {reselectPendingLabel && (
            <p data-testid="mate-reselect-pending" style={{ margin: 0, fontWeight: "bold", color: "#ffb74d" }}>
              {reselectPendingLabel}
            </p>
          )}
          <button type="button" data-testid="btn-cancel-mate-reselect" onClick={onCancelReselect}>
            キャンセル
          </button>
        </div>
      )}

      {hasSubsequentBodyEdit && (
        <p
          data-testid="mate-order-warning"
          title="合致は全フィーチャー評価後にまとめて解決されるため、これらの操作は合致で解決される前の配置を基準に行われます。"
          style={{ fontSize: 11, color: "#ffb74d", margin: 0 }}
        >
          ⚠ この合致より後ろに押し出し/回転体のカット・追加があります。
        </p>
      )}

      <button type="button" data-testid="btn-delete-mate" onClick={() => removeFeature(mate.id)}>
        削除
      </button>
    </div>
  );
}
