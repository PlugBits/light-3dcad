// フィーチャーツリーパネル。doc.features を順序どおり一覧表示し、選択/削除を行う。
// SolidWorks風ロールバックバー(Phase 25): 各フィーチャー行の間+末尾に常時クリック可能な
// 挿入スロットを表示し、クリックでバーをその位置へ移動する(ドラッグはサポートしない)。
// バー以降(index >= 有効フィーチャー数)のフィーチャーはグレーアウト表示にし、選択不可にする。
import { useState } from "react";
import type { CadDocument, Feature, FeatureId } from "../model/types";
import { effectiveFeatureCount } from "../model/document";

const ICONS: Record<Feature["type"], string> = {
  sketch: "▢", // □
  extrude: "⬆", // ⬆
  fillet3d: "◠", // 3Dフィレット/面取り(Phase 25a)
  shell: "▨", // シェル(中抜き、Phase 25b)
  revolve: "◍", // 回転体(Phase 25b)
  thread: "⚙", // ねじ(Phase 25c)
};

const TYPE_LABEL: Record<Feature["type"], string> = {
  sketch: "スケッチ",
  extrude: "押し出し",
  fillet3d: "フィレット/面取り",
  shell: "シェル",
  revolve: "回転体",
  thread: "ねじ",
};

/**
 * フィーチャーツリーに表示する種別ラベル。face参照スケッチは「面上スケッチ」、
 * fillet3dはkindに応じて「フィレット」/「面取り」と表示する(Phase 25a)。
 * threadはhandに応じて「ねじ(雄)」/「ねじ穴(雌・簡易表現)」と表示する(Phase 25c)。
 */
function typeLabel(feature: Feature): string {
  if (feature.type === "sketch" && feature.plane.kind === "face") {
    return "面上スケッチ";
  }
  if (feature.type === "fillet3d") {
    return feature.kind === "fillet" ? "フィレット" : "面取り";
  }
  if (feature.type === "thread") {
    return feature.hand === "male" ? "ねじ(雄)" : "ねじ穴(雌・簡易表現)";
  }
  return TYPE_LABEL[feature.type];
}

interface FeatureTreeProps {
  doc: CadDocument;
  selectedFeatureId: FeatureId | null;
  errorFeatureId: FeatureId | null;
  onSelect: (featureId: FeatureId) => void;
  onDelete: (featureId: FeatureId) => void;
  /** ロールバックバーの移動。indexはfeatures先頭からの有効フィーチャー数(末尾はnull)。 */
  onSetRollback: (index: number | null) => void;
}

/**
 * ロールバックバーの挿入スロット。slotIndexは「このスロットにバーを置いたときの有効フィーチャー数」。
 * activeCountと一致する場合は実際のバー(横線)として表示し、それ以外は薄い当たり判定のみのバーとして
 * ホバー時に見える細い線を表示する。
 */
function RollbackSlot({
  slotIndex,
  activeCount,
  total,
  onSetRollback,
}: {
  slotIndex: number;
  activeCount: number;
  total: number;
  onSetRollback: (index: number | null) => void;
}) {
  const isBarHere = slotIndex === activeCount;
  const [hovered, setHovered] = useState(false);
  return (
    <div
      data-testid={`rollback-slot-${slotIndex}`}
      onClick={() => onSetRollback(slotIndex >= total ? null : slotIndex)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title="ロールバックバーをここに移動"
      style={{
        height: 8,
        margin: "1px 0",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
      }}
    >
      <div
        data-testid={isBarHere ? "rollback-bar" : undefined}
        style={{
          height: isBarHere ? 3 : 1,
          width: "100%",
          borderRadius: 2,
          background: isBarHere ? "#3b82f6" : hovered ? "rgba(150,170,255,0.5)" : "transparent",
          transition: "background 0.1s",
        }}
      />
    </div>
  );
}

export function FeatureTree({ doc, selectedFeatureId, errorFeatureId, onSelect, onDelete, onSetRollback }: FeatureTreeProps) {
  if (doc.features.length === 0) {
    return <p style={{ fontSize: 13, opacity: 0.7 }}>フィーチャーがありません。</p>;
  }

  const total = doc.features.length;
  const activeCount = effectiveFeatureCount(doc);

  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 0 }}>
      {doc.features.map((feature, index) => {
        const selected = feature.id === selectedFeatureId;
        const hasError = feature.id === errorFeatureId;
        const isActive = index < activeCount;
        return (
          <li key={feature.id}>
            <RollbackSlot slotIndex={index} activeCount={activeCount} total={total} onSetRollback={onSetRollback} />
            <div
              data-testid={`feature-item-${feature.name}`}
              onClick={isActive ? () => onSelect(feature.id) : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 8px",
                borderRadius: 4,
                cursor: isActive ? "pointer" : "default",
                opacity: isActive ? 1 : 0.45,
                fontStyle: isActive ? "normal" : "italic",
                background: selected ? "rgba(100, 150, 255, 0.25)" : "transparent",
                border: hasError ? "1px solid #ff6b6b" : "1px solid transparent",
              }}
            >
              <span aria-hidden="true">{ICONS[feature.type]}</span>
              <span style={{ flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {feature.name}
                <span style={{ opacity: 0.6 }}> ({typeLabel(feature)})</span>
              </span>
              {hasError && (
                <span title="評価エラーがあります" style={{ color: "#ff6b6b" }}>
                  ⚠
                </span>
              )}
              <button
                type="button"
                title="削除"
                data-testid={`feature-delete-${feature.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(feature.id);
                }}
                style={{ fontSize: 11, lineHeight: 1, padding: "2px 6px" }}
              >
                ✕
              </button>
            </div>
          </li>
        );
      })}
      <li>
        <RollbackSlot slotIndex={total} activeCount={activeCount} total={total} onSetRollback={onSetRollback} />
      </li>
    </ul>
  );
}
