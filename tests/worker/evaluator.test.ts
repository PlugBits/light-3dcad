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
  patchExtrudeFeature,
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

/** テスト用: 形状の中からXY平面に平行(法線がほぼ+Z)な面を探し、faceId/center/normalを取り出す。 */
function findTopFace(shape: Shape3D): { faceId: number; center: [number, number, number]; normal: [number, number, number] } {
  const faces = shape.faces;
  let found: { faceId: number; center: [number, number, number]; normal: [number, number, number] } | null = null;
  for (const face of faces) {
    if (face.geomType === "PLANE") {
      const centerVec = face.center;
      const normalVec = face.normalAt();
      const center = centerVec.toTuple();
      const normal = normalVec.toTuple();
      centerVec.delete();
      normalVec.delete();
      if (Math.abs(normal[2] - 1) < 1e-6 && Math.abs(normal[0]) < 1e-6 && Math.abs(normal[1]) < 1e-6) {
        found = { faceId: face.hashCode, center, normal };
      }
    }
    face.delete();
  }
  if (!found) throw new Error("テストセットアップ失敗: 上面が見つかりません");
  return found;
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

  it("faceを参照するスケッチで参照先フィーチャーが存在しない場合はfeatureId付きエラーになる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const { doc } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "face", featureId: "does-not-matter", faceId: 1, center: [0, 0, 0], normal: [0, 0, 1] },
      entities: [createRectangleEntity({ width: 10, height: 10 })],
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.featureId).toBe(doc.features[0].id);
    expect(result.message).toContain("見つかりません");
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

describe("evaluateDocument (WASM統合): スケッチ・オン・フェイス", () => {
  it("箱の上面へのfaceスケッチ+円カットで穴があき、面数が増える(hashCode一致で解決)", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const rect = createRectangleEntity({ width: 60, height: 40 });
    const { doc: doc1, feature: boxSketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect],
    });
    const { doc: doc2, feature: boxExtrude } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: boxSketch.id,
      distance: 20,
      direction: 1,
      operation: "newBody",
    });

    const boxResult = evaluateDocument(doc2);
    expect(boxResult.ok).toBe(true);
    if (!boxResult.ok) return;
    const boxFaceCount = countFaces(boxResult.shape);
    const top = findTopFace(boxResult.shape);
    boxResult.shape.delete();

    expect(top.center[0]).toBeCloseTo(0, 6);
    expect(top.center[1]).toBeCloseTo(0, 6);
    expect(top.center[2]).toBeCloseTo(20, 6);
    expect(top.normal[2]).toBeCloseTo(1, 6);

    const circle = createCircleEntity({ radius: 10 });
    const { doc: doc3, feature: faceSketch } = addSketchFeature(doc2, {
      name: "FaceSketch1",
      plane: { kind: "face", featureId: boxExtrude.id, faceId: top.faceId, center: top.center, normal: top.normal },
      entities: [circle],
    });
    // 上面の法線は+Z(外向き)なので、内側に掘るcutはdirection:-1にする。
    const { doc: cutDoc } = addExtrudeFeature(doc3, {
      name: "Cut1",
      sketchId: faceSketch.id,
      distance: 10,
      direction: -1,
      operation: "cut",
    });

    const result = evaluateDocument(cutDoc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const faceCount = countFaces(result.shape);
    expect(faceCount).toBeGreaterThan(boxFaceCount);
    result.shape.delete();
  });

  it("上流寸法変更(高さ20→30)に幾何マッチングで追従する", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const rect = createRectangleEntity({ width: 60, height: 40 });
    const { doc: doc1, feature: boxSketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect],
    });
    const { doc: doc2, feature: boxExtrude } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: boxSketch.id,
      distance: 20,
      direction: 1,
      operation: "newBody",
    });

    const boxResult = evaluateDocument(doc2);
    expect(boxResult.ok).toBe(true);
    if (!boxResult.ok) return;
    const top = findTopFace(boxResult.shape);
    boxResult.shape.delete();

    const circle = createCircleEntity({ radius: 10 });
    const { doc: doc3, feature: faceSketch } = addSketchFeature(doc2, {
      name: "FaceSketch1",
      // 保存されたcenterは(0,0,20)のまま(高さ変更後も更新されない=意図的に古い値)
      plane: { kind: "face", featureId: boxExtrude.id, faceId: top.faceId, center: top.center, normal: top.normal },
      entities: [circle],
    });
    const { doc: cutDoc } = addExtrudeFeature(doc3, {
      name: "Cut1",
      sketchId: faceSketch.id,
      distance: 10,
      direction: -1,
      operation: "cut",
    });

    // 箱の高さを20→30に変更する。PlaneRef側のcenter/normalはあえて更新しない。
    const changedDoc = patchExtrudeFeature(cutDoc, boxExtrude.id, { distance: 30 });

    const result = evaluateDocument(changedDoc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 幾何マッチングで新しい上面(z=30)が見つかり、そこにカットが行われていること。
    // (旧centerのz=20はもはや箱の内部にあるため、成功した時点で新しい上面が使われた証拠になる)
    const bbox = result.shape.boundingBox;
    expect(bbox.depth).toBeCloseTo(30, 3);
    bbox.delete();

    result.shape.delete();
  });

  it("参照面が幾何マッチングでも見つからない場合、featureId付きエラーになる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const rect = createRectangleEntity({ width: 60, height: 40 });
    const { doc: doc1, feature: boxSketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect],
    });
    const { doc: doc2, feature: boxExtrude } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: boxSketch.id,
      distance: 20,
      direction: 1,
      operation: "newBody",
    });

    const circle = createCircleEntity({ radius: 10 });
    const diagonalNormal = 1 / Math.sqrt(3);
    const { doc: doc3, feature: faceSketch } = addSketchFeature(doc2, {
      name: "FaceSketch1",
      // 箱のどの面の法線とも一致しない不正な法線 + 実在しないfaceId
      plane: {
        kind: "face",
        featureId: boxExtrude.id,
        faceId: 999999999,
        center: [0, 0, 20],
        normal: [diagonalNormal, diagonalNormal, diagonalNormal],
      },
      entities: [circle],
    });
    const { doc } = addExtrudeFeature(doc3, {
      name: "Cut1",
      sketchId: faceSketch.id,
      distance: 10,
      direction: -1,
      operation: "cut",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.featureId).toBe(faceSketch.id);
    expect(result.message).toContain("面を選択し直してください");
  });
});
