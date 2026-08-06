// src/sketch/constraintDimensions.ts の単体テスト(純粋TS、WASM不要、Phase 20b)。
// 寸法ツール・拘束一覧パネル・寸法ラベル編集が使う拘束作成/更新ヘルパーの最小限の検証。
import { describe, expect, it } from "vitest";

import type { SketchSegment } from "../../src/model/types";
import {
  computeConstraintDimensions,
  distanceBetweenRefs,
  segmentLength,
  segmentRadius,
  upsertDistanceConstraint,
  upsertDistanceEntityLineConstraint,
  upsertLengthConstraint,
  upsertRadiusConstraint,
} from "../../src/sketch/constraintDimensions";

describe("upsertLengthConstraint", () => {
  it("既存のlength拘束が無ければ新規作成する", () => {
    const result = upsertLengthConstraint([], "seg-1", 25);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "length", segmentId: "seg-1", value: 25 });
  });

  it("既存のlength拘束があれば値だけ差し替え、id・件数は変わらない", () => {
    const existing = [{ id: "c-1", kind: "length" as const, segmentId: "seg-1", value: 10 }];
    const result = upsertLengthConstraint(existing, "seg-1", 50);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: "c-1", kind: "length", segmentId: "seg-1", value: 50 });
  });
});

describe("upsertRadiusConstraint", () => {
  it("既存のradius拘束が無ければ新規作成する", () => {
    const result = upsertRadiusConstraint([], "arc-1", 12);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "radius", segmentId: "arc-1", value: 12 });
  });
});

describe("upsertDistanceConstraint", () => {
  it("a/bの順序が逆でも既存拘束とみなして値を差し替える", () => {
    const a = { segmentId: "s1", end: "p1" as const };
    const b = { segmentId: "s2", end: "p2" as const };
    const existing = [{ id: "c-1", kind: "distance" as const, a: b, b: a, value: 5 }];
    const result = upsertDistanceConstraint(existing, a, b, 30);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(30);
  });

  it("一致する既存拘束が無ければ新規作成する", () => {
    const a = { segmentId: "s1", end: "p1" as const };
    const b = { segmentId: "s2", end: "p2" as const };
    const result = upsertDistanceConstraint([], a, b, 15);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "distance", a, b, value: 15 });
  });
});

describe("upsertDistanceEntityLineConstraint(寸法ツールが実際に生成する形式、ユーザー報告対応)", () => {
  it("line.kind:'segmentEdge'(自由な線分)で新規作成できる(CadViewer.tsが円クリック済み+自由な線分クリックで生成する形式)", () => {
    const result = upsertDistanceEntityLineConstraint([], "circle-1", { kind: "segmentEdge", segmentId: "seg-1" }, 20);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "distanceEntityLine",
      entity: { entityId: "circle-1" },
      line: { kind: "segmentEdge", segmentId: "seg-1" },
      value: 20,
    });
  });

  it("同じentityId+同じsegmentIdのsegmentEdgeが既にあれば値だけ差し替える(id・件数は変わらない)", () => {
    const existing = [
      {
        id: "c-1",
        kind: "distanceEntityLine" as const,
        entity: { entityId: "circle-1" },
        line: { kind: "segmentEdge" as const, segmentId: "seg-1" },
        value: 20,
      },
    ];
    const result = upsertDistanceEntityLineConstraint(existing, "circle-1", { kind: "segmentEdge", segmentId: "seg-1" }, 30);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ ...existing[0], value: 30 });
  });

  it("同じentityIdでもsegmentIdが異なれば別拘束として追加する(sameLineRefがsegmentId不一致を区別する)", () => {
    const existing = [
      {
        id: "c-1",
        kind: "distanceEntityLine" as const,
        entity: { entityId: "circle-1" },
        line: { kind: "segmentEdge" as const, segmentId: "seg-1" },
        value: 20,
      },
    ];
    const result = upsertDistanceEntityLineConstraint(existing, "circle-1", { kind: "segmentEdge", segmentId: "seg-2" }, 30);
    expect(result).toHaveLength(2);
  });
});

describe("現在値の計算(segmentLength/segmentRadius/distanceBetweenRefs)", () => {
  it("segmentLengthはp1-p2間のユークリッド距離を返す", () => {
    const seg: SketchSegment = { id: "s1", kind: "line", p1: [0, 0], p2: [3, 4] };
    expect(segmentLength(seg)).toBeCloseTo(5, 9);
  });

  it("segmentRadiusは円弧セグメントの半径を返し、直線ではnullを返す", () => {
    const line: SketchSegment = { id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] };
    expect(segmentRadius(line)).toBeNull();
    // bulge=1は半円(p1-p2が直径10の半円、半径5)。
    const arc: SketchSegment = { id: "s2", kind: "arc", p1: [0, 0], p2: [10, 0], bulge: 1 };
    expect(segmentRadius(arc)).toBeCloseTo(5, 6);
  });

  it("distanceBetweenRefsは2つのPointRef間の距離を返し、参照先が無ければnullを返す", () => {
    const segments: SketchSegment[] = [
      { id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] },
      { id: "s2", kind: "line", p1: [0, 10], p2: [10, 10] },
    ];
    const dist = distanceBetweenRefs(segments, { segmentId: "s1", end: "p1" }, { segmentId: "s2", end: "p1" });
    expect(dist).toBeCloseTo(10, 9);
    expect(distanceBetweenRefs(segments, { segmentId: "missing", end: "p1" }, { segmentId: "s2", end: "p1" })).toBeNull();
  });
});

describe("computeConstraintDimensions", () => {
  it("length/radius/distance拘束からアンカー座標付きの寸法一覧を作る(参照先が無い拘束は無視)", () => {
    const segments: SketchSegment[] = [
      { id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] },
      { id: "s2", kind: "arc", p1: [20, 0], p2: [20, 10], bulge: 1 },
    ];
    const dims = computeConstraintDimensions(segments, [
      { id: "c1", kind: "length", segmentId: "s1", value: 10 },
      { id: "c2", kind: "radius", segmentId: "s2", value: 5 },
      { id: "c3", kind: "length", segmentId: "missing", value: 1 },
    ]);
    expect(dims).toHaveLength(2);
    expect(dims[0]).toMatchObject({ kind: "seg-length", constraintId: "c1", value: 10, anchor: [5, 0] });
    expect(dims[1].kind).toBe("seg-radius");
    expect(dims[1].value).toBe(5);
  });
});
