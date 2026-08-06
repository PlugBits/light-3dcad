import { describe, expect, it } from "vitest";

import {
  addExtrudeFeature,
  addSketchEntity,
  addSketchFeature,
  addSketchSegments,
  applySegmentCornerToSketch,
  createEmptyDocument,
  createCircleEntity,
  createLineSegment,
  createPolygonEntity,
  createRectangleEntity,
  findFeature,
  getDependentFeatureIds,
  getDirectDependentFeatureIds,
  isDocumentValid,
  patchExtrudeFeature,
  patchSketchFeature,
  removeFeature,
  removeFeatureCascade,
  removeSketchEntity,
  setPolygonVertexCorner,
  updateSketchEntity,
  validateDocument,
  validateFeature,
} from "../../src/model";
import type { CadDocument, ExtrudeFeature, SketchConstraint, SketchFeature, SketchSegment } from "../../src/model";

function makeRectSketchDoc(): { doc: CadDocument; sketch: SketchFeature } {
  const empty = createEmptyDocument();
  const rect = createRectangleEntity({ width: 60, height: 40 });
  const { doc, feature } = addSketchFeature(empty, {
    name: "Sketch1",
    plane: { kind: "world", plane: "XY" },
    entities: [rect],
  });
  return { doc, sketch: feature };
}

describe("createEmptyDocument", () => {
  it("versionが1でfeaturesが空の配列を返す", () => {
    const doc = createEmptyDocument();
    expect(doc).toEqual({ version: 1, features: [] });
  });
});

describe("addSketchFeature / addExtrudeFeature", () => {
  it("スケッチフィーチャーを追加してユニークIDを採番する", () => {
    const { doc, sketch } = makeRectSketchDoc();
    expect(doc.features).toHaveLength(1);
    expect(doc.features[0]).toBe(sketch);
    expect(sketch.id).toMatch(/^sketch-/);
    expect(sketch.entities[0].id).toMatch(/^entity-/);
  });

  it("2回追加すると異なるIDが振られる", () => {
    const empty = createEmptyDocument();
    const { doc: doc1, feature: f1 } = addSketchFeature(empty, {
      name: "A",
      plane: { kind: "world", plane: "XY" },
      entities: [],
    });
    const { feature: f2 } = addSketchFeature(doc1, {
      name: "B",
      plane: { kind: "world", plane: "XY" },
      entities: [],
    });
    expect(f1.id).not.toBe(f2.id);
  });

  it("押し出しフィーチャーを追加できる", () => {
    const { doc, sketch } = makeRectSketchDoc();
    const { doc: doc2, feature: extrude } = addExtrudeFeature(doc, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: 20,
      direction: 1,
      operation: "newBody",
    });
    expect(doc2.features).toHaveLength(2);
    expect(extrude.type).toBe("extrude");
    expect(extrude.sketchId).toBe(sketch.id);
  });

  it("addFeatureは元のdocを変更せず新しいdocを返す(非破壊)", () => {
    const empty = createEmptyDocument();
    const { doc } = addSketchFeature(empty, {
      name: "A",
      plane: { kind: "world", plane: "XY" },
      entities: [],
    });
    expect(empty.features).toHaveLength(0);
    expect(doc.features).toHaveLength(1);
  });
});

describe("findFeature / removeFeature", () => {
  it("IDでフィーチャーを検索できる", () => {
    const { doc, sketch } = makeRectSketchDoc();
    expect(findFeature(doc, sketch.id)).toBe(sketch);
    expect(findFeature(doc, "does-not-exist")).toBeUndefined();
  });

  it("フィーチャーを削除できる", () => {
    const { doc, sketch } = makeRectSketchDoc();
    const removed = removeFeature(doc, sketch.id);
    expect(removed.features).toHaveLength(0);
    // 非破壊
    expect(doc.features).toHaveLength(1);
  });

  it("存在しないIDの削除は何もせず同じ内容を返す", () => {
    const { doc } = makeRectSketchDoc();
    const result = removeFeature(doc, "nope");
    expect(result.features).toEqual(doc.features);
  });
});

describe("patchSketchFeature / updateSketchEntity", () => {
  it("スケッチ名を更新できる", () => {
    const { doc, sketch } = makeRectSketchDoc();
    const updated = patchSketchFeature(doc, sketch.id, { name: "Renamed" });
    const found = findFeature(updated, sketch.id) as SketchFeature;
    expect(found.name).toBe("Renamed");
    // 元のdocは変わらない
    expect((findFeature(doc, sketch.id) as SketchFeature).name).toBe("Sketch1");
  });

  it("矩形エンティティの寸法を更新できる", () => {
    const { doc, sketch } = makeRectSketchDoc();
    const entityId = sketch.entities[0].id;
    const updated = updateSketchEntity(doc, sketch.id, entityId, { width: 100 });
    const found = findFeature(updated, sketch.id) as SketchFeature;
    expect(found.entities[0]).toMatchObject({ width: 100, height: 40 });
  });

  it("存在しないentityIdを指定しても他のフィールドは変化しない", () => {
    const { doc, sketch } = makeRectSketchDoc();
    const updated = updateSketchEntity(doc, sketch.id, "nope", { width: 999 });
    const found = findFeature(updated, sketch.id) as SketchFeature;
    expect(found.entities[0]).toMatchObject({ width: 60, height: 40 });
  });
});

describe("setPolygonVertexCorner", () => {
  function makePolygonSketchDoc(): { doc: CadDocument; sketch: SketchFeature; entityId: string } {
    const empty = createEmptyDocument();
    const polygon = createPolygonEntity({
      points: [
        [0, 0],
        [40, 0],
        [40, 40],
        [0, 40],
      ],
    });
    const { doc, feature } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [polygon],
    });
    return { doc, sketch: feature, entityId: polygon.id };
  }

  it("corners未指定のpolygonに1頂点のfilletを設定できる(他はnullで埋まる)", () => {
    const { doc, sketch, entityId } = makePolygonSketchDoc();
    const updated = setPolygonVertexCorner(doc, sketch.id, entityId, 1, { kind: "fillet", size: 5 });
    const found = findFeature(updated, sketch.id) as SketchFeature;
    const polygon = found.entities[0];
    expect(polygon.kind).toBe("polygon");
    if (polygon.kind !== "polygon") return;
    expect(polygon.corners).toEqual([null, { kind: "fillet", size: 5 }, null, null]);
    // 非破壊(元のdocは変化しない)
    const originalPolygon = (findFeature(doc, sketch.id) as SketchFeature).entities[0];
    expect(originalPolygon.kind === "polygon" ? originalPolygon.corners : undefined).toBeUndefined();
  });

  it("既存のcornersがある場合は該当頂点のみ上書きする", () => {
    const { doc, sketch, entityId } = makePolygonSketchDoc();
    const withFirst = setPolygonVertexCorner(doc, sketch.id, entityId, 0, { kind: "chamfer", size: 3 });
    const withSecond = setPolygonVertexCorner(withFirst, sketch.id, entityId, 2, { kind: "fillet", size: 8 });
    const polygon = (findFeature(withSecond, sketch.id) as SketchFeature).entities[0];
    expect(polygon.kind === "polygon" ? polygon.corners : undefined).toEqual([
      { kind: "chamfer", size: 3 },
      null,
      { kind: "fillet", size: 8 },
      null,
    ]);
  });

  it("nullを指定するとコーナーを解除できる", () => {
    const { doc, sketch, entityId } = makePolygonSketchDoc();
    const withCorner = setPolygonVertexCorner(doc, sketch.id, entityId, 1, { kind: "fillet", size: 5 });
    const cleared = setPolygonVertexCorner(withCorner, sketch.id, entityId, 1, null);
    const polygon = (findFeature(cleared, sketch.id) as SketchFeature).entities[0];
    expect(polygon.kind === "polygon" ? polygon.corners : undefined).toEqual([null, null, null, null]);
  });

  it("範囲外のvertexIndexは無視される(ドキュメント不変)", () => {
    const { doc, sketch, entityId } = makePolygonSketchDoc();
    const updated = setPolygonVertexCorner(doc, sketch.id, entityId, 99, { kind: "fillet", size: 5 });
    const polygon = (findFeature(updated, sketch.id) as SketchFeature).entities[0];
    expect(polygon.kind === "polygon" ? polygon.corners : undefined).toBeUndefined();
  });
});

describe("addSketchEntity / removeSketchEntity", () => {
  it("エンティティを追加できる", () => {
    const { doc, sketch } = makeRectSketchDoc();
    const circle = createCircleEntity({ radius: 10 });
    const updated = addSketchEntity(doc, sketch.id, circle);
    const found = findFeature(updated, sketch.id) as SketchFeature;
    expect(found.entities).toHaveLength(2);
    expect(found.entities[1]).toBe(circle);
    // 非破壊
    expect((findFeature(doc, sketch.id) as SketchFeature).entities).toHaveLength(1);
  });

  it("エンティティを削除できる", () => {
    const { doc, sketch } = makeRectSketchDoc();
    const entityId = sketch.entities[0].id;
    const updated = removeSketchEntity(doc, sketch.id, entityId);
    const found = findFeature(updated, sketch.id) as SketchFeature;
    expect(found.entities).toHaveLength(0);
  });

  it("存在しないentityIdの削除は何もしない", () => {
    const { doc, sketch } = makeRectSketchDoc();
    const updated = removeSketchEntity(doc, sketch.id, "nope");
    const found = findFeature(updated, sketch.id) as SketchFeature;
    expect(found.entities).toHaveLength(1);
  });
});

describe("addSketchSegments(constraints引数、Phase 20a)", () => {
  it("constraintsを渡すと既存constraintsに追記される(segmentsも追加される)", () => {
    const { doc, sketch } = makeRectSketchDoc();
    const seg = createLineSegment({ p1: [0, 0], p2: [10, 0] });
    const constraint: SketchConstraint = { id: "c1", kind: "horizontal", segmentId: seg.id };
    const updated = addSketchSegments(doc, sketch.id, [seg], [constraint]);
    const found = findFeature(updated, sketch.id) as SketchFeature;
    expect(found.segments).toEqual([seg]);
    expect(found.constraints).toEqual([constraint]);
  });

  it("constraintsを省略すると既存のconstraintsフィールドは追加されない(後方互換)", () => {
    const { doc, sketch } = makeRectSketchDoc();
    const seg = createLineSegment({ p1: [0, 0], p2: [10, 0] });
    const updated = addSketchSegments(doc, sketch.id, [seg]);
    const found = findFeature(updated, sketch.id) as SketchFeature;
    expect(found.segments).toEqual([seg]);
    expect(found.constraints).toBeUndefined();
  });
});

describe("applySegmentCornerToSketch(フィレット/面取り、Phase 24バグ修正: 隣接コーナーの拘束付け替え)", () => {
  /** L字3本(A: (0,0)->(10,0), B: (10,0)->(10,10), C: (10,10)->(0,10))+自動拘束(コーナーA/B・B/Cのcoincident)。 */
  function makeChainSketchDoc(): { doc: CadDocument; sketch: SketchFeature; a: SketchSegment; b: SketchSegment; c: SketchSegment } {
    const empty = createEmptyDocument();
    const { doc: doc0, feature } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [],
    });
    const a = createLineSegment({ p1: [0, 0], p2: [10, 0] });
    const b = createLineSegment({ p1: [10, 0], p2: [10, 10] });
    const c = createLineSegment({ p1: [10, 10], p2: [0, 10] });
    const constraints: SketchConstraint[] = [
      { id: "c-ab", kind: "coincident", a: { segmentId: a.id, end: "p2" }, b: { segmentId: b.id, end: "p1" } },
      { id: "c-bc", kind: "coincident", a: { segmentId: b.id, end: "p2" }, b: { segmentId: c.id, end: "p1" } },
    ];
    const doc = addSketchSegments(doc0, feature.id, [a, b, c], constraints);
    return { doc, sketch: feature, a, b, c };
  }

  it("フィレット適用時に、共有端点を結んでいた旧coincidentを削除し、a-corner/corner-bの新coincidentに置き換える", () => {
    const { doc, sketch, a, b } = makeChainSketchDoc();
    const next = applySegmentCornerToSketch(doc, sketch.id, a.id, b.id, "fillet", 2);
    const found = findFeature(next, sketch.id) as SketchFeature;
    const constraints = found.constraints ?? [];
    // 旧: a.p2 <-> b.p1 のcoincidentは残っていない。
    const stale = constraints.find(
      (c) =>
        c.kind === "coincident" &&
        ((c.a.segmentId === a.id && c.a.end === "p2" && c.b.segmentId === b.id && c.b.end === "p1") ||
          (c.b.segmentId === a.id && c.b.end === "p2" && c.a.segmentId === b.id && c.a.end === "p1")),
    );
    expect(stale).toBeUndefined();
    // 新規に追加された円弧セグメント(corner)を特定する(a・b以外でsegments末尾に追加される)。
    const cornerId = (found.segments ?? []).find((s) => s.id !== a.id && s.id !== b.id && s.kind === "arc")?.id;
    expect(cornerId).toBeDefined();
    // 新: a接点 <-> corner.p1、corner.p2 <-> b接点 のcoincidentが追加されている。
    const hasAToCorner = constraints.some(
      (c) =>
        c.kind === "coincident" &&
        ((c.a.segmentId === a.id && c.a.end === "p2" && c.b.segmentId === cornerId && c.b.end === "p1") ||
          (c.b.segmentId === a.id && c.b.end === "p2" && c.a.segmentId === cornerId && c.a.end === "p1")),
    );
    const hasCornerToB = constraints.some(
      (c) =>
        c.kind === "coincident" &&
        ((c.a.segmentId === cornerId && c.a.end === "p2" && c.b.segmentId === b.id && c.b.end === "p1") ||
          (c.b.segmentId === cornerId && c.b.end === "p2" && c.a.segmentId === b.id && c.a.end === "p1")),
    );
    expect(hasAToCorner).toBe(true);
    expect(hasCornerToB).toBe(true);
    // b/cの拘束(今回のコーナーと無関係な端点)はそのまま残る。
    expect(constraints.some((c) => c.id === "c-bc")).toBe(true);
  });

  it("隣接する2つの角を連続でフィレットしても、各セグメントの端点が新しい接点と一致し続ける(破綻しない)", () => {
    const { doc, sketch, a, b, c } = makeChainSketchDoc();
    const afterFirst = applySegmentCornerToSketch(doc, sketch.id, a.id, b.id, "fillet", 2);
    const afterSecond = applySegmentCornerToSketch(afterFirst, sketch.id, b.id, c.id, "fillet", 2);
    const found = findFeature(afterSecond, sketch.id) as SketchFeature;
    const segments = found.segments ?? [];
    const constraints = found.constraints ?? [];

    const segA = segments.find((s) => s.id === a.id)!;
    const segB = segments.find((s) => s.id === b.id)!;
    const segC = segments.find((s) => s.id === c.id)!;
    expect(segA.kind).toBe("line");
    expect(segB.kind).toBe("line");
    expect(segC.kind).toBe("line");

    // bはp1(角1側)・p2(角2側)の両方が短縮されているはず(いずれも元の端点(10,0)/(10,10)ではない)。
    expect(segB.p1).not.toEqual([10, 0]);
    expect(segB.p2).not.toEqual([10, 10]);

    // すべてのcoincident拘束が指す端点座標が、実際に一致していること(=拘束と幾何が整合している)。
    const pointAt = (segId: string, end: "p1" | "p2"): [number, number] | null => {
      const seg = segments.find((s) => s.id === segId);
      return seg ? seg[end] : null;
    };
    for (const constraint of constraints) {
      if (constraint.kind !== "coincident") continue;
      const pa = pointAt(constraint.a.segmentId, constraint.a.end);
      const pb = pointAt(constraint.b.segmentId, constraint.b.end);
      expect(pa).not.toBeNull();
      expect(pb).not.toBeNull();
      expect(Math.hypot(pa![0] - pb![0], pa![1] - pb![1])).toBeLessThan(1e-9);
    }
  });
});

describe("getDirectDependentFeatureIds / getDependentFeatureIds / removeFeatureCascade", () => {
  function makeSketchExtrudeChainDoc(): { doc: CadDocument; sketch: SketchFeature; extrude: ExtrudeFeature } {
    const { doc, sketch } = makeRectSketchDoc();
    const { doc: doc2, feature: extrude } = addExtrudeFeature(doc, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: 20,
      direction: 1,
      operation: "newBody",
    });
    return { doc: doc2, sketch, extrude };
  }

  it("extrudeが参照するsketchの直接依存を検出する", () => {
    const { doc, sketch, extrude } = makeSketchExtrudeChainDoc();
    expect(getDirectDependentFeatureIds(doc, sketch.id)).toEqual([extrude.id]);
    expect(getDirectDependentFeatureIds(doc, extrude.id)).toEqual([]);
  });

  it("依存の無いフィーチャーは空配列を返す", () => {
    const { doc, extrude } = makeSketchExtrudeChainDoc();
    expect(getDependentFeatureIds(doc, extrude.id)).toEqual([]);
  });

  it("removeFeatureCascadeはsketchと、それに依存するextrudeをまとめて削除する", () => {
    const { doc, sketch, extrude } = makeSketchExtrudeChainDoc();
    const updated = removeFeatureCascade(doc, sketch.id);
    expect(findFeature(updated, sketch.id)).toBeUndefined();
    expect(findFeature(updated, extrude.id)).toBeUndefined();
    expect(updated.features).toHaveLength(0);
    // 非破壊
    expect(doc.features).toHaveLength(2);
  });

  it("removeFeatureCascadeは依存フィーチャーを持たない場合そのフィーチャーのみ削除する", () => {
    const { doc, sketch, extrude } = makeSketchExtrudeChainDoc();
    const updated = removeFeatureCascade(doc, extrude.id);
    expect(findFeature(updated, sketch.id)).toBe(sketch);
    expect(findFeature(updated, extrude.id)).toBeUndefined();
    expect(updated.features).toHaveLength(1);
  });

  it("removeFeature(非カスケード)はsketchのみ削除しextrudeの参照が残る", () => {
    const { doc, sketch, extrude } = makeSketchExtrudeChainDoc();
    const updated = removeFeature(doc, sketch.id);
    expect(findFeature(updated, sketch.id)).toBeUndefined();
    expect(findFeature(updated, extrude.id)).toBe(extrude);
  });
});

describe("patchExtrudeFeature", () => {
  it("押し出し距離・方向を更新できる", () => {
    const { doc, sketch } = makeRectSketchDoc();
    const { doc: doc2, feature: extrude } = addExtrudeFeature(doc, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: 20,
      direction: 1,
      operation: "newBody",
    });
    const updated = patchExtrudeFeature(doc2, extrude.id, { distance: 50, direction: -1 });
    const found = findFeature(updated, extrude.id) as ExtrudeFeature;
    expect(found.distance).toBe(50);
    expect(found.direction).toBe(-1);
  });
});

describe("validateFeature / validateDocument", () => {
  it("正しいドキュメントはエラーなし", () => {
    const { doc, sketch } = makeRectSketchDoc();
    const { doc: doc2 } = addExtrudeFeature(doc, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: 20,
      direction: 1,
      operation: "newBody",
    });
    expect(validateDocument(doc2)).toEqual([]);
    expect(isDocumentValid(doc2)).toBe(true);
  });

  it("矩形の幅が0以下だとエラー", () => {
    const empty = createEmptyDocument();
    const rect = createRectangleEntity({ width: 0, height: 40 });
    const { doc, feature } = addSketchFeature(empty, {
      name: "S",
      plane: { kind: "world", plane: "XY" },
      entities: [rect],
    });
    const errors = validateFeature(feature, doc.features);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].featureId).toBe(feature.id);
  });

  it("負の高さはエラー", () => {
    const rect = createRectangleEntity({ width: 10, height: -5 });
    const errors = validateFeature(
      {
        type: "sketch",
        id: "s1",
        name: "S",
        plane: { kind: "world", plane: "XY" },
        entities: [rect],
      },
      [],
    );
    expect(errors.some((e) => e.message.includes("高さ"))).toBe(true);
  });

  it("円の半径が0以下だとエラー", () => {
    const circle = createCircleEntity({ radius: -1 });
    const errors = validateFeature(
      {
        type: "sketch",
        id: "s1",
        name: "S",
        plane: { kind: "world", plane: "XY" },
        entities: [circle],
      },
      [],
    );
    expect(errors.some((e) => e.message.includes("半径"))).toBe(true);
  });

  it("多角形の頂点数が3未満だとエラー", () => {
    const polygon = createPolygonEntity({
      points: [
        [0, 0],
        [10, 0],
      ],
    });
    const errors = validateFeature(
      {
        type: "sketch",
        id: "s1",
        name: "S",
        plane: { kind: "world", plane: "XY" },
        entities: [polygon],
      },
      [],
    );
    expect(errors.some((e) => e.message.includes("3点以上"))).toBe(true);
  });

  it("多角形に隣接する重複頂点があるとエラー", () => {
    const polygon = createPolygonEntity({
      points: [
        [0, 0],
        [10, 0],
        [10, 0.0000001],
        [0, 10],
      ],
    });
    const errors = validateFeature(
      {
        type: "sketch",
        id: "s1",
        name: "S",
        plane: { kind: "world", plane: "XY" },
        entities: [polygon],
      },
      [],
    );
    expect(errors.some((e) => e.message.includes("重複"))).toBe(true);
  });

  it("正しい多角形(3点以上・重複頂点なし)はエラーなし", () => {
    const polygon = createPolygonEntity({
      points: [
        [0, 0],
        [40, 0],
        [40, 20],
        [20, 20],
        [20, 40],
        [0, 40],
      ],
    });
    const errors = validateFeature(
      {
        type: "sketch",
        id: "s1",
        name: "S",
        plane: { kind: "world", plane: "XY" },
        entities: [polygon],
      },
      [],
    );
    expect(errors).toEqual([]);
  });

  describe("スケッチ拘束(SketchConstraint、Phase 20a)のバリデーション", () => {
    function sketchWithSegmentsAndConstraints(constraints: SketchConstraint[]): SketchFeature {
      return {
        type: "sketch",
        id: "s1",
        name: "S",
        plane: { kind: "world", plane: "XY" },
        entities: [],
        segments: [
          { id: "line1", kind: "line", p1: [0, 0], p2: [10, 0] },
          { id: "arc1", kind: "arc", p1: [0, 0], p2: [10, 0], bulge: 1 },
        ],
        constraints,
      };
    }

    it("正しい拘束(参照先が存在し、値が正、radiusはarc対象)はエラーなし", () => {
      const feature = sketchWithSegmentsAndConstraints([
        { id: "c1", kind: "horizontal", segmentId: "line1" },
        { id: "c2", kind: "length", segmentId: "line1", value: 10 },
        { id: "c3", kind: "radius", segmentId: "arc1", value: 8 },
        { id: "c4", kind: "coincident", a: { segmentId: "line1", end: "p1" }, b: { segmentId: "arc1", end: "p1" } },
        { id: "c5", kind: "fix", point: { segmentId: "line1", end: "p2" } },
      ]);
      expect(validateFeature(feature, [feature])).toEqual([]);
    });

    it("存在しないsegmentIdを参照する拘束はエラー", () => {
      const feature = sketchWithSegmentsAndConstraints([{ id: "c1", kind: "horizontal", segmentId: "missing" }]);
      const errors = validateFeature(feature, [feature]);
      expect(errors.some((e) => e.message.includes("見つかりません"))).toBe(true);
    });

    it("length拘束の値が0以下だとエラー", () => {
      const feature = sketchWithSegmentsAndConstraints([{ id: "c1", kind: "length", segmentId: "line1", value: 0 }]);
      const errors = validateFeature(feature, [feature]);
      expect(errors.some((e) => e.message.includes("長さ"))).toBe(true);
    });

    it("radius拘束をline(直線)セグメントに指定するとエラー", () => {
      const feature = sketchWithSegmentsAndConstraints([{ id: "c1", kind: "radius", segmentId: "line1", value: 5 }]);
      const errors = validateFeature(feature, [feature]);
      expect(errors.some((e) => e.message.includes("円弧セグメントにのみ"))).toBe(true);
    });

    it("distance拘束の参照点(PointRef)のsegmentIdが存在しないとエラー", () => {
      const feature = sketchWithSegmentsAndConstraints([
        { id: "c1", kind: "distance", a: { segmentId: "line1", end: "p1" }, b: { segmentId: "missing", end: "p2" }, value: 10 },
      ]);
      const errors = validateFeature(feature, [feature]);
      expect(errors.some((e) => e.message.includes("見つかりません"))).toBe(true);
    });
  });

  describe("多角形の頂点コーナー(fillet/chamfer、Phase 11)", () => {
    // 40x40正方形。頂点1=(40,0)は隣接辺(頂点0->1: 長さ40、頂点1->2: 長さ40)がともに40。
    const SQUARE_POINTS: [number, number][] = [
      [0, 0],
      [40, 0],
      [40, 40],
      [0, 40],
    ];

    function squareWithCorners(corners: (null | { kind: "fillet" | "chamfer"; size: number })[]) {
      return createPolygonEntity({ points: SQUARE_POINTS, corners });
    }

    it("corners未指定はエラーなし(既存データとの後方互換)", () => {
      const polygon = createPolygonEntity({ points: SQUARE_POINTS });
      const errors = validateFeature(
        { type: "sketch", id: "s1", name: "S", plane: { kind: "world", plane: "XY" }, entities: [polygon] },
        [],
      );
      expect(errors).toEqual([]);
    });

    it("妥当なサイズのfillet/chamfer指定はエラーなし", () => {
      const polygon = squareWithCorners([
        { kind: "fillet", size: 5 },
        { kind: "chamfer", size: 5 },
        null,
        null,
      ]);
      const errors = validateFeature(
        { type: "sketch", id: "s1", name: "S", plane: { kind: "world", plane: "XY" }, entities: [polygon] },
        [],
      );
      expect(errors).toEqual([]);
    });

    it("サイズが0以下だとエラー", () => {
      const polygon = squareWithCorners([{ kind: "fillet", size: 0 }, null, null, null]);
      const errors = validateFeature(
        { type: "sketch", id: "s1", name: "S", plane: { kind: "world", plane: "XY" }, entities: [polygon] },
        [],
      );
      expect(errors.some((e) => e.message.includes("正の数"))).toBe(true);
    });

    it("サイズが隣接辺の短い方の半分を超えるとエラー(粗い事前チェック)", () => {
      // 頂点1の隣接辺はどちらも長さ40。サイズ21 > 40/2=20 なのでエラーになるはず。
      const polygon = squareWithCorners([null, { kind: "fillet", size: 21 }, null, null]);
      const errors = validateFeature(
        { type: "sketch", id: "s1", name: "S", plane: { kind: "world", plane: "XY" }, entities: [polygon] },
        [],
      );
      expect(errors.some((e) => e.message.includes("大きすぎます"))).toBe(true);
    });

    it("サイズがちょうど隣接辺の短い方の半分ならエラーにならない(境界値)", () => {
      const polygon = squareWithCorners([null, { kind: "fillet", size: 20 }, null, null]);
      const errors = validateFeature(
        { type: "sketch", id: "s1", name: "S", plane: { kind: "world", plane: "XY" }, entities: [polygon] },
        [],
      );
      expect(errors).toEqual([]);
    });

    it("頂点0(始点)のコーナーサイズも同じ基準で検証される", () => {
      // 頂点0の隣接辺は 頂点3->0(長さ40)と頂点0->1(長さ40)。
      const polygon = squareWithCorners([{ kind: "fillet", size: 25 }, null, null, null]);
      const errors = validateFeature(
        { type: "sketch", id: "s1", name: "S", plane: { kind: "world", plane: "XY" }, entities: [polygon] },
        [],
      );
      expect(errors.some((e) => e.message.includes("大きすぎます"))).toBe(true);
    });

    it("不正なkindはエラー", () => {
      const polygon = createPolygonEntity({
        points: SQUARE_POINTS,
        // @ts-expect-error 意図的に不正なkindを渡す
        corners: [{ kind: "invalid", size: 5 }, null, null, null],
      });
      const errors = validateFeature(
        { type: "sketch", id: "s1", name: "S", plane: { kind: "world", plane: "XY" }, entities: [polygon] },
        [],
      );
      expect(errors.some((e) => e.message.includes("コーナー種別"))).toBe(true);
    });
  });

  it("押し出し距離が0以下だとエラー", () => {
    const errors = validateFeature(
      {
        type: "extrude",
        id: "e1",
        name: "E",
        sketchId: "s1",
        distance: 0,
        direction: 1,
        operation: "newBody",
      },
      [{ type: "sketch", id: "s1", name: "S", plane: { kind: "world", plane: "XY" }, entities: [] }],
    );
    expect(errors.some((e) => e.message.includes("押し出し距離"))).toBe(true);
  });

  it("extrudeのsketchIdが存在しない場合エラー", () => {
    const errors = validateFeature(
      {
        type: "extrude",
        id: "e1",
        name: "E",
        sketchId: "does-not-exist",
        distance: 10,
        direction: 1,
        operation: "newBody",
      },
      [],
    );
    expect(errors.some((e) => e.message.includes("存在しません"))).toBe(true);
  });

  it("operationが\"add\"でもエラーにならない", () => {
    const { doc, sketch } = makeRectSketchDoc();
    const { doc: doc2 } = addExtrudeFeature(doc, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: 20,
      direction: 1,
      operation: "newBody",
    });
    const { doc: doc3, feature: addSketch } = addSketchFeature(doc2, {
      name: "Sketch2",
      plane: { kind: "world", plane: "XY" },
      entities: [createCircleEntity({ radius: 5 })],
    });
    const { doc: doc4 } = addExtrudeFeature(doc3, {
      name: "Add1",
      sketchId: addSketch.id,
      distance: 10,
      direction: 1,
      operation: "add",
    });
    expect(validateDocument(doc4)).toEqual([]);
    expect(isDocumentValid(doc4)).toBe(true);
  });

  it("operationが不正な文字列だとエラー", () => {
    const errors = validateFeature(
      {
        type: "extrude",
        id: "e1",
        name: "E",
        sketchId: "s1",
        distance: 10,
        direction: 1,
        operation: "invalidOp" as unknown as ExtrudeFeature["operation"],
      },
      [{ type: "sketch", id: "s1", name: "S", plane: { kind: "world", plane: "XY" }, entities: [] }],
    );
    expect(errors.some((e) => e.message.includes("対応していない押し出し操作"))).toBe(true);
  });

  it("extrudeのsketchIdがsketch以外を指しているとエラー", () => {
    const otherExtrude: ExtrudeFeature = {
      type: "extrude",
      id: "e0",
      name: "E0",
      sketchId: "s1",
      distance: 10,
      direction: 1,
      operation: "newBody",
    };
    const errors = validateFeature(
      { ...otherExtrude, id: "e1", sketchId: "e0" },
      [otherExtrude],
    );
    expect(errors.some((e) => e.message.includes("スケッチではありません"))).toBe(true);
  });

  it("フィーチャーID重複はドキュメントレベルでエラーになる", () => {
    const dup: SketchFeature = {
      type: "sketch",
      id: "dup",
      name: "A",
      plane: { kind: "world", plane: "XY" },
      entities: [],
    };
    const doc: CadDocument = { version: 1, features: [dup, { ...dup, name: "B" }] };
    const errors = validateDocument(doc);
    expect(errors.some((e) => e.message.includes("重複"))).toBe(true);
  });
});
