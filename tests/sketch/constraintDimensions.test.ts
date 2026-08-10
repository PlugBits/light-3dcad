// src/sketch/constraintDimensions.ts の単体テスト(純粋TS、WASM不要、Phase 20b)。
// 寸法ツール・拘束一覧パネル・寸法ラベル編集が使う拘束作成/更新ヘルパーの最小限の検証。
import { describe, expect, it } from "vitest";

import type { SketchEntity, SketchSegment } from "../../src/model/types";
import {
  addConcentricConstraint,
  addTangentArcLineConstraint,
  addTangentSegmentConstraint,
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

describe("addConcentricConstraint(Phase 42b: circleエンティティ・円弧セグメントの両対応)", () => {
  it("circleエンティティ同士(EntityRef)のconcentric拘束を追加する", () => {
    const result = addConcentricConstraint([], { entityId: "c1" }, { entityId: "c2" });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "concentric", a: { entityId: "c1" }, b: { entityId: "c2" } });
  });

  it("円弧セグメント(ArcRef)↔circleエンティティのconcentric拘束を追加する", () => {
    const result = addConcentricConstraint([], { segmentId: "arc1" }, { entityId: "c1" });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "concentric", a: { segmentId: "arc1" }, b: { entityId: "c1" } });
  });

  it("円弧セグメント同士(ArcRef)のconcentric拘束を追加する", () => {
    const result = addConcentricConstraint([], { segmentId: "arcA" }, { segmentId: "arcB" });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "concentric", a: { segmentId: "arcA" }, b: { segmentId: "arcB" } });
  });

  it("同じ組み合わせ(順不同)が既にあれば追加しない(冪等)", () => {
    const existing = addConcentricConstraint([], { segmentId: "arc1" }, { entityId: "c1" });
    const again = addConcentricConstraint(existing, { entityId: "c1" }, { segmentId: "arc1" });
    expect(again).toHaveLength(1);
  });

  it("EntityRefとArcRefが同じidを偶然共有していても別対象として扱う(entityId/segmentIdの型で判別)", () => {
    const existing = addConcentricConstraint([], { entityId: "x1" }, { entityId: "c1" });
    const again = addConcentricConstraint(existing, { segmentId: "x1" }, { entityId: "c1" });
    expect(again).toHaveLength(2);
  });
});

describe("addTangentArcLineConstraint(Phase 42b新設: 円弧↔直線のtangent拘束)", () => {
  it("円弧↔直線のtangent拘束を追加する", () => {
    const result = addTangentArcLineConstraint([], "arc1", "s1");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "tangent",
      entity: { segmentId: "arc1" },
      target: { kind: "segment", segmentId: "s1" },
    });
  });

  it("同じ組み合わせが既にあれば追加しない(冪等)", () => {
    const once = addTangentArcLineConstraint([], "arc1", "s1");
    const twice = addTangentArcLineConstraint(once, "arc1", "s1");
    expect(twice).toHaveLength(1);
  });

  it("circleエンティティのtangent拘束(EntityRef)とは別物として共存する(entityId/segmentIdが同じ値でも混同しない)", () => {
    const withCircleTangent = addTangentSegmentConstraint([], "x1", "s1");
    const result = addTangentArcLineConstraint(withCircleTangent, "x1", "s1");
    expect(result).toHaveLength(2);
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

  it("新規作成時のみsigned:trueを付ける(寸法値の符号仕様の明確化、Phase 33)。既存拘束の値だけ差し替える場合は既存のsignedをそのまま保つ", () => {
    const a = { segmentId: "s1", end: "p1" as const };
    const b = { segmentId: "s2", end: "p2" as const };
    const created = upsertDistanceConstraint([], a, b, 15, "x");
    expect(created[0]).toMatchObject({ signed: true });

    // 旧データ(signedフィールドが無い)を編集しても、signedは付与されない(後方互換: 絶対値のまま解釈させる)。
    const legacy = [{ id: "c-1", kind: "distance" as const, a, b, value: 5, axis: "x" as const }];
    const edited = upsertDistanceConstraint(legacy, a, b, 30, "x");
    expect(edited).toHaveLength(1);
    expect(edited[0].value).toBe(30);
    expect((edited[0] as { signed?: boolean }).signed).toBeUndefined();
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

describe("addTangentSegmentConstraint(接線拘束のside永続化、実機報告対応Phase 32)", () => {
  function circle(id: string, center: [number, number], radius: number): Extract<SketchEntity, { kind: "circle" }> {
    return { kind: "circle", id, center, radius };
  }

  it("円が直線の右側(x>0)にある場合と左側(x<0)にある場合とで、逆符号のsideが保存される", () => {
    const segLeft: SketchSegment = { id: "s1", kind: "line", p1: [0, -10], p2: [0, 10] }; // 垂直な直線(x=0)
    const circleOnRightSide = circle("c1", [10, 0], 3); // 直線の右側(+x)にある円
    const circleOnLeftSide = circle("c2", [-10, 0], 3); // 直線の左側(-x)にある円

    const right = addTangentSegmentConstraint([], "c1", "s1", [circleOnRightSide], [segLeft]);
    const left = addTangentSegmentConstraint([], "c2", "s1", [circleOnLeftSide], [segLeft]);

    expect(right).toHaveLength(1);
    expect(left).toHaveLength(1);
    const rightTarget = right[0].kind === "tangent" && right[0].target.kind === "segment" ? right[0].target : null;
    const leftTarget = left[0].kind === "tangent" && left[0].target.kind === "segment" ? left[0].target : null;
    expect(rightTarget?.side).toBeDefined();
    expect(leftTarget?.side).toBeDefined();
    expect(rightTarget?.side).toBe(-leftTarget?.side);
  });

  it("entities/segmentsを省略した場合はsideを省略して作成する(後方互換フォールバック)", () => {
    const result = addTangentSegmentConstraint([], "c1", "s1");
    expect(result).toHaveLength(1);
    const target = result[0].kind === "tangent" && result[0].target.kind === "segment" ? result[0].target : null;
    expect(target?.side).toBeUndefined();
  });

  it("同じ組み合わせが既にあれば何もしない(重複追加しない)", () => {
    const seg: SketchSegment = { id: "s1", kind: "line", p1: [0, -10], p2: [0, 10] };
    const c = circle("c1", [10, 0], 3);
    const once = addTangentSegmentConstraint([], "c1", "s1", [c], [seg]);
    const twice = addTangentSegmentConstraint(once, "c1", "s1", [c], [seg]);
    expect(twice).toHaveLength(1);
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
