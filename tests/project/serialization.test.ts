// src/project/serialization.ts の単体テスト(Phase 26)。
import { describe, expect, it } from "vitest";

import {
  addExtrudeFeature,
  addPartInstanceFeature,
  addSketchFeature,
  addThreadFeature,
  createCircleEntity,
  createEmptyDocument,
  createLineSegment,
  createPointEntity,
  createRectangleEntity,
  patchThreadPositionRef,
} from "../../src/model";
import { deserializeProject, PROJECT_FORMAT, PROJECT_SCHEMA_VERSION, serializeProject } from "../../src/project/serialization";

function sampleDoc() {
  const rect = createRectangleEntity({ width: 60, height: 40 });
  const { doc: withSketch, feature: sketch } = addSketchFeature(createEmptyDocument(), {
    name: "Sketch1",
    plane: { kind: "world", plane: "XY" },
    entities: [rect],
  });
  const { doc } = addExtrudeFeature(withSketch, {
    name: "Extrude1",
    sketchId: sketch.id,
    distance: 20,
    direction: 1,
    operation: "newBody",
  });
  return doc;
}

describe("serializeProject / deserializeProject", () => {
  it("serialize→deserializeで元のCadDocumentと完全一致する(往復テスト)", () => {
    const doc = sampleDoc();
    const text = serializeProject(doc);
    const result = deserializeProject(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc).toEqual(doc);
    }
  });

  it("serializeしたJSONはformat/schemaVersionを含む", () => {
    const text = serializeProject(sampleDoc());
    const parsed = JSON.parse(text);
    expect(parsed.format).toBe(PROJECT_FORMAT);
    expect(parsed.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it("壊れたJSONは拒否される", () => {
    const result = deserializeProject("{ this is not valid json ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/JSON/);
    }
  });

  it("未知のformatは拒否される", () => {
    const text = JSON.stringify({ format: "some-other-cad", schemaVersion: 1, document: createEmptyDocument() });
    const result = deserializeProject(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/フォーマット/);
    }
  });

  it("部品配置(簡易アセンブリ、Phase 27b)を含むドキュメントもserialize→deserializeで完全一致する(往復テスト)", () => {
    const part = sampleDoc();
    const { doc } = addPartInstanceFeature(sampleDoc(), {
      name: "Part1",
      part,
      position: [10, 20, 30],
      rotation: [0, 90, 0],
    });
    const text = serializeProject(doc);
    const result = deserializeProject(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc).toEqual(doc);
    }
  });

  it("寸法ラベルのドラッグ移動オフセット(Phase 31a、拘束labelOffset・sketch.dimensionOffsetsとも)を含むドキュメントもserialize→deserializeで完全一致する(往復テスト)", () => {
    const rect = createRectangleEntity({ width: 60, height: 40 });
    const seg = createLineSegment({ p1: [0, 0], p2: [20, 0] });
    const { doc } = addSketchFeature(createEmptyDocument(), {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect],
      segments: [seg],
    });
    const sketch = doc.features[0];
    if (sketch.type !== "sketch") throw new Error("unreachable");
    const docWithOffsets = {
      ...doc,
      features: [
        {
          ...sketch,
          constraints: [{ id: "c-length", kind: "length" as const, segmentId: seg.id, value: 20, labelOffset: [3, -4] as [number, number] }],
          dimensionOffsets: { [`${rect.id}-w`]: [1.5, 2.5] as [number, number] },
        },
        ...doc.features.slice(1),
      ],
    };
    const text = serializeProject(docWithOffsets);
    const result = deserializeProject(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc).toEqual(docWithOffsets);
    }
  });

  it("ねじフィーチャー(positionRef省略、Phase 46追加前と同形)はserialize→deserializeで完全一致する(往復テスト)", () => {
    const { doc: withExtrude } = (() => {
      const rect = createRectangleEntity({ width: 60, height: 40 });
      const { doc: withSketch, feature: sketch } = addSketchFeature(createEmptyDocument(), {
        name: "Sketch1",
        plane: { kind: "world", plane: "XY" },
        entities: [rect],
      });
      return addExtrudeFeature(withSketch, { name: "Extrude1", sketchId: sketch.id, distance: 20, direction: 1, operation: "newBody" });
    })();
    const { doc } = addThreadFeature(withExtrude, {
      name: "M6ねじ1",
      hand: "male",
      preset: "M6",
      length: 10,
      face: { faceId: 1, center: [0, 0, 20], normal: [0, 0, 1] },
      position: [3, -4],
      direction: 1,
    });
    const text = serializeProject(doc);
    const result = deserializeProject(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc).toEqual(doc);
    }
  });

  it("positionRef(スケッチの円参照配置、Phase 46追加項目)を含むねじフィーチャーもserialize→deserializeで完全一致する(往復テスト、追加フィールドの後方互換性)", () => {
    const rect = createRectangleEntity({ width: 60, height: 40 });
    const { doc: withSketch, feature: sketch } = addSketchFeature(createEmptyDocument(), {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect],
    });
    const { doc: withExtrude, feature: extrude } = addExtrudeFeature(withSketch, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: 20,
      direction: 1,
      operation: "newBody",
    });
    const circle = createCircleEntity({ center: [3, -4], radius: 2 });
    const { doc: withFaceSketch, feature: faceSketch } = addSketchFeature(withExtrude, {
      name: "FaceSketch1",
      plane: { kind: "face", featureId: extrude.id, faceId: 1, center: [0, 0, 20], normal: [0, 0, 1] },
      entities: [circle],
    });
    const { doc: withThread, feature: thread } = addThreadFeature(withFaceSketch, {
      name: "M6ねじ1",
      hand: "male",
      preset: "M6",
      length: 10,
      face: { faceId: 1, center: [0, 0, 20], normal: [0, 0, 1] },
      position: [3, -4],
      direction: 1,
    });
    const doc = patchThreadPositionRef(withThread, thread.id, { sketchId: faceSketch.id, entityId: circle.id });

    const text = serializeProject(doc);
    const result = deserializeProject(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc).toEqual(doc);
      const restoredThread = result.doc.features.find((f) => f.id === thread.id);
      expect(restoredThread?.type === "thread" ? restoredThread.positionRef : undefined).toEqual({
        sketchId: faceSketch.id,
        entityId: circle.id,
      });
    }
  });

  it("点エンティティ(Phase 47)を含むスケッチはserialize→deserializeで完全一致する(往復テスト)", () => {
    const point = createPointEntity({ position: [3, -4] });
    const { doc } = addSketchFeature(createEmptyDocument(), {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [point],
    });
    const text = serializeProject(doc);
    const result = deserializeProject(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc).toEqual(doc);
      const sketch = result.doc.features[0];
      expect(sketch.type === "sketch" ? sketch.entities[0] : null).toEqual(point);
    }
  });

  it("positionRefが点エンティティ(Phase 47)を参照するねじフィーチャーもserialize→deserializeで完全一致する(往復テスト)", () => {
    const rect = createRectangleEntity({ width: 60, height: 40 });
    const { doc: withSketch, feature: sketch } = addSketchFeature(createEmptyDocument(), {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect],
    });
    const { doc: withExtrude, feature: extrude } = addExtrudeFeature(withSketch, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: 20,
      direction: 1,
      operation: "newBody",
    });
    const point = createPointEntity({ position: [3, -4] });
    const { doc: withFaceSketch, feature: faceSketch } = addSketchFeature(withExtrude, {
      name: "FaceSketch1",
      plane: { kind: "face", featureId: extrude.id, faceId: 1, center: [0, 0, 20], normal: [0, 0, 1] },
      entities: [point],
    });
    const { doc: withThread, feature: thread } = addThreadFeature(withFaceSketch, {
      name: "M6ねじ1",
      hand: "male",
      preset: "M6",
      length: 10,
      face: { faceId: 1, center: [0, 0, 20], normal: [0, 0, 1] },
      position: [3, -4],
      direction: 1,
    });
    const doc = patchThreadPositionRef(withThread, thread.id, { sketchId: faceSketch.id, entityId: point.id });

    const text = serializeProject(doc);
    const result = deserializeProject(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc).toEqual(doc);
    }
  });

  it("部品(part)内に入れ子の部品配置を含むドキュメントは拒否される", () => {
    const innerPart = sampleDoc();
    const { doc: partWithNesting } = addPartInstanceFeature(createEmptyDocument(), {
      name: "Inner",
      part: innerPart,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    });
    const { doc } = addPartInstanceFeature(sampleDoc(), {
      name: "Outer",
      part: partWithNesting,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    });
    const text = serializeProject(doc);
    const result = deserializeProject(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/入れ子/);
    }
  });

  it("バリデーション違反(参照先スケッチが存在しない押し出し)は拒否される", () => {
    const doc = {
      version: 1 as const,
      features: [
        {
          type: "extrude" as const,
          id: "extrude-does-not-exist",
          name: "Extrude1",
          sketchId: "sketch-missing",
          distance: 10,
          direction: 1 as const,
          operation: "newBody" as const,
        },
      ],
    };
    const text = JSON.stringify({ format: PROJECT_FORMAT, schemaVersion: PROJECT_SCHEMA_VERSION, document: doc });
    const result = deserializeProject(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/バリデーション/);
    }
  });
});
