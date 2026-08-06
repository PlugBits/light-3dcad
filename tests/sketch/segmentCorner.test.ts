// src/sketch/segmentCorner.ts の単体テスト(純粋TS、WASM不要、Phase 24: 自由な線分同士の角への
// フィレット/面取り)。
import { describe, expect, it } from "vitest";

import { createLineSegment } from "../../src/model";
import type { SketchSegment } from "../../src/model/types";
import { arcGeometryFromBulge } from "../../src/sketch/bulge";
import { applySegmentCorner, findSharedEndpoint } from "../../src/sketch/segmentCorner";

describe("findSharedEndpoint", () => {
  it("端点が一致する2本の線分の共有端点を検出する", () => {
    const a = createLineSegment({ p1: [0, 0], p2: [10, 0] });
    const b = createLineSegment({ p1: [0, 0], p2: [0, 10] });
    const shared = findSharedEndpoint(a, b);
    expect(shared).not.toBeNull();
    expect(shared!.aEnd).toBe("p1");
    expect(shared!.bEnd).toBe("p1");
    expect(shared!.point).toEqual([0, 0]);
  });

  it("端点が一致しない場合はnull", () => {
    const a = createLineSegment({ p1: [0, 0], p2: [10, 0] });
    const b = createLineSegment({ p1: [5, 5], p2: [5, 10] });
    expect(findSharedEndpoint(a, b)).toBeNull();
  });
});

describe("applySegmentCorner", () => {
  it("直角(90度)のフィレット: 接点はL=r(tan45=1)の位置、円弧半径はrに一致する", () => {
    const a = createLineSegment({ p1: [0, 0], p2: [10, 0] }); // shared=p1
    const b = createLineSegment({ p1: [0, 0], p2: [0, 10] }); // shared=p1
    const r = 2;
    const result = applySegmentCorner(a, b, "fillet", r);
    expect(result).not.toBeNull();
    const { a: nextA, b: nextB, corner } = result!;

    // 共有端点側(p1)が接点まで短縮される。90度なのでL = r/tan(45°) = r。
    expect(nextA.p1[0]).toBeCloseTo(2, 6);
    expect(nextA.p1[1]).toBeCloseTo(0, 6);
    expect(nextA.p2).toEqual([10, 0]); // 遠端は変わらない
    expect(nextB.p1[0]).toBeCloseTo(0, 6);
    expect(nextB.p1[1]).toBeCloseTo(2, 6);
    expect(nextB.p2).toEqual([0, 10]);

    expect(corner.kind).toBe("arc");
    expect(corner.p1[0]).toBeCloseTo(2, 6);
    expect(corner.p1[1]).toBeCloseTo(0, 6);
    expect(corner.p2[0]).toBeCloseTo(0, 6);
    expect(corner.p2[1]).toBeCloseTo(2, 6);

    // 円弧の半径がフィレットサイズrに一致し、中心角(π-φ=π-π/2=π/2)が90度になっている。
    const geometry = arcGeometryFromBulge(corner.p1, corner.p2, corner.bulge!);
    expect(geometry).not.toBeNull();
    expect(geometry!.radius).toBeCloseTo(r, 6);
    expect(Math.abs(geometry!.sweep)).toBeCloseTo(Math.PI / 2, 6);
  });

  it("鋭角(60度)のフィレット: 接点距離L=r/tan(30°)、円弧半径がrに一致する", () => {
    const a = createLineSegment({ p1: [0, 0], p2: [10, 0] }); // shared=p1, dirA=(1,0)
    const angle = Math.PI / 3; // 60度
    const b = createLineSegment({ p1: [0, 0], p2: [10 * Math.cos(angle), 10 * Math.sin(angle)] });
    const r = 1;
    const result = applySegmentCorner(a, b, "fillet", r);
    expect(result).not.toBeNull();
    const { a: nextA, b: nextB, corner } = result!;

    const expectedL = r / Math.tan(angle / 2);
    const distA = Math.hypot(nextA.p1[0] - 0, nextA.p1[1] - 0);
    const distB = Math.hypot(nextB.p1[0] - 0, nextB.p1[1] - 0);
    expect(distA).toBeCloseTo(expectedL, 6);
    expect(distB).toBeCloseTo(expectedL, 6);

    const geometry = arcGeometryFromBulge(corner.p1, corner.p2, corner.bulge!);
    expect(geometry).not.toBeNull();
    expect(geometry!.radius).toBeCloseTo(r, 6);
    // 中心角はπ-φ = π - 60° = 120°。
    expect(Math.abs(geometry!.sweep)).toBeCloseTo(Math.PI - angle, 6);
  });

  it("鈍角(120度)のフィレット: 接点距離L=r/tan(60°)、円弧半径がrに一致する", () => {
    const a = createLineSegment({ p1: [0, 0], p2: [10, 0] });
    const angle = (2 * Math.PI) / 3; // 120度
    const b = createLineSegment({ p1: [0, 0], p2: [10 * Math.cos(angle), 10 * Math.sin(angle)] });
    const r = 1.5;
    const result = applySegmentCorner(a, b, "fillet", r);
    expect(result).not.toBeNull();
    const { corner } = result!;

    const geometry = arcGeometryFromBulge(corner.p1, corner.p2, corner.bulge!);
    expect(geometry).not.toBeNull();
    expect(geometry!.radius).toBeCloseTo(r, 6);
    expect(Math.abs(geometry!.sweep)).toBeCloseTo(Math.PI - angle, 6);
  });

  it("面取り(chamfer)は接続セグメントが直線になり、接点距離はフィレットと同じL=size/tan(φ/2)", () => {
    const a = createLineSegment({ p1: [0, 0], p2: [10, 0] });
    const b = createLineSegment({ p1: [0, 0], p2: [0, 10] }); // 90度
    const size = 2;
    const result = applySegmentCorner(a, b, "chamfer", size);
    expect(result).not.toBeNull();
    const { a: nextA, b: nextB, corner } = result!;

    expect(corner.kind).toBe("line");
    expect(corner.bulge ?? 0).toBe(0);
    // 90度なのでL = size/tan(45°) = size。
    expect(nextA.p1[0]).toBeCloseTo(size, 6);
    expect(nextB.p1[1]).toBeCloseTo(size, 6);
    expect(corner.p1[0]).toBeCloseTo(size, 6);
    expect(corner.p2[1]).toBeCloseTo(size, 6);
  });

  it("サイズが大きすぎて線分内に収まらない場合はnullを返す", () => {
    const a = createLineSegment({ p1: [0, 0], p2: [1, 0] }); // 長さ1
    const b = createLineSegment({ p1: [0, 0], p2: [0, 10] });
    const result = applySegmentCorner(a, b, "fillet", 5); // L=5 > lenA=1
    expect(result).toBeNull();
  });

  it("円弧セグメントが絡む角はv1対象外でnullを返す", () => {
    const a = createLineSegment({ p1: [0, 0], p2: [10, 0] });
    const arc: SketchSegment = { id: "arc-1", kind: "arc", p1: [0, 0], p2: [0, 10], bulge: 0.5 };
    const result = applySegmentCorner(a, arc, "fillet", 1);
    expect(result).toBeNull();
  });
});
