// ショートカット一覧オーバーレイ(Phase 49)。トップバー右端の「?」ボタン、またはShift+?で開く。
// Escapeまたは背景クリックで閉じる。マウス操作・キーボード操作を日本語でまとめて表示するだけの
// 静的パネルで、実際の操作ロジックは持たない。
import { useEffect } from "react";

export interface ShortcutHelpOverlayProps {
  onClose: () => void;
}

const MOUSE_ROWS: { action: string; keys: string }[] = [
  { action: "回転", keys: "左ドラッグ / 中ドラッグ" },
  { action: "パン", keys: "右ドラッグ / Shift+中ドラッグ" },
  { action: "ズーム(カーソル位置中心)", keys: "ホイール" },
  { action: "コンテキストメニュー", keys: "右クリック(ドラッグなし)" },
];

const KEYBOARD_ROWS: { action: string; keys: string }[] = [
  { action: "元に戻す", keys: "Ctrl+Z" },
  { action: "やり直す", keys: "Ctrl+Y / Ctrl+Shift+Z" },
  { action: "削除", keys: "Delete / Backspace" },
  { action: "フィット", keys: "F" },
  { action: "保存", keys: "Ctrl+S" },
  { action: "このヘルプを開く", keys: "? / Shift+?" },
];

const SKETCH_ROWS: { action: string; keys: string }[] = [
  { action: "線分", keys: "L" },
  { action: "矩形", keys: "R" },
  { action: "円", keys: "C" },
  { action: "点", keys: "P" },
  { action: "寸法", keys: "D" },
  { action: "拘束", keys: "K" },
  { action: "トリム", keys: "T" },
  { action: "ツール中断", keys: "Esc" },
];

function ShortcutRows({ rows }: { rows: { action: string; keys: string }[] }) {
  return (
    <div className="shortcut-help-rows">
      {rows.map((row) => (
        <div className="shortcut-help-row" key={row.action}>
          <span>{row.action}</span>
          <span className="shortcut-help-key">{row.keys}</span>
        </div>
      ))}
    </div>
  );
}

export function ShortcutHelpOverlay({ onClose }: ShortcutHelpOverlayProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      data-testid="shortcut-help-backdrop"
      className="shortcut-help-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div data-testid="shortcut-help-panel" className="shortcut-help-panel" role="dialog" aria-modal="true">
        <div className="shortcut-help-header">
          <h2>ショートカット一覧</h2>
          <button type="button" data-testid="btn-shortcut-help-close" onClick={onClose}>
            閉じる
          </button>
        </div>
        <div className="shortcut-help-section">
          <h3>マウス操作</h3>
          <ShortcutRows rows={MOUSE_ROWS} />
        </div>
        <div className="shortcut-help-section">
          <h3>共通キーボード操作</h3>
          <ShortcutRows rows={KEYBOARD_ROWS} />
        </div>
        <div className="shortcut-help-section">
          <h3>スケッチ編集中のみ</h3>
          <ShortcutRows rows={SKETCH_ROWS} />
        </div>
      </div>
    </div>
  );
}
