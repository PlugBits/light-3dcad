// src/sketch/trim.ts の単体テスト(純粋TS、WASM不要、Phase 19b)。
import { describe, expect, it } from "vitest";

import { createArcSegment, createLineSegment } from "../../src/model";
import { trimSegmentAtPoint } from "../../src/sketch/trim";

describe("trimSegmentAtPoint", () => {
  it("2箇所で交差する線分の中間区間を削除すると両側の2区間が残る(セグメント分割)", () => {
    const target = createLineSegment({ p1: [0, 0], p2: [10, 0] });
    const crossA = createLineSegment({ p1: [3, -5], p2: [3, 5] });
    const crossB = createLineSegment({ p1: [7, -5], p2: [7, 5] });
    const result = trimSegmentAtPoint([target, crossA, crossB], target.id, [5, 0]);

    expect(result).toHaveLength(4); // crossA, crossB, 左区間, 右区間
    const lines = result.filter((s) => s.id !== crossA.id && s.id !== crossB.id);
    expect(lines).toHaveLength(2);
    const xs = lines.flatMap((s) => [s.p1[0], s.p2[0]]).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(0, 6);
    expect(xs[1]).toBeCloseTo(3, 6);
    expect(xs[2]).toBeCloseTo(7, 6);
    expect(xs[3]).toBeCloseTo(10, 6);
  });

  it("1箇所で交差する線分の端点側区間をクリックすると、その区間が短縮される", () => {
    const target = createLineSegment({ p1: [0, 0], p2: [10, 0] });
    const cross = createLineSegment({ p1: [3, -5], p2: [3, 5] });
    const result = trimSegmentAtPoint([target, cross], target.id, [1, 0]);

    expect(result).toHaveLength(2); // cross, 短縮された残り区間
    const kept = result.find((s) => s.id !== cross.id);
    expect(kept).toBeDefined();
    const xs = [kept!.p1[0], kept!.p2[0]].sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(3, 6);
    expect(xs[1]).toBeCloseTo(10, 6);
  });

  it("他セグメントと交点を持たないセグメントは全体が削除される", () => {
    const target = createLineSegment({ p1: [0, 0], p2: [10, 0] });
    const result = trimSegmentAtPoint([target], target.id, [5, 0]);
    expect(result).toHaveLength(0);
  });

  it("円弧セグメントも交点で区切ってトリムできる", () => {
    // 中心(0,0)半径5の上半円(p1=(-5,0) -> p2=(5,0)、bulge=-1で頂点(0,5)経由)。
    const target = createArcSegment({ p1: [-5, 0], p2: [5, 0], bulge: -1 });
    const cross = createLineSegment({ p1: [0, -1], p2: [0, 10] }); // x=0の縦線、弧の頂点(0,5)で交差
    const result = trimSegmentAtPoint([target, cross], target.id, [-3, 4]); // 左半分をクリック

    expect(result).toHaveLength(2); // cross, 右半分
    const kept = result.find((s) => s.id !== cross.id);
    expect(kept).toBeDefined();
    expect(kept!.kind).toBe("arc");
    // 残るのは頂点(0,5)から(5,0)までの右半分。
    const endpoints = [kept!.p1, kept!.p2].sort((a, b) => a[0] - b[0]);
    expect(endpoints[0][0]).toBeCloseTo(0, 5);
    expect(endpoints[0][1]).toBeCloseTo(5, 5);
    expect(endpoints[1][0]).toBeCloseTo(5, 5);
    expect(endpoints[1][1]).toBeCloseTo(0, 5);
  });

  it("T字交差(他方の端点がtargetの内部に接する)でもtargetを分割してトリムできる", () => {
    const target = createLineSegment({ p1: [0, 0], p2: [10, 0] });
    const stem = createLineSegment({ p1: [5, 0], p2: [5, 5] }); // targetの中点から生えるT字
    const result = trimSegmentAtPoint([target, stem], target.id, [2, 0]); // 左側をクリック

    expect(result).toHaveLength(2); // stem, 右側区間
    const kept = result.find((s) => s.id !== stem.id);
    expect(kept).toBeDefined();
    const xs = [kept!.p1[0], kept!.p2[0]].sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(5, 6);
    expect(xs[1]).toBeCloseTo(10, 6);
  });
});
