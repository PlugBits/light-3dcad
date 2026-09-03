// src/app/shortcuts.ts の単体テスト(純粋TS、DOM不要、Phase 49)。
import { describe, expect, it } from "vitest";

import { isEditableTarget, resolveShortcut, SKETCH_ONLY_ACTIONS, type KeyEventLike } from "../../src/app/shortcuts";

function key(overrides: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...overrides };
}

describe("isEditableTarget", () => {
  it("input/textarea/select要素、またはcontentEditableならtrue", () => {
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableTarget({ tagName: "SELECT" })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("それ以外(nullやdiv/button等)はfalse", () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
    expect(isEditableTarget({ tagName: "DIV" })).toBe(false);
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableTarget({ tagName: "CANVAS" })).toBe(false);
  });
});

describe("resolveShortcut", () => {
  it("Ctrl+Z / Cmd+Zはundo、Ctrl+Shift+Zはredo", () => {
    expect(resolveShortcut(key({ key: "z", ctrlKey: true }))).toBe("undo");
    expect(resolveShortcut(key({ key: "z", metaKey: true }))).toBe("undo");
    expect(resolveShortcut(key({ key: "z", ctrlKey: true, shiftKey: true }))).toBe("redo");
  });

  it("Ctrl+Yはredo", () => {
    expect(resolveShortcut(key({ key: "y", ctrlKey: true }))).toBe("redo");
  });

  it("Ctrl+Sはsave", () => {
    expect(resolveShortcut(key({ key: "s", ctrlKey: true }))).toBe("save");
    expect(resolveShortcut(key({ key: "S", metaKey: true }))).toBe("save");
  });

  it("Ctrl+ShiftのSやCtrl+他の文字キーは何にもマッチしない(ブラウザ標準に譲る)", () => {
    expect(resolveShortcut(key({ key: "s", ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(resolveShortcut(key({ key: "l", ctrlKey: true }))).toBeNull();
    expect(resolveShortcut(key({ key: "a", ctrlKey: true }))).toBeNull();
  });

  it("Delete/Backspaceはmeta状態を問わずdelete", () => {
    expect(resolveShortcut(key({ key: "Delete" }))).toBe("delete");
    expect(resolveShortcut(key({ key: "Backspace" }))).toBe("delete");
    expect(resolveShortcut(key({ key: "Backspace", metaKey: true }))).toBe("delete");
  });

  it("Fはfit、単キーのL/R/C/P/D/K/Tはスケッチツールにマッピングされる", () => {
    expect(resolveShortcut(key({ key: "f" }))).toBe("fit");
    expect(resolveShortcut(key({ key: "F" }))).toBe("fit");
    expect(resolveShortcut(key({ key: "l" }))).toBe("sketch-line");
    expect(resolveShortcut(key({ key: "r" }))).toBe("sketch-rect");
    expect(resolveShortcut(key({ key: "c" }))).toBe("sketch-circle");
    expect(resolveShortcut(key({ key: "p" }))).toBe("sketch-point");
    expect(resolveShortcut(key({ key: "d" }))).toBe("sketch-dimension");
    expect(resolveShortcut(key({ key: "k" }))).toBe("sketch-constraint");
    expect(resolveShortcut(key({ key: "t" }))).toBe("sketch-trim");
  });

  it("すべてのsketch-*アクションはSKETCH_ONLY_ACTIONSに含まれる", () => {
    for (const action of ["sketch-line", "sketch-rect", "sketch-circle", "sketch-point", "sketch-dimension", "sketch-constraint", "sketch-trim"] as const) {
      expect(SKETCH_ONLY_ACTIONS.has(action)).toBe(true);
    }
    expect(SKETCH_ONLY_ACTIONS.has("fit")).toBe(false);
  });

  it("?、またはShift+/でhelp", () => {
    expect(resolveShortcut(key({ key: "?" }))).toBe("help");
    expect(resolveShortcut(key({ key: "/", shiftKey: true }))).toBe("help");
  });

  it("Altキー併用は常にnull(OS標準ショートカットと衝突させない)", () => {
    expect(resolveShortcut(key({ key: "f", altKey: true }))).toBeNull();
    expect(resolveShortcut(key({ key: "z", ctrlKey: true, altKey: true }))).toBeNull();
  });

  it("マッピングの無いキーはnull", () => {
    expect(resolveShortcut(key({ key: "x" }))).toBeNull();
    expect(resolveShortcut(key({ key: "Enter" }))).toBeNull();
    expect(resolveShortcut(key({ key: "Escape" }))).toBeNull();
  });
});
