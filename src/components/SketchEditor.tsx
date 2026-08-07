// スケッチフィーチャー選択時の編集パネル。矩形/円/多角形エンティティの追加(多角形は描画モード)・
// 数値編集・削除を行う。多角形は頂点ごとのフィレット/面取り(コーナー)編集も提供する(Phase 11)。
// 各エンティティは「分解」で等価なsegments(線分・円弧)に変換できる(Phase 19b、トリム対象になる)。
import { useEffect, useRef, useState } from "react";

import { explodeEntity } from "../sketch/explode";
import {
  addSketchEntity,
  explodeSketchEntity,
  patchSketchFeature,
  removeSketchElementCascade,
  removeSketchEntity,
  setPolygonVertexCorner,
  setSketchConstraints,
  setSketchSegments,
  updateSketchEntity,
} from "../model/document";
import { createCircleEntity, createRectangleEntity, createRegularPolygonEntity, createSlotEntity } from "../model/entity";
import type { FeatureId, PolygonCorner, SketchEntity, SketchFeature, SketchSegment } from "../model/types";
import { isEntityFixed, removeConstraint, setEntityFixed } from "../sketch/constraintDimensions";
import { CONSTRAINT_KIND_LABELS, describeConstraint } from "../sketch/constraintLabels";
import { formatMm } from "../sketch/format";
import { updateDocumentWithConflictRollback } from "../state/constraintUpdate";
import { useCadStore } from "../state/store";

/**
 * 数値入力欄。表示は小数3桁に丸める(formatMm)が、内部値(onChangeで渡す値)はフル精度のまま。
 * フォーカス中は入力途中の生文字列をそのまま表示する(=丸め表示がユーザーの入力を上書きしない)ため、
 * 小数3桁を超える値を入力してもその値が尊重される。フォーカスを外すと表示は丸め値に戻る
 * (ユーザー報告対応: 左パネルの数値表示を小数3桁にする)。
 */
function NumberField({
  label,
  value,
  onChange,
  testId,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  testId?: string;
  disabled?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState(() => String(formatMm(value)));

  useEffect(() => {
    if (!focused) setText(String(formatMm(value)));
  }, [value, focused]);

  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
      {label}
      <input
        type="number"
        value={text}
        data-testid={testId}
        disabled={disabled}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setText(String(formatMm(value)));
        }}
        onChange={(e) => {
          setText(e.target.value);
          const num = Number(e.target.value);
          if (Number.isNaN(num)) return;
          onChange(num);
        }}
        style={{ width: "100%" }}
      />
    </label>
  );
}

/**
 * SketchEditorの一時トースト通知先(削除時の「関連する拘束N件も削除しました」)。App.tsxの
 * showTransientMessageを渡す想定(省略時は何もしない、テスト・単体利用時の後方互換)。
 */
export function SketchEditor({ sketch, onNotice }: { sketch: SketchFeature; onNotice?: (message: string) => void }) {
  const updateDocument = useCadStore((s) => s.updateDocument);
  // ビューア上のスケッチ線直接クリックで選択されたentity/segmentのid(Phase 31b、未選択はnull)。
  // 該当エンティティ/セグメント欄への自動スクロール&一時ハイライトに使う(ビューア側の3D強調は
  // entity/segment共通)。セグメント一覧も個別行を持つようになった(実機報告対応、Phase 32②)ため、
  // entityRefs/segmentRefsの両方を対象にする。
  const selectedEntityId = useCadStore((s) => s.selectedEntityId);
  const entityRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const segmentRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // 一時ハイライト対象のid(entity/segment共通、selectedEntityIdが変わるたびに一定時間だけ強調表示する)。
  const [highlightEntityId, setHighlightEntityId] = useState<string | null>(null);
  const highlightTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!selectedEntityId) return;
    const el = entityRefs.current[selectedEntityId] ?? segmentRefs.current[selectedEntityId];
    if (!el) return; // このsketchに属さないid(他スケッチのentity選択等)は何もしない。
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightEntityId(selectedEntityId);
    if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => setHighlightEntityId(null), 1500);
  }, [selectedEntityId]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    };
  }, []);

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

  function handleAddSlot() {
    const entity = createSlotEntity({ start: [-10, 0], end: [10, 0], width: 10 });
    updateDocument((doc) => addSketchEntity(doc, sketch.id, entity));
  }

  function handleAddRegularPolygon() {
    const entity = createRegularPolygonEntity({ radius: 10, sides: 6 });
    updateDocument((doc) => addSketchEntity(doc, sketch.id, entity));
  }

  function handleRemoveEntity(entityId: string) {
    updateDocument((doc) => removeSketchEntity(doc, sketch.id, entityId));
  }

  /** エンティティを等価なsegments(線分・円弧、Phase 19a)に変換して置き換える(「分解」、Phase 19b)。 */
  function handleExplodeEntity(entity: SketchEntity) {
    const segments = explodeEntity(entity);
    updateDocument((doc) => explodeSketchEntity(doc, sketch.id, entity.id, segments));
  }

  /** sketchのsegments(Phase 19a)を全削除する。 */
  function handleClearSegments() {
    updateDocument((doc) => setSketchSegments(doc, sketch.id, []));
  }

  /**
   * セグメント1本を個別に削除する(実機報告対応、Phase 32②)。参照する拘束
   * (coincident/horizontal/tangent等)も同時に削除され、削除件数が1件以上あれば一時トーストで
   * 通知する(App.tsxのonNotice、省略時は通知しない)。削除したセグメントが選択中だった場合は
   * 選択も解除する(存在しないidを参照したままにしないため)。
   */
  function handleRemoveSegment(segmentId: string) {
    updateDocument((doc) => {
      const { doc: nextDoc, removedConstraintCount } = removeSketchElementCascade(doc, sketch.id, segmentId);
      if (removedConstraintCount > 0) onNotice?.(`関連する拘束${removedConstraintCount}件も削除しました`);
      return nextDoc;
    });
    if (useCadStore.getState().selectedEntityId === segmentId) {
      useCadStore.setState({ selectedEntityId: null });
    }
  }

  /** セグメント一覧の行クリックでビューア直接選択と同じselectedEntityIdへ反映する(強調表示の統一)。 */
  function handleSelectSegment(segmentId: string) {
    useCadStore.getState().selectSketchEntity(sketch.id, segmentId);
  }

  function handleCenterChange(entityId: string, axis: 0 | 1, value: number, center: [number, number]) {
    const nextCenter: [number, number] = [...center];
    nextCenter[axis] = value;
    updateDocument((doc) => updateSketchEntity(doc, sketch.id, entityId, { center: nextCenter }));
  }

  /**
   * エンティティの位置を固定/解除する(fixEntity拘束のon/off、Phase 22。矩形・多角形をソルバで
   * 動かせるようにする改善でcircle以外のkindにも対応)。
   * 既存の位置寸法拘束(distanceEntityOrigin等)と矛盾する場合は自動的に取り消す
   * (App.tsxのhandleApplyDimensionTargetと同じupdateDocumentWithConflictRollback経路)。
   */
  function handleToggleEntityFixed(entityId: string, fixed: boolean) {
    updateDocumentWithConflictRollback(
      sketch.id,
      (doc) => setSketchConstraints(doc, sketch.id, setEntityFixed(sketch.constraints ?? [], entityId, fixed)),
      (message) => window.alert(message),
    );
  }

  function handlePointChange(
    entityId: string,
    field: "start" | "end",
    axis: 0 | 1,
    value: number,
    point: [number, number],
  ) {
    const next: [number, number] = [...point];
    next[axis] = value;
    updateDocument((doc) => updateSketchEntity(doc, sketch.id, entityId, { [field]: next }));
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

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} title="既定サイズの図形を数値で追加します(後から数値編集できます)">
        <button type="button" data-testid="btn-add-rectangle" onClick={handleAddRectangle} title="20x20mmの矩形を原点に追加します">
          矩形を数値で追加
        </button>
        <button type="button" data-testid="btn-add-circle" onClick={handleAddCircle} title="半径10mmの円を原点に追加します">
          円を数値で追加
        </button>
        <button type="button" data-testid="btn-add-slot" onClick={handleAddSlot} title="幅10mmのスロット(長円)を原点付近に追加します">
          スロットを数値で追加
        </button>
        <button
          type="button"
          data-testid="btn-add-regular-polygon"
          onClick={handleAddRegularPolygon}
          title="外接円半径10mm・6角形の正多角形を原点に追加します"
        >
          正多角形を数値で追加
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {sketch.entities.length === 0 && (
          <p style={{ fontSize: 12, opacity: 0.7 }}>
            図形がありません。ツールバーの「矩形」「円」「線描画」ボタンで作図するか、上の「数値で追加」を使ってください。
          </p>
        )}
        {sketch.entities.map((entity, index) => (
          <div
            key={entity.id}
            id={`entity-panel-${entity.id}`}
            ref={(el) => {
              entityRefs.current[entity.id] = el;
            }}
            data-testid={`entity-${entity.kind}-${index}`}
            style={{
              border: entity.id === highlightEntityId ? "2px solid #ffea00" : "1px solid #444",
              borderRadius: 4,
              padding: 8,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              background: entity.id === highlightEntityId ? "rgba(255, 234, 0, 0.12)" : undefined,
              transition: "background-color 0.3s ease, border-color 0.3s ease",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ fontSize: 12 }}>
                {entity.kind === "rectangle"
                  ? "矩形"
                  : entity.kind === "circle"
                    ? "円"
                    : entity.kind === "slot"
                      ? "スロット"
                      : entity.kind === "regularPolygon"
                        ? "正多角形"
                        : "多角形"}
              </strong>
              <span style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  title="等価な線分・円弧セグメントに変換します(変換後はトリムツールで編集できます)"
                  data-testid={`entity-${entity.kind}-${index}-explode`}
                  onClick={() => handleExplodeEntity(entity)}
                  style={{ fontSize: 11 }}
                >
                  分解
                </button>
                <button
                  type="button"
                  title="削除"
                  data-testid={`entity-${entity.kind}-${index}-delete`}
                  onClick={() => handleRemoveEntity(entity.id)}
                  style={{ fontSize: 11 }}
                >
                  削除
                </button>
              </span>
            </div>
            {entity.kind === "polygon" ? (
              <PolygonVertexEditor sketchId={sketch.id} entityIndex={index} entity={entity} />
            ) : entity.kind === "slot" ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                <NumberField
                  label="始点X (mm)"
                  value={entity.start[0]}
                  testId={`entity-${entity.kind}-${index}-start-x`}
                  onChange={(v) => handlePointChange(entity.id, "start", 0, v, entity.start)}
                />
                <NumberField
                  label="始点Y (mm)"
                  value={entity.start[1]}
                  testId={`entity-${entity.kind}-${index}-start-y`}
                  onChange={(v) => handlePointChange(entity.id, "start", 1, v, entity.start)}
                />
                <NumberField
                  label="終点X (mm)"
                  value={entity.end[0]}
                  testId={`entity-${entity.kind}-${index}-end-x`}
                  onChange={(v) => handlePointChange(entity.id, "end", 0, v, entity.end)}
                />
                <NumberField
                  label="終点Y (mm)"
                  value={entity.end[1]}
                  testId={`entity-${entity.kind}-${index}-end-y`}
                  onChange={(v) => handlePointChange(entity.id, "end", 1, v, entity.end)}
                />
                <NumberField
                  label="幅 (mm)"
                  value={entity.width}
                  testId={`entity-${entity.kind}-${index}-width`}
                  onChange={(v) => updateDocument((doc) => updateSketchEntity(doc, sketch.id, entity.id, { width: v }))}
                />
              </div>
            ) : entity.kind === "regularPolygon" ? (
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
                <NumberField
                  label="外接円半径 (mm)"
                  value={entity.radius}
                  testId={`entity-${entity.kind}-${index}-radius`}
                  onChange={(v) => updateDocument((doc) => updateSketchEntity(doc, sketch.id, entity.id, { radius: v }))}
                />
                <NumberField
                  label="辺数 (3〜24)"
                  value={entity.sides}
                  testId={`entity-${entity.kind}-${index}-sides`}
                  onChange={(v) => {
                    const sides = Math.round(v);
                    if (sides < 3 || sides > 24) return;
                    updateDocument((doc) => updateSketchEntity(doc, sketch.id, entity.id, { sides }));
                  }}
                />
                <NumberField
                  label="回転 (度)"
                  value={((entity.rotation ?? 0) * 180) / Math.PI}
                  testId={`entity-${entity.kind}-${index}-rotation`}
                  onChange={(v) =>
                    updateDocument((doc) => updateSketchEntity(doc, sketch.id, entity.id, { rotation: (v * Math.PI) / 180 }))
                  }
                />
              </div>
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
            {/*
              固定チェックボックス(fixEntity拘束のon/off)。矩形・多角形をソルバで動かせるようにする
              改善: 円だけでなくrectangle/polygon/regularPolygon/slotもソルバの変数(中心、または
              polygon/slotは並進オフセット)を持つようになったため、これらも固定対象にできる。
            */}
            <label
              style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}
              title="現在位置(circle/rectangle/regularPolygonは中心、polygon/slotは全体位置)を固定します(fixEntity拘束のon/off)。他の位置寸法拘束と矛盾する場合は取り消されます"
            >
              <input
                type="checkbox"
                data-testid={`entity-${entity.kind}-${index}-fixed`}
                checked={isEntityFixed(sketch.constraints ?? [], entity.id)}
                onChange={(e) => handleToggleEntityFixed(entity.id, e.target.checked)}
              />
              固定
            </label>
          </div>
        ))}
      </div>

      <div
        style={{
          borderTop: "1px solid #444",
          paddingTop: 10,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 13 }} title="座標編集は未対応(トリムツールで区間ごと削除できます)">
          セグメント(線分・円弧)
        </h3>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
          <span data-testid="segment-count">セグメント数: {sketch.segments?.length ?? 0}</span>
          <button
            type="button"
            data-testid="btn-clear-segments"
            onClick={handleClearSegments}
            disabled={!sketch.segments || sketch.segments.length === 0}
            style={{ fontSize: 11 }}
            title="全てのセグメントを一括削除します(参照する拘束も一緒に削除されます)"
          >
            全削除
          </button>
        </div>
        {/*
          セグメント個別行の一覧(実機報告対応、Phase 32②: 従来は件数+全削除ボタンのみだった)。
          クリックでビューア直接選択と同じselectedEntityIdに反映され、行が強調表示される
          (ビューア上でクリック選択→Deleteキーの操作とも連動する)。行数が多い場合は
          max-heightで縦スクロールする。
        */}
        {sketch.segments && sketch.segments.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 240, overflowY: "auto" }}>
            {sketch.segments.map((seg, index) => {
              const isSelected = seg.id === selectedEntityId;
              const isHighlighted = seg.id === highlightEntityId;
              return (
                <div
                  key={seg.id}
                  ref={(el) => {
                    segmentRefs.current[seg.id] = el;
                  }}
                  data-testid={`segment-row-${index}`}
                  onClick={() => handleSelectSegment(seg.id)}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 6px",
                    borderRadius: 4,
                    cursor: "pointer",
                    border: isSelected ? "2px solid #4a90d9" : "1px solid #444",
                    background: isHighlighted ? "rgba(255, 234, 0, 0.12)" : isSelected ? "rgba(74, 144, 217, 0.12)" : undefined,
                    transition: "background-color 0.3s ease, border-color 0.3s ease",
                    fontSize: 11,
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {segmentRowLabel(seg, index)}
                  </span>
                  <button
                    type="button"
                    title="このセグメントを削除します(参照する拘束も一緒に削除されます)"
                    data-testid={`segment-row-${index}-delete`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemoveSegment(seg.id);
                    }}
                    style={{ fontSize: 11, flexShrink: 0 }}
                  >
                    削除
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ConstraintListPanel sketch={sketch} />
    </div>
  );
}

/**
 * セグメント個別行の表示ラベル(種類+概略座標、実機報告対応Phase 32②)。
 * 例: 「セグメント1(線分): (0, 0) → (10, 0)」。座標はformatMm()で小数3桁に丸める(表示用)。
 */
function segmentRowLabel(seg: SketchSegment, index: number): string {
  const kindLabel = seg.kind === "arc" ? "円弧" : "線分";
  const p1 = `(${formatMm(seg.p1[0])}, ${formatMm(seg.p1[1])})`;
  const p2 = `(${formatMm(seg.p2[0])}, ${formatMm(seg.p2[1])})`;
  return `セグメント${index + 1}(${kindLabel}): ${p1} → ${p2}`;
}

/**
 * 拘束一覧パネル(Phase 20b)。種類・対象・値の簡易表示+削除ボタン。値なし拘束(coincident/
 * horizontal/vertical/fix)も表示・削除できる。削除後の再ソルブ・再評価はstore.tsのupdateDocument
 * 経由で自動的に行われる(削除は拘束を緩めるだけなので矛盾を新たに生むことはなく、巻き戻しは不要)。
 */
function ConstraintListPanel({ sketch }: { sketch: SketchFeature }) {
  const updateDocument = useCadStore((s) => s.updateDocument);
  const constraints = sketch.constraints ?? [];

  function handleRemove(constraintId: string) {
    updateDocument((doc) => setSketchConstraints(doc, sketch.id, removeConstraint(constraints, constraintId)));
  }

  return (
    <div
      style={{
        borderTop: "1px solid #444",
        paddingTop: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 13 }}>拘束一覧</h3>
      {constraints.length === 0 ? (
        <p style={{ fontSize: 11, opacity: 0.7, margin: 0 }} data-testid="constraint-list-empty">
          拘束はありません。線分ツールで自動付与されるか、寸法ツールで作成できます。
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {constraints.map((constraint, index) => (
            <div
              key={constraint.id}
              data-testid={`constraint-${index}`}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 6,
                fontSize: 11,
                border: "1px solid #333",
                borderRadius: 4,
                padding: "4px 6px",
              }}
            >
              <span>
                <strong>{CONSTRAINT_KIND_LABELS[constraint.kind]}</strong>{" "}
                <span style={{ opacity: 0.8 }}>{describeConstraint(sketch.segments, sketch.entities, constraint)}</span>
              </span>
              <button
                type="button"
                data-testid={`constraint-${index}-delete`}
                onClick={() => handleRemove(constraint.id)}
                title="削除"
                style={{ fontSize: 10 }}
              >
                削除
              </button>
            </div>
          ))}
        </div>
      )}
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
    updateDocument((doc) => {
      const withPoints = updateSketchEntity(doc, sketchId, entity.id, { points: nextPoints });
      // corners配列も頂点削除に合わせてインデックスを詰める(既存指定があれば維持する)。
      if (!entity.corners) return withPoints;
      const nextCorners = entity.corners.filter((_, i) => i !== vertexIndex);
      return updateSketchEntity(withPoints, sketchId, entity.id, { corners: nextCorners });
    });
  }

  function handleCornerKindChange(vertexIndex: number, kind: "" | "fillet" | "chamfer") {
    const current = entity.corners?.[vertexIndex];
    const size = current?.size ?? 5;
    const next: PolygonCorner = kind === "" ? null : { kind, size };
    updateDocument((doc) => setPolygonVertexCorner(doc, sketchId, entity.id, vertexIndex, next));
  }

  function handleCornerSizeChange(vertexIndex: number, size: number) {
    const current = entity.corners?.[vertexIndex];
    if (!current) return;
    updateDocument((doc) =>
      setPolygonVertexCorner(doc, sketchId, entity.id, vertexIndex, { kind: current.kind, size }),
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {entity.points.map(([x, y], vertexIndex) => {
        const corner = entity.corners?.[vertexIndex] ?? null;
        return (
          <div
            key={vertexIndex}
            style={{ display: "flex", flexDirection: "column", gap: 4, border: "1px solid #333", borderRadius: 4, padding: 6 }}
          >
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 6, alignItems: "end" }}>
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
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, alignItems: "end" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
                コーナー
                <select
                  value={corner?.kind ?? ""}
                  data-testid={`entity-polygon-${entityIndex}-vertex-${vertexIndex}-corner-kind`}
                  onChange={(e) => handleCornerKindChange(vertexIndex, e.target.value as "" | "fillet" | "chamfer")}
                >
                  <option value="">なし</option>
                  <option value="fillet">フィレット</option>
                  <option value="chamfer">面取り</option>
                </select>
              </label>
              <NumberField
                label="サイズ (mm)"
                value={corner?.size ?? 5}
                testId={`entity-polygon-${entityIndex}-vertex-${vertexIndex}-corner-size`}
                disabled={!corner}
                onChange={(v) => handleCornerSizeChange(vertexIndex, v)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
