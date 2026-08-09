// src/project/shareLink.ts の単体テスト(Phase 40a、モデル共有リンク)。
import { gunzipSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  addExtrudeFeature,
  addSketchFeature,
  createEmptyDocument,
  createRectangleEntity,
} from "../../src/model";
import {
  buildShareLinkUrl,
  decodeShareLinkPayload,
  encodeShareLinkPayload,
  extractShareLinkData,
  isShareLinkSupported,
  SHARE_LINK_HASH_PREFIX,
  SHARE_LINK_WARN_CHARS,
  type ByteTransform,
} from "../../src/project/shareLink";

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

// node:zlibを使ったByteTransform(注入可能な圧縮/伸長の実体をテスト側で用意する例)。
// vitestが動くNode自体もCompressionStream/DecompressionStreamを持つため既定実装(ブラウザと同じ経路)を
// そのまま使えるが、node:zlibによる独立実装でも往復できることを確認しておく。
const nodeGzip: ByteTransform = async (input) => new Uint8Array(gzipSync(input));
const nodeGunzip: ByteTransform = async (input) => new Uint8Array(gunzipSync(input));

describe("isShareLinkSupported", () => {
  it("Node(vitest実行環境)はCompressionStream/DecompressionStreamを持つためtrueを返す", () => {
    expect(isShareLinkSupported()).toBe(true);
  });
});

describe("extractShareLinkData", () => {
  it("#m=で始まるhashからデータ部分を取り出す", () => {
    expect(extractShareLinkData("#m=abcXYZ-_123")).toBe("abcXYZ-_123");
  });

  it("#m=で始まらないhashはnull(共有リンクではない)", () => {
    expect(extractShareLinkData("")).toBeNull();
    expect(extractShareLinkData("#")).toBeNull();
    expect(extractShareLinkData("#other=1")).toBeNull();
  });

  it("データ部分が空(#m=のみ)の場合もnull", () => {
    expect(extractShareLinkData("#m=")).toBeNull();
  });
});

describe("buildShareLinkUrl", () => {
  it("origin + pathname + #m= + data を連結する", () => {
    const url = buildShareLinkUrl("https://example.com", "/light-3dcad/", "abc123");
    expect(url).toBe(`https://example.com/light-3dcad/${SHARE_LINK_HASH_PREFIX}abc123`);
  });
});

describe("encodeShareLinkPayload / decodeShareLinkPayload(往復テスト)", () => {
  it("既定の圧縮実装(CompressionStream)でencode→decodeすると元のCadDocumentと完全一致する", async () => {
    const doc = sampleDoc();
    const payload = await encodeShareLinkPayload(doc);
    expect(payload.data.length).toBeGreaterThan(0);
    expect(payload.byteLength).toBeGreaterThan(0);

    const result = await decodeShareLinkPayload(payload.data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc).toEqual(doc);
    }
  });

  it("注入したnode:zlib実装でencode→decodeしても元のCadDocumentと完全一致する(injectable compressor)", async () => {
    const doc = sampleDoc();
    const payload = await encodeShareLinkPayload(doc, nodeGzip);
    const result = await decodeShareLinkPayload(payload.data, nodeGunzip);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc).toEqual(doc);
    }
  });

  it("圧縮実装が違っても(gzip形式が同じなら)相互運用できる: node:zlibでencodeしCompressionStreamの既定実装でdecodeできる", async () => {
    const doc = sampleDoc();
    const payload = await encodeShareLinkPayload(doc, nodeGzip);
    const result = await decodeShareLinkPayload(payload.data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc).toEqual(doc);
    }
  });

  it("圧縮後のbyteLengthは実際のgzipバイナリ長と一致する", async () => {
    const doc = sampleDoc();
    const json = JSON.stringify({ format: "l3dcad", schemaVersion: 1, document: doc }, null, 2);
    // encodeShareLinkPayload()内部はserializeProject()を使うため出力そのものと比較する必要はないが、
    // gzip後の長さがnode:zlibで直接計算した長さと一致することを確認する(nodeGzipは決定的)。
    const direct = gzipSync(new TextEncoder().encode(json));
    const payload = await encodeShareLinkPayload(doc, nodeGzip);
    expect(payload.byteLength).toBe(direct.byteLength);
  });

  it("小さなモデルのURLはSHARE_LINK_WARN_CHARSの閾値を大きく下回る", async () => {
    const payload = await encodeShareLinkPayload(sampleDoc());
    expect(payload.data.length).toBeLessThan(SHARE_LINK_WARN_CHARS);
  });
});

describe("decodeShareLinkPayload: 不正なデータの扱い", () => {
  it("base64urlとして不正な文字列はok:falseかつメッセージ付きで返る(例外を投げない)", async () => {
    const result = await decodeShareLinkPayload("!!!not-base64!!!");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("base64urlとしては妥当だがgzipデータとして不正な文字列はok:falseで返る", async () => {
    // "hello"をbase64url化しただけの、gzipマジックバイトを持たないデータ。
    const bogus = Buffer.from("hello world, not gzip data").toString("base64url");
    const result = await decodeShareLinkPayload(bogus);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/展開|gzip/);
    }
  });

  it("gzip伸長は成功するがJSONとして不正なデータはok:falseで返る(deserializeProjectのJSON解析エラー)", async () => {
    const bytes = gzipSync(new TextEncoder().encode("{ this is not valid json"));
    const data = Buffer.from(bytes).toString("base64url");
    const result = await decodeShareLinkPayload(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/JSON/);
    }
  });

  it("JSONとしては妥当だがl3dcad形式でないデータはok:falseで返る(deserializeProjectのformatチェック)", async () => {
    const bytes = gzipSync(new TextEncoder().encode(JSON.stringify({ foo: "bar" })));
    const data = Buffer.from(bytes).toString("base64url");
    const result = await decodeShareLinkPayload(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/フォーマット/);
    }
  });
});
