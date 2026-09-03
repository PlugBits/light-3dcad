// 右クリックコンテキストメニュー(Phase 49)。キャンバス(3D面/スケッチ要素/空クリック)と
// フィーチャーツリー行の両方から、同じ軽量な位置指定メニューとして使う。
// クリックアウェイ(メニュー外側のmousedown)またはEscapeで閉じる。項目クリックは実行後に閉じる。
import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/** メニューが画面外へはみ出さないよう、想定サイズでクランプした表示位置を返す。 */
function clampPosition(x: number, y: number, itemCount: number): { left: number; top: number } {
  const MENU_WIDTH = 200;
  const ITEM_HEIGHT = 30;
  const MARGIN = 8;
  const width = typeof window !== "undefined" ? window.innerWidth : MENU_WIDTH + MARGIN * 2;
  const height = typeof window !== "undefined" ? window.innerHeight : itemCount * ITEM_HEIGHT + MARGIN * 2;
  const left = Math.min(x, Math.max(MARGIN, width - MENU_WIDTH - MARGIN));
  const top = Math.min(y, Math.max(MARGIN, height - itemCount * ITEM_HEIGHT - MARGIN));
  return { left, top };
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    // capture段階で登録することで、対象の右クリック自体(メニューを開いたcontextmenuイベント)の
    // 直後に発生しうる別要素へのmousedownでも確実に検知する。
    window.addEventListener("mousedown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const { left, top } = clampPosition(x, y, items.length);

  return (
    <div ref={ref} data-testid="context-menu" role="menu" className="context-menu" style={{ left, top }}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          data-testid={`context-menu-item-${item.key}`}
          className="context-menu-item"
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.onSelect();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
