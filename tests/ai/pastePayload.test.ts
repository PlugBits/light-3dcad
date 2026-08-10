// src/ai/pastePayload.ts の単体テスト(Phase 45: 貼り付けモードのwrapper/bare/フェンス解析)。
import { describe, expect, it } from "vitest";

import { parsePastePayload, stripCodeFence } from "../../src/ai/pastePayload";

const BARE_MODEL = {
  sketches: [{ id: "s1", plane: "XY", entities: [], segments: [], constraints: [] }],
  features: [],
};

describe("stripCodeFence", () => {
  it("フェンス無しのテキストはそのまま返す", () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  });

  it("全体を囲むコードフェンス(```json ... ```)を剥がす", () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("言語指定の無いフェンス(``` ... ```)も剥がす", () => {
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("前後に説明文が混在していても最初のフェンスブロックの中身を返す", () => {
    const text = '以下がJSONです:\n```json\n{"a":1}\n```\nよろしくお願いします。';
    expect(stripCodeFence(text)).toBe('{"a":1}');
  });

  it("前後の空白は取り除く", () => {
    expect(stripCodeFence('  \n```json\n{"a":1}\n```\n  ')).toBe('{"a":1}');
  });
});

describe("parsePastePayload", () => {
  it("新形式({model, meta})を解析し、model/metaを両方返す", () => {
    const text = JSON.stringify({
      model: BARE_MODEL,
      meta: { title: "テスト板", description: "幅100mmの板", tags: ["板", "テスト"] },
    });
    const result = parsePastePayload(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.model).toEqual(BARE_MODEL);
    expect(result.meta).toEqual({ title: "テスト板", description: "幅100mmの板", tags: ["板", "テスト"] });
  });

  it("後方互換: 素の{sketches, features}形式(旧形式)もmodelとして解析でき、metaはnull", () => {
    const result = parsePastePayload(JSON.stringify(BARE_MODEL));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.model).toEqual(BARE_MODEL);
    expect(result.meta).toBeNull();
  });

  it("新形式でmetaを省略した場合はmeta: null", () => {
    const result = parsePastePayload(JSON.stringify({ model: BARE_MODEL }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.meta).toBeNull();
  });

  it("metaのフィールド欠落/型違いは空文字列・空配列にフォールバックする", () => {
    const result = parsePastePayload(JSON.stringify({ model: BARE_MODEL, meta: { title: "T" } }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.meta).toEqual({ title: "T", description: "", tags: [] });
  });

  it("metaのtagsが文字列以外の要素を含む場合は取り除く", () => {
    const result = parsePastePayload(JSON.stringify({ model: BARE_MODEL, meta: { tags: ["ok", 1, null, "ok2"] } }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.meta?.tags).toEqual(["ok", "ok2"]);
  });

  it("コードフェンス付きの新形式も解析できる", () => {
    const text = '```json\n' + JSON.stringify({ model: BARE_MODEL, meta: { title: "T", description: "D", tags: [] } }) + '\n```';
    const result = parsePastePayload(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.model).toEqual(BARE_MODEL);
    expect(result.meta?.title).toBe("T");
  });

  it("JSON構文エラーはエラーを返す", () => {
    const result = parsePastePayload("{invalid json");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("JSONの解析に失敗しました");
  });

  it("トップレベルが配列やプリミティブの場合はエラーを返す", () => {
    expect(parsePastePayload("[1,2,3]").ok).toBe(false);
    expect(parsePastePayload("42").ok).toBe(false);
    expect(parsePastePayload('"text"').ok).toBe(false);
  });
});
