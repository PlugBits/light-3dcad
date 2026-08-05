// スケッチフィーチャー選択時の編集パネル。矩形/円/多角形エンティティの追加(多角形は描画モード)・
// 数値編集・削除を行う。
import { addSketchEntity, patchSketchFeature, removeSketchEntity, updateSketchEntity } from "../model/document";
import { createCircleEntity, createRectangleEntity } from "../model/entity";
import type { FeatureId, SketchEntity, SketchFeature } from "../model/types";
import { useCadStore } from "../state/store";

function NumberField({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  testId?: string;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
      {label}
      <input
        type="number"
        value={value}
        data-testid={testId}
        onChange={(e) => {
          const num = Number(e.target.value);
          if (Number.isNaN(num)) return;
          onChange(num);
        }}
        style={{ width: "100%" }}
      />
    </label>
  );
}

export function SketchEditor({ sketch }: { sketch: SketchFeature }) {
  const updateDocument = useCadStore((s) => s.updateDocument);

  function handleRename(name: string) {
    updateDocument((doc) => patchSketchFeature(doc, sketch.id, { name }));
  }

  function handleAddRectangle() {
    const entity = createRectangleEntity({ width: 20, height: 20 });
    updateDocument((doc) => addSketchEntity(doc, sketch.id, entity));
  }

  function handleAddCircle() {
    const entity = createCircleEntity({ radius: 10 });
    updateDocument((doc) => addSketchEntity(doc, sketch.id, entity));
  }

  function handleRemoveEntity(entityId: string) {
    updateDocument((doc) => removeSketchEntity(doc, sketch.id, entityId));
  }

  function handleCenterChange(entityId: string, axis: 0 | 1, value: number, center: [number, number]) {
    const nextCenter: [number, number] = [...center];
    nextCenter[axis] = value;
    updateDocument((doc) => updateSketchEntity(doc, sketch.id, entityId, { center: nextCenter }));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>スケッチ編集</h3>
      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
        名前
        <input type="text" value={sketch.name} onChange={(e) => handleRename(e.target.value)} />
      </label>
      <p style={{ fontSize: 11, opacity: 0.7, margin: 0 }}>
        平面:{" "}
        {sketch.plane.kind === "world"
          ? `ワールド ${sketch.plane.plane}`
          : `面参照(中心 ${sketch.plane.center.map((v) => v.toFixed(1)).join(", ")} / 法線 ${sketch.plane.normal
              .map((v) => v.toFixed(2))
              .join(", ")})`}
      </p>

      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" data-testid="btn-add-rectangle" onClick={handleAddRectangle}>
          矩形追加
        </button>
        <button type="button" data-testid="btn-add-circle" onClick={handleAddCircle}>
          円追加
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {sketch.entities.length === 0 && (
          <p style={{ fontSize: 12, opacity: 0.7 }}>図形がありません。「矩形追加」「円追加」で作成してください。</p>
        )}
        {sketch.entities.map((entity, index) => (
          <div
            key={entity.id}
            data-testid={`entity-${entity.kind}-${index}`}
            style={{
              border: "1px solid #444",
              borderRadius: 4,
              padding: 8,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ fontSize: 12 }}>
                {entity.kind === "rectangle" ? "矩形" : entity.kind === "circle" ? "円" : "多角形"}
              </strong>
              <button
                type="button"
                title="削除"
                data-testid={`entity-${entity.kind}-${index}-delete`}
                onClick={() => handleRemoveEntity(entity.id)}
                style={{ fontSize: 11 }}
              >
                削除
              </button>
            </div>
            {entity.kind === "polygon" ? (
              <PolygonVertexEditor sketchId={sketch.id} entityIndex={index} entity={entity} />
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                <NumberField
                  label="中心X (mm)"
                  value={entity.center[0]}
                  testId={`entity-${entity.kind}-${index}-center-x`}
                  onChange={(v) => handleCenterChange(entity.id, 0, v, entity.center)}
                />
                <NumberField
                  label="中心Y (mm)"
                  value={entity.center[1]}
                  testId={`entity-${entity.kind}-${index}-center-y`}
                  onChange={(v) => handleCenterChange(entity.id, 1, v, entity.center)}
                />
                {entity.kind === "rectangle" ? (
                  <>
                    <NumberField
                      label="幅 (mm)"
                      value={entity.width}
                      testId={`entity-${entity.kind}-${index}-width`}
                      onChange={(v) => updateDocument((doc) => updateSketchEntity(doc, sketch.id, entity.id, { width: v }))}
                    />
                    <NumberField
                      label="高さ (mm)"
                      value={entity.height}
                      testId={`entity-${entity.kind}-${index}-height`}
                      onChange={(v) => updateDocument((doc) => updateSketchEntity(doc, sketch.id, entity.id, { height: v }))}
                    />
                  </>
                ) : (
                  <NumberField
                    label="半径 (mm)"
                    value={entity.radius}
                    testId={`entity-${entity.kind}-${index}-radius`}
                    onChange={(v) => updateDocument((doc) => updateSketchEntity(doc, sketch.id, entity.id, { radius: v }))}
                  />
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

type PolygonEntity = Extract<SketchEntity, { kind: "polygon" }>;

/**
 * 多角形エンティティの頂点座標を数値編集する簡易UI。頂点の追加は線描画モード推奨のため、
 * ここでは既存頂点のX/Y編集と削除のみを提供する(3点未満になる削除は無効化)。
 */
function PolygonVertexEditor({
  sketchId,
  entityIndex,
  entity,
}: {
  sketchId: FeatureId;
  entityIndex: number;
  entity: PolygonEntity;
}) {
  const updateDocument = useCadStore((s) => s.updateDocument);

  function handlePointChange(vertexIndex: number, axis: 0 | 1, value: number) {
    const nextPoints = entity.points.map((point, i): [number, number] =>
      i === vertexIndex ? (axis === 0 ? [value, point[1]] : [point[0], value]) : point,
    );
    updateDocument((doc) => updateSketchEntity(doc, sketchId, entity.id, { points: nextPoints }));
  }

  function handleRemoveVertex(vertexIndex: number) {
    if (entity.points.length <= 3) return;
    const nextPoints = entity.points.filter((_, i) => i !== vertexIndex);
    updateDocument((doc) => updateSketchEntity(doc, sketchId, entity.id, { points: nextPoints }));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {entity.points.map(([x, y], vertexIndex) => (
        <div
          key={vertexIndex}
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 6, alignItems: "end" }}
        >
          <NumberField
            label={`頂点${vertexIndex + 1} X`}
            value={x}
            testId={`entity-polygon-${entityIndex}-vertex-${vertexIndex}-x`}
            onChange={(v) => handlePointChange(vertexIndex, 0, v)}
          />
          <NumberField
            label={`頂点${vertexIndex + 1} Y`}
            value={y}
            testId={`entity-polygon-${entityIndex}-vertex-${vertexIndex}-y`}
            onChange={(v) => handlePointChange(vertexIndex, 1, v)}
          />
          <button
            type="button"
            title="頂点を削除"
            data-testid={`entity-polygon-${entityIndex}-vertex-${vertexIndex}-delete`}
            disabled={entity.points.length <= 3}
            onClick={() => handleRemoveVertex(vertexIndex)}
            style={{ fontSize: 11 }}
          >
            削除
          </button>
        </div>
      ))}
    </div>
  );
}
