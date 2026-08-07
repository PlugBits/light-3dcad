// src/project/serialization.ts の単体テスト(Phase 26)。
import { describe, expect, it } from "vitest";

import { addExtrudeFeature, addSketchFeature, createEmptyDocument, createRectangleEntity } from "../../src/model";
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
