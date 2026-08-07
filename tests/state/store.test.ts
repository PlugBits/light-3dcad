// undo/redo後の選択維持ロジック(src/state/store.tsのresolveSelectionAfterHistory)、および
// 起動クラッシュループ防止(Phase 29a、src/state/store.tsのdecideAutosaveRestore)の単体テスト。
// store.ts本体はWorkerを起動するため(new Worker(...))、undo/redoアクション自体はここでは
// 呼び出さず、切り出した純粋関数のみを対象にする(tests/state/history.test.tsと同じ方針)。
import { describe, expect, it } from "vitest";

import { addSketchFeature, createEmptyDocument } from "../../src/model/document";
import { decideAutosaveRestore, resolveSelectionAfterHistory } from "../../src/state/store";

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

describe("decideAutosaveRestore(起動クラッシュループ防止、Phase 29a)", () => {
  it("マーカーが残っている(前回、復元中に落ちた)場合は自動保存を復元せず、スキップとして報告する", () => {
    const autosaved = createEmptyDocument();
    const decision = decideAutosaveRestore(true, autosaved);
    expect(decision.doc).toBeNull();
    expect(decision.skippedDueToPriorFailure).toBe(true);
  });

  it("マーカーが無ければ自動保存をそのまま復元対象として返す(スキップしない)", () => {
    const autosaved = createEmptyDocument();
    const decision = decideAutosaveRestore(false, autosaved);
    expect(decision.doc).toBe(autosaved);
    expect(decision.skippedDueToPriorFailure).toBe(false);
  });

  it("自動保存が無ければマーカーの有無に関わらず復元しない(スキップでもない、通常の初回起動)", () => {
    expect(decideAutosaveRestore(true, null)).toEqual({ doc: null, skippedDueToPriorFailure: false });
    expect(decideAutosaveRestore(false, null)).toEqual({ doc: null, skippedDueToPriorFailure: false });
  });
});
