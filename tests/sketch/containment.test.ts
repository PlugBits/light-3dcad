// src/sketch/containment.ts の単体テスト(純粋TS、WASM不要)。
import { describe, expect, it } from "vitest";

import { classifySketchEntities, isContained } from "../../src/sketch/containment";
import { createCircleEntity, createPolygonEntity, createRectangleEntity } from "../../src/model";

describe("isContained", () => {
  it("矩形の内側に完全に収まる円は含まれる(含む)", () => {
    const rect = createRectangleEntity({ width: 60, height: 40 });
    const circle = createCircleEntity({ radius: 10 });
    expect(isContained(circle, rect)).toBe(true);
    expect(isContained(rect, circle)).toBe(false);
  });

  it("部分的に重なる矩形と円は含まれない(交差)", () => {
    const rect = createRectangleEntity({ width: 60, height: 40 });
    const circle = createCircleEntity({ radius: 10, center: [55, 0] });
    expect(isContained(circle, rect)).toBe(false);
    expect(isContained(rect, circle)).toBe(false);
  });

  it("完全に離れた円は含まれない(外)", () => {
    const rect = createRectangleEntity({ width: 60, height: 40 });
    const circle = createCircleEntity({ radius: 10, center: [500, 500] });
    expect(isContained(circle, rect)).toBe(false);
    expect(isContained(rect, circle)).toBe(false);
  });

  it("円の中に完全に収まる小さい円は含まれる(ドーナツ形状の判定)", () => {
    const outer = createCircleEntity({ radius: 20 });
    const inner = createCircleEntity({ radius: 5 });
    expect(isContained(inner, outer)).toBe(true);
    expect(isContained(outer, inner)).toBe(false);
  });

  it("多角形の内側に完全に収まる矩形は含まれる", () => {
    const outer = createPolygonEntity({
      points: [
        [-50, -50],
        [50, -50],
        [50, 50],
        [-50, 50],
      ],
    });
    const inner = createRectangleEntity({ width: 10, height: 10 });
    expect(isContained(inner, outer)).toBe(true);
  });

  it("同一サイズ・同一位置の矩形同士は互いに含まれない(相互包含の防止)", () => {
    const a = createRectangleEntity({ width: 20, height: 20 });
    const b = createRectangleEntity({ width: 20, height: 20 });
    expect(isContained(a, b)).toBe(false);
    expect(isContained(b, a)).toBe(false);
  });
});

describe("classifySketchEntities", () => {
  it("矩形の中に円1つ: 矩形がouter、円がholeに分類される", () => {
    const rect = createRectangleEntity({ width: 60, height: 40 });
    const circle = createCircleEntity({ radius: 10 });
    const { outers, holes } = classifySketchEntities([rect, circle]);
    expect(outers.map((e) => e.id)).toEqual([rect.id]);
    expect(holes.map((e) => e.id)).toEqual([circle.id]);
  });

  it("部分的に重なるだけの2図形は両方outerのまま(従来どおりfuse対象)", () => {
    const rect = createRectangleEntity({ width: 60, height: 40 });
    const circle = createCircleEntity({ radius: 10, center: [55, 0] });
    const { outers, holes } = classifySketchEntities([rect, circle]);
    expect(outers.map((e) => e.id).sort()).toEqual([circle.id, rect.id].sort());
    expect(holes).toHaveLength(0);
  });

  it("単一エンティティのみの場合はouterに分類される", () => {
    const rect = createRectangleEntity({ width: 10, height: 10 });
    const { outers, holes } = classifySketchEntities([rect]);
    expect(outers).toHaveLength(1);
    expect(holes).toHaveLength(0);
  });
});
