// Phase 37b: AIプロバイダ(Anthropic/OpenAI)の抽象。AiGeneratePanelとgenerateCadDocumentの橋渡し。
// このファイルは副作用のない純粋TypeScript(SDK本体はgenerate.ts/openaiClient.tsの中で動的importされる)。
import { defaultCallModel, type CallModelFn } from "./generate";
import { openaiCallModel } from "./openaiClient";

export type Provider = "anthropic" | "openai";

export const PROVIDERS: readonly Provider[] = ["anthropic", "openai"];

export const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (GPT)",
};

/** プロバイダ選択に応じたcallModel実装を返す(generateCadDocumentのcallModelオプションへ渡す)。 */
export function getCallModelForProvider(provider: Provider): CallModelFn {
  switch (provider) {
    case "anthropic":
      return defaultCallModel;
    case "openai":
      return openaiCallModel;
  }
}
