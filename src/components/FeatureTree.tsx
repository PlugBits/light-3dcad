// フィーチャーツリーパネル(SolidWorks風FeatureManager、Phase 38b)。doc.features を順序どおり
// 一覧表示し、選択/削除/インライン改名を行う。
// SolidWorks風ロールバックバー(Phase 25): 各フィーチャー行の間+末尾に常時クリック可能な
// 挿入スロットを表示し、クリックでバーをその位置へ移動する(ドラッグはサポートしない)。
// バー以降(index >= 有効フィーチャー数)のフィーチャーはグレーアウト表示にし、選択不可にする。
import { useEffect, useRef, useState } from "react";
import type { CadDocument, Feature, FeatureId, MateFeature } from "../model/types";
import { effectiveFeatureCount, mateHasSubsequentBodyEdit } from "../model/document";
import { ToolIcon, type ToolIconName } from "./ToolIcon";

/** フィーチャー種別ごとの行アイコン(ToolIconの共有SVGを再利用、Phase 38b)。 */
function iconFor(feature: Feature): ToolIconName {
  switch (feature.type) {
    case "sketch":
      return feature.plane.kind === "face" ? "faceSketch" : "sketchStart";
    case "extrude":
      return "extrude";
    case "revolve":
      return "revolve";
    case "fillet3d":
      return feature.kind === "fillet" ? "fillet3d" : "chamfer3d";
    case "shell":
      return "shell";
    case "thread":
      return "thread";
    case "partInstance":
      return "addPart";
    case "mate":
      return "mate";
    default:
      return "sketchStart";
  }
}

const TYPE_LABEL: Record<Feature["type"], string> = {
  sketch: "スケッチ",
  extrude: "押し出し",
  fillet3d: "フィレット/面取り",
  shell: "シェル",
  revolve: "回転体",
  thread: "ねじ",
  partInstance: "部品配置",
  mate: "合致",
};

const MATE_KIND_LABEL: Record<MateFeature["kind"], string> = {
  coincident: "一致",
  distance: "距離",
  concentric: "同軸",
};

/**
 * フィーチャーツリーに表示する種別ラベル。face参照スケッチは「面上スケッチ」、
 * fillet3dはkindに応じて「フィレット」/「面取り」と表示する(Phase 25a)。
 * threadはhandに応じて「ねじ(雄)」/「ねじ穴(雌・簡易表現)」と表示する(Phase 25c)。
 * mateはkindに応じて「合致(一致)」等と表示する(Phase 28c)。
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
  if (feature.type === "mate") {
    return `合致(${MATE_KIND_LABEL[feature.kind]})`;
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
  /** インライン改名(名前ダブルクリック→編集確定、Phase 38b)。 */
  onRename: (featureId: FeatureId, name: string) => void;
  /**
   * 行の右クリック(Phase 49、右クリックコンテキストメニュー)。isActiveはロールバックバー以前かどうか
   * (「編集(選択)」「名前を変更」の有効/無効判定にApp.tsx側で使う。「削除」は常に有効)。
   */
  onContextMenu?: (featureId: FeatureId, isActive: boolean, clientX: number, clientY: number) => void;
  /**
   * 右クリックメニューの「名前を変更」から既存のインライン改名(FeatureRow内部状態)を外部起動する
   * ためのリクエストID(Phase 49)。一致するfeature.idの行がこれを検知するとstartEdit()し、
   * onRenameRequestHandled()を呼んで消費済みにする。
   */
  renameRequestId?: FeatureId | null;
  onRenameRequestHandled?: () => void;
}

/**
 * ロールバックバーの挿入スロット。slotIndexは「このスロットにバーを置いたときの有効フィーチャー数」。
 * activeCountと一致する場合は実際のバー(グラブバー)として表示し、それ以外は薄い当たり判定のみの
 * バーとして、ホバー時に見えるプレビュー線を表示する。
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
      className="rollback-slot"
    >
      <div
        data-testid={isBarHere ? "rollback-bar" : undefined}
        className={`rollback-line${isBarHere ? " is-active" : ""}${hovered ? " is-hovered" : ""}`}
      >
        {isBarHere && <span className="rollback-grip" aria-hidden="true" />}
      </div>
    </div>
  );
}

/** フィーチャー行1件。インライン改名(ダブルクリック)・ホバー時のみ表示するアクション群を持つ。 */
function FeatureRow({
  feature,
  isActive,
  selected,
  hasError,
  showMateOrderWarning,
  onSelect,
  onDelete,
  onRename,
  onContextMenu,
  forceEdit,
  onForceEditHandled,
}: {
  feature: Feature;
  isActive: boolean;
  selected: boolean;
  hasError: boolean;
  showMateOrderWarning: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
  onContextMenu?: (clientX: number, clientY: number) => void;
  forceEdit?: boolean;
  onForceEditHandled?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(feature.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function startEdit() {
    if (!isActive) return;
    setDraft(feature.name);
    setEditing(true);
  }

  // 右クリックメニューの「名前を変更」からの外部起動(Phase 49)。startEdit()自体はisActiveでない
  // 場合は何もしない(App.tsx側のメニュー項目自体もisActive=falseなら無効化される)。
  useEffect(() => {
    if (forceEdit) {
      startEdit();
      onForceEditHandled?.();
    }
  }, [forceEdit]);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== feature.name) onRename(trimmed);
    setEditing(false);
  }

  function cancel() {
    setDraft(feature.name);
    setEditing(false);
  }

  const displayName = feature.type === "partInstance" ? `部品: ${feature.name}` : feature.name;

  return (
    <div
      data-testid={`feature-item-${feature.name}`}
      onClick={isActive ? onSelect : undefined}
      onContextMenu={(e) => {
        if (!onContextMenu) return;
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e.clientX, e.clientY);
      }}
      className={`feature-row${isActive ? "" : " is-suppressed"}${selected ? " is-selected" : ""}${hasError ? " has-error" : ""}`}
    >
      <span className="feature-row-icon" aria-hidden="true">
        <ToolIcon name={iconFor(feature)} size={15} />
      </span>
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          className="feature-row-rename-input"
          data-testid={`feature-rename-input-${feature.id}`}
          value={draft}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
        />
      ) : (
        <span className="feature-row-name" onDoubleClick={startEdit} title="ダブルクリックで名前を変更">
          {displayName}
          {feature.type !== "partInstance" && <span className="feature-row-type-label"> ({typeLabel(feature)})</span>}
        </span>
      )}
      {hasError && (
        <span className="feature-row-warning" title="評価エラーがあります" aria-hidden="true">
          ⚠
        </span>
      )}
      {!hasError && showMateOrderWarning && (
        <span
          data-testid={`mate-order-warning-${feature.name}`}
          className="feature-row-warning feature-row-warning-soft"
          title="この合致より後ろに押し出し/回転体のカット・追加があります。合致は全フィーチャー評価後にまとめて解決されるため、それらの操作は合致で解決される前の配置を基準に行われます。"
        >
          ⚠
        </span>
      )}
      <span className="feature-row-actions">
        <button
          type="button"
          title="削除"
          data-testid={`feature-delete-${feature.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="feature-row-action-btn"
        >
          ✕
        </button>
      </span>
    </div>
  );
}

export function FeatureTree({
  doc,
  selectedFeatureId,
  errorFeatureId,
  onSelect,
  onDelete,
  onSetRollback,
  onRename,
  onContextMenu,
  renameRequestId,
  onRenameRequestHandled,
}: FeatureTreeProps) {
  const total = doc.features.length;
  const activeCount = effectiveFeatureCount(doc);

  return (
    <div className="feature-tree">
      <div className="feature-tree-header" data-testid="feature-tree-header">
        <span className="feature-tree-header-icon" aria-hidden="true">
          <ToolIcon name="addPart" size={16} />
        </span>
        <span className="feature-tree-header-name">部品1</span>
      </div>
      {total === 0 ? (
        <p className="feature-tree-empty">フィーチャーがありません。</p>
      ) : (
        <ul className="feature-tree-list">
          {doc.features.map((feature, index) => {
            const selected = feature.id === selectedFeatureId;
            const hasError = feature.id === errorFeatureId;
            const isActive = index < activeCount;
            return (
              <li key={feature.id}>
                <RollbackSlot slotIndex={index} activeCount={activeCount} total={total} onSetRollback={onSetRollback} />
                <FeatureRow
                  feature={feature}
                  isActive={isActive}
                  selected={selected}
                  hasError={hasError}
                  showMateOrderWarning={feature.type === "mate" && mateHasSubsequentBodyEdit(doc, feature.id)}
                  onSelect={() => onSelect(feature.id)}
                  onDelete={() => onDelete(feature.id)}
                  onRename={(name) => onRename(feature.id, name)}
                  onContextMenu={onContextMenu ? (clientX, clientY) => onContextMenu(feature.id, isActive, clientX, clientY) : undefined}
                  forceEdit={renameRequestId === feature.id}
                  onForceEditHandled={onRenameRequestHandled}
                />
              </li>
            );
          })}
          <li>
            <RollbackSlot slotIndex={total} activeCount={activeCount} total={total} onSetRollback={onSetRollback} />
          </li>
        </ul>
      )}
    </div>
  );
}
