// 寸法ツール(Phase 20b)がヒットした対象の値を入力する小さなポップアップ。
// 見た目・キー操作はsrc/components/DimensionOverlay.tsxのDimensionEditPopupを踏襲する
// (単一の数値フィールドのみを扱う点が異なるため、専用の軽量コンポーネントとして分離した)。
import { useEffect, useRef, useState } from "react";

export function DimensionToolPopup({
  titleLabel,
  initialValue,
  screen,
  hintLabel,
  onApply,
  onCancel,
}: {
  /** フィールドのラベル(例: "長さ (mm)" / "半径 (mm)" / "距離 (mm)")。 */
  titleLabel: string;
  initialValue: number;
  screen: { x: number; y: number };
  /**
   * タイトルの下に小さく表示する補足の一行(Phase 21b、位置寸法)。例:
   * 「距離指定へ: 原点/別の円/辺をクリック」「後にクリックした方(この円)が移動します」。
   * 未指定なら表示しない。
   */
  hintLabel?: string;
  onApply: (value: number) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue.toFixed(2));
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) {
      setError("正の数を入力してください");
      return;
    }
    onApply(num);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      // window.keydownリスナー(CadViewer)まで伝播させない(寸法ツール終了等の副作用を避ける)。
      e.stopPropagation();
      onCancel();
    }
  }

  return (
    <form
      data-testid="dimension-tool-popup"
      onSubmit={handleSubmit}
      onKeyDown={handleKeyDown}
      style={{
        position: "absolute",
        left: screen.x,
        top: screen.y,
        transform: "translate(-50%, 10px)",
        pointerEvents: "auto",
        background: "#2a2f3a",
        border: "1px solid #555",
        borderRadius: 6,
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontSize: 12,
        zIndex: 20,
        boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
        minWidth: 160,
      }}
    >
      {hintLabel && (
        <p data-testid="dimension-tool-popup-hint" style={{ margin: 0, fontSize: 10, color: "#9aa5b1" }}>
          {hintLabel}
        </p>
      )}
      <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {titleLabel}
        <input
          ref={inputRef}
          data-testid="dimension-tool-popup-value"
          type="number"
          step="any"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      {error && (
        <p data-testid="dimension-tool-popup-error" role="alert" style={{ margin: 0, fontSize: 10, color: "#ff6b6b" }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button type="button" onClick={onCancel} style={{ fontSize: 11 }}>
          キャンセル
        </button>
        <button type="submit" data-testid="dimension-tool-popup-apply" style={{ fontSize: 11 }}>
          適用
        </button>
      </div>
    </form>
  );
}
