// src/project/galleryLoad.ts の単体テスト(Phase 40c、モデルギャラリーの起動時ロード)。
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addExtrudeFeature,
  addSketchFeature,
  createEmptyDocument,
  createRectangleEntity,
} from "../../src/model";
import { serializeProject } from "../../src/project/serialization";
import { extractGallerySlug, fetchGalleryModel, stripGallerySlugFromSearch } from "../../src/project/galleryLoad";

function sampleDocText() {
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
  return serializeProject(doc);
}

describe("extractGallerySlug", () => {
  it("gパラメータがあればslugを返す", () => {
    expect(extractGallerySlug("?g=ring")).toBe("ring");
  });
  it("gパラメータが無ければnull", () => {
    expect(extractGallerySlug("")).toBeNull();
    expect(extractGallerySlug("?foo=bar")).toBeNull();
  });
  it("gパラメータが空文字列ならnull", () => {
    expect(extractGallerySlug("?g=")).toBeNull();
  });
});

describe("stripGallerySlugFromSearch", () => {
  it("gパラメータのみを取り除く", () => {
    expect(stripGallerySlugFromSearch("?g=ring")).toBe("");
  });
  it("他のパラメータは保持する", () => {
    expect(stripGallerySlugFromSearch("?g=ring&foo=bar")).toBe("?foo=bar");
  });
  it("gパラメータが無ければそのまま(空はそのまま空)", () => {
    expect(stripGallerySlugFromSearch("")).toBe("");
  });
});

describe("fetchGalleryModel", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("成功時はCadDocumentを返す", async () => {
    const text = sampleDocText();
    global.fetch = vi.fn(async (url: unknown) => {
      expect(url).toBe("/models/ring/model.l3dcad");
      return new Response(text, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchGalleryModel("/", "ring");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc.features.length).toBe(2);
    }
  });

  it("404の場合はok:falseを返す(例外を投げない)", async () => {
    global.fetch = vi.fn(async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const result = await fetchGalleryModel("/", "does-not-exist");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("404");
    }
  });

  it("ネットワークエラーの場合もok:falseを返す(例外を投げない)", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await fetchGalleryModel("/", "ring");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("network down");
    }
  });

  it("不正なJSONの場合もok:falseを返す(deserializeProjectの検証に委譲)", async () => {
    global.fetch = vi.fn(async () => new Response("{ not json", { status: 200 })) as unknown as typeof fetch;
    const result = await fetchGalleryModel("/", "ring");
    expect(result.ok).toBe(false);
  });

  it("BASE_URLが/light-3dcad/の場合、その配下のパスをfetchする", async () => {
    const text = sampleDocText();
    global.fetch = vi.fn(async (url: unknown) => {
      expect(url).toBe("/light-3dcad/models/ring/model.l3dcad");
      return new Response(text, { status: 200 });
    }) as unknown as typeof fetch;
    await fetchGalleryModel("/light-3dcad/", "ring");
  });
});
