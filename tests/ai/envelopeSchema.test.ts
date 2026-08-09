// src/ai/envelopeSchema.ts の JSON Schema 健全性テスト(Phase 39)。authoringSchema.test.tsと同じ
// ウォーカーで、Anthropic/OpenAI構造化出力の両方が要求する「全objectノードにadditionalProperties:false
// +required(全プロパティ)」「再帰なし」を確認する(AUTHORING_JSON_SCHEMAを"model"プロパティとして
// 埋め込んでいるため、そちらの健全性もここで再確認される)。
import { describe, expect, it } from "vitest";

import { AI_RESPONSE_JSON_SCHEMA } from "../../src/ai/envelopeSchema";

type JsonSchemaNode = Record<string, unknown>;

function isSchemaNode(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walk(node: unknown, path: string, seen: Set<unknown>, errors: string[]): void {
  if (!isSchemaNode(node)) return;
  if (seen.has(node)) {
    errors.push(`${path}: 循環参照(再帰スキーマ)が検出されました`);
    return;
  }
  seen.add(node);

  if (node.type === "object") {
    if (node.additionalProperties !== false) {
      errors.push(`${path}: additionalProperties:false がありません`);
    }
    const properties = isSchemaNode(node.properties) ? node.properties : {};
    const propertyKeys = Object.keys(properties);
    const required = Array.isArray(node.required) ? node.required : [];
    if (!Array.isArray(node.required)) {
      errors.push(`${path}: required が配列ではありません`);
    } else {
      for (const key of propertyKeys) {
        if (!required.includes(key)) {
          errors.push(`${path}: プロパティ "${key}" が required に含まれていません`);
        }
      }
    }
    for (const key of propertyKeys) {
      walk(properties[key], `${path}.properties.${key}`, seen, errors);
    }
  }

  if (Array.isArray(node.anyOf)) {
    node.anyOf.forEach((child, i) => walk(child, `${path}.anyOf[${i}]`, seen, errors));
  }
  if (Array.isArray(node.allOf)) {
    node.allOf.forEach((child, i) => walk(child, `${path}.allOf[${i}]`, seen, errors));
  }
  if (node.type === "array" && node.items !== undefined) {
    walk(node.items, `${path}.items`, seen, errors);
  }

  for (const forbidden of ["minimum", "maximum", "minLength", "maxLength", "multipleOf"]) {
    if (forbidden in node) {
      errors.push(`${path}: 禁止されたキーワード "${forbidden}" が使われています`);
    }
  }

  seen.delete(node);
}

describe("AI_RESPONSE_JSON_SCHEMA: 構造化出力の健全性", () => {
  it("すべてのobjectノードにadditionalProperties:falseとrequired(全プロパティ)がある", () => {
    const errors: string[] = [];
    walk(AI_RESPONSE_JSON_SCHEMA, "root", new Set(), errors);
    expect(errors).toEqual([]);
  });

  it("ルートはtype:objectでdesign/questions/modelを持つ", () => {
    expect(AI_RESPONSE_JSON_SCHEMA.type).toBe("object");
    const properties = AI_RESPONSE_JSON_SCHEMA.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(["design", "model", "questions"]);
    expect(AI_RESPONSE_JSON_SCHEMA.required).toEqual(["design", "questions", "model"]);
  });

  it("design/questions/modelはいずれもnullを許容するanyOf分岐を持つ", () => {
    const properties = AI_RESPONSE_JSON_SCHEMA.properties as Record<string, JsonSchemaNode>;
    for (const key of ["design", "questions", "model"]) {
      const anyOf = properties[key].anyOf as JsonSchemaNode[];
      expect(Array.isArray(anyOf)).toBe(true);
      expect(anyOf.some((n) => n.type === "null")).toBe(true);
    }
  });

  it("JSON.stringify/parseで往復できる(循環参照が無いことの追加確認)", () => {
    expect(() => JSON.parse(JSON.stringify(AI_RESPONSE_JSON_SCHEMA))).not.toThrow();
  });
});
