// Phase 37b: OpenAI用のcallModel実装。openai SDKは関数内でのみ動的import()する
// (このファイルはsrc/ai/provider.ts経由でAiGeneratePanelの遅延チャンクからのみ読み込まれる想定だが、
// SDK自体もさらに別チャンクへ分離してビルド時の主要チャンクサイズへ絶対に影響しないようにするため)。
import { AI_RESPONSE_JSON_SCHEMA } from "./envelopeSchema";
import { GenerateModelError, type CallModelFn } from "./generate";

/**
 * openai SDK(Responses API)を使ったcallModel実装。dangerouslyAllowBrowser: trueは
 * ブラウザから直接呼ぶ際にOpenAIが要求するオプトインフラグ(Anthropic SDKと同じ位置付け)。
 * 構造化出力(text.format: {type:"json_schema", strict:true})でAI_RESPONSE_JSON_SCHEMAに
 * 従ったJSONを強制する(AI_RESPONSE_JSON_SCHEMAは既にadditionalProperties:false+全キーrequired
 * なので、OpenAIのstrictモードにそのまま渡せる)。
 */
export const openaiCallModel: CallModelFn = async (params) => {
  const sdk = await import("openai");
  const OpenAI = sdk.default;
  const client = new OpenAI({ apiKey: params.apiKey, dangerouslyAllowBrowser: true });

  try {
    const response = await client.responses.create({
      model: params.model,
      instructions: params.system,
      input: params.messages.map((m) => ({ role: m.role, content: m.content })),
      max_output_tokens: 16000,
      text: {
        format: {
          type: "json_schema",
          name: "ai_response_envelope",
          schema: AI_RESPONSE_JSON_SCHEMA,
          strict: true,
        },
      },
    });

    const isRefusal = response.output.some(
      (item) => item.type === "message" && item.content.some((part) => part.type === "refusal"),
    );
    if (isRefusal) {
      return { text: "", stopReason: "refusal" };
    }

    const text = response.output_text;
    if (!text) {
      throw new GenerateModelError("AIの応答にテキストが含まれていませんでした(想定外の応答形式です)");
    }
    return { text, stopReason: "end_turn" };
  } catch (err) {
    if (err instanceof GenerateModelError) throw err;
    if (err instanceof sdk.AuthenticationError) throw new GenerateModelError("APIキーが無効です。設定を確認してください。");
    if (err instanceof sdk.PermissionDeniedError) throw new GenerateModelError("このAPIキーには権限がありません。");
    if (err instanceof sdk.RateLimitError) throw new GenerateModelError("APIのレート制限に達しました。しばらく待ってから再試行してください。");
    if (err instanceof sdk.NotFoundError) throw new GenerateModelError("指定したモデルが見つかりません。モデル名を確認してください。");
    if (err instanceof sdk.APIConnectionError) throw new GenerateModelError("OpenAI APIに接続できませんでした。ネットワーク接続を確認してください。");
    if (err instanceof sdk.APIError) throw new GenerateModelError(`OpenAI APIエラー: ${err.message}`);
    throw new GenerateModelError(err instanceof Error ? err.message : String(err));
  }
};
