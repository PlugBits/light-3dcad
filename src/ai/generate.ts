// Phase 37/39: AIモデル生成のループ(生成→コンパイル→スケッチ拘束を解く→ドライラン評価→
// 失敗時は最大3回まで自己修復)。Phase 39でAI応答を「エンベロープ」形式
// ({design, questions, model}、src/ai/envelopeSchema.ts)に変更し、design-first生成
// (設計メモを先に書かせる)と質問モード(寸法が一意に決まらない場合はquestionsで確認する、
// セッションあたり最大1ラウンド)に対応した。
//
// @anthropic-ai/sdk は関数内でのみ動的import()する(このファイル自体がAiGeneratePanel経由の
// 遅延チャンクからのみ読み込まれる想定だが、SDK自体もさらに別チャンクへ分離してビルド時の
// 主要チャンクサイズへ絶対に影響しないようにするため)。
import type { CadDocument } from "../model/types";
import type { WorkerResponse } from "../protocol/messages";
import { compileAuthoringModel } from "./compile";
import { AI_RESPONSE_JSON_SCHEMA, type AiQuestion } from "./envelopeSchema";
import { AUTHORING_SYSTEM_PROMPT } from "./promptSpec";

export type { AiQuestion } from "./envelopeSchema";

/** モデルへ渡す会話の1メッセージ(Anthropic Messages APIのuser/assistantロールのみ)。 */
export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelCallParams {
  apiKey: string;
  model: string;
  system: string;
  messages: ModelMessage[];
}

export interface ModelCallResult {
  /** アシスタント応答のテキスト(構造化出力のJSON文字列を想定)。stopReasonが"refusal"の場合は空文字。 */
  text: string;
  stopReason: string;
}

/** callModelの型(テストではフェイク実装を注入する)。 */
export type CallModelFn = (params: ModelCallParams) => Promise<ModelCallResult>;

/** callModel内で投げる、ユーザーに表示してよい(既に日本語化済みの)エラー。生成ループはリトライせず即座に失敗として扱う。 */
export class GenerateModelError extends Error {}

/**
 * @anthropic-ai/sdk を使ったデフォルトのcallModel実装。SDKは関数内で動的importする
 * (dangerouslyAllowBrowser: trueはブラウザから直接呼ぶ際にAnthropicが要求するオプトインフラグ)。
 * 構造化出力(output_config.format)でAUTHORING_JSON_SCHEMAに従ったJSONを強制する。
 * ストリーミングを使う(max_tokens: 16000はHTTPタイムアウトの懸念がある閾値のため)。
 */
export const defaultCallModel: CallModelFn = async (params) => {
  const sdk = await import("@anthropic-ai/sdk");
  const Anthropic = sdk.default;
  const client = new Anthropic({ apiKey: params.apiKey, dangerouslyAllowBrowser: true });

  try {
    const stream = client.messages.stream({
      model: params.model,
      max_tokens: 16000,
      system: params.system,
      messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
      output_config: { format: { type: "json_schema", schema: AI_RESPONSE_JSON_SCHEMA } },
    });
    const finalMessage = await stream.finalMessage();

    if (finalMessage.stop_reason === "refusal") {
      return { text: "", stopReason: "refusal" };
    }

    const textBlock = finalMessage.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new GenerateModelError("AIの応答にテキストが含まれていませんでした(想定外の応答形式です)");
    }
    return { text: textBlock.text, stopReason: finalMessage.stop_reason ?? "end_turn" };
  } catch (err) {
    if (err instanceof GenerateModelError) throw err;
    if (err instanceof sdk.AuthenticationError) throw new GenerateModelError("APIキーが無効です。設定を確認してください。");
    if (err instanceof sdk.PermissionDeniedError) throw new GenerateModelError("このAPIキーには権限がありません。");
    if (err instanceof sdk.RateLimitError) throw new GenerateModelError("APIのレート制限に達しました。しばらく待ってから再試行してください。");
    if (err instanceof sdk.NotFoundError) throw new GenerateModelError("指定したモデルが見つかりません。モデル名を確認してください。");
    if (err instanceof sdk.APIConnectionError) throw new GenerateModelError("Anthropic APIに接続できませんでした。ネットワーク接続を確認してください。");
    if (err instanceof sdk.APIError) throw new GenerateModelError(`Anthropic APIエラー: ${err.message}`);
    throw new GenerateModelError(err instanceof Error ? err.message : String(err));
  }
};

/** ドキュメントの評価を行う関数の型(テストではフェイク実装を注入する)。src/state/store.tsのdryRunEvaluate相当。 */
export type DryRunEvaluateFn = (doc: CadDocument) => Promise<WorkerResponse>;

const defaultDryRunEvaluate: DryRunEvaluateFn = async (doc) => {
  const { useCadStore } = await import("../state/store");
  return useCadStore.getState().dryRunEvaluate(doc);
};

/** スケッチ拘束(constraints)を解く関数の型(テストではフェイク実装を注入する)。src/sketch/solver.tsのsolveDocumentSketchesAsync相当。 */
export interface SolveResult {
  doc: CadDocument;
  conflict: { featureId?: string; message: string } | null;
}
export type SolveSketchesFn = (doc: CadDocument) => Promise<SolveResult>;

const defaultSolveSketches: SolveSketchesFn = async (doc) => {
  const solverModule = await import("../sketch/solver");
  await solverModule.ensureGcsInitialized();
  return solverModule.solveDocumentSketchesAsync(doc);
};

export type GeneratePhase = "generating" | "compiling" | "solving" | "evaluating";

export interface GenerateProgress {
  attempt: number;
  maxAttempts: number;
  phase: GeneratePhase;
}

/** 1回の試行で発生した修復対象のエラー一覧(成功した試行はログに現れない)。 */
export interface GenerateAttemptLog {
  attempt: number;
  errors: string[];
}

export interface GenerateTranscript {
  attempts: number;
  repaired: GenerateAttemptLog[];
}

/**
 * 生成結果("document")か、質問モード("questions")か。質問モードのconversationには、
 * ユーザーの回答メッセージを追加した上で再度generateCadDocument()の`conversation`
 * オプションへそのまま渡す(`answeringQuestions: true`とセットで)。
 */
export type GenerateResult =
  | { ok: true; kind: "document"; doc: CadDocument; design: string; transcript: GenerateTranscript }
  | { ok: true; kind: "questions"; questions: AiQuestion[]; conversation: ModelMessage[]; transcript: GenerateTranscript }
  | { ok: false; message: string; transcript: GenerateTranscript };

export const MAX_GENERATE_ATTEMPTS = 3;

/** ユーザーが質問へ回答しなかった項目、または「おまかせ」を選んだ項目に使う固定文言。 */
const AUTO_OMAKASE_MESSAGE = "すべておまかせで生成してください";

export interface GenerateOptions {
  apiKey: string;
  model: string;
  /** 新規セッションの初回プロンプト。`conversation`を渡した場合はそちらが優先され、これは無視される。 */
  prompt: string;
  /**
   * 質問モードの回答フローを継続する場合に渡す、直前までの会話全体(GenerateResultの
   * kind:"questions"が返したconversationに、ユーザーの回答メッセージを追加したもの)。
   * 省略時はpromptから新規に会話を開始する。
   */
  conversation?: ModelMessage[];
  /**
   * この呼び出しが「質問への回答」フロー(=既に1回の質問ラウンドが完了している)ならtrue。
   * trueの場合、AIが再度questionsを返してもUIへは返さず、1回だけAUTO_OMAKASE_MESSAGEを
   * 自動送信して生成へ誘導する(既に自動応答済みで、なお質問してきた場合は失敗として扱う)。
   */
  answeringQuestions?: boolean;
  onProgress?: (progress: GenerateProgress) => void;
  callModel?: CallModelFn;
  dryRunEvaluate?: DryRunEvaluateFn;
  solveSketches?: SolveSketchesFn;
  maxAttempts?: number;
}

function buildRepairPrompt(errors: string[]): string {
  const list = errors.map((e) => `- ${e}`).join("\n");
  return `生成されたJSONに次のエラーがありました。エラーを修正した上で、指定されたJSONオブジェクトのみを出力し直してください(説明文やコードフェンスは不要です):\n${list}`;
}

type EnvelopeParseResult =
  | { kind: "document"; design: string; model: unknown }
  | { kind: "questions"; questions: AiQuestion[] }
  | { kind: "invalid"; message: string };

/**
 * AI応答のJSON(AiResponseEnvelope形状であるはず)を検証する。構造化出力である程度の形は
 * 保証されるが、(1)貼り付け不要でも念のため、(2)テストでのフェイクcallModel経由の入力、の
 * 両方に備えてここでも再検証する。compileAuthoringModel()と同様、深いバリデーションは行わず
 * 「document/questionsどちらの形か」の判定に必要な最小限のみをチェックする(model本体の
 * 詳細な検証はcompileAuthoringModel()に委ねる)。
 */
function parseEnvelope(json: unknown): EnvelopeParseResult {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { kind: "invalid", message: "応答はJSONオブジェクトである必要があります" };
  }
  const obj = json as Record<string, unknown>;
  const questionsRaw = obj.questions;

  if (questionsRaw !== null && questionsRaw !== undefined) {
    if (!Array.isArray(questionsRaw) || questionsRaw.length < 1 || questionsRaw.length > 3) {
      return { kind: "invalid", message: "questionsは1〜3件の配列である必要があります" };
    }
    const questions: AiQuestion[] = [];
    for (const q of questionsRaw) {
      if (typeof q !== "object" || q === null) {
        return { kind: "invalid", message: "questionsの各項目はオブジェクトである必要があります" };
      }
      const qObj = q as Record<string, unknown>;
      const options = qObj.options;
      if (
        typeof qObj.question !== "string" ||
        !Array.isArray(options) ||
        options.length < 2 ||
        options.length > 4 ||
        !options.every((o) => typeof o === "string")
      ) {
        return {
          kind: "invalid",
          message: "questionsの各項目はquestion(文字列)とoptions(2〜4件の文字列配列)を持つ必要があります",
        };
      }
      questions.push({ question: qObj.question, options: options as string[] });
    }
    return { kind: "questions", questions };
  }

  const design = obj.design;
  const model = obj.model;
  if (typeof design === "string" && model !== null && model !== undefined) {
    return { kind: "document", design, model };
  }

  return {
    kind: "invalid",
    message: "応答はdesign+model(生成)、またはquestions(質問)のいずれかの形式である必要があります",
  };
}

/**
 * 自然言語プロンプトからCadDocumentを生成する(生成→JSON解析→コンパイル→スケッチ拘束を解く→
 * ドライラン評価、のいずれかで失敗したら、そのエラーをAIへ日本語で伝えて再生成する。最大
 * maxAttempts回[既定3回]試行し、それでも成功しなければ失敗として返す)。
 */
export async function generateCadDocument(options: GenerateOptions): Promise<GenerateResult> {
  const maxAttempts = options.maxAttempts ?? MAX_GENERATE_ATTEMPTS;
  const callModel = options.callModel ?? defaultCallModel;
  const dryRunEvaluate = options.dryRunEvaluate ?? defaultDryRunEvaluate;
  const solveSketches = options.solveSketches ?? defaultSolveSketches;

  const messages: ModelMessage[] = options.conversation ? [...options.conversation] : [{ role: "user", content: options.prompt }];
  const repaired: GenerateAttemptLog[] = [];
  /** 質問ラウンドの上限(セッションあたり最大1回)を超えて質問された場合に1回だけ自動応答したかどうか。 */
  let autoOmakaseUsed = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.onProgress?.({ attempt, maxAttempts, phase: "generating" });

    let modelResult: ModelCallResult;
    try {
      modelResult = await callModel({
        apiKey: options.apiKey,
        model: options.model,
        system: AUTHORING_SYSTEM_PROMPT,
        messages,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message, transcript: { attempts: attempt, repaired } };
    }

    if (modelResult.stopReason === "refusal") {
      return {
        ok: false,
        message: "AIモデルがこのリクエストの生成を拒否しました(安全上の理由)。プロンプトの内容を見直すか、別の表現でお試しください。",
        transcript: { attempts: attempt, repaired },
      };
    }

    let json: unknown;
    try {
      json = JSON.parse(modelResult.text);
    } catch (err) {
      const message = `AIの出力をJSONとして解析できませんでした: ${err instanceof Error ? err.message : String(err)}`;
      if (attempt >= maxAttempts) {
        repaired.push({ attempt, errors: [message] });
        break;
      }
      messages.push({ role: "assistant", content: modelResult.text });
      messages.push({ role: "user", content: buildRepairPrompt([message]) });
      repaired.push({ attempt, errors: [message] });
      continue;
    }

    const envelope = parseEnvelope(json);

    if (envelope.kind === "invalid") {
      const message = `応答の形式が仕様(design+model または questions)に従っていません: ${envelope.message}`;
      if (attempt >= maxAttempts) {
        repaired.push({ attempt, errors: [message] });
        break;
      }
      messages.push({ role: "assistant", content: modelResult.text });
      messages.push({ role: "user", content: buildRepairPrompt([message]) });
      repaired.push({ attempt, errors: [message] });
      continue;
    }

    if (envelope.kind === "questions") {
      // このセッションで既に1回の質問ラウンドが完了している(answeringQuestions)か、
      // 既に自動「おまかせ」応答を1回使い切っている場合、UIへは返さず処理を続ける。
      const mustNotAskAgain = options.answeringQuestions === true || autoOmakaseUsed;
      if (!mustNotAskAgain) {
        messages.push({ role: "assistant", content: modelResult.text });
        return {
          ok: true,
          kind: "questions",
          questions: envelope.questions,
          conversation: messages,
          transcript: { attempts: attempt, repaired },
        };
      }
      if (autoOmakaseUsed) {
        return {
          ok: false,
          message: "AIが回答済みにもかかわらず再度質問してきたため、生成を中止しました。プロンプトをより具体的にして再試行してください。",
          transcript: { attempts: attempt, repaired },
        };
      }
      messages.push({ role: "assistant", content: modelResult.text });
      messages.push({ role: "user", content: AUTO_OMAKASE_MESSAGE });
      autoOmakaseUsed = true;
      repaired.push({
        attempt,
        errors: ["AIが回答済みにもかかわらず再度質問しました(「すべておまかせで生成してください」と自動応答しました)"],
      });
      continue;
    }

    options.onProgress?.({ attempt, maxAttempts, phase: "compiling" });
    const compiled = compileAuthoringModel(envelope.model);
    if ("errors" in compiled) {
      if (attempt >= maxAttempts) {
        repaired.push({ attempt, errors: compiled.errors });
        break;
      }
      messages.push({ role: "assistant", content: modelResult.text });
      messages.push({ role: "user", content: buildRepairPrompt(compiled.errors) });
      repaired.push({ attempt, errors: compiled.errors });
      continue;
    }

    options.onProgress?.({ attempt, maxAttempts, phase: "solving" });
    let solved: SolveResult;
    try {
      solved = await solveSketches(compiled.doc);
    } catch (err) {
      const message = `スケッチ拘束の求解中にエラーが発生しました: ${err instanceof Error ? err.message : String(err)}`;
      if (attempt >= maxAttempts) {
        repaired.push({ attempt, errors: [message] });
        break;
      }
      messages.push({ role: "assistant", content: modelResult.text });
      messages.push({ role: "user", content: buildRepairPrompt([message]) });
      repaired.push({ attempt, errors: [message] });
      continue;
    }
    if (solved.conflict) {
      const message = `スケッチ拘束が矛盾しています${solved.conflict.featureId ? `(${solved.conflict.featureId})` : ""}: ${solved.conflict.message}`;
      if (attempt >= maxAttempts) {
        repaired.push({ attempt, errors: [message] });
        break;
      }
      messages.push({ role: "assistant", content: modelResult.text });
      messages.push({ role: "user", content: buildRepairPrompt([message]) });
      repaired.push({ attempt, errors: [message] });
      continue;
    }

    options.onProgress?.({ attempt, maxAttempts, phase: "evaluating" });
    let evalResponse: WorkerResponse;
    try {
      evalResponse = await dryRunEvaluate(solved.doc);
    } catch (err) {
      const message = `形状の評価中にエラーが発生しました: ${err instanceof Error ? err.message : String(err)}`;
      if (attempt >= maxAttempts) {
        repaired.push({ attempt, errors: [message] });
        break;
      }
      messages.push({ role: "assistant", content: modelResult.text });
      messages.push({ role: "user", content: buildRepairPrompt([message]) });
      repaired.push({ attempt, errors: [message] });
      continue;
    }

    if (evalResponse.kind !== "evaluated") {
      const message =
        evalResponse.kind === "error"
          ? `形状の評価に失敗しました${evalResponse.featureId ? `(${evalResponse.featureId})` : ""}: ${evalResponse.message}`
          : `形状の評価で予期しない応答を受け取りました: ${evalResponse.kind}`;
      if (attempt >= maxAttempts) {
        repaired.push({ attempt, errors: [message] });
        break;
      }
      messages.push({ role: "assistant", content: modelResult.text });
      messages.push({ role: "user", content: buildRepairPrompt([message]) });
      repaired.push({ attempt, errors: [message] });
      continue;
    }

    return { ok: true, kind: "document", doc: solved.doc, design: envelope.design, transcript: { attempts: attempt, repaired } };
  }

  return {
    ok: false,
    message: `${maxAttempts}回試行しましたが、有効なモデルを生成できませんでした。`,
    transcript: { attempts: maxAttempts, repaired },
  };
}
