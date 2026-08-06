// ねじフィーチャー選択時の編集パネル(Phase 25c)。
// v1: 名前・呼び径プリセット・種別(雄/雌)・長さのみ編集可能(配置面の再選択UIは持たない。
// 面が解決できなくなった場合は評価エラーになるため、フィーチャーを削除して作り直す運用。
// Fillet3DEditor/ShellEditorと同じ方針)。
import { patchThreadFeature } from "../model/document";
import { MALE_THREAD_MAX_LENGTH, THREAD_PRESET_LIST, threadDrillDiameter, threadPitch } from "../model/threadPresets";
import type { ThreadFeature, ThreadPreset } from "../model/types";
import { useCadStore } from "../state/store";

export function ThreadEditor({ thread }: { thread: ThreadFeature }) {
  const updateDocument = useCadStore((s) => s.updateDocument);

  function patch(p: Partial<Pick<ThreadFeature, "name" | "preset" | "length" | "hand">>) {
    updateDocument((d) => patchThreadFeature(d, thread.id, p));
  }

  const drillDiameter = threadDrillDiameter(thread.preset);

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
            const length = hand === "male" ? Math.min(thread.length, MALE_THREAD_MAX_LENGTH) : thread.length;
            patch({ hand, length });
          }}
        >
          <option value="male">雄(ボス・実ねじ山)</option>
          <option value="female">雌(穴・簡易表現)</option>
        </select>
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        長さ (mm){thread.hand === "male" ? `(上限${MALE_THREAD_MAX_LENGTH}mm)` : ""}
        <input
          type="number"
          value={thread.length}
          data-testid="thread-length-input"
          min={0.1}
          max={thread.hand === "male" ? MALE_THREAD_MAX_LENGTH : undefined}
          step="any"
          onChange={(e) => {
            const num = Number(e.target.value);
            if (!Number.isFinite(num) || num <= 0) return;
            if (thread.hand === "male" && num > MALE_THREAD_MAX_LENGTH) return;
            patch({ length: num });
          }}
        />
      </label>

      <p style={{ fontSize: 11, opacity: 0.6, margin: 0 }}>
        {thread.hand === "male"
          ? `${thread.preset}(呼び径・ピッチ${threadPitch(thread.preset)}mmのISO並目)の実ねじ山です。`
          : `${thread.preset}ねじ穴(簡易表現・下穴φ${drillDiameter.toFixed(1)}mm)。ねじ山は作成されません。`}
      </p>
      <p style={{ fontSize: 11, opacity: 0.6, margin: 0 }}>
        配置面: 選び直しはできません(削除して作り直してください)。ねじを含むドキュメントは再評価に
        数秒かかることがあります。編集中はロールバックバーをねじの前に置くと軽くなります。
      </p>
    </div>
  );
}
