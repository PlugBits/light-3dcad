// src/sketch/extend.ts の単体テスト(純粋TS、WASM不要、Phase 31b)。
import { describe, expect, it } from "vitest";

import { createLineSegment, createRectangleEntity } from "../../src/model";
import { extendSegmentAtPoint } from "../../src/sketch/extend";

describe("extendSegmentAtPoint", () => {
  it("交差しない線分同士: 近い側の端点を相手の線まで延長する", () => {
    // targetはx軸上[0,0]-[8,0]。相手はx=10の縦線(交わらない)。p2([8,0])側をクリックして延長。
    const target = createLineSegment({ p1: [0, 0], p2: [8, 0] });
    const other = createLineSegment({ p1: [10, -5], p2: [10, 5] });
    const result = extendSegmentAtPoint([target, other], [], target.id, [8, 0]);

    expect(result).not.toBeNull();
    const updated = result!.find((s) => s.id === target.id)!;
    // p1は動かず、p2が(10,0)まで伸びる。
    expect(updated.p1[0]).toBeCloseTo(0, 6);
    expect(updated.p1[1]).toBeCloseTo(0, 6);
    expect(updated.p2[0]).toBeCloseTo(10, 6);
    expect(updated.p2[1]).toBeCloseTo(0, 6);
  });

  it("エンティティ輪郭(矩形)まで延長できる", () => {
    // targetはx軸上[0,0]-[3,0]。矩形(中心[10,0]、幅4高さ4)の左辺(x=8)まで延長する。
    const target = createLineSegment({ p1: [0, 0], p2: [3, 0] });
    const rect = createRectangleEntity({ center: [10, 0], width: 4, height: 4 });
    const result = extendSegmentAtPoint([target], [rect], target.id, [3, 0]);

    expect(result).not.toBeNull();
    const updated = result!.find((s) => s.id === target.id)!;
    expect(updated.p2[0]).toBeCloseTo(8, 6);
    expect(updated.p2[1]).toBeCloseTo(0, 6);
  });

  it("延長先に交点が無ければnullを返す(セグメントは変更しない)", () => {
    // 相手はtargetの延長線上にはない(平行でオフセットした別の直線)ので交わらない。
    const target = createLineSegment({ p1: [0, 0], p2: [8, 0] });
    const other = createLineSegment({ p1: [10, 5], p2: [20, 5] });
    const result = extendSegmentAtPoint([target, other], [], target.id, [8, 0]);
    expect(result).toBeNull();
  });

  it("クリック位置に近い側の端点が延長される(遠い側は動かない)", () => {
    // targetはx軸上[0,0]-[8,0]。両側に境界を用意し、p1側クリックとp2側クリックで挙動が変わることを確認する。
    const target = createLineSegment({ p1: [0, 0], p2: [8, 0] });
    const leftWall = createLineSegment({ p1: [-5, -5], p2: [-5, 5] });
    const rightWall = createLineSegment({ p1: [12, -5], p2: [12, 5] });

    // p1([0,0])に近い点をクリック -> p1側が-5まで伸び、p2は8のまま。
    const resultNearP1 = extendSegmentAtPoint([target, leftWall, rightWall], [], target.id, [0.5, 0]);
    expect(resultNearP1).not.toBeNull();
    const updatedNearP1 = resultNearP1!.find((s) => s.id === target.id)!;
    expect(updatedNearP1.p1[0]).toBeCloseTo(-5, 6);
    expect(updatedNearP1.p2[0]).toBeCloseTo(8, 6);

    // p2([8,0])に近い点をクリック -> p2側が12まで伸び、p1は0のまま。
    const resultNearP2 = extendSegmentAtPoint([target, leftWall, rightWall], [], target.id, [7.5, 0]);
    expect(resultNearP2).not.toBeNull();
    const updatedNearP2 = resultNearP2!.find((s) => s.id === target.id)!;
    expect(updatedNearP2.p1[0]).toBeCloseTo(0, 6);
    expect(updatedNearP2.p2[0]).toBeCloseTo(12, 6);
  });

  it("targetIdが見つからない場合はnullを返す", () => {
    const target = createLineSegment({ p1: [0, 0], p2: [8, 0] });
    const result = extendSegmentAtPoint([target], [], "not-found", [8, 0]);
    expect(result).toBeNull();
  });
});
