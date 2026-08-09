// Phase 38a: CommandManagerリボン用の共有アイコンコンポーネント。
// SolidWorks風の手描き線画(stroke)アイコンをnameで切り替える単一コンポーネント。
// アイコンライブラリへの依存を避け、すべてインラインSVGパスとして定義する(新規npm依存なし)。
// サイズは呼び出し側でwidth/heightを上書きできるが、既定はリボンボタン内の~22pxを想定。

import type { ReactElement } from "react";

export type ToolIconName =
  | "new"
  | "save"
  | "open"
  | "shareLink"
  | "addPart"
  | "aiGenerate"
  | "exportStl"
  | "exportStep"
  | "undo"
  | "redo"
  | "line"
  | "rect"
  | "circle"
  | "slot"
  | "polygon"
  | "arc"
  | "fillet"
  | "chamfer"
  | "trim"
  | "extend"
  | "dimension"
  | "constraint"
  | "sketchStart"
  | "sketchExit"
  | "faceSketch"
  | "extrude"
  | "revolve"
  | "fillet3d"
  | "chamfer3d"
  | "shell"
  | "thread"
  | "partDrag"
  | "mate"
  | "interference"
  | "fit"
  | "normalTo"
  | "viewFront"
  | "viewBack"
  | "viewLeft"
  | "viewRight"
  | "viewTop"
  | "viewBottom"
  | "viewIso";

/**
 * 各アイコンの中身(<svg>の子要素群)。viewBoxは統一して0 0 24 24。
 * strokeは呼び出し元のcurrentColorを継承する(親のcolorでボタン無効時のグレーアウト等に追従)。
 */
const PATHS: Record<ToolIconName, ReactElement> = {
  new: (
    <>
      <path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h6" />
    </>
  ),
  save: (
    <>
      <path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
      <path d="M8 4v6h7V4" />
      <path d="M8 14h8v6H8z" />
    </>
  ),
  open: (
    <>
      <path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v2H3Z" />
      <path d="M3 9l1.4 10.2a1 1 0 0 0 1 .8h13.2a1 1 0 0 0 1-.8L21 9" />
    </>
  ),
  // 共有リンク(Phase 40a): 3つの丸(ノード)を線で結ぶ、一般的な「共有」アイコンの意匠。
  shareLink: (
    <>
      <circle cx="6" cy="12" r="2.6" />
      <circle cx="18" cy="5.5" r="2.6" />
      <circle cx="18" cy="18.5" r="2.6" />
      <path d="M8.3 10.8 15.7 6.8M8.3 13.2l7.4 4" />
    </>
  ),
  addPart: (
    <>
      <path d="M12 3 4 7v10l8 4 8-4V7Z" />
      <path d="M4 7l8 4 8-4M12 11v10" />
      <path d="M17 2l1.4 1.4L20 2" transform="translate(0 0)" />
    </>
  ),
  aiGenerate: (
    <>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
      <path d="M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2" />
      <circle cx="12" cy="12" r="3.4" />
    </>
  ),
  exportStl: (
    <>
      <path d="M12 3l7 4v10l-7 4-7-4V7Z" />
      <path d="M12 3v18M5 7l7 4 7-4" />
    </>
  ),
  exportStep: (
    <>
      <path d="M4 5h16v14H4z" />
      <path d="M4 10h16M9 10v9" />
      <path d="M13 14h4M13 17h4" />
    </>
  ),
  undo: (
    <>
      <path d="M8 8H4V4" />
      <path d="M4 8c2.2-2.8 5.4-4.4 9-4a8 8 0 1 1-7.6 10.8" />
    </>
  ),
  redo: (
    <>
      <path d="M16 8h4V4" />
      <path d="M20 8c-2.2-2.8-5.4-4.4-9-4a8 8 0 1 0 7.6 10.8" />
    </>
  ),
  line: (
    <>
      <circle cx="5" cy="19" r="1.6" />
      <circle cx="19" cy="5" r="1.6" />
      <path d="M6.3 17.7 17.7 6.3" />
    </>
  ),
  rect: <rect x="4" y="6" width="16" height="12" rx="0.5" />,
  circle: <circle cx="12" cy="12" r="8" />,
  slot: (
    <>
      <path d="M8 6a6 6 0 1 0 0 12" />
      <path d="M16 6a6 6 0 1 1 0 12" />
      <path d="M8 6h8M8 18h8" />
    </>
  ),
  polygon: <path d="M12 3 20 9.3 17 19H7L4 9.3Z" />,
  arc: (
    <>
      <path d="M4 18a12 12 0 0 1 16-11.3" />
      <circle cx="4" cy="18" r="1.4" />
      <circle cx="20" cy="6.7" r="1.4" />
    </>
  ),
  fillet: (
    <>
      <path d="M4 20V10a6 6 0 0 1 6-6h10" />
      <path d="M4 20h6a0 0 0 0 0 0 0" />
    </>
  ),
  chamfer: <path d="M4 20V9l9-5h7" />,
  trim: (
    <>
      <path d="M4 5l16 14M20 5 4 19" />
      <circle cx="7" cy="17" r="1.6" />
      <circle cx="17" cy="7" r="1.6" />
    </>
  ),
  extend: (
    <>
      <path d="M3 12h11" />
      <path d="M11 7l5 5-5 5" />
      <path d="M18 7v10" strokeDasharray="2.5 2.5" />
    </>
  ),
  dimension: (
    <>
      <path d="M4 7v10M20 7v10" />
      <path d="M4 12h16" />
      <path d="M8 9l-4 3 4 3M16 9l4 3-4 3" />
    </>
  ),
  constraint: (
    <>
      <path d="M4 20 20 4" strokeDasharray="1 3.4" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="6" r="2" />
    </>
  ),
  sketchStart: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="0.5" strokeDasharray="2.6 2.2" />
      <path d="M9 15l2.2-6L15 9l-2.2 6z" />
    </>
  ),
  faceSketch: (
    <>
      <path d="M4 8 12 4l8 4-8 4-8-4Z" />
      <path d="M4 8v8l8 4 8-4V8" />
      <circle cx="12" cy="12" r="1.8" />
    </>
  ),
  // 「スケッチ終了」ボタン(ユーザー報告対応、Phase 38c)。丸に囲まれたチェックマーク(SolidWorks風の
  // 「スケッチ終了」アイコンを意識した、緑系の確定/完了を示す意匠)。
  sketchExit: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M7.5 12.5l3 3 6-6.5" />
    </>
  ),
  extrude: (
    <>
      <path d="M6 15 12 12l6 3-6 3z" />
      <path d="M6 15V9l6-3 6 3v6" />
      <path d="M12 12V3" />
      <path d="M9.5 5.5 12 3l2.5 2.5" />
    </>
  ),
  revolve: (
    <>
      <path d="M12 3v18" strokeDasharray="2 2" />
      <ellipse cx="12" cy="12" rx="7" ry="3" />
      <path d="M16.5 8.7A7 7 0 0 1 19 12" />
      <path d="M19 9.3v2.7h-2.7" />
    </>
  ),
  fillet3d: (
    <>
      <path d="M4 20V11a7 7 0 0 1 7-7h9" />
      <path d="M4 20h4" />
      <path d="M4 16v4" strokeDasharray="1.6 1.6" />
    </>
  ),
  chamfer3d: (
    <>
      <path d="M4 20V8l8-5h8" />
      <path d="M4 20h4" strokeDasharray="1.6 1.6" />
    </>
  ),
  shell: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="0.5" />
      <rect x="8" y="8" width="8" height="8" rx="0.3" strokeDasharray="1.8 1.8" />
    </>
  ),
  thread: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M6 9c1.5 1.4 3 1.4 4.5 0s3-1.4 4.5 0 3 1.4 4.5 0" />
      <path d="M6 15c1.5 1.4 3 1.4 4.5 0s3-1.4 4.5 0 3 1.4 4.5 0" />
    </>
  ),
  partDrag: (
    <>
      <path d="M5 8h5V3M8.5 5.5 3 11" />
      <rect x="10" y="10" width="10" height="10" rx="0.5" />
    </>
  ),
  mate: (
    <>
      <rect x="3" y="7" width="8" height="10" rx="0.5" />
      <rect x="13" y="7" width="8" height="10" rx="0.5" />
      <path d="M11 12h2" strokeDasharray="1.6 1.6" />
    </>
  ),
  interference: (
    <>
      <circle cx="9" cy="12" r="6.5" />
      <circle cx="15" cy="12" r="6.5" />
    </>
  ),
  fit: (
    <>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
      <rect x="8.5" y="8.5" width="7" height="7" rx="0.3" />
    </>
  ),
  normalTo: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="0.5" strokeDasharray="2.4 2" />
      <path d="M12 12 18 6" />
      <path d="M13.4 6H18v4.6" />
    </>
  ),
  viewFront: <rect x="5" y="5" width="14" height="14" rx="0.5" />,
  viewBack: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="0.5" strokeDasharray="2.4 2" />
      <path d="M9 9h6v6H9z" />
    </>
  ),
  viewLeft: (
    <>
      <path d="M8 4v16M8 4 4 8v8l4 4" />
      <path d="M8 4h11a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H8" strokeDasharray="2.2 2" />
    </>
  ),
  viewRight: (
    <>
      <path d="M16 4v16M16 4l4 4v8l-4 4" />
      <path d="M16 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h11" strokeDasharray="2.2 2" />
    </>
  ),
  viewTop: (
    <>
      <path d="M4 8h16M4 8l4-4h8l4 4" />
      <path d="M4 8v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8" strokeDasharray="2.2 2" />
    </>
  ),
  viewBottom: (
    <>
      <path d="M4 16h16M4 16l4 4h8l4-4" />
      <path d="M4 16V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v11" strokeDasharray="2.2 2" />
    </>
  ),
  viewIso: (
    <>
      <path d="M12 3 20 7.5v9L12 21 4 16.5v-9Z" />
      <path d="M12 3v9M12 12 4 7.5M12 12l8-4.5" />
    </>
  ),
};

export function ToolIcon({ name, size = 22 }: { name: ToolIconName; size?: number }) {
  return (
    <svg
      className="tool-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
