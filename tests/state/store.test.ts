// undo/redo後の選択維持ロジック(src/state/store.tsのresolveSelectionAfterHistory)の単体テスト。
// store.ts本体はWorkerを起動するため(new Worker(...))、undo/redoアクション自体はここでは
// 呼び出さず、切り出した純粋関数のみを対象にする(tests/state/history.test.tsと同じ方針)。
import { describe, expect, it } from "vitest";

import { addSketchFeature, createEmptyDocument } from "../../src/model/document";
import { resolveSelectionAfterHistory } from "../../src/state/store";

describe("resolveSelectionAfterHistory", () => {
  it("復元後のドキュメントに選択中フィーチャーがまだ存在する場合は選択を維持する", () => {
    const { doc, feature } = addSketchFeature(createEmptyDocument(), {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [],
    });
    expect(resolveSelectionAfterHistory(doc, feature.id)).toBe(feature.id);
  });

  it("復元後のドキュメントに選択中フィーチャーが存在しない場合はnullを返す(クリア)", () => {
    const doc = createEmptyDocument();
    expect(resolveSelectionAfterHistory(doc, "sketch-does-not-exist")).toBeNull();
  });

  it("選択が元々nullの場合はnullのまま", () => {
    const doc = createEmptyDocument();
    expect(resolveSelectionAfterHistory(doc, null)).toBeNull();
  });
});
