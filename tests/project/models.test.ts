// リポジトリルートの models/ (モデルギャラリー、Phase 40c) に対するバリデーションテスト。
// PRで models/<slug>/ を追加するコントリビューションの検証(壊れたモデルはCIで落ちる)を兼ねる。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { deserializeProject } from "../../src/project/serialization";

const MODELS_DIR = resolve(__dirname, "../../models");

interface ModelMeta {
  title: string;
  author: string;
  description: string;
  tags: string[];
}

function listModelSlugs(): string[] {
  return readdirSync(MODELS_DIR).filter((name) => statSync(join(MODELS_DIR, name)).isDirectory());
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateMetaShape(meta: unknown): string[] {
  const errors: string[] = [];
  if (typeof meta !== "object" || meta === null) {
    return ["meta.jsonがオブジェクトではありません"];
  }
  const obj = meta as Record<string, unknown>;
  if (!isNonEmptyString(obj.title)) errors.push("titleが空文字列または不正です");
  if (!isNonEmptyString(obj.author)) errors.push("authorが空文字列または不正です");
  if (!isNonEmptyString(obj.description)) errors.push("descriptionが空文字列または不正です");
  if (!Array.isArray(obj.tags) || !obj.tags.every((t) => typeof t === "string")) {
    errors.push("tagsは文字列配列である必要があります");
  }
  return errors;
}

describe("models/ (モデルギャラリー)", () => {
  const slugs = listModelSlugs();

  it("少なくとも1件のモデルが存在する", () => {
    expect(slugs.length).toBeGreaterThan(0);
  });

  it.each(slugs)("models/%s/model.l3dcad はserialization/validationを通過する", (slug) => {
    const text = readFileSync(join(MODELS_DIR, slug, "model.l3dcad"), "utf-8");
    const result = deserializeProject(text);
    expect(result.ok, result.ok ? "" : result.message).toBe(true);
    if (result.ok) {
      expect(result.doc.features.length).toBeGreaterThan(0);
    }
  });

  it.each(slugs)("models/%s/meta.json は必須フィールドを満たす", (slug) => {
    const text = readFileSync(join(MODELS_DIR, slug, "meta.json"), "utf-8");
    const meta = JSON.parse(text) as unknown;
    const errors = validateMetaShape(meta);
    expect(errors, errors.join(", ")).toEqual([]);
    expect((meta as ModelMeta).author).toBe("PlugBits");
  });

  it("slugはURLセーフな英数字・ハイフンのみで構成される", () => {
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });
});
