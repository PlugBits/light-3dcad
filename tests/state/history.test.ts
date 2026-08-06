// Phase 14: 簡易アンドゥ/リドゥ履歴(src/state/history.ts)の単体テスト。
import { describe, expect, it } from "vitest";

import { createHistoryState, HISTORY_LIMIT, pushHistory, redoHistory, undoHistory } from "../../src/state/history";

describe("pushHistory", () => {
  it("空の履歴にpushするとpastに1件積まれ、futureは空のまま", () => {
    const state = pushHistory(createHistoryState<number>(), 1);
    expect(state.past).toEqual([1]);
    expect(state.future).toEqual([]);
  });

  it("push時にfutureがクリアされる(redoできなくなる)", () => {
    const afterUndo = undoHistory(pushHistory(createHistoryState<number>(), 1), 2);
    const state = pushHistory(afterUndo!.state, 99);
    expect(state.future).toEqual([]);
  });

  it("HISTORY_LIMIT件を超えるpushで最古のエントリが捨てられる", () => {
    let state = createHistoryState<number>();
    for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) {
      state = pushHistory(state, i);
    }
    expect(state.past.length).toBe(HISTORY_LIMIT);
    expect(state.past[0]).toBe(5);
    expect(state.past[state.past.length - 1]).toBe(HISTORY_LIMIT + 4);
  });
});

describe("undoHistory", () => {
  it("pastが空ならnullを返す", () => {
    expect(undoHistory(createHistoryState<number>(), 1)).toBeNull();
  });

  it("pastの末尾を返し、currentをfutureの先頭に積む", () => {
    const state = pushHistory(createHistoryState<number>(), 1);
    const result = undoHistory(state, 2);
    expect(result?.doc).toBe(1);
    expect(result?.state.past).toEqual([]);
    expect(result?.state.future).toEqual([2]);
  });
});

describe("redoHistory", () => {
  it("futureが空ならnullを返す", () => {
    expect(redoHistory(createHistoryState<number>(), 1)).toBeNull();
  });

  it("undo後にredoすると元の値に戻り、pastにcurrentが積まれる", () => {
    const afterPush = pushHistory(createHistoryState<number>(), 1);
    const afterUndo = undoHistory(afterPush, 2)!;
    const afterRedo = redoHistory(afterUndo.state, afterUndo.doc);
    expect(afterRedo?.doc).toBe(2);
    expect(afterRedo?.state.past).toEqual([1]);
    expect(afterRedo?.state.future).toEqual([]);
  });
});
