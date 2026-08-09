// src/ai/promptSpec.ts のfew-shot例が実際にcompileAuthoringModel()を通ることを確認する(Phase 39)。
// プロンプト文中の例と食い違わないよう、FEW_SHOT_EXAMPLESは両プロンプト文字列の組み立てにも
// 使われている実体そのもの(promptSpec.ts参照)。
import { describe, expect, it } from "vitest";

import { compileAuthoringModel } from "../../src/ai/compile";
import { AUTHORING_PASTE_PROMPT, AUTHORING_SYSTEM_PROMPT, FEW_SHOT_EXAMPLES } from "../../src/ai/promptSpec";

describe("promptSpec: few-shot例がcompileAuthoringModel()を通る", () => {
  it.each(FEW_SHOT_EXAMPLES.map((ex, i) => [i, ex] as const))("例%i: %s", (_i, example) => {
    const result = compileAuthoringModel(example.model);
    if ("errors" in result) {
      throw new Error(`「${example.title}」がコンパイルに失敗しました:\n${result.errors.join("\n")}`);
    }
    expect(result.doc.features.length).toBeGreaterThan(0);
  });

  it("各designはdesign-first出力手順の見出しを含む", () => {
    for (const example of FEW_SHOT_EXAMPLES) {
      expect(example.design).toContain("## 対象物の実寸");
      expect(example.design).toContain("## 機能要件");
      expect(example.design).toContain("## 主要寸法");
      expect(example.design).toContain("## 造形方針");
    }
  });
});

describe("promptSpec: プロンプト文字列の整合性", () => {
  it("AUTHORING_SYSTEM_PROMPT(エンベロープ版)はdesign/questions/modelの契約に言及する", () => {
    expect(AUTHORING_SYSTEM_PROMPT).toContain('"design"');
    expect(AUTHORING_SYSTEM_PROMPT).toContain('"questions"');
    expect(AUTHORING_SYSTEM_PROMPT).toContain('"model"');
    expect(AUTHORING_SYSTEM_PROMPT).toContain("質問モード");
  });

  it("AUTHORING_SYSTEM_PROMPTにfew-shot例のmodelがJSONとして埋め込まれている", () => {
    for (const example of FEW_SHOT_EXAMPLES) {
      const envelope = { design: example.design, questions: null, model: example.model };
      expect(AUTHORING_SYSTEM_PROMPT).toContain(JSON.stringify(envelope, null, 2));
    }
  });

  it("AUTHORING_PASTE_PROMPT(貼り付け版)はエンベロープではなく素のsketches/featuresのみを要求する", () => {
    expect(AUTHORING_PASTE_PROMPT).not.toContain('"questions"');
    expect(AUTHORING_PASTE_PROMPT).toContain('"sketches"');
    expect(AUTHORING_PASTE_PROMPT).toContain('"features"');
    for (const example of FEW_SHOT_EXAMPLES) {
      expect(AUTHORING_PASTE_PROMPT).toContain(JSON.stringify(example.model, null, 2));
    }
  });

  it("revolveのfew-shot例(リング)はaxis:'y'で鉛直軸(接地状態)を使う", () => {
    const ringExample = FEW_SHOT_EXAMPLES.find((ex) => ex.title.includes("リング"));
    expect(ringExample).toBeDefined();
    const revolveFeature = ringExample?.model.features.find((f) => f.type === "revolve");
    expect(revolveFeature).toBeDefined();
    if (revolveFeature?.type === "revolve") {
      expect(revolveFeature.axis).toBe("y");
      const sketch = ringExample?.model.sketches.find((s) => s.id === revolveFeature.sketch);
      expect(sketch?.plane).toBe("XZ");
    }
  });
});
