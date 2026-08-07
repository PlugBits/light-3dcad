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
  allowZero,
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
   * 0を許容する距離系の値かどうか(寸法値の符号仕様の明確化、Phase 33。省略=false=従来通り正の数のみ)。
   * axisOptions指定時、axisが"x"/"y"のときは(このフラグに関わらず)符号付きとして負の値も許容する
   * (1点目→2点目の向きが符号の基準、0=軸整列)。axisが"direct"、またはaxisOptions非指定のときは
   * このフラグがtrueなら0以上、falseなら正の数のみを許容する(負は常に不可)。
   * quantityOptions指定時は"距離"選択中のみこのフラグの意味で扱い、"角度"選択中は常に正の数のみ
   * (角度に0許容は含まない)。
   */
  allowZero?: boolean;
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

  // X/Y距離は符号付き(1点目→2点目の向きが基準、0=軸整列、寸法値の符号仕様の明確化、Phase 33)。
  const axisIsSigned = axisOptions === true && axis !== "direct";
  // 0を許容するかどうか。quantityOptions("距離"/"角度"の切替)がある場合は"角度"選択中は対象外
  // (角度に0許容は含まない、従来通り正の数のみ)。
  const effectiveAllowZero = quantityOptions ? quantity === "distance" && allowZero === true : allowZero === true;
  const valueHint = axisIsSigned
    ? "符号は1点目→2点目の向き(0=整列)"
    : effectiveAllowZero
      ? "0以上(方向は現在の配置を維持)"
      : undefined;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const num = Number(value);
    const valid = axisIsSigned ? Number.isFinite(num) : Number.isFinite(num) && (effectiveAllowZero ? num >= 0 : num > 0);
    if (!valid) {
      setError(axisIsSigned ? "数値を入力してください" : effectiveAllowZero ? "0以上の数を入力してください" : "正の数を入力してください");
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
      {valueHint && (
        <p data-testid="dimension-tool-popup-value-hint" style={{ margin: 0, fontSize: 10, color: "#9aa5b1" }}>
          {valueHint}
        </p>
      )}
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
