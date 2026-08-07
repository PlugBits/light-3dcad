// evaluator.ts の統合テスト。実際のOpenCascade WASMをNode上にロードして検証する。
// WASM初期化はこのファイル内で1回だけ(beforeAll)行い、全テストで共有する。
// 何らかの理由でNode上でWASMがロードできない環境では、各テスト冒頭のctx.skip()で
// 動的にスキップする(beforeAllは非同期のため、収集時に確定するdescribe.skipIfは使えない)。
// モデル層のテスト(tests/model/)はこのファイルの成否に影響されない。
import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import initOpenCascadeUntyped from "replicad-opencascadejs/src/replicad_single.js";
import { measureVolume, setOC, type Shape3D } from "replicad";
import type { OpenCascadeInstance } from "replicad-opencascadejs/src/replicad_single.js";

import {
  addExtrudeFeature,
  addFillet3DFeature,
  addPartInstanceFeature,
  addRevolveFeature,
  addShellFeature,
  addSketchFeature,
  addThreadFeature,
  createArcSegment,
  createCircleEntity,
  createEmptyDocument,
  createLineSegment,
  createPolygonEntity,
  createRectangleEntity,
  createRegularPolygonEntity,
  createSlotEntity,
  patchExtrudeFeature,
  resolveEvaluationDocument,
  setRollbackIndex,
} from "../../src/model";
import type { CadDocument, FilletEdgeRef, SketchSegment } from "../../src/model/types";
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

/** 円柱面(geomType === "CYLINDRE")の数を数える。ドーナツ形状は内外2面、単純な円柱は1面になる。 */
function countCylindricalFaces(shape: Shape3D): number {
  const faces = shape.faces;
  const count = faces.filter((f) => f.geomType === "CYLINDRE").length;
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

/**
 * テスト用(Phase 25a): 3Dフィレット/面取りフィーチャーのedges用スナップショットを作る。
 * shapeの直線エッジ(geomType==="LINE")のうち、両端点のZ座標がtopZにほぼ一致するもの
 * (=箱の上面を構成する4辺)をすべて集めてFilletEdgeRef配列として返す。
 */
function topFaceEdgeSnapshots(shape: Shape3D, topZ: number): FilletEdgeRef[] {
  const result: FilletEdgeRef[] = [];
  const edges = shape.edges;
  for (const edge of edges) {
    if (edge.geomType === "LINE") {
      const startVec = edge.startPoint;
      const endVec = edge.endPoint;
      const midVec = edge.pointAt(0.5);
      const p1 = startVec.toTuple();
      const p2 = endVec.toTuple();
      const midpoint = midVec.toTuple();
      startVec.delete();
      endVec.delete();
      midVec.delete();
      if (Math.abs(p1[2] - topZ) < 1e-6 && Math.abs(p2[2] - topZ) < 1e-6) {
        result.push({ edgeId: edge.hashCode, p1, p2, midpoint });
      }
    }
    edge.delete();
  }
  return result;
}

const SKIP_NOTE = "Node上でのOpenCascade WASM初期化に失敗したためスキップ";

/**
 * テスト用(Phase 27b、簡易アセンブリ): XY平面中心の矩形(width x height)をdistanceだけ+Z方向に
 * 押し出した単一ボディのドキュメントを作る(部品として使う)。
 */
function boxDoc(width: number, height: number, distance: number): CadDocument {
  const empty = createEmptyDocument();
  const rect = createRectangleEntity({ width, height });
  const { doc: withSketch, feature: sketch } = addSketchFeature(empty, {
    name: "PartSketch1",
    plane: { kind: "world", plane: "XY" },
    entities: [rect],
  });
  const { doc } = addExtrudeFeature(withSketch, {
    name: "PartExtrude1",
    sketchId: sketch.id,
    distance,
    direction: 1,
    operation: "newBody",
  });
  return doc;
}

/** 頂点列(閉ループ、最後は最初に自動的に戻る)から直線セグメントの配列を作る(Phase 19a評価テスト用)。 */
function rectSegments(points: [number, number][]): SketchSegment[] {
  const segs: SketchSegment[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    segs.push(createLineSegment({ p1, p2 }));
  }
  return segs;
}

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

    // XYスケッチの解決済み平面はワールド原点・単位XY基底になる。
    expect(result.sketchPlanes).toHaveLength(1);
    const [plane] = result.sketchPlanes;
    expect(plane.sketchId).toBe(sketch.id);
    expect(plane.origin).toEqual([0, 0, 0]);
    expect(plane.xDir).toEqual([1, 0, 0]);
    expect(plane.yDir).toEqual([0, 1, 0]);
    expect(plane.normal).toEqual([0, 0, 1]);

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

  it("ボディが無い状態でのaddはエラーになる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [createCircleEntity({ radius: 5 })],
    });
    const { doc, feature: add } = addExtrudeFeature(doc1, {
      name: "Add1",
      sketchId: sketch.id,
      distance: 10,
      direction: 1,
      operation: "add",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.featureId).toBe(add.id);
    expect(result.message).toContain("追加対象");
  });

  it("2回目のnewBodyは新しい独立したボディとして成功する(単一ボディ制限は撤廃、Phase 27a)", (ctx) => {
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
    // 離れた位置(center=[50,0])に置くことで、体積が単純な和になる(重なり合わない)ようにする。
    const { doc: doc3, feature: sketch2 } = addSketchFeature(doc2, {
      name: "Sketch2",
      plane: { kind: "world", plane: "XY" },
      entities: [createRectangleEntity({ center: [50, 0], width: 5, height: 5 })],
    });
    const { doc } = addExtrudeFeature(doc3, {
      name: "Extrude2",
      sketchId: sketch2.id,
      distance: 10,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.shape).not.toBeNull();
    const shape = result.shape as Shape3D;
    // 2つの独立したソリッド(直方体6面x2=12面)を持つcompoundになる。
    expect(countFaces(shape)).toBe(12);
    expect(measureVolume(shape)).toBeCloseTo(20 * 20 * 10 + 5 * 5 * 10, 3);
    shape.delete();
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

  it("フィーチャーが無い(押し出しが存在しない)ドキュメントはボディなしの正常ケースとして返る(Phase 13)", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const { doc } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [createRectangleEntity({ width: 10, height: 10 })],
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.shape).toBeNull();
    // ボディが無くても、スケッチの平面基底(sketchPlanes)は解決済みとして返る(スケッチ線表示継続のため)。
    expect(result.sketchPlanes).toHaveLength(1);
    expect(result.sketchPlanes[0].sketchId).toBe(doc.features[0].id);
  });

  it("空ドキュメント(フィーチャー0件)もボディなしの正常ケースとして返る(Phase 13)", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const result = evaluateDocument(empty);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.shape).toBeNull();
    expect(result.sketchPlanes).toEqual([]);
  });

  it("XZ/YZ平面のスケッチを押し出せる(Phase 13)", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const rect = createRectangleEntity({ width: 20, height: 10 });
    const { doc: doc1, feature: xzSketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XZ" },
      entities: [rect],
    });
    const { doc } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: xzSketch.id,
      distance: 5,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.shape).not.toBeNull();
    const shape = result.shape as Shape3D;
    // replicadの名前付きXZ平面はnormal=[0,-1,0]。sketchPlanesの基底がそれと一致することを確認する。
    const plane = result.sketchPlanes.find((p) => p.sketchId === xzSketch.id);
    expect(plane).toBeDefined();
    expect(plane?.origin).toEqual([0, 0, 0]);
    expect(plane?.xDir).toEqual([1, 0, 0]);
    expect(plane?.yDir).toEqual([0, 0, 1]);
    expect(plane?.normal).toEqual([0, -1, 0]);
    // XZ平面(y=0)に20x10の矩形をdistance5だけ押し出した直方体。バウンディングボックスのY方向が5mm。
    const bbox = shape.boundingBox;
    expect(bbox.height).toBeCloseTo(5, 6);
    bbox.delete();
    shape.delete();
  });

  it("L字型polygonを押し出すとバウンディングボックス40x40x20で、矩形40x40x20より体積が小さい", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    // L字: (0,0)(40,0)(40,20)(20,20)(20,40)(0,40) の6頂点。
    const lShape = createPolygonEntity({
      points: [
        [0, 0],
        [40, 0],
        [40, 20],
        [20, 20],
        [20, 40],
        [0, 40],
      ],
    });
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [lShape],
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

    const bbox = result.shape.boundingBox;
    expect(bbox.width).toBeCloseTo(40, 6);
    expect(bbox.height).toBeCloseTo(40, 6);
    expect(bbox.depth).toBeCloseTo(20, 6);
    bbox.delete();

    // L字の断面積は 40*40 - 20*20 = 1200mm^2 なので体積は 1200*20 = 24000mm^3。
    // 矩形40x40x20の体積(32000mm^3)より小さいことを面積指標(体積)で確認する。
    const volume = measureVolume(result.shape);
    expect(volume).toBeLessThan(40 * 40 * 20);
    expect(volume).toBeCloseTo(1200 * 20, 0);

    result.shape.delete();
  });

  it("40x40正方形の4頂点(頂点0含む)全てにフィレットr=5を適用すると押し出しに成功し、体積が角のある正方形より小さくなる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const r = 5;
    const height = 20;
    const filleted = createPolygonEntity({
      points: [
        [0, 0],
        [40, 0],
        [40, 40],
        [0, 40],
      ],
      corners: [
        { kind: "fillet", size: r },
        { kind: "fillet", size: r },
        { kind: "fillet", size: r },
        { kind: "fillet", size: r },
      ],
    });
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [filleted],
    });
    const { doc } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: height,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bbox = result.shape.boundingBox;
    // フィレットは角を丸めるだけなのでバウンディングボックスは40x40x20のまま。
    expect(bbox.width).toBeCloseTo(40, 3);
    expect(bbox.height).toBeCloseTo(40, 3);
    expect(bbox.depth).toBeCloseTo(height, 6);
    bbox.delete();

    // 直角90度の角を半径rでフィレットすると、1隅あたり r^2 - πr^2/4 = r^2(1-π/4) の断面積が削れる。
    // 4隅分・高さ倍した体積が減ることを概算検証する(誤差1mm^3程度まで許容)。
    const plainVolume = 40 * 40 * height;
    const removedPerCorner = r * r * (1 - Math.PI / 4);
    const expectedVolume = plainVolume - 4 * removedPerCorner * height;
    const volume = measureVolume(result.shape);
    expect(volume).toBeLessThan(plainVolume);
    expect(volume).toBeCloseTo(expectedVolume, 0);

    result.shape.delete();
  });

  it("40x40正方形の4頂点(頂点0含む)全てに面取りsize=5を適用すると押し出しに成功し、体積がフィレットよりさらに小さくなる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const size = 5;
    const height = 20;
    const chamfered = createPolygonEntity({
      points: [
        [0, 0],
        [40, 0],
        [40, 40],
        [0, 40],
      ],
      corners: [
        { kind: "chamfer", size },
        { kind: "chamfer", size },
        { kind: "chamfer", size },
        { kind: "chamfer", size },
      ],
    });
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [chamfered],
    });
    const { doc } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: height,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 直角90度の角を面取りすると、1隅あたり size^2/2 の直角二等辺三角形の断面積が削れる
    // (脚長がsizeと一致するのは90度の頂点のみ。src/sketch/polygonOutline.ts のコメント参照)。
    const plainVolume = 40 * 40 * height;
    const removedPerCorner = (size * size) / 2;
    const expectedVolume = plainVolume - 4 * removedPerCorner * height;
    const volume = measureVolume(result.shape);
    expect(volume).toBeLessThan(plainVolume);
    expect(volume).toBeCloseTo(expectedVolume, 0);

    result.shape.delete();
  });

  it("頂点0(始点)のみにフィレットを適用しても押し出しに成功する(customCorner/closeWithCustomCornerのスパイク回帰テスト)", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const r = 5;
    const height = 10;
    const filletedAtVertex0 = createPolygonEntity({
      points: [
        [0, 0],
        [40, 0],
        [40, 40],
        [0, 40],
      ],
      corners: [{ kind: "fillet", size: r }, null, null, null],
    });
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [filletedAtVertex0],
    });
    const { doc } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: height,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 頂点0(0,0)近傍が丸められ、他の3頂点(直角のまま)は残る。
    // バウンディングボックスの最小コーナーは、頂点0が丸められた分だけ(0,0)から後退しない
    // (フィレットは角を内側に削るだけで外形の頂点1,2,3側の境界は変わらないため、bboxはそのまま40x40)。
    const bbox = result.shape.boundingBox;
    expect(bbox.width).toBeCloseTo(40, 3);
    expect(bbox.height).toBeCloseTo(40, 3);
    bbox.delete();

    const plainVolume = 40 * 40 * height;
    const removedPerCorner = r * r * (1 - Math.PI / 4);
    const expectedVolume = plainVolume - removedPerCorner * height;
    const volume = measureVolume(result.shape);
    expect(volume).toBeLessThan(plainVolume);
    expect(volume).toBeCloseTo(expectedVolume, 0);

    result.shape.delete();
  });

  it("コーナーサイズが隣接辺に対して大きすぎる場合、OCCT到達前の事前バリデーションでfeatureId付きエラーになる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    // 頂点1の隣接辺はどちらも長さ40mm。サイズ30 > 40/2=20 のため事前チェックで弾かれるはず。
    const oversized = createPolygonEntity({
      points: [
        [0, 0],
        [40, 0],
        [40, 40],
        [0, 40],
      ],
      corners: [null, { kind: "fillet", size: 30 }, null, null],
    });
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [oversized],
    });
    const { doc } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: 10,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // エラーはsketchフィーチャー(コーナーの持ち主)のIDで返る。
    expect(result.featureId).toBe(sketch.id);
    expect(result.message).toContain("大きすぎます");
  });

  it("重複頂点を含むpolygonの押し出しはOCCTエラーとしてfeatureId付きで返る", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    // モデル層バリデーションをすり抜けた不正な入力(隣接重複頂点)を直接evaluatorに渡すケース。
    // OCCT側のエラーが既存のfeatureIdエラー経路に乗ることを確認する。
    const empty = createEmptyDocument();
    const degenerate = createPolygonEntity({
      points: [
        [0, 0],
        [0, 0],
        [10, 0],
        [10, 10],
      ],
    });
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [degenerate],
    });
    const { doc } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: 10,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    // 重複点があってもOCCT側で吸収されて成功する場合と、エラーになる場合がありうる。
    // どちらであってもfeatureId付きの整合したレスポンス形状であることのみ検証する
    // (evaluator自体がクラッシュしないこと、エラー時はfeatureIdが特定できることが目的)。
    if (!result.ok) {
      expect(result.featureId).toBe(doc.features[1].id);
    } else {
      result.shape.delete();
    }
  });
  it("矩形60x40の中に完全に含まれる円r=10を同一スケッチに置いて押し出すと、穴あき板の体積になる(Phase 15)", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const rect = createRectangleEntity({ width: 60, height: 40 });
    const hole = createCircleEntity({ radius: 10 });
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect, hole],
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

    const bbox = result.shape.boundingBox;
    // 穴は外形の内側に収まるので外形のバウンディングボックス(60x40x20)は変わらない。
    expect(bbox.width).toBeCloseTo(60, 6);
    expect(bbox.height).toBeCloseTo(40, 6);
    expect(bbox.depth).toBeCloseTo(20, 6);
    bbox.delete();

    // 断面積 = 60*40 - π*10^2、高さ20の押し出し体積。
    const expectedVolume = (60 * 40 - Math.PI * 10 * 10) * 20;
    const volume = measureVolume(result.shape);
    expect(volume).toBeLessThan(60 * 40 * 20);
    expect(volume).toBeCloseTo(expectedVolume, 0);

    result.shape.delete();
  });

  it("円(半径20)の中に完全に含まれる円(半径8)でドーナツ形状になる(Phase 15)", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();

    const outer = createCircleEntity({ radius: 20 });
    const inner = createCircleEntity({ radius: 8 });
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [outer, inner],
    });
    const { doc } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: 5,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // ドーナツ形状は内側(半径8)・外側(半径20)の2つの円柱面を持つ(単純な円柱は1つだけ)。
    // Phase 21: 面数の単純比較(旧: 単純な円柱よりtoBeGreaterThan)は、2D Drawing#cut()→3D
    // Shape3D#cut()への変更(タンジェント境界のバグ修正、containment.ts参照)でOCCTが返す
    // 面の内訳が変わり(旧実装はシーム由来と見られる余剰面を含んでいた)、意味のある比較で
    // なくなったため、より直接的な「円柱面が2つある」検証に置き換えた。
    expect(countCylindricalFaces(result.shape)).toBe(2);

    const expectedVolume = (Math.PI * 20 * 20 - Math.PI * 8 * 8) * 5;
    const volume = measureVolume(result.shape);
    expect(volume).toBeCloseTo(expectedVolume, 0);

    result.shape.delete();
  });

  it("矩形20x20(既定寸法)の中心に円r=10(既定寸法)がちょうど内接(辺の中点に接する)しても穴として扱われる(Phase 21回帰)", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    // SketchEditorの「矩形を数値で追加」「円を数値で追加」ボタン(src/components/SketchEditor.tsx)の
    // 既定値そのもの(createRectangleEntity({width:20,height:20})・createCircleEntity({radius:10})、
    // どちらも中心は既定の[0,0])を使う。この組み合わせは円の半径(10)が矩形の半幅(20/2=10)と
    // ちょうど一致し、円が矩形の各辺の中点にタンジェント(接する)状態になる。修正前は境界接触が
    // 微小マージンで「含まれない」と判定され、円がholeに分類されずouterどうしのfuseになり
    // (fuse結果は矩形と等しいため見た目に変化がなく)穴が消えて見える不具合があった。
    const empty = createEmptyDocument();
    const rect = createRectangleEntity({ width: 20, height: 20 });
    const hole = createCircleEntity({ radius: 10 });
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect, hole],
    });
    const { doc } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: 10,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 穴が正しく開いていれば、単純な20x20x10の直方体(体積4000mm^3)より小さい体積になる。
    const expectedVolume = (20 * 20 - Math.PI * 10 * 10) * 10;
    const volume = measureVolume(result.shape);
    expect(volume).toBeLessThan(20 * 20 * 10);
    expect(volume).toBeCloseTo(expectedVolume, 0);

    result.shape.delete();
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

    // 箱上面へのfaceスケッチの解決済み平面はorigin≈(0,0,20)/normal≈(0,0,1)になる。
    const facePlane = result.sketchPlanes.find((p) => p.sketchId === faceSketch.id);
    expect(facePlane).toBeDefined();
    expect(facePlane?.origin[0]).toBeCloseTo(0, 6);
    expect(facePlane?.origin[1]).toBeCloseTo(0, 6);
    expect(facePlane?.origin[2]).toBeCloseTo(20, 6);
    expect(facePlane?.normal[0]).toBeCloseTo(0, 6);
    expect(facePlane?.normal[1]).toBeCloseTo(0, 6);
    expect(facePlane?.normal[2]).toBeCloseTo(1, 6);

    result.shape.delete();
  });

  it("箱の上面へのfaceスケッチのreferenceEdgesに上面の4辺(スケッチローカル座標)が返る(Phase 22)", (ctx) => {
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
      plane: { kind: "face", featureId: boxExtrude.id, faceId: top.faceId, center: top.center, normal: top.normal },
      entities: [circle],
    });

    const result = evaluateDocument(doc3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.shape) result.shape.delete();

    const refSet = result.referenceEdges.find((r) => r.sketchId === faceSketch.id);
    expect(refSet).toBeDefined();
    expect(refSet?.edges.length).toBe(4);

    // 60x40の矩形(center原点)の上面: スケッチローカル座標での4頂点は(±30, ±20)のいずれかの組み合わせ。
    // xDir=[1,0,0]/yDir=[0,1,0](法線+Zのフォールバックxdir)と一致する。
    const corners = new Set<string>();
    for (const edge of refSet?.edges ?? []) {
      corners.add(`${edge.p1[0].toFixed(1)},${edge.p1[1].toFixed(1)}`);
      corners.add(`${edge.p2[0].toFixed(1)},${edge.p2[1].toFixed(1)}`);
    }
    expect(corners).toEqual(new Set(["30.0,20.0", "30.0,-20.0", "-30.0,20.0", "-30.0,-20.0"]));

    // sketch1(world XY、押し出し前=bodyがまだ存在しない時点)にはreferenceEdgesのエントリが無い。
    expect(result.referenceEdges.some((r) => r.sketchId === boxSketch.id)).toBe(false);
  });

  it("箱の上面へのfaceスケッチ+円でAdd(材料追加)するとボスが乗り、バウンディングボックスの高さが増える", (ctx) => {
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
    const boxBbox = boxResult.shape.boundingBox;
    expect(boxBbox.depth).toBeCloseTo(20, 6);
    boxBbox.delete();
    const top = findTopFace(boxResult.shape);
    boxResult.shape.delete();

    const circle = createCircleEntity({ radius: 10 });
    const { doc: doc3, feature: faceSketch } = addSketchFeature(doc2, {
      name: "FaceSketch1",
      plane: { kind: "face", featureId: boxExtrude.id, faceId: top.faceId, center: top.center, normal: top.normal },
      entities: [circle],
    });
    // 上面の法線は+Z(外向き)なので、外側に盛り上げるaddはdirection:+1にする。
    const { doc: addDoc } = addExtrudeFeature(doc3, {
      name: "Add1",
      sketchId: faceSketch.id,
      distance: 10,
      direction: 1,
      operation: "add",
    });

    const result = evaluateDocument(addDoc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bbox = result.shape.boundingBox;
    // 箱の高さ20 + ボスの高さ10 = 30程度になる(境界ボックスの深さがZ方向の全高に相当)。
    expect(bbox.depth).toBeCloseTo(30, 6);
    bbox.delete();
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

    // sketchPlanesも幾何マッチング後の新しい上面(z=30)に追従している。
    const facePlane = result.sketchPlanes.find((p) => p.sketchId === faceSketch.id);
    expect(facePlane).toBeDefined();
    expect(facePlane?.origin[2]).toBeCloseTo(30, 3);

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
    // 面解決に失敗した場合はエラー応答(ok:false)のみが返り、sketchPlanesは含まれない
    // (EvaluationFailureにはsketchPlanesフィールド自体が存在しない)。
    expect("sketchPlanes" in result).toBe(false);
  });

  it("箱の上面へのfaceスケッチに小さい三角形polygonを置いてCutすると成功する", (ctx) => {
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

    // 上面中心付近に収まる小さい三角形。
    const triangle = createPolygonEntity({
      points: [
        [-5, -5],
        [5, -5],
        [0, 5],
      ],
    });
    const { doc: doc3, feature: faceSketch } = addSketchFeature(doc2, {
      name: "FaceSketch1",
      plane: { kind: "face", featureId: boxExtrude.id, faceId: top.faceId, center: top.center, normal: top.normal },
      entities: [triangle],
    });
    // 上面の法線は+Z(外向き)なので、内側に掘るcutはdirection:-1にする。
    const { doc: cutDoc } = addExtrudeFeature(doc3, {
      name: "Cut1",
      sketchId: faceSketch.id,
      distance: 5,
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

  it("押し出しに使われていないスケッチもsketchPlanesに含まれる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const rect = createRectangleEntity({ width: 60, height: 40 });
    const { doc: doc1, feature: boxSketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect],
    });
    const { doc: doc2 } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: boxSketch.id,
      distance: 20,
      direction: 1,
      operation: "newBody",
    });

    // Extrudeで使われない、独立した(未使用の)円スケッチを追加する。
    const circle = createCircleEntity({ radius: 5, center: [10, 10] });
    const { doc, feature: unusedSketch } = addSketchFeature(doc2, {
      name: "UnusedSketch",
      plane: { kind: "world", plane: "XY" },
      entities: [circle],
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.sketchPlanes).toHaveLength(2);
    const ids = result.sketchPlanes.map((p) => p.sketchId).sort();
    expect(ids).toEqual([boxSketch.id, unusedSketch.id].sort());

    result.shape.delete();
  });

  it("Phase 17: スロット(長円)を押し出すと体積が (直線部の面積+円の面積)*高さ になる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const width = 10;
    const length = 30; // start-end間の距離(直線部の長さ)。
    const height = 5;
    const slot = createSlotEntity({ start: [-length / 2, 0], end: [length / 2, 0], width });
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [slot],
    });
    const { doc } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: height,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const r = width / 2;
    const expectedArea = length * width + Math.PI * r * r;
    const volume = measureVolume(result.shape);
    expect(volume).toBeCloseTo(expectedArea * height, 1);

    const bbox = result.shape.boundingBox;
    expect(bbox.width).toBeCloseTo(length + width, 3);
    expect(bbox.height).toBeCloseTo(width, 3);
    expect(bbox.depth).toBeCloseTo(height, 6);
    bbox.delete();

    result.shape.delete();
  });

  it("Phase 17: 正六角形(外接円半径10)を押し出すと体積が正六角形の面積*高さになる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const radius = 10;
    const sides = 6;
    const height = 4;
    const hexagon = createRegularPolygonEntity({ radius, sides });
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [hexagon],
    });
    const { doc } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: height,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 正n角形(外接円半径r)の面積 = (1/2) n r^2 sin(2π/n)。
    const expectedArea = 0.5 * sides * radius * radius * Math.sin((2 * Math.PI) / sides);
    const volume = measureVolume(result.shape);
    expect(volume).toBeCloseTo(expectedArea * height, 1);

    const faces = result.shape.faces;
    // 六角柱: 側面6+上下2=8面。
    expect(faces.length).toBe(8);
    faces.forEach((f) => f.delete());

    result.shape.delete();
  });

  it("Phase 17: polygonの1辺をbulge=1(半円)にすると体積が半円分増える(半円+半正方形)", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const height = 3;
    const side = 20;
    // 正方形(0,0)(20,0)(20,20)(0,20)の下辺(頂点0→1)を、外側(-Y方向)に膨らむ半円にする。
    // 半円の弦=20、半径=10。bulge=+1(または-1)は辺の向きに応じて外向きの半円になる。
    // 実際にどちら向きに膨らむかは幾何(circumcircle)で決まるため、体積の符号ではなく
    // 「正方形単体の体積との差の絶対値が半円の面積*高さに一致する」ことで検証する。
    const bulgedSquare = createPolygonEntity({
      points: [
        [0, 0],
        [side, 0],
        [side, side],
        [0, side],
      ],
      bulges: [1, null, null, null],
    });
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [bulgedSquare],
    });
    const { doc } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: height,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const r = side / 2;
    const semicircleArea = (Math.PI * r * r) / 2;
    const squareVolume = side * side * height;
    const volume = measureVolume(result.shape);
    expect(Math.abs(volume - squareVolume)).toBeCloseTo(semicircleArea * height, 0);

    result.shape.delete();
  });
});

describe("evaluateDocument (WASM統合): segmentsベースの閉領域検出→押し出し(Phase 19a)", () => {
  it("4線分の矩形segmentsを押し出すと、entitiesの矩形と同じ体積になる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const width = 60;
    const height = 40;
    const extrudeHeight = 20;

    const segEmpty = createEmptyDocument();
    const segments = rectSegments([
      [-width / 2, -height / 2],
      [width / 2, -height / 2],
      [width / 2, height / 2],
      [-width / 2, height / 2],
    ]);
    const { doc: segDoc1, feature: segSketch } = addSketchFeature(segEmpty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [],
      segments,
    });
    const { doc: segDoc } = addExtrudeFeature(segDoc1, {
      name: "Extrude1",
      sketchId: segSketch.id,
      distance: extrudeHeight,
      direction: 1,
      operation: "newBody",
    });
    const segResult = evaluateDocument(segDoc);
    expect(segResult.ok).toBe(true);
    if (!segResult.ok) return;
    const segVolume = measureVolume(segResult.shape);
    segResult.shape.delete();

    const entEmpty = createEmptyDocument();
    const rect = createRectangleEntity({ width, height });
    const { doc: entDoc1, feature: entSketch } = addSketchFeature(entEmpty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect],
    });
    const { doc: entDoc } = addExtrudeFeature(entDoc1, {
      name: "Extrude1",
      sketchId: entSketch.id,
      distance: extrudeHeight,
      direction: 1,
      operation: "newBody",
    });
    const entResult = evaluateDocument(entDoc);
    expect(entResult.ok).toBe(true);
    if (!entResult.ok) return;
    const entVolume = measureVolume(entResult.shape);
    entResult.shape.delete();

    expect(segVolume).toBeCloseTo(entVolume, 3);
    expect(segVolume).toBeCloseTo(width * height * extrudeHeight, 3);
  });

  it("矩形+内側矩形のsegmentsを押し出すと穴あき体積になる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const outer = rectSegments([
      [0, 0],
      [60, 0],
      [60, 40],
      [0, 40],
    ]);
    const inner = rectSegments([
      [20, 10],
      [40, 10],
      [40, 30],
      [20, 30],
    ]);
    const height = 5;
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [],
      segments: [...outer, ...inner],
    });
    const { doc } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: height,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedArea = 60 * 40 - 20 * 20;
    const volume = measureVolume(result.shape);
    expect(volume).toBeCloseTo(expectedArea * height, 3);

    result.shape.delete();
  });

  it("円弧+直線のD字形segmentsを押し出すと半円+矩形部分の体積になる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const r = 10;
    const height = 3;
    const line = createLineSegment({ p1: [-r, 0], p2: [r, 0] });
    const arc = createArcSegment({ p1: [r, 0], p2: [-r, 0], bulge: -1 });
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [],
      segments: [line, arc],
    });
    const { doc } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: height,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedArea = (Math.PI * r * r) / 2;
    const volume = measureVolume(result.shape);
    expect(volume).toBeCloseTo(expectedArea * height, 1);

    result.shape.delete();
  });

  it("開いた線分のみのsegments(閉じた領域なし)を押し出そうとするとfeatureId付きエラーになる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const segments: SketchSegment[] = [
      createLineSegment({ p1: [0, 0], p2: [10, 0] }),
      createLineSegment({ p1: [10, 0], p2: [10, 10] }),
    ];
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [],
      segments,
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
    expect(result.message).toContain("閉じた領域がありません");
  });

  it("entitiesの矩形とsegmentsの離れた矩形を同じスケッチに置くと、両方がfuseされた体積になる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const entityRect = createRectangleEntity({ width: 10, height: 10, center: [0, 0] });
    const segRect = rectSegments([
      [100, 0],
      [110, 0],
      [110, 10],
      [100, 10],
    ]);
    const height = 4;
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [entityRect],
      segments: segRect,
    });
    const { doc } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: height,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedVolume = (10 * 10 + 10 * 10) * height;
    const volume = measureVolume(result.shape);
    expect(volume).toBeCloseTo(expectedVolume, 3);

    result.shape.delete();
  });

  it("線分ツールで描いた矩形(segments、閉チェーン)の内側に円entityを置いて押し出すと、穴あき体積になる(報告バグの再現・Phase 22)", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const outer = rectSegments([
      [0, 0],
      [60, 0],
      [60, 40],
      [0, 40],
    ]);
    const hole = createCircleEntity({ radius: 2, center: [30, 20] });
    const height = 5;
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [hole],
      segments: outer,
    });
    const { doc } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: height,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 修正前は円entityがsegments矩形と単純にfuseされ(穴として無視され)、体積が変わらなかった。
    const expectedArea = 60 * 40 - Math.PI * 2 * 2;
    const volume = measureVolume(result.shape);
    expect(volume).toBeCloseTo(expectedArea * height, 1);

    result.shape.delete();
  });

  it("矩形entity(外形)の内側に線分ツールで描いた矩形(segments、閉チェーン)を穴として置いて押し出すと、穴あき体積になる(逆方向の回帰確認・Phase 22)", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const outerRect = createRectangleEntity({ width: 60, height: 40, center: [30, 20] });
    const innerHole = rectSegments([
      [20, 10],
      [40, 10],
      [40, 30],
      [20, 30],
    ]);
    const height = 5;
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [outerRect],
      segments: innerHole,
    });
    const { doc } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: height,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedArea = 60 * 40 - 20 * 20;
    const volume = measureVolume(result.shape);
    expect(volume).toBeCloseTo(expectedArea * height, 3);

    result.shape.delete();
  });
});

describe("ロールバックバー(rollbackIndex、Phase 25): evaluateDocumentとの統合", () => {
  it("箱+穴カットのドキュメントで、バーを穴カット前に置いて評価すると穴なしの体積になる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);

    // Sketch1(60x40矩形) -> Extrude1(newBody, 20mm) -> Sketch2(円r10) -> Cut1(cut, 30mm)
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
    const circle = createCircleEntity({ radius: 10 });
    const { doc: doc3, feature: circleSketch } = addSketchFeature(doc2, {
      name: "Sketch2",
      plane: { kind: "world", plane: "XY" },
      entities: [circle],
    });
    const { doc: fullDoc } = addExtrudeFeature(doc3, {
      name: "Cut1",
      sketchId: circleSketch.id,
      distance: 30,
      direction: 1,
      operation: "cut",
    });

    // 末尾(rollbackIndex未設定)で評価: 穴あきの体積。
    const fullResult = evaluateDocument(resolveEvaluationDocument(fullDoc));
    expect(fullResult.ok).toBe(true);
    if (!fullResult.ok) return;
    const fullVolume = measureVolume(fullResult.shape);
    fullResult.shape.delete();

    // ロールバックバーをCut1の直前(Extrude1までの2フィーチャー)に移動して評価: 穴なしの体積。
    const rolledBackDoc = setRollbackIndex(fullDoc, 2);
    const evalDoc = resolveEvaluationDocument(rolledBackDoc);
    expect(evalDoc.features.map((f) => f.name)).toEqual(["Sketch1", "Extrude1"]);

    const rolledBackResult = evaluateDocument(evalDoc);
    expect(rolledBackResult.ok).toBe(true);
    if (!rolledBackResult.ok) return;
    const rolledBackVolume = measureVolume(rolledBackResult.shape);
    rolledBackResult.shape.delete();

    const boxVolume = 60 * 40 * 20;
    expect(rolledBackVolume).toBeCloseTo(boxVolume, 3);
    expect(fullVolume).toBeLessThan(rolledBackVolume);
    expect(fullVolume).toBeCloseTo(boxVolume - Math.PI * 10 * 10 * 20, 1);

    // バーを末尾へ戻すと穴ありの体積に復帰する(rollbackIndex: nullは「末尾」を表す)。
    const restoredDoc = setRollbackIndex(rolledBackDoc, null);
    expect(resolveEvaluationDocument(restoredDoc)).toBe(restoredDoc); // 末尾はコピーせず正本をそのまま使う
    const restoredResult = evaluateDocument(resolveEvaluationDocument(restoredDoc));
    expect(restoredResult.ok).toBe(true);
    if (!restoredResult.ok) return;
    const restoredVolume = measureVolume(restoredResult.shape);
    restoredResult.shape.delete();
    expect(restoredVolume).toBeCloseTo(fullVolume, 3);
  });
});

describe("evaluateDocument (WASM統合): 3Dフィレット/面取り(Phase 25a)", () => {
  /** 60x40x20の箱(XY原点中心、Z方向に押し出し)のドキュメントを作る共通セットアップ。 */
  function buildBoxDoc(distance = 20) {
    const empty = createEmptyDocument();
    const rect = createRectangleEntity({ width: 60, height: 40 });
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect],
    });
    const { doc, feature: extrude } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance,
      direction: 1,
      operation: "newBody",
    });
    return { doc, extrude };
  }

  it("箱の上面1エッジにフィレット5を適用すると体積が減る", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const { doc: boxDoc } = buildBoxDoc(20);
    const boxResult = evaluateDocument(boxDoc);
    expect(boxResult.ok).toBe(true);
    if (!boxResult.ok) return;
    const boxVolume = measureVolume(boxResult.shape);
    expect(boxVolume).toBeCloseTo(60 * 40 * 20, 3);
    const topEdges = topFaceEdgeSnapshots(boxResult.shape, 20);
    boxResult.shape.delete();
    expect(topEdges.length).toBe(4);

    const { doc } = addFillet3DFeature(boxDoc, {
      name: "フィレット1",
      kind: "fillet",
      size: 5,
      edges: [topEdges[0]],
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const volume = measureVolume(result.shape);
    result.shape.delete();
    expect(volume).toBeLessThan(boxVolume);
  });

  it("箱の上面4エッジ全周にフィレット5を適用すると、1エッジのみより体積が減る", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const { doc: boxDoc } = buildBoxDoc(20);
    const boxResult = evaluateDocument(boxDoc);
    expect(boxResult.ok).toBe(true);
    if (!boxResult.ok) return;
    const boxVolume = measureVolume(boxResult.shape);
    const topEdges = topFaceEdgeSnapshots(boxResult.shape, 20);
    boxResult.shape.delete();
    expect(topEdges.length).toBe(4);

    const { doc: singleDoc } = addFillet3DFeature(boxDoc, {
      name: "フィレット1",
      kind: "fillet",
      size: 5,
      edges: [topEdges[0]],
    });
    const singleResult = evaluateDocument(singleDoc);
    expect(singleResult.ok).toBe(true);
    if (!singleResult.ok) return;
    const singleVolume = measureVolume(singleResult.shape);
    singleResult.shape.delete();

    const { doc: allDoc } = addFillet3DFeature(boxDoc, {
      name: "フィレット1",
      kind: "fillet",
      size: 5,
      edges: topEdges,
    });
    const allResult = evaluateDocument(allDoc);
    expect(allResult.ok).toBe(true);
    if (!allResult.ok) return;
    const allVolume = measureVolume(allResult.shape);
    allResult.shape.delete();

    expect(allVolume).toBeLessThan(singleVolume);
    expect(singleVolume).toBeLessThan(boxVolume);
  });

  it("箱の上面1エッジに面取り5を適用すると体積が減る", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const { doc: boxDoc } = buildBoxDoc(20);
    const boxResult = evaluateDocument(boxDoc);
    expect(boxResult.ok).toBe(true);
    if (!boxResult.ok) return;
    const boxVolume = measureVolume(boxResult.shape);
    const topEdges = topFaceEdgeSnapshots(boxResult.shape, 20);
    boxResult.shape.delete();

    const { doc } = addFillet3DFeature(boxDoc, {
      name: "面取り1",
      kind: "chamfer",
      size: 5,
      edges: [topEdges[0]],
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const volume = measureVolume(result.shape);
    result.shape.delete();
    expect(volume).toBeLessThan(boxVolume);
  });

  it("寸法変更(押し出し距離)後も幾何マッチングで同じ稜線にフィレットが追従する", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const { doc: boxDoc, extrude } = buildBoxDoc(20);
    const boxResult = evaluateDocument(boxDoc);
    expect(boxResult.ok).toBe(true);
    if (!boxResult.ok) return;
    const topEdges = topFaceEdgeSnapshots(boxResult.shape, 20);
    boxResult.shape.delete();

    const { doc: filletDoc } = addFillet3DFeature(boxDoc, {
      name: "フィレット1",
      kind: "fillet",
      size: 3,
      edges: [topEdges[0]],
    });

    // 高さを20→22へ小さく変更する(edgeIdはOCCTの再構築で変わりうるため、
    // resolveFilletEdgesのフォールバック[中点距離最近傍+方向一致]で再解決される想定)。
    const changedDoc = patchExtrudeFeature(filletDoc, extrude.id, { distance: 22 });
    const result = evaluateDocument(changedDoc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const volume = measureVolume(result.shape);
    result.shape.delete();
    // フィレットが追従して適用されていれば、無加工の60x40x22の箱より体積が小さいはず。
    expect(volume).toBeLessThan(60 * 40 * 22);
  });

  it("過大な半径を指定するとfeatureId付きのエラーになる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const { doc: boxDoc } = buildBoxDoc(20);
    const boxResult = evaluateDocument(boxDoc);
    expect(boxResult.ok).toBe(true);
    if (!boxResult.ok) return;
    const topEdges = topFaceEdgeSnapshots(boxResult.shape, 20);
    boxResult.shape.delete();

    const { doc, feature } = addFillet3DFeature(boxDoc, {
      name: "フィレット1",
      kind: "fillet",
      size: 1000,
      edges: [topEdges[0]],
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.featureId).toBe(feature.id);
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe("evaluateDocument (WASM統合): シェル(中抜き、Phase 25b)", () => {
  /** 60x40x20の箱(XY原点中心、Z方向に押し出し)のドキュメントを作る共通セットアップ。 */
  function buildBoxDoc(distance = 20) {
    const empty = createEmptyDocument();
    const rect = createRectangleEntity({ width: 60, height: 40 });
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect],
    });
    const { doc, feature: extrude } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance,
      direction: 1,
      operation: "newBody",
    });
    return { doc, extrude };
  }

  it("上面を開口して肉厚2のシェルを適用すると体積が薄肉相当まで減る", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const { doc: boxDoc } = buildBoxDoc(20);
    const boxResult = evaluateDocument(boxDoc);
    expect(boxResult.ok).toBe(true);
    if (!boxResult.ok) return;
    const boxVolume = measureVolume(boxResult.shape);
    expect(boxVolume).toBeCloseTo(60 * 40 * 20, 3);
    const topFace = findTopFace(boxResult.shape);
    boxResult.shape.delete();

    const { doc } = addShellFeature(boxDoc, {
      name: "シェル1",
      thickness: 2,
      faces: [topFace],
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const volume = measureVolume(result.shape);
    result.shape.delete();
    // 外形寸法60x40x20から、肉厚2mmの殻(底面+側面4枚、上面は開口)を残した程度まで減るはず
    // (手計算の目安: 内側キャビティ56x36x18=36288 → 殻の体積は48000-36288=11712程度)。
    // 幾何計算の詳細差異を避けるため、緩めの範囲(半分以下・0より大)のみを検証する。
    expect(volume).toBeGreaterThan(0);
    expect(volume).toBeLessThan(boxVolume / 2);
  });

  it("寸法変更(押し出し距離)後も幾何マッチングで同じ面にシェルが追従する", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const { doc: boxDoc, extrude } = buildBoxDoc(20);
    const boxResult = evaluateDocument(boxDoc);
    expect(boxResult.ok).toBe(true);
    if (!boxResult.ok) return;
    const topFace = findTopFace(boxResult.shape);
    boxResult.shape.delete();

    const { doc: shellDoc } = addShellFeature(boxDoc, {
      name: "シェル1",
      thickness: 2,
      faces: [topFace],
    });

    // 高さを20→22へ変更する(faceIdはOCCTの再構築で変わりうるため、resolveShellFacesの
    // フォールバック[平面かつ法線一致+中心最近傍]で再解決される想定)。
    const changedDoc = patchExtrudeFeature(shellDoc, extrude.id, { distance: 22 });
    const result = evaluateDocument(changedDoc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const volume = measureVolume(result.shape);
    result.shape.delete();
    // シェルが追従して適用されていれば、無加工の60x40x22の箱より体積が小さいはず。
    expect(volume).toBeLessThan(60 * 40 * 22);
    expect(volume).toBeGreaterThan(0);
  });

  it("過大な肉厚を指定するとfeatureId付きのエラーになる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const { doc: boxDoc } = buildBoxDoc(20);
    const boxResult = evaluateDocument(boxDoc);
    expect(boxResult.ok).toBe(true);
    if (!boxResult.ok) return;
    const topFace = findTopFace(boxResult.shape);
    boxResult.shape.delete();

    const { doc, feature } = addShellFeature(boxDoc, {
      name: "シェル1",
      thickness: 100,
      faces: [topFace],
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.featureId).toBe(feature.id);
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe("evaluateDocument (WASM統合): ねじ(Phase 25c)", () => {
  /** 60x40x20の箱(XY原点中心、Z方向に押し出し)のドキュメントを作る共通セットアップ。 */
  function buildBoxDoc(distance = 20) {
    const empty = createEmptyDocument();
    const rect = createRectangleEntity({ width: 60, height: 40 });
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect],
    });
    const { doc, feature: extrude } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance,
      direction: 1,
      operation: "newBody",
    });
    return { doc, extrude };
  }

  // M6の谷径(evaluator.tsのTHREAD_ENGAGEMENT_FACTOR=0.61343と同じ式)。「円柱のみをfuseした場合」との
  // 体積比較に使う(テスト側で独自に計算し、evaluator内部の値と一致させる)。
  const M6_NOMINAL = 6;
  const M6_PITCH = 1.0;
  const M6_MINOR_RADIUS = M6_NOMINAL / 2 - 0.61343 * M6_PITCH;

  it("箱の上面にM6雄ねじ(5mm)を配置すると、谷径円柱のみをfuseした場合より体積が大きい(ねじ山分)", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const { doc: boxDoc } = buildBoxDoc(20);
    const boxResult = evaluateDocument(boxDoc);
    expect(boxResult.ok).toBe(true);
    if (!boxResult.ok) return;
    const boxVolume = measureVolume(boxResult.shape);
    const topFace = findTopFace(boxResult.shape);
    boxResult.shape.delete();

    const { doc, feature } = addThreadFeature(boxDoc, {
      name: "M6ねじ1",
      hand: "male",
      preset: "M6",
      length: 5,
      face: topFace,
      position: [0, 0],
      direction: 1,
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const volume = measureVolume(result.shape);
    result.shape.delete();

    const rodOnlyVolume = boxVolume + Math.PI * M6_MINOR_RADIUS * M6_MINOR_RADIUS * 5;
    expect(volume).toBeGreaterThan(rodOnlyVolume);
    // ねじ山ぶんの上乗せが極端に大きすぎない(明らかな破綻形状でない)ことも粗くチェックする。
    expect(volume).toBeLessThan(rodOnlyVolume + 30);
    void feature;
  }, 45000);

  it("箱の上面にM6雌ねじ(下穴)を配置すると、規格下穴径(呼び径-ピッチ=5.0mm)ぶん体積が減る", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const { doc: boxDoc } = buildBoxDoc(20);
    const boxResult = evaluateDocument(boxDoc);
    expect(boxResult.ok).toBe(true);
    if (!boxResult.ok) return;
    const boxVolume = measureVolume(boxResult.shape);
    const topFace = findTopFace(boxResult.shape);
    boxResult.shape.delete();

    const { doc, feature } = addThreadFeature(boxDoc, {
      name: "M6ねじ穴1(簡易表現・下穴φ5.0)",
      hand: "female",
      preset: "M6",
      length: 5,
      face: topFace,
      position: [15, 10],
      direction: -1,
    });
    expect(feature.name).toContain("下穴φ5.0");

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const volume = measureVolume(result.shape);
    result.shape.delete();

    const drillRadius = (6 - 1.0) / 2; // 呼び径6 - ピッチ1.0、半分が半径
    expect(drillRadius).toBeCloseTo(2.5, 6);
    const expectedVolume = boxVolume - Math.PI * drillRadius * drillRadius * 5;
    expect(volume).toBeCloseTo(expectedVolume, 1);
  });

  it("雄ねじの長さが上限(20mm)を超えるとfeatureId付きのエラーになる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const { doc: boxDoc } = buildBoxDoc(20);
    const boxResult = evaluateDocument(boxDoc);
    expect(boxResult.ok).toBe(true);
    if (!boxResult.ok) return;
    const topFace = findTopFace(boxResult.shape);
    boxResult.shape.delete();

    const { doc, feature } = addThreadFeature(boxDoc, {
      name: "M6ねじ1",
      hand: "male",
      preset: "M6",
      length: 25,
      face: topFace,
      position: [0, 0],
      direction: 1,
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.featureId).toBe(feature.id);
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe("evaluateDocument (WASM統合): 回転体(Revolve、Phase 25b)", () => {
  /** 軸から離れた矩形(スケッチX軸周りに回転すると、major radius=30・断面20x10のトーラス相当になる)。 */
  function buildOffsetRectDoc(angle: number) {
    const empty = createEmptyDocument();
    const rect = createRectangleEntity({ center: [0, 30], width: 20, height: 10 });
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect],
    });
    const { doc, feature: revolve } = addRevolveFeature(doc1, {
      name: "Revolve1",
      sketchId: sketch.id,
      axis: "x",
      angle,
      operation: "newBody",
    });
    return { doc, revolve };
  }

  it("軸から離れた矩形を360°回転すると、パップスの定理どおりの体積のトーラスになる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const { doc } = buildOffsetRectDoc(360);
    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const volume = measureVolume(result.shape);
    result.shape.delete();
    // パップスの定理: V = 2π * 重心の軸からの距離(30) * 断面積(20*10=200)。
    expect(volume).toBeCloseTo(2 * Math.PI * 30 * 200, 1);
  });

  it("90°回転すると、360°回転の1/4の体積になる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const { doc } = buildOffsetRectDoc(90);
    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const volume = measureVolume(result.shape);
    result.shape.delete();
    // パップスの定理(部分回転): V = 回転角(ラジアン) * 重心の軸からの距離(30) * 断面積(200)。
    expect(volume).toBeCloseTo((Math.PI / 2) * 30 * 200, 1);
  });

  it("cut操作: 箱を回転体でくり抜くと体積が減る", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const boxRect = createRectangleEntity({ width: 60, height: 40 });
    const { doc: doc1, feature: boxSketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [boxRect],
    });
    const { doc: doc2 } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: boxSketch.id,
      distance: 20,
      direction: 1,
      operation: "newBody",
    });

    const boxResult = evaluateDocument(doc2);
    expect(boxResult.ok).toBe(true);
    if (!boxResult.ok) return;
    const boxVolume = measureVolume(boxResult.shape);
    boxResult.shape.delete();

    // 軸(世界X軸)から離れた円(トーラス状のツール、major radius=10・tube radius=8)を、
    // 箱と重なるように箱の底面スケッチ(XY、z=0)上に描く。
    const circle = createCircleEntity({ center: [0, 10], radius: 8 });
    const { doc: doc3, feature: toolSketch } = addSketchFeature(doc2, {
      name: "Sketch2",
      plane: { kind: "world", plane: "XY" },
      entities: [circle],
    });
    const { doc: cutDoc } = addRevolveFeature(doc3, {
      name: "Revolve1",
      sketchId: toolSketch.id,
      axis: "x",
      angle: 360,
      operation: "cut",
    });

    const result = evaluateDocument(cutDoc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const volume = measureVolume(result.shape);
    result.shape.delete();
    expect(volume).toBeGreaterThan(0);
    expect(volume).toBeLessThan(boxVolume);
  });

  it("プロファイルが回転軸をまたぐとOCCTエラーになりfeatureId付きで返る", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    // center=(0,0)の矩形はスケッチX軸(y=0)をまたぐため、自己交差する回転体になり失敗する。
    const rect = createRectangleEntity({ center: [0, 0], width: 20, height: 10 });
    const { doc: doc1, feature: sketch } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect],
    });
    const { doc, feature: revolve } = addRevolveFeature(doc1, {
      name: "Revolve1",
      sketchId: sketch.id,
      axis: "x",
      angle: 360,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.featureId).toBe(revolve.id);
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe("evaluateDocument (WASM統合): STEPエクスポート(Phase 26)", () => {
  it("矩形スケッチを押し出したボディのSTEP出力(blobSTEP())が非空でISO-10303ヘッダを含む", async (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const rect = createRectangleEntity({ width: 60, height: 40 });
    const { doc: docWithSketch, feature: sketch } = addSketchFeature(createEmptyDocument(), {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect],
    });
    const { doc } = addExtrudeFeature(docWithSketch, {
      name: "Extrude1",
      sketchId: sketch.id,
      distance: 20,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.shape).not.toBeNull();
    if (!result.shape) return;
    try {
      const blob = result.shape.blobSTEP();
      expect(blob.size).toBeGreaterThan(0);
      const text = await blob.text();
      // STEP(ISO 10303-21)ファイルは "ISO-10303-21;" で始まる規格上のヘッダ行を持つ。
      expect(text).toContain("ISO-10303");
      expect(text.startsWith("ISO-10303-21;")).toBe(true);
    } finally {
      result.shape.delete();
    }
  });
});

describe("evaluateDocument (WASM統合): 複数ボディ(Phase 27a)", () => {
  /** 平面(法線がほぼ+Z)かつ中心XがxCloseToに最も近い面を探す(2ボディ環境で目的の面を一意に特定するため)。 */
  function findTopFaceNear(
    shape: Shape3D,
    xCloseTo: number,
  ): { faceId: number; center: [number, number, number]; normal: [number, number, number] } {
    const faces = shape.faces;
    let found: { faceId: number; center: [number, number, number]; normal: [number, number, number] } | null = null;
    let bestDist = Infinity;
    for (const face of faces) {
      if (face.geomType === "PLANE") {
        const centerVec = face.center;
        const normalVec = face.normalAt();
        const center = centerVec.toTuple();
        const normal = normalVec.toTuple();
        centerVec.delete();
        normalVec.delete();
        const isUpward = Math.abs(normal[2] - 1) < 1e-6 && Math.abs(normal[0]) < 1e-6 && Math.abs(normal[1]) < 1e-6;
        const dist = Math.abs(center[0] - xCloseTo);
        if (isUpward && dist < bestDist) {
          found = { faceId: face.hashCode, center, normal };
          bestDist = dist;
        }
      }
      face.delete();
    }
    if (!found) throw new Error("テストセットアップ失敗: 上面が見つかりません");
    return found;
  }

  it("① 離れた位置にnewBodyを2回適用すると、compoundの体積が両ボディの体積の和になる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const rect1 = createRectangleEntity({ width: 20, height: 20 });
    const { doc: doc1, feature: sketch1 } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect1],
    });
    const { doc: doc2 } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch1.id,
      distance: 10,
      direction: 1,
      operation: "newBody",
    });

    const rect2 = createRectangleEntity({ center: [100, 0], width: 30, height: 15 });
    const { doc: doc3, feature: sketch2 } = addSketchFeature(doc2, {
      name: "Sketch2",
      plane: { kind: "world", plane: "XY" },
      entities: [rect2],
    });
    const { doc } = addExtrudeFeature(doc3, {
      name: "Extrude2",
      sketchId: sketch2.id,
      distance: 5,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.shape).not.toBeNull();
    const shape = result.shape as Shape3D;
    expect(countFaces(shape)).toBe(12);
    const volume = measureVolume(shape);
    const expected = 20 * 20 * 10 + 30 * 15 * 5;
    expect(volume).toBeCloseTo(expected, 3);
    shape.delete();
  });

  it("② targetBodyIdを指定するとそのボディのみにcutが適用され、他方のボディは不変", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const rect1 = createRectangleEntity({ width: 60, height: 40 });
    const { doc: doc1, feature: sketch1 } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect1],
    });
    const { doc: doc2, feature: extrude1 } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch1.id,
      distance: 20,
      direction: 1,
      operation: "newBody",
    });

    const rect2 = createRectangleEntity({ center: [100, 0], width: 30, height: 15 });
    const { doc: doc3, feature: sketch2 } = addSketchFeature(doc2, {
      name: "Sketch2",
      plane: { kind: "world", plane: "XY" },
      entities: [rect2],
    });
    const { doc: doc4 } = addExtrudeFeature(doc3, {
      name: "Extrude2",
      sketchId: sketch2.id,
      distance: 5,
      direction: 1,
      operation: "newBody",
    });

    // カット用の円(半径5)はbody1の位置(原点)のみに重なる。
    const holeCircle = createCircleEntity({ radius: 5 });
    const { doc: doc5, feature: holeSketch } = addSketchFeature(doc4, {
      name: "Sketch3",
      plane: { kind: "world", plane: "XY" },
      entities: [holeCircle],
    });
    const { doc } = addExtrudeFeature(doc5, {
      name: "Cut1",
      sketchId: holeSketch.id,
      distance: 30,
      direction: 1,
      operation: "cut",
      targetBodyId: extrude1.id,
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const volume = measureVolume(result.shape as Shape3D);
    const expectedBody1 = (60 * 40 - Math.PI * 5 * 5) * 20;
    const expectedBody2 = 30 * 15 * 5;
    expect(volume).toBeCloseTo(expectedBody1 + expectedBody2, 0);
    (result.shape as Shape3D).delete();
  });

  it("③ targetBodyId省略時は最後に作られたボディにaddが適用される", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const rect1 = createRectangleEntity({ width: 20, height: 20 });
    const { doc: doc1, feature: sketch1 } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect1],
    });
    const { doc: doc2 } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch1.id,
      distance: 10,
      direction: 1,
      operation: "newBody",
    });

    const rect2 = createRectangleEntity({ center: [100, 0], width: 20, height: 20 });
    const { doc: doc3, feature: sketch2 } = addSketchFeature(doc2, {
      name: "Sketch2",
      plane: { kind: "world", plane: "XY" },
      entities: [rect2],
    });
    const { doc: doc4 } = addExtrudeFeature(doc3, {
      name: "Extrude2",
      sketchId: sketch2.id,
      distance: 10,
      direction: 1,
      operation: "newBody",
    });

    // 追加用の矩形(center=[100,0]、body2の位置のみに重なる)をtargetBodyId省略でaddする。
    const addRect = createRectangleEntity({ center: [100, 0], width: 10, height: 10 });
    const { doc: doc5, feature: addSketchFeature2 } = addSketchFeature(doc4, {
      name: "Sketch3",
      plane: { kind: "world", plane: "XY" },
      entities: [addRect],
    });
    const { doc } = addExtrudeFeature(doc5, {
      name: "Add1",
      sketchId: addSketchFeature2.id,
      distance: 30,
      direction: 1,
      operation: "add",
      // targetBodyIdは指定しない: 最後に作られたボディ(Extrude2/body2)が対象になるはず。
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const volume = measureVolume(result.shape as Shape3D);
    const body1Volume = 20 * 20 * 10;
    const body2Volume = 20 * 20 * 10;
    // body2(z:[0,10])と追加ボス(z:[0,30])は10x10footprintで重なるため、重複しない範囲(z:[10,30])のみ加算する。
    const addedBossVolume = 10 * 10 * (30 - 10);
    expect(volume).toBeCloseTo(body1Volume + body2Volume + addedBossVolume, 0);
    (result.shape as Shape3D).delete();
  });

  it("④ 2ボディ環境でface参照スケッチが正しい方のボディの面に解決される", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const rect1 = createRectangleEntity({ width: 60, height: 40 });
    const { doc: doc1, feature: sketch1 } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect1],
    });
    const { doc: doc2 } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch1.id,
      distance: 20,
      direction: 1,
      operation: "newBody",
    });

    const rect2 = createRectangleEntity({ center: [100, 0], width: 30, height: 15 });
    const { doc: doc3, feature: sketch2 } = addSketchFeature(doc2, {
      name: "Sketch2",
      plane: { kind: "world", plane: "XY" },
      entities: [rect2],
    });
    const { doc: doc4, feature: extrude2 } = addExtrudeFeature(doc3, {
      name: "Extrude2",
      sketchId: sketch2.id,
      distance: 5,
      direction: 1,
      operation: "newBody",
    });

    const boxesResult = evaluateDocument(doc4);
    expect(boxesResult.ok).toBe(true);
    if (!boxesResult.ok) return;
    const top2 = findTopFaceNear(boxesResult.shape as Shape3D, 100);
    (boxesResult.shape as Shape3D).delete();
    // body2(高さ5、x=100中心)の上面であることを確認(body1は高さ20、x=0中心なので混同していない)。
    expect(top2.center[2]).toBeCloseTo(5, 6);
    expect(top2.center[0]).toBeCloseTo(100, 6);

    const circle = createCircleEntity({ radius: 3 });
    const { doc: doc5, feature: faceSketch } = addSketchFeature(doc4, {
      name: "FaceSketch1",
      plane: { kind: "face", featureId: extrude2.id, faceId: top2.faceId, center: top2.center, normal: top2.normal },
      entities: [circle],
    });
    const { doc } = addExtrudeFeature(doc5, {
      name: "Cut1",
      sketchId: faceSketch.id,
      distance: 10,
      direction: -1,
      operation: "cut",
      targetBodyId: extrude2.id,
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const volume = measureVolume(result.shape as Shape3D);
    const body1Volume = 60 * 40 * 20;
    const body2VolumeWithHole = 30 * 15 * 5 - Math.PI * 3 * 3 * 5;
    expect(volume).toBeCloseTo(body1Volume + body2VolumeWithHole, 0);
    (result.shape as Shape3D).delete();
  });

  it("⑤ 2ボディ環境でfillet3dが幾何マッチングにより正しい方のボディに適用される", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const rect1 = createRectangleEntity({ width: 60, height: 40 });
    const { doc: doc1, feature: sketch1 } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect1],
    });
    const { doc: doc2 } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch1.id,
      distance: 20,
      direction: 1,
      operation: "newBody",
    });

    const rect2 = createRectangleEntity({ center: [100, 0], width: 20, height: 20 });
    const { doc: doc3, feature: sketch2 } = addSketchFeature(doc2, {
      name: "Sketch2",
      plane: { kind: "world", plane: "XY" },
      entities: [rect2],
    });
    const { doc: boxesDoc } = addExtrudeFeature(doc3, {
      name: "Extrude2",
      sketchId: sketch2.id,
      distance: 10,
      direction: 1,
      operation: "newBody",
    });

    const boxesResult = evaluateDocument(boxesDoc);
    expect(boxesResult.ok).toBe(true);
    if (!boxesResult.ok) return;
    const boxesVolume = measureVolume(boxesResult.shape as Shape3D);
    // body1は高さ20(上面z=20)、body2は高さ10(上面z=10)なので、z=10で絞ればbody2の上面4辺のみ取れる。
    const body2TopEdges = topFaceEdgeSnapshots(boxesResult.shape as Shape3D, 10);
    (boxesResult.shape as Shape3D).delete();
    expect(body2TopEdges.length).toBe(4);

    const { doc } = addFillet3DFeature(boxesDoc, {
      name: "フィレット1",
      kind: "fillet",
      size: 3,
      edges: [body2TopEdges[0]],
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const volume = measureVolume(result.shape as Shape3D);
    (result.shape as Shape3D).delete();
    expect(volume).toBeLessThan(boxesVolume);
    // body1(60x40x20)は不変のはずなので、減少分はbody2由来の1エッジ(上面の辺、長さ20mm)分の
    // 概算除去体積のみ(断面積r^2(1-π/4)の四半円柱をエッジの長さ[20mm、rect2の一辺]だけ除去する)。
    const removedApprox = 3 * 3 * (1 - Math.PI / 4) * 20;
    expect(boxesVolume - volume).toBeCloseTo(removedApprox, 0);
  });

  it("⑥ STL/STEPエクスポート(blobSTL/blobSTEP)が2ボディ分の形状を含む", async (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const rect1 = createRectangleEntity({ width: 20, height: 20 });
    const { doc: doc1, feature: sketch1 } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect1],
    });
    const { doc: doc2 } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch1.id,
      distance: 10,
      direction: 1,
      operation: "newBody",
    });

    const rect2 = createRectangleEntity({ center: [100, 0], width: 20, height: 20 });
    const { doc: doc3, feature: sketch2 } = addSketchFeature(doc2, {
      name: "Sketch2",
      plane: { kind: "world", plane: "XY" },
      entities: [rect2],
    });
    const { doc } = addExtrudeFeature(doc3, {
      name: "Extrude2",
      sketchId: sketch2.id,
      distance: 10,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const shape = result.shape as Shape3D;
    try {
      expect(countFaces(shape)).toBe(12);
      const stlBlob = shape.blobSTL();
      expect(stlBlob.size).toBeGreaterThan(0);
      const stepBlob = shape.blobSTEP();
      expect(stepBlob.size).toBeGreaterThan(0);
      const stepText = await stepBlob.text();
      expect(stepText.startsWith("ISO-10303-21;")).toBe(true);
    } finally {
      shape.delete();
    }
  });
});

describe("evaluateDocument (WASM統合): 簡易アセンブリ(部品配置、Phase 27b)", () => {
  it("① 部品を位置(50,0,0)に配置すると、体積が本体+部品の合計になり、部品のバウンディングボックスが指定位置になる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    // 部品: 10x10x10の箱(原点中心、XY center=[0,0])。
    const partDoc = boxDoc(10, 10, 10);
    // 本体: 20x20x20の箱(原点中心)。
    const mainDoc = boxDoc(20, 20, 20);

    const { doc } = addPartInstanceFeature(mainDoc, {
      name: "Part1",
      part: partDoc,
      position: [50, 0, 0],
      rotation: [0, 0, 0],
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const shape = result.shape as Shape3D;
    try {
      const volume = measureVolume(shape);
      expect(volume).toBeCloseTo(20 * 20 * 20 + 10 * 10 * 10, 3);

      // 本体はx:[-10,10]、部品(x:[-5,5]がposition[50,0,0]だけ平行移動)はx:[45,55]になるはず。
      const bbox = shape.boundingBox;
      const [min, max] = bbox.bounds;
      bbox.delete();
      expect(min[0]).toBeCloseTo(-10, 6);
      expect(max[0]).toBeCloseTo(55, 6);
    } finally {
      shape.delete();
    }
  });

  it("② 回転90°(X軸)で配置すると、部品のY/Z方向の外形寸法が入れ替わる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    // 部品: X方向10、Y方向4、Z方向(押し出し距離)2の非対称な直方体。
    const partDoc = boxDoc(10, 4, 2);

    const { doc: unrotatedDoc } = addPartInstanceFeature(createEmptyDocument(), {
      name: "Part0",
      part: partDoc,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    });
    const unrotatedResult = evaluateDocument(unrotatedDoc);
    expect(unrotatedResult.ok).toBe(true);
    if (!unrotatedResult.ok) return;
    const unrotatedShape = unrotatedResult.shape as Shape3D;
    const bbox0 = unrotatedShape.boundingBox;
    expect(bbox0.width).toBeCloseTo(10, 6);
    expect(bbox0.height).toBeCloseTo(4, 6);
    expect(bbox0.depth).toBeCloseTo(2, 6);
    bbox0.delete();
    unrotatedShape.delete();

    const { doc: rotatedDoc } = addPartInstanceFeature(createEmptyDocument(), {
      name: "Part1",
      part: partDoc,
      position: [0, 0, 0],
      rotation: [90, 0, 0],
    });
    const rotatedResult = evaluateDocument(rotatedDoc);
    expect(rotatedResult.ok).toBe(true);
    if (!rotatedResult.ok) return;
    const rotatedShape = rotatedResult.shape as Shape3D;
    const bbox1 = rotatedShape.boundingBox;
    // X軸周りの回転なのでX方向の寸法は不変、Y/Zの外形寸法が入れ替わる。
    expect(bbox1.width).toBeCloseTo(10, 6);
    expect(bbox1.height).toBeCloseTo(2, 6);
    expect(bbox1.depth).toBeCloseTo(4, 6);
    bbox1.delete();
    rotatedShape.delete();
  });

  it("③ 部品(part)内にpartInstanceを含む(入れ子)ドキュメントの評価は明確なエラーになる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const innerPart = boxDoc(10, 10, 10);
    const { doc: partWithNesting } = addPartInstanceFeature(createEmptyDocument(), {
      name: "Inner",
      part: innerPart,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    });
    const { doc } = addPartInstanceFeature(createEmptyDocument(), {
      name: "Outer",
      part: partWithNesting,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/入れ子/);
    expect(result.message).toContain("Outer");
  });

  it("④ 同一部品docは2回目以降の評価でキャッシュが再利用され、結果も正しい(2箇所配置+速度計測ログ)", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    // 上面4辺にフィレットを付けた、多少コストのある部品にする(キャッシュの効果を確認しやすくするため)。
    const base = boxDoc(20, 20, 5);
    const baseResult = evaluateDocument(base);
    expect(baseResult.ok).toBe(true);
    if (!baseResult.ok) return;
    const topEdges = topFaceEdgeSnapshots(baseResult.shape as Shape3D, 5);
    (baseResult.shape as Shape3D).delete();
    expect(topEdges.length).toBe(4);

    const { doc: partDoc } = addFillet3DFeature(base, {
      name: "Fillet1",
      kind: "fillet",
      size: 2,
      edges: topEdges,
    });

    // 同じ部品を2箇所(異なる位置)に配置する1つのドキュメント。
    const { doc: doc1 } = addPartInstanceFeature(createEmptyDocument(), {
      name: "PartA",
      part: partDoc,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    });
    const { doc } = addPartInstanceFeature(doc1, {
      name: "PartB",
      part: partDoc,
      position: [100, 0, 0],
      rotation: [0, 0, 0],
    });

    const t0 = performance.now();
    const first = evaluateDocument(doc);
    const t1 = performance.now();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const shape1 = first.shape as Shape3D;
    const volume1 = measureVolume(shape1);
    shape1.delete();

    // ドキュメント自体は変えず、もう一度評価する(部品docのJSONは完全に同一なので、
    // Workerメモリキャッシュ[本テストではモジュールスコープを共有する同一プロセス内]により
    // 部品の再評価[loft/fillet等の重い計算]は発生しないはず)。
    const t2 = performance.now();
    const second = evaluateDocument(doc);
    const t3 = performance.now();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const shape2 = second.shape as Shape3D;
    const volume2 = measureVolume(shape2);
    shape2.delete();

    // eslint-disable-next-line no-console
    console.log(
      `[part cache] 1回目(2箇所とも部品未キャッシュの可能性): ${(t1 - t0).toFixed(1)}ms, ` +
        `2回目(2箇所ともキャッシュ済みのはず): ${(t3 - t2).toFixed(1)}ms`,
    );

    // 部品単体の体積を求め、2箇所配置(重ならない位置)なのでちょうど2倍になることを確認する。
    const partOnlyResult = evaluateDocument(partDoc);
    expect(partOnlyResult.ok).toBe(true);
    if (!partOnlyResult.ok) return;
    const partVolume = measureVolume(partOnlyResult.shape as Shape3D);
    (partOnlyResult.shape as Shape3D).delete();

    expect(volume1).toBeCloseTo(partVolume * 2, 3);
    expect(volume2).toBeCloseTo(partVolume * 2, 3);
  });
});

describe("evaluateDocument (WASM統合): bodyGroups(部品ドラッグ配置のヒット判定用、Phase 28a)", () => {
  it("① 離れた位置の2ボディ(newBody×2)で、bodyGroupsが2件になりfaceIdが重複なく正しく分類される", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const empty = createEmptyDocument();
    const rect1 = createRectangleEntity({ width: 20, height: 20 });
    const { doc: doc1, feature: sketch1 } = addSketchFeature(empty, {
      name: "Sketch1",
      plane: { kind: "world", plane: "XY" },
      entities: [rect1],
    });
    const { doc: doc2, feature: extrude1 } = addExtrudeFeature(doc1, {
      name: "Extrude1",
      sketchId: sketch1.id,
      distance: 10,
      direction: 1,
      operation: "newBody",
    });
    const rect2 = createRectangleEntity({ width: 10, height: 10, center: [100, 0] });
    const { doc: doc3, feature: sketch2 } = addSketchFeature(doc2, {
      name: "Sketch2",
      plane: { kind: "world", plane: "XY" },
      entities: [rect2],
    });
    const { doc, feature: extrude2 } = addExtrudeFeature(doc3, {
      name: "Extrude2",
      sketchId: sketch2.id,
      distance: 5,
      direction: 1,
      operation: "newBody",
    });

    const result = evaluateDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    (result.shape as Shape3D).delete();

    // 2つのnewBodyフィーチャー(extrude1/extrude2)それぞれに対応する1件ずつのbodyGroupsになる。
    expect(result.bodyGroups.length).toBe(2);
    const ids = result.bodyGroups.map((g) => g.featureId).sort();
    expect(ids).toEqual([extrude1.id, extrude2.id].sort());

    // 箱(6面)同士なのでどちらも6面、faceIdは互いに重複しない。
    const group1 = result.bodyGroups.find((g) => g.featureId === extrude1.id);
    const group2 = result.bodyGroups.find((g) => g.featureId === extrude2.id);
    expect(group1?.faceIds.length).toBe(6);
    expect(group2?.faceIds.length).toBe(6);
    const overlap = group1!.faceIds.filter((id) => group2!.faceIds.includes(id));
    expect(overlap.length).toBe(0);

    // faceInfo(mesh評価から独立に計算)のfaceIdは、bodyGroupsが集めたfaceIdの和集合と完全一致する
    // (compound化してもfaceIdが変化しないことの確認、Phase 27a snapshotロジックと同じ前提)。
    const allBodyFaceIds = new Set([...(group1?.faceIds ?? []), ...(group2?.faceIds ?? [])]);
    expect(allBodyFaceIds.size).toBe(12);
  });

  it("② 部品配置(partInstance)で作ったボディは、そのpartInstanceフィーチャーのidをfeatureIdに持つbodyGroupsエントリとして識別できる", (ctx) => {
    ctx.skip(!wasmLoaded, SKIP_NOTE);
    const mainDoc = boxDoc(20, 20, 20);
    const partDoc = boxDoc(10, 10, 10);
    const { doc: docWithPart, feature: partFeature } = addPartInstanceFeature(mainDoc, {
      name: "Part1",
      part: partDoc,
      position: [50, 0, 0],
      rotation: [0, 0, 0],
    });

    const result = evaluateDocument(docWithPart);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    (result.shape as Shape3D).delete();

    // 本体(newBodyフィーチャー由来)+部品(partInstanceフィーチャー由来)の2ボディ。
    expect(result.bodyGroups.length).toBe(2);
    const mainNewBody = mainDoc.features.find((f) => f.type === "extrude");
    expect(mainNewBody).toBeDefined();

    const partGroup = result.bodyGroups.find((g) => g.featureId === partFeature.id);
    expect(partGroup).toBeDefined();
    expect(partGroup?.faceIds.length).toBe(6);

    const mainGroup = result.bodyGroups.find((g) => g.featureId === mainNewBody!.id);
    expect(mainGroup).toBeDefined();
    expect(mainGroup?.faceIds.length).toBe(6);

    // 部品側と本体側でfaceIdの重複が無い(独立したボディとして分類されている)。
    const overlap = partGroup!.faceIds.filter((id) => mainGroup!.faceIds.includes(id));
    expect(overlap.length).toBe(0);
  });
});
