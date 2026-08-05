// evaluator.ts の統合テスト。実際のOpenCascade WASMをNode上にロードして検証する。
// WASM初期化はこのファイル内で1回だけ(beforeAll)行い、全テストで共有する。
// 何らかの理由でNode上でWASMがロードできない環境では、各テスト冒頭のctx.skip()で
// 動的にスキップする(beforeAllは非同期のため、収集時に確定するdescribe.skipIfは使えない)。
// モデル層のテスト(tests/model/)はこのファイルの成否に影響されない。
import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import initOpenCascadeUntyped from "replicad-opencascadejs/src/replicad_single.js";
import { setOC, type Shape3D } from "replicad";
import type { OpenCascadeInstance } from "replicad-opencascadejs/src/replicad_single.js";

import {
  addExtrudeFeature,
  addSketchFeature,
  createCircleEntity,
  createEmptyDocument,
  createRectangleEntity,
} from "../../src/model";
import { evaluateDocument } from "../../src/worker/evaluator";

const initOpenCascade = initOpenCascadeUntyped as unknown as (moduleOverrides: {
  locateFile: (path: string) => string;
}) => Promise<OpenCascadeInstance>;

let wasmLoaded = false;

beforeAll(async () => {
  try {
    const wasmPath = path.resolve("node_modules/replicad-opencascadejs/src/replicad_single.wasm");
    const OC = await initOpenCascade({ locateFile: () => wasmPath });
    setOC(OC);
    wasmLoaded = true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[evaluator.test] Node上でのOpenCascade WASM初期化に失敗したため、evaluatorの統合テストをスキップします:",
      err,
    );
    wasmLoaded = false;
  }
}, 60000);

function countTriangles(shape: Shape3D): number {
  const mesh = shape.mesh({ tolerance: 0.1, angularTolerance: 30 });
  return mesh.triangles.length / 3;
}

function countFaces(shape: Shape3D): number {
  const faces = shape.faces;
  const count = faces.length;
  faces.forEach((f) => f.delete());
  return count;
}

const SKIP_NOTE = "Node上でのOpenCascade WASM初期化に失敗したためスキップ";

describe("evaluateDocument (WASM統合)", () => {
  it("矩形スケッチを押し出すとメッシュとfaceGroupsが返る(直方体=6面)", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const rect = createRectangleEntity({ width: 60, height: 40 });
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect],
    });
    const { doc } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: 20,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const mesh = result.shape.mesh({ tolerance: 0.1, angularTolerance: 30 });
    expect(mesh.triangles.length).toBeGreaterThan(0);
    expect(mesh.faceGroups).toHaveLength(6);

    const faceIds = new Set(mesh.faceGroups.map((g) => g.faceId));
    expect(faceIds.size).toBe(6);

    result.shape.delete();
  });

  it("direction:-1は逆向きに押し出す(体積・メッシュは正の方向と同等)", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const rect = createRectangleEntity({ width: 60, height: 40 });
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect],
    });
    const { doc } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: 20,
      direction: -1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(countFaces(result.shape)).toBe(6);
    result.shape.delete();
  });

  it("円カットで三角形数が変わり、faceInfo相当の面数が増える", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const rect = createRectangleEntity({ width: 60, height: 40 });
    const { doc: doc1, feature: rectSketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect],
    });
    const { doc: doc2 } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: rectSketch.id,
      distance: 20,
      direction: 1,
      operation: "newBody",
    });

    const boxOnlyResult = evaluateDocument(doc2);
    expect(boxOnlyResult.ok).toBe(true);
    if (!boxOnlyResult.ok) return;
    const boxTriangles = countTriangles(boxOnlyResult.shape);
    const boxFaces = countFaces(boxOnlyResult.shape);
    boxOnlyResult.shape.delete();

    const circle = createCircleEntity({ radius: 10 });
    const { doc: doc3, feature: circleSketch } = addSketchFeature(doc2, {
      name: "Sketch2",
      plane: { kind: "world", plane: "XY" },
      entities: [circle],
    });
    const { doc: cutDoc } = addExtrudeFeature(doc3, {
      name: "Cut1",
      sketchId: circleSketch.id,
      distance: 30,
      direction: 1,
      operation: "cut",
    });

    const cutResult = evaluateDocument(cutDoc);
    expect(cutResult.ok).toBe(true);
    if (!cutResult.ok) return;
    const cutTriangles = countTriangles(cutResult.shape);
    const cutFaces = countFaces(cutResult.shape);

    expect(cutTriangles).not.toBe(boxTriangles);
    expect(cutFaces).toBeGreaterThan(boxFaces);

    cutResult.shape.delete();
  });

  it("faceを参照するスケッチ平面は未対応エラー(featureId付き)", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const { doc } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "face", featureId: "does-not-matter", faceId: 1 },
      entities: [createRectangleEntity({ width: 10, height: 10 })],
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.featureId).toBe(doc.features[0].id);
    expect(result.message).toContain("未対応");
  });

  it("extrudeの参照sketchIdが存在しない場合、featureId付きエラーになる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const { doc, feature: extrude } = addExtrudeFeature(empty, {
      name: "Extrude1",
      sketchId: "not-exist",
      distance: 10,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.featureId).toBe(extrude.id);
  });

  it("ボディが無い状態でのcutはエラーになる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [createCircleEntity({ radius: 5 })],
    });
    const { doc, feature: cut } = addExtrudeFeature(doc1, {
      name: "Cut1",
      sketchId: sketch.id,
      distance: 10,
      direction: 1,
      operation: "cut",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.featureId).toBe(cut.id);
    expect(result.message).toContain("カット対象");
  });

  it("2回目のnewBodyはエラーになる(単一ボディのみ対応)", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const rect = createRectangleEntity({ width: 20, height: 20 });
    const { doc: doc1, feature: sketch1 } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect],
    });
    const { doc: doc2 } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch1.id,
      distance: 10,
      direction: 1,
      operation: "newBody",
    });
    const { doc: doc3, feature: sketch2 } = addSketchFeature(doc2, {
      name: "Sketch2",
      plane: { kind: "world", plane: "XY" },
      entities: [createRectangleEntity({ width: 5, height: 5 })],
    });
    const { doc, feature: extrude2 } = addExtrudeFeature(doc3, {
      name: "Extrude2",
      sketchId: sketch2.id,
      distance: 10,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.featureId).toBe(extrude2.id);
    expect(result.message).toContain("単一ボディ");
  });

  it("図形が無いスケッチを押し出そうとするとエラーになる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [],
    });
    const { doc, feature: extrude } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: 10,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.featureId).toBe(extrude.id);
  });

  it("フィーチャーが無い(押し出しが存在しない)ドキュメントはエラーになる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const { doc } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [createRectangleEntity({ width: 10, height: 10 })],
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(false);
  });
});
