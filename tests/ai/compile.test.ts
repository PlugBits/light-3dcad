// src/ai/compile.ts の単体テスト(Phase 37)。
import { describe, expect, it } from "vitest";

import { compileAuthoringModel } from "../../src/ai/compile";
import type { ExtrudeFeature, RevolveFeature, SketchFeature } from "../../src/model/types";

function fullValidExample() {
  return {
    sketches: [
      {
        id: "s1",
        plane: "XY",
        entities: [
          { kind: "rectangle", id: "outer", center: [0, 0], width: 100, height: 50 },
          { kind: "circle", id: "hole", center: [0, 0], radius: 10 },
        ],
        segments: [],
        constraints: [],
      },
    ],
    features: [
      { type: "extrude", id: null, sketch: "s1", distance: 10, operation: "newBody", direction: 1, targetBody: null },
    ],
  };
}

describe("compileAuthoringModel: 正常系", () => {
  it("有効な最小例からCadDocumentへ変換できる(rectangle+入れ子circle→extrude)", () => {
    const result = compileAuthoringModel(fullValidExample());
    expect("doc" in result).toBe(true);
    if (!("doc" in result)) throw new Error("unreachable");
    expect(result.doc.version).toBe(1);
    expect(result.doc.features).toHaveLength(2);
    const sketch = result.doc.features[0] as SketchFeature;
    expect(sketch.type).toBe("sketch");
    expect(sketch.name).toBe("Sketch1");
    expect(sketch.plane).toEqual({ kind: "world", plane: "XY" });
    expect(sketch.entities).toHaveLength(2);
    expect(sketch.entities[0]).toMatchObject({ kind: "rectangle", center: [0, 0], width: 100, height: 50 });
    expect(sketch.entities[1]).toMatchObject({ kind: "circle", center: [0, 0], radius: 10 });

    const extrude = result.doc.features[1] as ExtrudeFeature;
    expect(extrude.type).toBe("extrude");
    expect(extrude.name).toBe("Extrude1");
    expect(extrude.sketchId).toBe(sketch.id);
    expect(extrude.distance).toBe(10);
    expect(extrude.direction).toBe(1);
    expect(extrude.operation).toBe("newBody");
    expect(extrude.targetBodyId).toBeUndefined();
  });

  it("direction/targetBodyがnullなら省略時の既定値になる(direction=1、targetBodyId未設定)", () => {
    const model = fullValidExample();
    const result = compileAuthoringModel(model);
    if (!("doc" in result)) throw new Error("unreachable");
    const extrude = result.doc.features[1] as ExtrudeFeature;
    expect(extrude.direction).toBe(1);
    expect("targetBodyId" in extrude).toBe(false);
  });

  it("cut操作でtargetBodyを明示指定して先行するnewBodyを解決できる", () => {
    const model = {
      sketches: [
        { id: "s1", plane: "XY", entities: [{ kind: "rectangle", id: "e1", center: [0, 0], width: 100, height: 50 }], segments: [], constraints: [] },
        { id: "s2", plane: "XY", entities: [{ kind: "circle", id: "e2", center: [0, 0], radius: 5 }], segments: [], constraints: [] },
      ],
      features: [
        { type: "extrude", id: "base", sketch: "s1", distance: 10, operation: "newBody", direction: 1, targetBody: null },
        { type: "extrude", id: null, sketch: "s2", distance: 20, operation: "cut", direction: -1, targetBody: "base" },
      ],
    };
    const result = compileAuthoringModel(model);
    if (!("doc" in result)) throw new Error(`expected success, got errors: ${JSON.stringify((result as { errors: string[] }).errors)}`);
    // features順序: [sketch1, sketch2, extrude(newBody), extrude(cut)]
    const [sketch1, , newBodyFeature, cutFeature] = result.doc.features;
    const cut = cutFeature as ExtrudeFeature;
    expect(cut.operation).toBe("cut");
    expect(cut.targetBodyId).toBe((newBodyFeature as ExtrudeFeature).id);
    expect(sketch1.type).toBe("sketch");
  });

  it("revolveでangle/axis省略(null)時は360度・省略targetBodyが解決される", () => {
    const model = {
      sketches: [{ id: "s1", plane: "XY", entities: [{ kind: "rectangle", id: "e1", center: [10, 0], width: 10, height: 20 }], segments: [], constraints: [] }],
      features: [{ type: "revolve", id: null, sketch: "s1", axis: "y", angle: null, operation: "newBody", targetBody: null }],
    };
    const result = compileAuthoringModel(model);
    if (!("doc" in result)) throw new Error("unreachable");
    const revolve = result.doc.features[1] as RevolveFeature;
    expect(revolve.angle).toBe(360);
    expect(revolve.axis).toBe("y");
  });

  it("segments+constraints(horizontal/vertical/coincident/distance/radius)を内部SketchConstraintへ変換する", () => {
    const model = {
      sketches: [
        {
          id: "s1",
          plane: "XY",
          entities: [],
          segments: [
            { kind: "line", id: "seg1", p1: [0, 0], p2: [10, 0] },
            { kind: "arc", id: "seg2", p1: [10, 0], p2: [10, 10], bulge: 0.5 },
          ],
          constraints: [
            { kind: "horizontal", segment: "seg1" },
            { kind: "vertical", segment: "seg1" },
            { kind: "coincident", a: { segment: "seg1", point: "end" }, b: { segment: "seg2", point: "start" } },
            { kind: "distance", a: { segment: "seg1", point: "start" }, b: { segment: "seg1", point: "end" }, value: 10 },
            { kind: "radius", segment: "seg2", value: 5 },
          ],
        },
      ],
      features: [{ type: "extrude", id: null, sketch: "s1", distance: 5, operation: "newBody", direction: 1, targetBody: null }],
    };
    const result = compileAuthoringModel(model);
    if (!("doc" in result)) throw new Error(`expected success, got errors: ${JSON.stringify((result as { errors: string[] }).errors)}`);
    const sketch = result.doc.features[0] as SketchFeature;
    expect(sketch.segments).toHaveLength(2);
    expect(sketch.constraints).toHaveLength(5);
    const coincident = sketch.constraints?.find((c) => c.kind === "coincident");
    expect(coincident).toMatchObject({ kind: "coincident", a: { segmentId: "seg1", end: "p2" }, b: { segmentId: "seg2", end: "p1" } });
    const radius = sketch.constraints?.find((c) => c.kind === "radius");
    expect(radius).toMatchObject({ kind: "radius", segmentId: "seg2", value: 5 });
  });
});

describe("compileAuthoringModel: 意味的エラー(日本語+JSONパス)", () => {
  it("features[].sketchが解決できないIDを参照している(タスク仕様の例と同じ文言)", () => {
    const model = {
      sketches: [{ id: "s1", plane: "XY", entities: [{ kind: "rectangle", id: "e1", center: [0, 0], width: 10, height: 10 }], segments: [], constraints: [] }],
      features: [
        { type: "extrude", id: null, sketch: "s1", distance: 5, operation: "newBody", direction: 1, targetBody: null },
        { type: "extrude", id: null, sketch: "s9", distance: 5, operation: "newBody", direction: 1, targetBody: null },
      ],
    };
    const result = compileAuthoringModel(model);
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("unreachable");
    expect(result.errors).toContain('features[1].sketch: "s9" というIDのスケッチがありません');
  });

  it("ボディが存在しない状態でcut操作を行おうとするとエラーになる", () => {
    const model = {
      sketches: [{ id: "s1", plane: "XY", entities: [{ kind: "circle", id: "e1", center: [0, 0], radius: 5 }], segments: [], constraints: [] }],
      features: [{ type: "extrude", id: null, sketch: "s1", distance: 5, operation: "cut", direction: 1, targetBody: null }],
    };
    const result = compileAuthoringModel(model);
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("unreachable");
    expect(result.errors.some((e) => e.includes("ボディが1つも作られていない"))).toBe(true);
  });

  it("targetBodyが未知のIDを参照しているとエラーになる", () => {
    const model = {
      sketches: [
        { id: "s1", plane: "XY", entities: [{ kind: "rectangle", id: "e1", center: [0, 0], width: 10, height: 10 }], segments: [], constraints: [] },
        { id: "s2", plane: "XY", entities: [{ kind: "circle", id: "e2", center: [0, 0], radius: 2 }], segments: [], constraints: [] },
      ],
      features: [
        { type: "extrude", id: "base", sketch: "s1", distance: 10, operation: "newBody", direction: 1, targetBody: null },
        { type: "extrude", id: null, sketch: "s2", distance: 5, operation: "cut", direction: 1, targetBody: "does-not-exist" },
      ],
    };
    const result = compileAuthoringModel(model);
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("unreachable");
    expect(result.errors.some((e) => e.includes('"does-not-exist" という'))).toBe(true);
  });

  it("非正の寸法(width<=0)はエラーになる", () => {
    const model = {
      sketches: [{ id: "s1", plane: "XY", entities: [{ kind: "rectangle", id: "e1", center: [0, 0], width: 0, height: 10 }], segments: [], constraints: [] }],
      features: [{ type: "extrude", id: null, sketch: "s1", distance: 5, operation: "newBody", direction: 1, targetBody: null }],
    };
    const result = compileAuthoringModel(model);
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("unreachable");
    expect(result.errors).toContain("sketches[0].entities[0].width: 正の数である必要があります");
  });

  it("押し出し距離が負の場合もエラーになる", () => {
    const model = {
      sketches: [{ id: "s1", plane: "XY", entities: [{ kind: "circle", id: "e1", center: [0, 0], radius: 5 }], segments: [], constraints: [] }],
      features: [{ type: "extrude", id: null, sketch: "s1", distance: -5, operation: "newBody", direction: 1, targetBody: null }],
    };
    const result = compileAuthoringModel(model);
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("unreachable");
    expect(result.errors).toContain("features[0].distance: 正の数である必要があります");
  });

  it("図形もセグメントも無いスケッチ(プロファイルが作れない)はエラーになる", () => {
    const model = {
      sketches: [{ id: "s1", plane: "XY", entities: [], segments: [], constraints: [] }],
      features: [{ type: "extrude", id: null, sketch: "s1", distance: 5, operation: "newBody", direction: 1, targetBody: null }],
    };
    const result = compileAuthoringModel(model);
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("unreachable");
    expect(result.errors.some((e) => e.startsWith("sketches[0]:") && e.includes("プロファイルを作れません"))).toBe(true);
  });

  it("半径拘束をline(円弧でない)セグメントに指定するとエラーになる", () => {
    const model = {
      sketches: [
        {
          id: "s1",
          plane: "XY",
          entities: [],
          segments: [{ kind: "line", id: "seg1", p1: [0, 0], p2: [10, 0] }],
          constraints: [{ kind: "radius", segment: "seg1", value: 5 }],
        },
      ],
      features: [{ type: "extrude", id: null, sketch: "s1", distance: 5, operation: "newBody", direction: 1, targetBody: null }],
    };
    const result = compileAuthoringModel(model);
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("unreachable");
    expect(result.errors.some((e) => e.includes("円弧セグメントにのみ指定できます"))).toBe(true);
  });

  it("拘束が存在しないセグメントIDを参照しているとエラーになる", () => {
    const model = {
      sketches: [
        {
          id: "s1",
          plane: "XY",
          entities: [],
          segments: [{ kind: "line", id: "seg1", p1: [0, 0], p2: [10, 0] }],
          constraints: [{ kind: "horizontal", segment: "does-not-exist" }],
        },
      ],
      features: [{ type: "extrude", id: null, sketch: "s1", distance: 5, operation: "newBody", direction: 1, targetBody: null }],
    };
    const result = compileAuthoringModel(model);
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("unreachable");
    expect(result.errors.some((e) => e.includes('"does-not-exist" というIDのセグメントが見つかりません'))).toBe(true);
  });

  it("regularPolygonのsidesが範囲外(3〜24)だとエラーになる", () => {
    const model = {
      sketches: [{ id: "s1", plane: "XY", entities: [{ kind: "regularPolygon", id: "e1", center: [0, 0], radius: 10, sides: 2, rotation: null }], segments: [], constraints: [] }],
      features: [{ type: "extrude", id: null, sketch: "s1", distance: 5, operation: "newBody", direction: 1, targetBody: null }],
    };
    const result = compileAuthoringModel(model);
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("unreachable");
    expect(result.errors).toContain("sketches[0].entities[0].sides: 3〜24の整数である必要があります");
  });

  it("revolveのangleが0以下または360より大きいとエラーになる", () => {
    const model = {
      sketches: [{ id: "s1", plane: "XY", entities: [{ kind: "circle", id: "e1", center: [10, 0], radius: 5 }], segments: [], constraints: [] }],
      features: [{ type: "revolve", id: null, sketch: "s1", axis: "y", angle: 400, operation: "newBody", targetBody: null }],
    };
    const result = compileAuthoringModel(model);
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("unreachable");
    expect(result.errors.some((e) => e.startsWith("features[0].angle:"))).toBe(true);
  });

  it("スケッチIDが重複しているとエラーになる", () => {
    const model = {
      sketches: [
        { id: "s1", plane: "XY", entities: [{ kind: "circle", id: "e1", center: [0, 0], radius: 5 }], segments: [], constraints: [] },
        { id: "s1", plane: "XY", entities: [{ kind: "circle", id: "e2", center: [0, 0], radius: 3 }], segments: [], constraints: [] },
      ],
      features: [{ type: "extrude", id: null, sketch: "s1", distance: 5, operation: "newBody", direction: 1, targetBody: null }],
    };
    const result = compileAuthoringModel(model);
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("unreachable");
    expect(result.errors.some((e) => e.includes('スケッチID "s1" が重複しています'))).toBe(true);
  });

  it("ルートがオブジェクトでない・sketches/featuresが配列でない場合もエラーを返す(例外を投げない)", () => {
    expect("errors" in compileAuthoringModel(null)).toBe(true);
    expect("errors" in compileAuthoringModel("not json")).toBe(true);
    expect("errors" in compileAuthoringModel({})).toBe(true);
    expect("errors" in compileAuthoringModel({ sketches: [], features: [] })).toBe(true);
  });
});
