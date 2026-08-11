// src/model/threadPositionRef.ts の単体テスト(Phase 46: ねじのスケッチ参照配置)。
import { describe, expect, it } from "vitest";

import { listThreadPositionRefCandidates, sameFacePlane } from "../../src/model/threadPositionRef";
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

  it("同じ面のface参照スケッチが持つcircleエンティティのみを候補として返す", () => {
    const candidates = listThreadPositionRefCandidates(doc, thread, sketchPlanes);
    expect(candidates).toEqual([
      { sketchId: "fs1", entityId: "circle1", label: "FaceSketch1 の 円1" },
      { sketchId: "fs1", entityId: "circle2", label: "FaceSketch1 の 円2" },
    ]);
  });

  it("平面が未解決(sketchPlanesに無い)スケッチは候補から除外する", () => {
    const candidates = listThreadPositionRefCandidates(doc, thread, []);
    expect(candidates).toEqual([]);
  });
});
