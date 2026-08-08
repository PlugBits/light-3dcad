// src/ai/authoringSchema.ts の JSON Schema 健全性テスト(Phase 37)。
// Anthropicの構造化出力(output_config.format)は「全オブジェクトにadditionalProperties:false+
// required」「再帰なし」を要求するため、AUTHORING_JSON_SCHEMAツリー全体を歩いて検証する。
import { describe, expect, it } from "vitest";

import { AUTHORING_JSON_SCHEMA } from "../../src/ai/authoringSchema";

type JsonSchemaNode = Record<string, unknown>;

function isSchemaNode(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** スキーマツリーを再帰的に歩き、"type":"object" のノードすべてに additionalProperties:false と
 * required(propertiesの全キーを含む)があることを確認する。同時に既訪問ノード(参照)集合で
 * 循環参照(=再帰スキーマ)が無いことも確認する。
 */
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

  // 数値・文字列の禁止キーワード(タスク仕様: minimum/maximum/minLength/maxLengthは使わない)。
  for (const forbidden of ["minimum", "maximum", "minLength", "maxLength", "multipleOf"]) {
    if (forbidden in node) {
      errors.push(`${path}: 禁止されたキーワード "${forbidden}" が使われています`);
    }
  }

  seen.delete(node);
}

describe("AUTHORING_JSON_SCHEMA: 構造化出力の健全性", () => {
  it("すべてのobjectノードにadditionalProperties:falseとrequired(全プロパティ)がある", () => {
    const errors: string[] = [];
    walk(AUTHORING_JSON_SCHEMA, "root", new Set(), errors);
    expect(errors).toEqual([]);
  });

  it("ルートはtype:objectでsketches/featuresを持つ", () => {
    expect(AUTHORING_JSON_SCHEMA.type).toBe("object");
    const properties = AUTHORING_JSON_SCHEMA.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(["features", "sketches"]);
    expect(AUTHORING_JSON_SCHEMA.required).toEqual(["sketches", "features"]);
  });

  it("JSON.stringify/parseで往復できる(循環参照が無いことの追加確認)", () => {
    expect(() => JSON.parse(JSON.stringify(AUTHORING_JSON_SCHEMA))).not.toThrow();
  });
});
