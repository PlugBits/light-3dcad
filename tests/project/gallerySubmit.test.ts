// src/project/gallerySubmit.ts の単体テスト(Phase 40d、「ギャラリーに投稿」ダイアログのURL組み立て)。
import { describe, expect, it } from "vitest";

import {
  buildGallerySubmissionUrl,
  GALLERY_SUBMISSION_ISSUES_NEW_URL,
  GALLERY_SUBMISSION_TEMPLATE,
  type GallerySubmitFields,
} from "../../src/project/gallerySubmit";

const FIELDS: GallerySubmitFields = {
  title: "L字ブラケット",
  author: "yourname",
  description: "60×50mm・厚さ15mmのL字形状ブラケット",
  tags: "ブラケット, L字",
};

const SHARE_LINK_URL = "https://plugbits.github.io/light-3dcad/#m=abcXYZ-_123";

describe("buildGallerySubmissionUrl", () => {
  it("既定ではモデルデータ込みのURLを組み立てる(payloadIncluded: true)", () => {
    const result = buildGallerySubmissionUrl(FIELDS, SHARE_LINK_URL);
    expect(result.payloadIncluded).toBe(true);
    expect(result.url.startsWith(`${GALLERY_SUBMISSION_ISSUES_NEW_URL}?`)).toBe(true);

    const url = new URL(result.url);
    expect(url.searchParams.get("template")).toBe(GALLERY_SUBMISSION_TEMPLATE);
    expect(url.searchParams.get("labels")).toBe("model-submission");
    expect(url.searchParams.get("title")).toBe("[モデル投稿] L字ブラケット");
    expect(url.searchParams.get("model_title")).toBe("L字ブラケット");
    expect(url.searchParams.get("author_name")).toBe("yourname");
    expect(url.searchParams.get("description")).toBe(FIELDS.description);
    expect(url.searchParams.get("tags")).toBe(FIELDS.tags);
    expect(url.searchParams.get("model_data")).toBe(SHARE_LINK_URL);
  });

  it("タグが空文字列の場合はtagsパラメータを付けない", () => {
    const result = buildGallerySubmissionUrl({ ...FIELDS, tags: "  " }, SHARE_LINK_URL);
    const url = new URL(result.url);
    expect(url.searchParams.has("tags")).toBe(false);
  });

  it("baseUrl/templateはオプションで差し替えられる", () => {
    const result = buildGallerySubmissionUrl(FIELDS, SHARE_LINK_URL, {
      baseUrl: "https://example.com/x/issues/new",
      template: "custom.yml",
    });
    expect(result.url.startsWith("https://example.com/x/issues/new?")).toBe(true);
    expect(new URL(result.url).searchParams.get("template")).toBe("custom.yml");
  });

  it("URLがlengthLimitを超える場合、model_dataを除いたフォールバックURLを返す(payloadIncluded: false)", () => {
    const longPayloadUrl = `https://plugbits.github.io/light-3dcad/#m=${"a".repeat(9000)}`;
    const result = buildGallerySubmissionUrl(FIELDS, longPayloadUrl, { lengthLimit: 7000 });
    expect(result.payloadIncluded).toBe(false);
    const url = new URL(result.url);
    expect(url.searchParams.has("model_data")).toBe(false);
    // フォールバックURLでも他のフィールドは事前入力されたままであること。
    expect(url.searchParams.get("model_title")).toBe("L字ブラケット");
    expect(result.url.length).toBeLessThan(longPayloadUrl.length);
  });

  it("lengthLimitちょうどの長さは含む側(payloadIncluded: true)として扱う", () => {
    const result = buildGallerySubmissionUrl(FIELDS, SHARE_LINK_URL);
    const exactLimit = result.url.length;
    const exact = buildGallerySubmissionUrl(FIELDS, SHARE_LINK_URL, { lengthLimit: exactLimit });
    expect(exact.payloadIncluded).toBe(true);
    const overByOne = buildGallerySubmissionUrl(FIELDS, SHARE_LINK_URL, { lengthLimit: exactLimit - 1 });
    expect(overByOne.payloadIncluded).toBe(false);
  });
});
