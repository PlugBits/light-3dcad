// ねじフィーチャー選択時の編集パネル(Phase 25c、Phase 29bで配置面再選択UIを追加、Phase 46で
// スケッチの円参照配置[positionRef]を追加)。名前・呼び径プリセット・種別(雄/雌)・長さの編集に
// 加え、「配置し直す」ボタンでビューアのねじ配置ツールを再選択モードで起動できる。面選択ツールと
// 異なりクリック1回で即座に確定する(「適用」ボタンは無い、通常のねじ配置ツールと同じ操作感)。
import { patchThreadFeature, patchThreadPosition, patchThreadPositionRef } from "../model/document";
import type { CadDocument, ThreadFeature, ThreadPreset } from "../model/types";
import { THREAD_PRESET_LIST, threadDrillDiameter, threadPitch } from "../model/threadPresets";
import { listThreadPositionRefCandidates } from "../model/threadPositionRef";
import { useCadStore } from "../state/store";

export interface ThreadEditorProps {
  thread: ThreadFeature;
  /** positionRef(Phase 46)の候補一覧を作るために必要な、ドキュメント全体(面上スケッチ・円を列挙する)。 */
  doc: CadDocument;
  /** このフィーチャーが評価エラー中(store.errorFeatureId一致)かどうか。ボタンを目立たせる。 */
  hasError: boolean;
  /** 配置し直しモード中かどうか(App.tsx側のthreadReselectTargetIdがこのフィーチャーと一致)。 */
  isReselecting: boolean;
  onStartReselect: () => void;
  onCancelReselect: () => void;
}

export function ThreadEditor({ thread, doc, hasError, isReselecting, onStartReselect, onCancelReselect }: ThreadEditorProps) {
  const updateDocument = useCadStore((s) => s.updateDocument);
  const sketchPlanes = useCadStore((s) => s.sketchPlanes);

  function patch(p: Partial<Pick<ThreadFeature, "name" | "preset" | "length" | "hand">>) {
    updateDocument((d) => patchThreadFeature(d, thread.id, p));
  }

  /** 配置位置(面ローカル2D座標、mm)を数値編集する。faceは変えない(Phase 43)。positionRef中は使わない。 */
  function patchPosition(index: 0 | 1, value: number) {
    if (!Number.isFinite(value)) return;
    const next: [number, number] = [...thread.position];
    next[index] = value;
    updateDocument((d) => patchThreadPosition(d, thread.id, next));
  }

  // 配置基準参照(positionRef、Phase 46)の候補一覧: thread.faceと同じ面上スケッチが持つ円。
  const positionRefCandidates = listThreadPositionRefCandidates(doc, thread, sketchPlanes);
  const positionRefKey = thread.positionRef ? `${thread.positionRef.sketchId}:${thread.positionRef.entityId}` : "";

  /** 「スケッチの円を参照」ラジオを選んだとき: 候補の先頭を初期選択する(候補が無ければ何もしない)。 */
  function switchToSketchRef() {
    const first = positionRefCandidates[0];
    if (!first) return;
    updateDocument((d) => patchThreadPositionRef(d, thread.id, { sketchId: first.sketchId, entityId: first.entityId }));
  }

  /** 「数値/クリック(従来)」ラジオへ戻す: positionRefのみ解除し、直近の解決済み位置(position)は維持する。 */
  function switchToManual() {
    updateDocument((d) => patchThreadPositionRef(d, thread.id, null));
  }

  function selectPositionRefCandidate(key: string) {
    const separatorIndex = key.indexOf(":");
    if (separatorIndex < 0) return;
    const sketchId = key.slice(0, separatorIndex);
    const entityId = key.slice(separatorIndex + 1);
    updateDocument((d) => patchThreadPositionRef(d, thread.id, { sketchId, entityId }));
  }

  const drillDiameter = threadDrillDiameter(thread.preset);
  // 表示は3桁丸め(入力自体は自由精度、丸めは表示のみ)。positionRef中はevaluate応答由来の
  // 解決済み位置(src/state/store.tsのapplyThreadPositionUpdates参照)がそのまま表示される。
  const posX = Number(thread.position[0].toFixed(3));
  const posY = Number(thread.position[1].toFixed(3));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>ねじ編集</h3>
      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        名前
        <input type="text" value={thread.name} onChange={(e) => patch({ name: e.target.value })} />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        呼び径
        <select
          data-testid="thread-preset-select"
          value={thread.preset}
          onChange={(e) => patch({ preset: e.target.value as ThreadPreset })}
        >
          {THREAD_PRESET_LIST.map((p) => (
            <option key={p} value={p}>
              {p} (ピッチ{threadPitch(p)}mm)
            </option>
          ))}
        </select>
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        種別
        <select
          data-testid="thread-hand-select"
          value={thread.hand}
          onChange={(e) => {
            const hand = e.target.value as "male" | "female";
            patch({ hand });
          }}
        >
          <option value="male">雄(ボス・実ねじ山)</option>
          <option value="female">雌(穴・簡易表現)</option>
        </select>
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        長さ (mm)
        <input
          type="number"
          value={thread.length}
          data-testid="thread-length-input"
          min={0.1}
          step="any"
          onChange={(e) => {
            const num = Number(e.target.value);
            if (!Number.isFinite(num) || num <= 0) return;
            patch({ length: num });
          }}
        />
      </label>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 12, opacity: 0.8 }}>配置基準</span>
        <div style={{ display: "flex", gap: 12, fontSize: 11 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input
              type="radio"
              name={`thread-position-mode-${thread.id}`}
              data-testid="thread-position-mode-manual"
              checked={!thread.positionRef}
              onChange={switchToManual}
            />
            数値/クリック(従来)
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input
              type="radio"
              name={`thread-position-mode-${thread.id}`}
              data-testid="thread-position-mode-sketch"
              checked={!!thread.positionRef}
              disabled={positionRefCandidates.length === 0 && !thread.positionRef}
              onChange={switchToSketchRef}
            />
            スケッチの円を参照
          </label>
        </div>

        {thread.positionRef && (
          <>
            {positionRefCandidates.length > 0 ? (
              <select
                data-testid="thread-position-ref-select"
                value={positionRefKey}
                onChange={(e) => selectPositionRefCandidate(e.target.value)}
              >
                {!positionRefCandidates.some((c) => `${c.sketchId}:${c.entityId}` === positionRefKey) && (
                  <option value={positionRefKey}>(参照先が見つかりません)</option>
                )}
                {positionRefCandidates.map((c) => (
                  <option key={`${c.sketchId}:${c.entityId}`} value={`${c.sketchId}:${c.entityId}`}>
                    {c.label}
                  </option>
                ))}
              </select>
            ) : (
              <p style={{ fontSize: 11, color: "#ff6b6b", margin: 0 }}>
                参照できる円がありません。ねじの配置面と同じ面上のスケッチに円を作成してください。
              </p>
            )}
          </>
        )}

        <span style={{ fontSize: 12, opacity: 0.8 }}>配置位置 (mm、基準: 面のローカル座標)</span>
        <div style={{ display: "flex", gap: 6 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, flex: 1 }}>
            位置X
            <input
              type="number"
              data-testid="thread-position-x-input"
              value={posX}
              step="any"
              readOnly={!!thread.positionRef}
              onChange={(e) => patchPosition(0, Number(e.target.value))}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, flex: 1 }}>
            位置Y
            <input
              type="number"
              data-testid="thread-position-y-input"
              value={posY}
              step="any"
              readOnly={!!thread.positionRef}
              onChange={(e) => patchPosition(1, Number(e.target.value))}
            />
          </label>
        </div>
        {thread.positionRef && (
          <p style={{ fontSize: 11, opacity: 0.6, margin: 0 }}>
            スケッチの円から解決した位置です(読み取り専用)。円の位置・寸法を変更すると自動的に追従します。
          </p>
        )}
      </div>

      <p style={{ fontSize: 11, opacity: 0.6, margin: 0 }}>
        {thread.hand === "male"
          ? `${thread.preset}(呼び径・ピッチ${threadPitch(thread.preset)}mmのISO並目)の簡易表示です。実体は呼び径円柱、ねじ山は線表示のみです。`
          : `${thread.preset}ねじ穴(簡易表現・下穴φ${drillDiameter.toFixed(1)}mm)。ねじ山は線表示のみです。`}
      </p>

      {hasError && !isReselecting && (
        <p data-testid="thread-error-hint" style={{ fontSize: 12, color: "#ff6b6b", margin: 0 }}>
          参照が解決できません。配置面を選び直してください。
        </p>
      )}

      {!isReselecting && (
        <button
          type="button"
          data-testid="btn-reselect-thread-placement"
          onClick={onStartReselect}
          style={
            hasError
              ? { background: "#5c1f1f", color: "#fff", border: "1px solid #ff6b6b", fontWeight: "bold" }
              : undefined
          }
        >
          配置し直す
        </button>
      )}

      {isReselecting && (
        <div data-testid="thread-reselect-panel" style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
          <p style={{ margin: 0 }}>ビューア上で平面をクリックすると即座に配置し直されます。Escでキャンセルします。</p>
          <button type="button" data-testid="btn-cancel-thread-reselect" onClick={onCancelReselect}>
            キャンセル
          </button>
        </div>
      )}
    </div>
  );
}
