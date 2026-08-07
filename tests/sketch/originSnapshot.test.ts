// src/sketch/originSnapshot.ts の単体テスト(純粋TS、WASM不要)。
// updateReferenceEdgeSnapshots(src/sketch/referenceEdgeMatch.ts)と対になる、原点系拘束の
// originLocalスナップショット追従の検証。
import { describe, expect, it } from "vitest";

import type { CadDocument, SketchFeature } from "../../src/model/types";
import type { SketchPlaneInfo } from "../../src/protocol/messages";
import { updateOriginSnapshots } from "../../src/sketch/originSnapshot";

function sketchDoc(constraints: SketchFeature["constraints"]): CadDocument {
  const sketch: SketchFeature = {
    type: "sketch",
    id: "sketch1",
    name: "Sketch1",
    plane: { kind: "world", plane: "XY" },
    entities: [{ kind: "circle", id: "c1", center: [10, 10], radius: 5 }],
    constraints,
  };
  return { version: 1, features: [sketch] };
}

describe("updateOriginSnapshots", () => {
  it("① 面上スケッチ相当(sketchPlanes.origin≠[0,0,0])のdistanceEntityOrigin拘束にoriginLocalが書き込まれる(箱を(30,20)中心で作った上面スケッチ相当)", () => {
    const doc = sketchDoc([{ id: "d1", kind: "distanceEntityOrigin", entity: { entityId: "c1" }, value: 25 }]);
    const sketchPlanes: SketchPlaneInfo[] = [
      { sketchId: "sketch1", origin: [30, 20, 10], xDir: [1, 0, 0], yDir: [0, 1, 0], normal: [0, 0, 1] },
    ];
    const next = updateOriginSnapshots(doc, sketchPlanes);
    const feature = next.features[0] as SketchFeature;
    const constraint = feature.constraints?.[0];
    expect(constraint?.kind).toBe("distanceEntityOrigin");
    if (constraint?.kind !== "distanceEntityOrigin") return;
    expect(constraint.originLocal?.[0]).toBeCloseTo(-30, 6);
    expect(constraint.originLocal?.[1]).toBeCloseTo(-20, 6);
  });

  it("② world平面(sketchPlanes.origin=[0,0,0])ではoriginLocalが[0,0]になる", () => {
    const doc = sketchDoc([{ id: "d1", kind: "distancePointOrigin", point: { segmentId: "s1", end: "p1" }, value: 10 }]);
    const sketchPlanes: SketchPlaneInfo[] = [
      { sketchId: "sketch1", origin: [0, 0, 0], xDir: [1, 0, 0], yDir: [0, 1, 0], normal: [0, 0, 1] },
    ];
    const next = updateOriginSnapshots(doc, sketchPlanes);
    const feature = next.features[0] as SketchFeature;
    const constraint = feature.constraints?.[0];
    expect(constraint?.kind).toBe("distancePointOrigin");
    if (constraint?.kind !== "distancePointOrigin") return;
    expect(constraint.originLocal?.[0]).toBeCloseTo(0, 6);
    expect(constraint.originLocal?.[1]).toBeCloseTo(0, 6);
  });

  it("③ 値が変わらなければ元のdoc参照をそのまま返す(不要な再レンダリング防止)", () => {
    const doc = sketchDoc([{ id: "o1", kind: "coincidentOrigin", point: { entityId: "c1" }, originLocal: [-30, -20] }]);
    const sketchPlanes: SketchPlaneInfo[] = [
      { sketchId: "sketch1", origin: [30, 20, 10], xDir: [1, 0, 0], yDir: [0, 1, 0], normal: [0, 0, 1] },
    ];
    const next = updateOriginSnapshots(doc, sketchPlanes);
    expect(next).toBe(doc);
  });

  it("④ 対応するsketchPlanesが無いスケッチ(面解決失敗等)はそのまま(変更しない)", () => {
    const doc = sketchDoc([{ id: "d1", kind: "distanceEntityOrigin", entity: { entityId: "c1" }, value: 25 }]);
    const next = updateOriginSnapshots(doc, []);
    expect(next).toBe(doc);
  });
});
