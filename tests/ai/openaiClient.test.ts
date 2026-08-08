// src/ai/openaiClient.ts の単体テスト(Phase 37b)。openai SDKは動的import("openai")されるため、
// vi.mock("openai", ...)でモジュール自体を差し替える(実際のOpenAI APIには一切アクセスしない)。
import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

const mocks = vi.hoisted(() => {
  class OpenAIError extends Error {}
  class APIError extends OpenAIError {}
  class AuthenticationError extends APIError {}
  class PermissionDeniedError extends APIError {}
  class RateLimitError extends APIError {}
  class NotFoundError extends APIError {}
  class APIConnectionError extends APIError {}

  const createMock = vi.fn();
  const constructorMock = vi.fn();

  class MockOpenAI {
    responses = { create: createMock };
    constructor(opts: unknown) {
      constructorMock(opts);
    }
  }

  return {
    OpenAIError,
    APIError,
    AuthenticationError,
    PermissionDeniedError,
    RateLimitError,
    NotFoundError,
    APIConnectionError,
    createMock,
    constructorMock,
    MockOpenAI,
  };
});

vi.mock("openai", () => ({
  default: mocks.MockOpenAI,
  OpenAIError: mocks.OpenAIError,
  APIError: mocks.APIError,
  AuthenticationError: mocks.AuthenticationError,
  PermissionDeniedError: mocks.PermissionDeniedError,
  RateLimitError: mocks.RateLimitError,
  NotFoundError: mocks.NotFoundError,
  APIConnectionError: mocks.APIConnectionError,
}));

import { GenerateModelError } from "../../src/ai/generate";
import { openaiCallModel } from "../../src/ai/openaiClient";

beforeEach(() => {
  mocks.createMock.mockReset();
  mocks.constructorMock.mockReset();
});

describe("openaiCallModel: 正常系", () => {
  it("output_textからJSONテキストを抽出し、リクエストが期待どおりに組み立てられる", async () => {
    mocks.createMock.mockResolvedValueOnce({
      output_text: '{"sketches":[],"features":[]}',
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: '{"sketches":[],"features":[]}' }],
        },
      ],
    });

    const result = await openaiCallModel({
      apiKey: "sk-test",
      model: "gpt-5.5",
      system: "system-prompt",
      messages: [{ role: "user", content: "幅100の板" }],
    });

    expect(result).toEqual({ text: '{"sketches":[],"features":[]}', stopReason: "end_turn" });
    expect(mocks.constructorMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-test", dangerouslyAllowBrowser: true }),
    );
    expect(mocks.createMock).toHaveBeenCalledTimes(1);

    const callArgs = mocks.createMock.mock.calls[0][0];
    expect(callArgs.model).toBe("gpt-5.5");
    expect(callArgs.instructions).toBe("system-prompt");
    expect(callArgs.input).toEqual([{ role: "user", content: "幅100の板" }]);
    expect(callArgs.text.format.type).toBe("json_schema");
    expect(callArgs.text.format.strict).toBe(true);
    expect(callArgs.text.format.schema).toBeTruthy();
  });

  it("refusalコンテンツを検出したら空文字+stopReason:refusalを返す(JSONは含まれない)", async () => {
    mocks.createMock.mockResolvedValueOnce({
      output_text: "",
      output: [{ type: "message", content: [{ type: "refusal", refusal: "対応できません" }] }],
    });

    const result = await openaiCallModel({
      apiKey: "sk-test",
      model: "gpt-5.5",
      system: "sys",
      messages: [],
    });

    expect(result).toEqual({ text: "", stopReason: "refusal" });
  });
});

describe("openaiCallModel: 異常系", () => {
  it("output_textが空でrefusalでもない場合はGenerateModelErrorを投げる", async () => {
    mocks.createMock.mockResolvedValueOnce({ output_text: "", output: [] });

    await expect(
      openaiCallModel({ apiKey: "sk-test", model: "gpt-5.5", system: "sys", messages: [] }),
    ).rejects.toBeInstanceOf(GenerateModelError);
  });

  it.each([
    [mocks.AuthenticationError, "APIキーが無効です。設定を確認してください。"],
    [mocks.PermissionDeniedError, "このAPIキーには権限がありません。"],
    [mocks.RateLimitError, "APIのレート制限に達しました。しばらく待ってから再試行してください。"],
    [mocks.NotFoundError, "指定したモデルが見つかりません。モデル名を確認してください。"],
    [mocks.APIConnectionError, "OpenAI APIに接続できませんでした。ネットワーク接続を確認してください。"],
  ])("%p を日本語エラーメッセージへマップする", async (ErrorClass, expectedMessage) => {
    mocks.createMock.mockRejectedValueOnce(new ErrorClass("boom"));

    await expect(
      openaiCallModel({ apiKey: "sk-test", model: "gpt-5.5", system: "sys", messages: [] }),
    ).rejects.toThrow(expectedMessage);
  });

  it("未知のAPIErrorはOpenAI APIエラーとして日本語化する", async () => {
    mocks.createMock.mockRejectedValueOnce(new mocks.APIError("何かがおかしい"));

    await expect(
      openaiCallModel({ apiKey: "sk-test", model: "gpt-5.5", system: "sys", messages: [] }),
    ).rejects.toThrow("OpenAI APIエラー: 何かがおかしい");
  });

  it("APIError系ではない例外はメッセージをそのまま使う", async () => {
    mocks.createMock.mockRejectedValueOnce(new Error("想定外の例外"));

    await expect(
      openaiCallModel({ apiKey: "sk-test", model: "gpt-5.5", system: "sys", messages: [] }),
    ).rejects.toThrow("想定外の例外");
  });
});
