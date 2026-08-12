// src/model/threadPositionRef.ts の単体テスト(Phase 46: ねじのスケッチ参照配置、
// Phase 47: 配置スケッチを編集ガイド付きフロー)。
import { describe, expect, it } from "vitest";

import {
  findFaceSketchOnFace,
  listThreadPositionRefCandidates,
  resolvePendingThreadPlacementLink,
  sameFacePlane,
} from "../../src/model/threadPositionRef";
import type { CadDocument, ThreadFeature } from "../../src/model/types";

const thread: ThreadFeature = {
  type: "thread",
  id: "t1",
  name: "M6ねじ1",
  hand: "male",
  preset: "M6",
  length: 10,
  face: { faceId: 1, center: [0, 0, 20], normal: [0, 0, 1] },
  position: [0, 0],
  direction: 1,
};

describe("sameFacePlane", () => {
  it("法線がほぼ平行かつ中心がほぼ一致すればtrue", () => {
    expect(sameFacePlane({ center: [0, 0, 20], normal: [0, 0, 1] }, { center: [0, 0, 20], normal: [0, 0, 1] })).toBe(true);
  });

  it("法線が逆向き(反対面)ならfalse", () => {
    expect(sameFacePlane({ center: [0, 0, 20], normal: [0, 0, 1] }, { center: [0, 0, 20], normal: [0, 0, -1] })).toBe(false);
  });

  it("法線は同じでも中心が離れていれば(平行な別の面)false", () => {
    expect(sameFacePlane({ center: [0, 0, 20], normal: [0, 0, 1] }, { center: [0, 0, 30], normal: [0, 0, 1] })).toBe(false);
  });
});

describe("listThreadPositionRefCandidates", () => {
  const doc: CadDocument = {
    version: 1,
    features: [
      {
        type: "sketch",
        id: "fs1",
        name: "FaceSketch1",
        plane: { kind: "face", featureId: "e1", faceId: 1, center: [0, 0, 20], normal: [0, 0, 1] },
        entities: [
          { kind: "circle", id: "circle1", center: [3, -4], radius: 2 },
          { kind: "circle", id: "circle2", center: [-3, 4], radius: 1 },
          { kind: "rectangle", id: "rect1", center: [0, 0], width: 5, height: 5 },
          { kind: "point", id: "point1", position: [1, 1] },
        ],
      },
      {
        // 異なる面(法線が逆)のスケッチは候補に含めない。
        type: "sketch",
        id: "fs2",
        name: "FaceSketch2",
        plane: { kind: "face", featureId: "e1", faceId: 2, center: [0, 0, 0], normal: [0, 0, -1] },
        entities: [{ kind: "circle", id: "circle3", center: [0, 0], radius: 1 }],
      },
      {
        // world平面のスケッチも候補に含めない(面上スケッチのみ対象)。
        type: "sketch",
        id: "s3",
        name: "Sketch3",
        plane: { kind: "world", plane: "XY" },
        entities: [{ kind: "circle", id: "circle4", center: [0, 0], radius: 1 }],
      },
    ],
  };
  const sketchPlanes = [
    { sketchId: "fs1", origin: [0, 0, 20] as [number, number, number], normal: [0, 0, 1] as [number, number, number] },
    { sketchId: "fs2", origin: [0, 0, 0] as [number, number, number], normal: [0, 0, -1] as [number, number, number] },
  ];

  it("同じ面のface参照スケッチが持つcircle/pointエンティティのみを候補として返す(Phase 47でpointも対象に追加)", () => {
    const candidates = listThreadPositionRefCandidates(doc, thread, sketchPlanes);
    expect(candidates).toEqual([
      { sketchId: "fs1", entityId: "circle1", label: "FaceSketch1 の 円1" },
      { sketchId: "fs1", entityId: "circle2", label: "FaceSketch1 の 円2" },
      { sketchId: "fs1", entityId: "point1", label: "FaceSketch1 の 点4" },
    ]);
  });

  it("平面が未解決(sketchPlanesに無い)スケッチは候補から除外する", () => {
    const candidates = listThreadPositionRefCandidates(doc, thread, []);
    expect(candidates).toEqual([]);
  });

  // Phase 47: バグ修正のリグレッションテスト。thread.face.center(初回配置クリック時点の値)が
  // 上流フィーチャーの変更(箱の寸法変更等)で古びても、直近評価で実際に解決した配置面
  // (threadFacePlane引数)を渡せば候補が正しく見つかる。
  it("thread.face.centerが古びていても、threadFacePlane(直近の再解決値)を渡せば候補が見つかる", () => {
    // このthreadは face.center=[0,0,20] のまま(初回配置時のクリック値、以後不変)だが、
    // 実際には箱の寸法変更で面がZ=30へ移動済み(sketchPlanesの新しいoriginと一致)という想定。
    const movedSketchPlanes = [{ sketchId: "fs1", origin: [0, 0, 30] as [number, number, number], normal: [0, 0, 1] as [number, number, number] }];

    // 修正前の挙動(threadFacePlane省略、thread.face.centerへフォールバック)では見つからない。
    expect(listThreadPositionRefCandidates(doc, thread, movedSketchPlanes)).toEqual([]);

    // threadFacePlane(evaluator.tsが今回の評価で実際に解決した配置面)を渡すと正しく見つかる。
    const candidates = listThreadPositionRefCandidates(doc, thread, movedSketchPlanes, { center: [0, 0, 30], normal: [0, 0, 1] });
    expect(candidates).toEqual([
      { sketchId: "fs1", entityId: "circle1", label: "FaceSketch1 の 円1" },
      { sketchId: "fs1", entityId: "circle2", label: "FaceSketch1 の 円2" },
      { sketchId: "fs1", entityId: "point1", label: "FaceSketch1 の 点4" },
    ]);
  });
});

describe("findFaceSketchOnFace", () => {
  const doc: CadDocument = {
    version: 1,
    features: [
      {
        type: "sketch",
        id: "fs1",
        name: "FaceSketch1",
        plane: { kind: "face", featureId: "e1", faceId: 1, center: [0, 0, 20], normal: [0, 0, 1] },
        entities: [],
      },
      {
        type: "sketch",
        id: "fs2",
        name: "FaceSketch2",
        plane: { kind: "face", featureId: "e1", faceId: 2, center: [0, 0, 0], normal: [0, 0, -1] },
        entities: [],
      },
      {
        type: "sketch",
        id: "s3",
        name: "Sketch3",
        plane: { kind: "world", plane: "XY" },
        entities: [],
      },
    ],
  };
  const sketchPlanes = [
    { sketchId: "fs1", origin: [0, 0, 20] as [number, number, number], normal: [0, 0, 1] as [number, number, number] },
    { sketchId: "fs2", origin: [0, 0, 0] as [number, number, number], normal: [0, 0, -1] as [number, number, number] },
  ];

  it("同じ面のface参照スケッチを返す(図形の有無は問わない)", () => {
    const found = findFaceSketchOnFace(doc, { center: [0, 0, 20], normal: [0, 0, 1] }, sketchPlanes);
    expect(found?.id).toBe("fs1");
  });

  it("一致する面が無ければnull", () => {
    const found = findFaceSketchOnFace(doc, { center: [0, 0, 99], normal: [0, 0, 1] }, sketchPlanes);
    expect(found).toBeNull();
  });
});

describe("resolvePendingThreadPlacementLink(Phase 47: 配置スケッチを編集ガイド付きフロー)", () => {
  function buildDoc(
    threadPositionRef: ThreadFeature["positionRef"],
    sketchEntities: { kind: "point" | "circle"; id: string; position?: [number, number]; center?: [number, number]; radius?: number }[],
  ): CadDocument {
    return {
      version: 1,
      features: [
        {
          type: "sketch",
          id: "fs1",
          name: "ThreadSketch1",
          plane: { kind: "face", featureId: "e1", faceId: 1, center: [0, 0, 20], normal: [0, 0, 1] },
          entities: sketchEntities.map((e) =>
            e.kind === "point" ? { kind: "point", id: e.id, position: e.position ?? [0, 0] } : { kind: "circle", id: e.id, center: e.center ?? [0, 0], radius: e.radius ?? 1 },
          ),
        },
        {
          type: "thread",
          id: "t1",
          name: "M6ねじ1",
          hand: "male",
          preset: "M6",
          length: 10,
          face: { faceId: 1, center: [0, 0, 20], normal: [0, 0, 1] },
          position: [0, 0],
          direction: 1,
          ...(threadPositionRef ? { positionRef: threadPositionRef } : {}),
        },
      ],
    };
  }

  it("スケッチに点が1つあれば、それをpositionRef候補として返す", () => {
    const doc = buildDoc(undefined, [{ kind: "point", id: "pt1", position: [3, 4] }]);
    const result = resolvePendingThreadPlacementLink(doc, { threadId: "t1", sketchId: "fs1" });
    expect(result).toEqual({ entityId: "pt1", label: "点1" });
  });

  it("複数の点があれば最後(最新)の点を返す", () => {
    const doc = buildDoc(undefined, [
      { kind: "point", id: "pt1", position: [1, 1] },
      { kind: "point", id: "pt2", position: [2, 2] },
    ]);
    const result = resolvePendingThreadPlacementLink(doc, { threadId: "t1", sketchId: "fs1" });
    expect(result).toEqual({ entityId: "pt2", label: "点2" });
  });

  it("点が1つも無ければnull(circleがあってもpositionRef候補にはしない)", () => {
    const doc = buildDoc(undefined, [{ kind: "circle", id: "c1", center: [0, 0], radius: 5 }]);
    expect(resolvePendingThreadPlacementLink(doc, { threadId: "t1", sketchId: "fs1" })).toBeNull();
  });

  it("threadに既にpositionRefが設定済みならnull(上書きしない)", () => {
    const doc = buildDoc({ sketchId: "other", entityId: "x" }, [{ kind: "point", id: "pt1", position: [1, 1] }]);
    expect(resolvePendingThreadPlacementLink(doc, { threadId: "t1", sketchId: "fs1" })).toBeNull();
  });

  it("対象のthread/sketchが存在しなければnull", () => {
    const doc = buildDoc(undefined, [{ kind: "point", id: "pt1", position: [1, 1] }]);
    expect(resolvePendingThreadPlacementLink(doc, { threadId: "missing", sketchId: "fs1" })).toBeNull();
    expect(resolvePendingThreadPlacementLink(doc, { threadId: "t1", sketchId: "missing" })).toBeNull();
  });
});
