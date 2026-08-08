// Phase 37: AIモデル生成のループ(生成→コンパイル→スケッチ拘束を解く→ドライラン評価→
// 失敗時は最大3回まで自己修復)。
//
// @anthropic-ai/sdk は関数内でのみ動的import()する(このファイル自体がAiGeneratePanel経由の
// 遅延チャンクからのみ読み込まれる想定だが、SDK自体もさらに別チャンクへ分離してビルド時の
// 主要チャンクサイズへ絶対に影響しないようにするため)。
import type { CadDocument } from "../model/types";
import type { WorkerResponse } from "../protocol/messages";
import { compileAuthoringModel } from "./compile";
import { AUTHORING_JSON_SCHEMA } from "./authoringSchema";
import { AUTHORING_SYSTEM_PROMPT } from "./promptSpec";

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
      output_config: { format: { type: "json_schema", schema: AUTHORING_JSON_SCHEMA } },
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

export type GenerateResult =
  | { ok: true; doc: CadDocument; transcript: GenerateTranscript }
  | { ok: false; message: string; transcript: GenerateTranscript };

export const MAX_GENERATE_ATTEMPTS = 3;

export interface GenerateOptions {
  apiKey: string;
  model: string;
  prompt: string;
  onProgress?: (progress: GenerateProgress) => void;
  callModel?: CallModelFn;
  dryRunEvaluate?: DryRunEvaluateFn;
  solveSketches?: SolveSketchesFn;
  maxAttempts?: number;
}

function buildRepairPrompt(errors: string[]): string {
  const list = errors.map((e) => `- ${e}`).join("\n");
  return `生成されたJSONに次のエラーがありました。エラーを修正した上で、JSONオブジェクトのみを出力し直してください(説明文やコードフェンスは不要です):\n${list}`;
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

  const messages: ModelMessage[] = [{ role: "user", content: options.prompt }];
  const repaired: GenerateAttemptLog[] = [];

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

    options.onProgress?.({ attempt, maxAttempts, phase: "compiling" });
    const compiled = compileAuthoringModel(json);
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

    return { ok: true, doc: solved.doc, transcript: { attempts: attempt, repaired } };
  }

  return {
    ok: false,
    message: `${maxAttempts}回試行しましたが、有効なモデルを生成できませんでした。`,
    transcript: { attempts: maxAttempts, repaired },
  };
}
