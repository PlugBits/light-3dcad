// src/ai/provider.ts の単体テスト(Phase 37b)。プロバイダ選択が正しいcallModel実装へ
// ルーティングされることのみを検証する(実際には呼び出さないため、実APIには一切触れない)。
import { describe, expect, it } from "vitest";

import { defaultCallModel } from "../../src/ai/generate";
import { openaiCallModel } from "../../src/ai/openaiClient";
import { getCallModelForProvider, PROVIDER_LABEL, PROVIDERS } from "../../src/ai/provider";

describe("getCallModelForProvider", () => {
  it("anthropicを選ぶとdefaultCallModel(Anthropic SDK実装)を返す", () => {
    expect(getCallModelForProvider("anthropic")).toBe(defaultCallModel);
  });

  it("openaiを選ぶとopenaiCallModel(OpenAI SDK実装)を返す", () => {
    expect(getCallModelForProvider("openai")).toBe(openaiCallModel);
  });

  it("PROVIDERSはanthropicとopenaiの2件のみ", () => {
    expect(PROVIDERS).toEqual(["anthropic", "openai"]);
  });

  it("PROVIDER_LABELは全プロバイダに対して定義されている", () => {
    for (const p of PROVIDERS) {
      expect(PROVIDER_LABEL[p]).toBeTruthy();
    }
  });
});
