// scripts/decode-share-link.mjs の単体テスト(Phase 40d)。
// src/project/shareLink.ts の encodeShareLinkPayload()(ブラウザ標準CompressionStream使用)で
// 作った共有リンクペイロードを、GitHub Actions側で使うnode:zlibベースの独立実装
// (scripts/decode-share-link.mjs)で正しく伸長できること(=同じgzip+base64url形式であること)を
// 検証する。
import { describe, expect, it } from "vitest";

import {
  addExtrudeFeature,
  addSketchFeature,
  createEmptyDocument,
  createRectangleEntity,
} from "../../src/model";
import { serializeProject } from "../../src/project/serialization";
import { encodeShareLinkPayload } from "../../src/project/shareLink";
import { base64UrlToBuffer, decodeShareLinkPayloadNode } from "../../scripts/decode-share-link.mjs";

function sampleDoc() {
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
  return doc;
}

describe("decodeShareLinkPayloadNode", () => {
  it("shareLink.tsのencodeShareLinkPayload()(CompressionStream)が作ったペイロードを伸長できる", async () => {
    const doc = sampleDoc();
    const { data } = await encodeShareLinkPayload(doc);
    const json = decodeShareLinkPayloadNode(data);
    expect(json).toBe(serializeProject(doc));
  });

  it("先頭が#m=で始まる完全な共有リンクURLからペイロード部分だけ渡してもデコードできる", async () => {
    const doc = sampleDoc();
    const { data } = await encodeShareLinkPayload(doc);
    // extractShareLinkData()相当(#m=以降の取り出し)は呼び出し側の責務。ここではペイロード自体が
    // ブラウザ側と完全に同じ文字列であることだけを確認する。
    const json = decodeShareLinkPayloadNode(data);
    const parsed = JSON.parse(json);
    expect(parsed.format).toBe("l3dcad");
    expect(parsed.document.features.length).toBe(2);
  });

  it("gzipマジックバイトを持たないデータを渡すと例外を投げる(呼び出し側でtry/catchする前提)", () => {
    // "aGVsbG8gd29ybGQ" は "hello world" のbase64url表現(gzipデータではない)。
    expect(() => decodeShareLinkPayloadNode("aGVsbG8gd29ybGQ")).toThrow();
  });

  it("base64UrlToBuffer: 空白・改行を無視してデコードする", async () => {
    const doc = sampleDoc();
    const { data } = await encodeShareLinkPayload(doc);
    const withWhitespace = data.slice(0, 10) + "\n  " + data.slice(10);
    const direct = base64UrlToBuffer(data);
    const withWs = base64UrlToBuffer(withWhitespace);
    expect(withWs.equals(direct)).toBe(true);
  });
});
