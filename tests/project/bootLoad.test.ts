// src/project/bootLoad.ts の単体テスト(Phase 40c、共有リンク[Phase 40a]と
// モデルギャラリーで共通化した起動時ロードのオーケストレーション)。
import { describe, expect, it, vi } from "vitest";

import {
  addExtrudeFeature,
  addSketchFeature,
  createEmptyDocument,
  createRectangleEntity,
} from "../../src/model";
import { runBootLoad, shouldConfirmBootLoad } from "../../src/project/bootLoad";

function sampleDoc(width = 60) {
  const rect = createRectangleEntity({ width, height: 40 });
  const { doc: withSketch, feature: sketch } = addSketchFeature(createEmptyDocument(), {
    name: "Sketch1",
    plane: { kind: "world", plane: "XY" },
    entities: [rect],
  });
  const { doc } = addExtrudeFeature(withSketch, {
    name: "Extrude1",
    sketchId: sketch.id,
    distance: 20,
    direction: 1,
    operation: "newBody",
  });
  return doc;
}

describe("shouldConfirmBootLoad", () => {
  it("自動保存が無い場合は確認不要", () => {
    expect(shouldConfirmBootLoad(null, sampleDoc())).toBe(false);
  });

  it("自動保存と内容が同一の場合は確認不要", () => {
    const doc = sampleDoc();
    expect(shouldConfirmBootLoad(doc, doc)).toBe(false);
  });

  it("自動保存と内容が異なる場合は確認が必要", () => {
    expect(shouldConfirmBootLoad(sampleDoc(60), sampleDoc(70))).toBe(true);
  });
});

describe("runBootLoad", () => {
  it("resolve失敗時はonErrorを呼びonSuccess/confirmは呼ばれない", async () => {
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const confirm = vi.fn(() => true);
    await runBootLoad({
      resolve: async () => ({ ok: false, message: "壊れています" }),
      getAutosaved: () => null,
      confirm,
      confirmMessage: "確認?",
      onSuccess,
      onError,
    });
    expect(onError).toHaveBeenCalledWith("壊れています");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("自動保存が無ければ確認なしでonSuccessを呼ぶ", async () => {
    const doc = sampleDoc();
    const onSuccess = vi.fn();
    const confirm = vi.fn(() => true);
    await runBootLoad({
      resolve: async () => ({ ok: true, doc }),
      getAutosaved: () => null,
      confirm,
      confirmMessage: "確認?",
      onSuccess,
      onError: vi.fn(),
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledWith(doc);
  });

  it("自動保存と内容が異なりconfirmがtrueならonSuccessを呼ぶ", async () => {
    const doc = sampleDoc(70);
    const onSuccess = vi.fn();
    await runBootLoad({
      resolve: async () => ({ ok: true, doc }),
      getAutosaved: () => sampleDoc(60),
      confirm: () => true,
      confirmMessage: "確認?",
      onSuccess,
      onError: vi.fn(),
    });
    expect(onSuccess).toHaveBeenCalledWith(doc);
  });

  it("自動保存と内容が異なりconfirmがfalseならonCancelledを呼びonSuccessは呼ばれない", async () => {
    const doc = sampleDoc(70);
    const onSuccess = vi.fn();
    const onCancelled = vi.fn();
    await runBootLoad({
      resolve: async () => ({ ok: true, doc }),
      getAutosaved: () => sampleDoc(60),
      confirm: () => false,
      confirmMessage: "確認?",
      onSuccess,
      onError: vi.fn(),
      onCancelled,
    });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onCancelled).toHaveBeenCalled();
  });

  it("isCancelled()がtrueならonSuccess/onErrorのどちらも呼ばれない", async () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();
    await runBootLoad({
      resolve: async () => ({ ok: true, doc: sampleDoc() }),
      isCancelled: () => true,
      getAutosaved: () => null,
      confirm: () => true,
      confirmMessage: "確認?",
      onSuccess,
      onError,
    });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
