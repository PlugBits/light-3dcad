import { describe, expect, it } from "vitest";

import {
  addExtrudeFeature,
  addSketchEntity,
  addSketchFeature,
  createEmptyDocument,
  createCircleEntity,
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
  updateSketchEntity,
  validateDocument,
  validateFeature,
} from "../../src/model";
import type { CadDocument, ExtrudeFeature, SketchFeature } from "../../src/model";

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
