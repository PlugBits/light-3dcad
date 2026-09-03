// キーボードショートカット(Phase 49)の純粋なキー→アクション対応表。
// App.tsx側のwindow keydownリスナーはこのモジュールの関数だけを使って
// 「このキー入力が何のアクションか(resolveShortcut)」「今テキスト入力欄にフォーカスがあるため
// 無視すべきか(isEditableTarget)」を判定し、実際の副作用(store操作・ビューア操作)は一切持たない。
// three.js/DOM/Reactに依存しないため、Vitestで直接テストできる。

export type ShortcutAction =
  | "undo"
  | "redo"
  | "delete"
  | "fit"
  | "save"
  | "help"
  | "sketch-line"
  | "sketch-rect"
  | "sketch-circle"
  | "sketch-point"
  | "sketch-dimension"
  | "sketch-constraint"
  | "sketch-trim";

/** KeyboardEventのうち判定に使うフィールドだけを抜き出した最小限の型(テストではDOM不要でリテラルを渡せる)。 */
export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** イベントターゲットのうち判定に使うフィールドだけを抜き出した最小限の型。 */
export interface EventTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
}

/**
 * フォーカスがテキスト入力系要素にあるかどうか。trueの間はショートカットを一切発動しない
 * (ブラウザ標準の編集操作・IME入力を妨げないため)。
 */
export function isEditableTarget(target: EventTargetLike | null | undefined): boolean {
  if (!target) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!target.isContentEditable;
}

/**
 * キーイベントに対応するショートカットアクションを返す(対応するものが無ければnull)。
 * isEditableTarget()のチェックは呼び出し側の責務(このモジュールはイベントターゲットを見ない)。
 *
 * 方針:
 * - altKey併用は一切扱わない(OS/ブラウザ独自のショートカットと衝突しうるため早期return)。
 * - Ctrl/Cmd(meta)併用は undo/redo/save のみを認識し、それ以外のCtrl/Cmd+文字は無視する
 *   (例: Ctrl+Lをsketch-lineとして誤爆させない)。
 * - Delete/Backspaceはmeta状態を問わず常にdeleteとして扱う(Mac変換キーボード事情に合わせる)。
 * - 単キーのアルファベットショートカット(スケッチツール用)はmeta/altが立っていない場合のみ有効。
 */
export function resolveShortcut(event: KeyEventLike): ShortcutAction | null {
  if (event.altKey) return null;

  const meta = event.ctrlKey || event.metaKey;
  const key = event.key;

  if (key === "Delete" || key === "Backspace") return "delete";

  if (meta) {
    const lower = key.toLowerCase();
    if (lower === "z") return event.shiftKey ? "redo" : "undo";
    if (lower === "y" && !event.shiftKey) return "redo";
    if (lower === "s" && !event.shiftKey) return "save";
    return null; // 他のCtrl/Cmd併用ショートカットはブラウザ標準に譲る。
  }

  if (key === "?" || (event.shiftKey && key === "/")) return "help";

  switch (key.toLowerCase()) {
    case "f":
      return "fit";
    case "l":
      return "sketch-line";
    case "r":
      return "sketch-rect";
    case "c":
      return "sketch-circle";
    case "p":
      return "sketch-point";
    case "d":
      return "sketch-dimension";
    case "k":
      return "sketch-constraint";
    case "t":
      return "sketch-trim";
    default:
      return null;
  }
}

/** スケッチ編集中のみ意味を持つアクションかどうか(呼び出し側が「対象スケッチ平面が未確定なら無視」を判断する材料)。 */
export const SKETCH_ONLY_ACTIONS: ReadonlySet<ShortcutAction> = new Set([
  "sketch-line",
  "sketch-rect",
  "sketch-circle",
  "sketch-point",
  "sketch-dimension",
  "sketch-constraint",
  "sketch-trim",
]);
