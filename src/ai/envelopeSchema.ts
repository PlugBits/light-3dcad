// Phase 39: AI応答の「エンベロープ」スキーマ(design-first生成 + 質問モード)。
// このファイルは副作用のない純粋TypeScript(Anthropic SDK等の重い依存はimportしない)。
//
// なぜエンベロープが必要か: Phase 37/37bまではAUTHORING_JSON_SCHEMA(アウソリングJSON本体)を
// そのまま構造化出力の型に使っていたが、Phase 39で(1)設計メモ(design)を毎回言語化させて
// 暗黙の寸法判断を無くす、(2)寸法が一意に決まらない曖昧な指示に対しては質問で確認する、の
// 2つを追加した。この2つを両立させるため、応答全体を
// { design: string|null, questions: [...]|null, model: AuthoringModel|null } の3フィールドに
// 固定し、生成結果はdesign+model、質問はquestionsのみを埋める(どちらか一方)契約にする。
import { AUTHORING_JSON_SCHEMA, type AuthoringModel } from "./authoringSchema";

/** 質問モードの1問。optionsは2〜4件、自由回答は求めない(選択式のみ)。 */
export interface AiQuestion {
  question: string;
  options: string[];
}

/** AIモデルが返す応答全体の形。design+model(生成)かquestions(質問)のどちらか一方だけを埋める。 */
export interface AiResponseEnvelope {
  design: string | null;
  questions: AiQuestion[] | null;
  model: AuthoringModel | null;
}

/** JSON Schemaはネスト構造を持つただのオブジェクトなので、緩い型で表現する。 */
type JsonSchema = Record<string, unknown>;

const QUESTION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    question: { type: "string" },
    options: { type: "array", items: { type: "string" } },
  },
  required: ["question", "options"],
  additionalProperties: false,
};

/**
 * Anthropic Messages API / OpenAI Responses API(strictモード)の両方の構造化出力にそのまま
 * 渡せるJSON Schema。AUTHORING_JSON_SCHEMA(既にadditionalProperties:false+全キーrequiredを
 * 満たす)を"model"プロパティとしてそのまま埋め込む(anyOfのnull分岐と組み合わせて省略可能にする)。
 * ルート自体もadditionalProperties:false+全キーrequiredを満たす(authoringSchema.test.tsと
 * 同じ健全性テストをenvelopeSchema.test.tsで実施する)。
 */
export const AI_RESPONSE_JSON_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    design: { anyOf: [{ type: "string" }, { type: "null" }] },
    questions: { anyOf: [{ type: "array", items: QUESTION_SCHEMA }, { type: "null" }] },
    model: { anyOf: [AUTHORING_JSON_SCHEMA, { type: "null" }] },
  },
  required: ["design", "questions", "model"],
  additionalProperties: false,
};
