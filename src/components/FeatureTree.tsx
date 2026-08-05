// フィーチャーツリーパネル。doc.features を順序どおり一覧表示し、選択/削除を行う。
import type { CadDocument, Feature, FeatureId } from "../model/types";

const ICONS: Record<Feature["type"], string> = {
  sketch: "▢", // □
  extrude: "⬆", // ⬆
};

const TYPE_LABEL: Record<Feature["type"], string> = {
  sketch: "スケッチ",
  extrude: "押し出し",
};

/** フィーチャーツリーに表示する種別ラベル。face参照スケッチは「面上スケッチ」と表示する。 */
function typeLabel(feature: Feature): string {
  if (feature.type === "sketch" && feature.plane.kind === "face") {
    return "面上スケッチ";
  }
  return TYPE_LABEL[feature.type];
}

interface FeatureTreeProps {
  doc: CadDocument;
  selectedFeatureId: FeatureId | null;
  errorFeatureId: FeatureId | null;
  onSelect: (featureId: FeatureId) => void;
  onDelete: (featureId: FeatureId) => void;
}

export function FeatureTree({ doc, selectedFeatureId, errorFeatureId, onSelect, onDelete }: FeatureTreeProps) {
  if (doc.features.length === 0) {
    return <p style={{ fontSize: 13, opacity: 0.7 }}>フィーチャーがありません。</p>;
  }

  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
      {doc.features.map((feature) => {
        const selected = feature.id === selectedFeatureId;
        const hasError = feature.id === errorFeatureId;
        return (
          <li key={feature.id}>
            <div
              data-testid={`feature-item-${feature.name}`}
              onClick={() => onSelect(feature.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 8px",
                borderRadius: 4,
                cursor: "pointer",
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
    </ul>
  );
}
