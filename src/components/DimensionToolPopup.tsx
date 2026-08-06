// 寸法ツール(Phase 20b)がヒットした対象の値を入力する小さなポップアップ。
// 見た目・キー操作はsrc/components/DimensionOverlay.tsxのDimensionEditPopupを踏襲する
// (単一の数値フィールドのみを扱う点が異なるため、専用の軽量コンポーネントとして分離した)。
import { useEffect, useRef, useState } from "react";

export function DimensionToolPopup({
  titleLabel,
  initialValue,
  screen,
  hintLabel,
  axisOptions,
  initialAxis,
  quantityOptions,
  onDelete,
  onApply,
  onCancel,
}: {
  /** フィールドのラベル(例: "長さ (mm)" / "半径 (mm)" / "距離 (mm)")。quantityOptions指定時は選択中の量に応じて上書きする。 */
  titleLabel: string;
  initialValue: number;
  screen: { x: number; y: number };
  /**
   * タイトルの下に小さく表示する補足の一行(Phase 21b、位置寸法)。例:
   * 「距離指定へ: 原点/別の円/辺をクリック」「後にクリックした方(この円)が移動します」。
   * 未指定なら表示しない。
   */
  hintLabel?: string;
  /** 円↔円の距離のときだけtrue: 「距離/X距離/Y距離」の3択を表示する(UI改善対応)。 */
  axisOptions?: boolean;
  /** axisOptions表示時の初期選択(既存拘束の編集時、未指定は"direct")。 */
  initialAxis?: "direct" | "x" | "y";
  /**
   * 線分↔線分・線分↔参照エッジの寸法のときだけ設定: 「距離/角度」の2択(ラジオ)を表示する
   * (Phase 24項目3、UI改善)。切り替えるとtitleLabel/入力値がdistanceValue/angleValueに差し替わる。
   */
  quantityOptions?: { distanceValue: number; angleValue: number; initial: "distance" | "angle" };
  /**
   * 指定時のみ「削除」ボタンを表示する(拘束由来の寸法ラベル編集時、ユーザー報告対応)。
   * 該当拘束を削除してポップアップを閉じる想定(既存の拘束一覧の削除と同じ処理)。
   * 寸法ツールでの新規作成時(App.tsx側の使用)は未指定で、削除ボタンは出ない。
   */
  onDelete?: () => void;
  onApply: (value: number, axis?: "direct" | "x" | "y", quantity?: "distance" | "angle") => void;
  onCancel: () => void;
}) {
  const [quantity, setQuantity] = useState<"distance" | "angle">(quantityOptions?.initial ?? "distance");
  const [value, setValue] = useState(initialValue.toFixed(2));
  const [axis, setAxis] = useState<"direct" | "x" | "y">(initialAxis ?? "direct");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function handleQuantityChange(next: "distance" | "angle") {
    setQuantity(next);
    if (quantityOptions) {
      setValue((next === "distance" ? quantityOptions.distanceValue : quantityOptions.angleValue).toFixed(2));
    }
  }

  const effectiveTitleLabel = quantityOptions ? (quantity === "distance" ? "距離 (mm)" : "角度 (°)") : titleLabel;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) {
      setError("正の数を入力してください");
      return;
    }
    onApply(num, axisOptions ? axis : undefined, quantityOptions ? quantity : undefined);
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
      {axisOptions && (
        <div data-testid="dimension-tool-popup-axis" style={{ display: "flex", gap: 8, fontSize: 11 }}>
          {(["direct", "x", "y"] as const).map((a) => (
            <label key={a} style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <input
                type="radio"
                name="dimension-tool-axis"
                data-testid={`dimension-tool-popup-axis-${a}`}
                checked={axis === a}
                onChange={() => setAxis(a)}
              />
              {a === "direct" ? "距離" : a === "x" ? "X距離" : "Y距離"}
            </label>
          ))}
        </div>
      )}
      {quantityOptions && (
        <div data-testid="dimension-tool-popup-quantity" style={{ display: "flex", gap: 8, fontSize: 11 }}>
          {(["distance", "angle"] as const).map((q) => (
            <label key={q} style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <input
                type="radio"
                name="dimension-tool-quantity"
                data-testid={`dimension-tool-popup-quantity-${q}`}
                checked={quantity === q}
                onChange={() => handleQuantityChange(q)}
              />
              {q === "distance" ? "距離" : "角度"}
            </label>
          ))}
        </div>
      )}
      <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {effectiveTitleLabel}
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
      <div style={{ display: "flex", gap: 6, justifyContent: "space-between", alignItems: "center" }}>
        {onDelete ? (
          <button
            type="button"
            data-testid="dimension-tool-popup-delete"
            title="この拘束を削除します"
            onClick={onDelete}
            style={{ fontSize: 11, color: "#ff6b6b" }}
          >
            削除
          </button>
        ) : (
          <span />
        )}
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" onClick={onCancel} style={{ fontSize: 11 }}>
            キャンセル
          </button>
          <button type="submit" data-testid="dimension-tool-popup-apply" style={{ fontSize: 11 }}>
            適用
          </button>
        </div>
      </div>
    </form>
  );
}
