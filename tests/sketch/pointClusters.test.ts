// src/sketch/pointClusters.ts の単体テスト(頂点ベースの寸法指定、Phase 30)。
import { describe, expect, it } from "vitest";

import type { SketchConstraint, SketchSegment } from "../../src/model/types";
import { buildPointClusterRepMap, pointRefKey, resolvePointClusterRepresentative } from "../../src/sketch/pointClusters";

describe("buildPointClusterRepMap / resolvePointClusterRepresentative", () => {
  it("coincidentで結ばれた2端点は同じ代表点(segmentId昇順の先頭)に正規化される", () => {
    const segments: SketchSegment[] = [
      { id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] },
      { id: "s2", kind: "line", p1: [10, 0], p2: [20, 0] },
    ];
    const constraints: SketchConstraint[] = [
      { id: "c1", kind: "coincident", a: { segmentId: "s1", end: "p2" }, b: { segmentId: "s2", end: "p1" } },
    ];
    const map = buildPointClusterRepMap(segments, constraints);
    const repA = resolvePointClusterRepresentative({ segmentId: "s1", end: "p2" }, map);
    const repB = resolvePointClusterRepresentative({ segmentId: "s2", end: "p1" }, map);
    expect(repA).toEqual({ segmentId: "s1", end: "p2" });
    expect(repB).toEqual({ segmentId: "s1", end: "p2" });
  });

  it("3点以上のクラスタ(推移的なcoincident)も1つの代表点にまとまる", () => {
    const segments: SketchSegment[] = [
      { id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] },
      { id: "s2", kind: "line", p1: [10, 0], p2: [20, 0] },
      { id: "s3", kind: "line", p1: [10, 0], p2: [30, 30] },
    ];
    const constraints: SketchConstraint[] = [
      { id: "c1", kind: "coincident", a: { segmentId: "s1", end: "p2" }, b: { segmentId: "s2", end: "p1" } },
      { id: "c2", kind: "coincident", a: { segmentId: "s2", end: "p1" }, b: { segmentId: "s3", end: "p1" } },
    ];
    const map = buildPointClusterRepMap(segments, constraints);
    const reps = [
      resolvePointClusterRepresentative({ segmentId: "s1", end: "p2" }, map),
      resolvePointClusterRepresentative({ segmentId: "s2", end: "p1" }, map),
      resolvePointClusterRepresentative({ segmentId: "s3", end: "p1" }, map),
    ];
    for (const r of reps) expect(r).toEqual(reps[0]);
    expect(reps[0]).toEqual({ segmentId: "s1", end: "p2" });
  });

  it("coincidentで結ばれていない端点はクラスタに含まれず、自分自身が代表点になる", () => {
    const segments: SketchSegment[] = [{ id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] }];
    const map = buildPointClusterRepMap(segments, []);
    const ref = { segmentId: "s1", end: "p1" as const };
    expect(resolvePointClusterRepresentative(ref, map)).toEqual(ref);
    expect(map.has(pointRefKey(ref))).toBe(false);
  });

  it("coincident以外の拘束(distance等)は無視され、クラスタに影響しない", () => {
    const segments: SketchSegment[] = [
      { id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] },
      { id: "s2", kind: "line", p1: [10, 0], p2: [20, 0] },
    ];
    const constraints: SketchConstraint[] = [
      { id: "d1", kind: "distance", a: { segmentId: "s1", end: "p2" }, b: { segmentId: "s2", end: "p1" }, value: 0 },
    ];
    const map = buildPointClusterRepMap(segments, constraints);
    expect(map.size).toBe(0);
  });
});
