// Phase 37/37b: AIモデル生成パネル(自然言語プロンプト→アウソリングJSON→CadDocument)。
// src/app/App.tsx から React.lazy() 経由でのみ読み込まれる(@anthropic-ai/sdk・openaiはこのチャンクからも
// 直接importせず、src/ai/generate.ts・src/ai/openaiClient.tsの中でさらに動的importする。
// メインバンドルには一切含まれない)。
import { useEffect, useState } from "react";

import { compileAuthoringModel } from "../ai/compile";
import { generateCadDocument, type GenerateProgress } from "../ai/generate";
import { AUTHORING_SYSTEM_PROMPT } from "../ai/promptSpec";
import { getCallModelForProvider, PROVIDER_LABEL, PROVIDERS, type Provider } from "../ai/provider";
import type { CadDocument } from "../model/types";

/**
 * APIキー/モデルのlocalStorage保存キー(この端末のみに保存し、対応するAPI以外へは送信しない)。
 * Anthropicのキーは既存ユーザーの保存値を引き継ぐため、Phase 37時点のキー名のまま変更しない。
 */
const PROVIDER_STORAGE_KEY = "light-3dcad:ai:provider:v1";
const API_KEY_STORAGE_KEYS: Record<Provider, string> = {
  anthropic: "light-3dcad:ai:apiKey:v1",
  openai: "light-3dcad:ai:apiKey:openai:v1",
};
const MODEL_STORAGE_KEYS: Record<Provider, string> = {
  anthropic: "light-3dcad:ai:model:v1",
  openai: "light-3dcad:ai:model:openai:v1",
};

const ANTHROPIC_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: "claude-opus-5", label: "Claude Opus 5(既定・高精度)" },
  { value: "claude-sonnet-5", label: "Claude Sonnet 5(バランス)" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5(高速・低コスト)" },
];

const OPENAI_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: "gpt-5.5", label: "GPT-5.5(既定・高精度)" },
  { value: "gpt-5.4", label: "GPT-5.4(バランス)" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 mini(高速・低コスト)" },
];

const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5.5",
};

const DEFAULT_PROVIDER: Provider = "anthropic";

const API_KEY_PLACEHOLDER: Record<Provider, string> = {
  anthropic: "sk-ant-...",
  openai: "sk-...",
};

function isProvider(value: string | null): value is Provider {
  return value === "anthropic" || value === "openai";
}

function loadStoredProvider(): Provider {
  if (typeof localStorage === "undefined") return DEFAULT_PROVIDER;
  try {
    const value = localStorage.getItem(PROVIDER_STORAGE_KEY);
    return isProvider(value) ? value : DEFAULT_PROVIDER;
  } catch {
    return DEFAULT_PROVIDER;
  }
}

function saveProvider(value: Provider) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PROVIDER_STORAGE_KEY, value);
  } catch {
    // ignore
  }
}

function loadStoredApiKey(provider: Provider): string {
  if (typeof localStorage === "undefined") return "";
  try {
    return localStorage.getItem(API_KEY_STORAGE_KEYS[provider]) ?? "";
  } catch {
    return "";
  }
}

function loadStoredModel(provider: Provider): string {
  if (typeof localStorage === "undefined") return DEFAULT_MODEL[provider];
  try {
    return localStorage.getItem(MODEL_STORAGE_KEYS[provider]) ?? DEFAULT_MODEL[provider];
  } catch {
    return DEFAULT_MODEL[provider];
  }
}

function saveApiKey(provider: Provider, value: string) {
  if (typeof localStorage === "undefined") return;
  try {
    if (value) localStorage.setItem(API_KEY_STORAGE_KEYS[provider], value);
    else localStorage.removeItem(API_KEY_STORAGE_KEYS[provider]);
  } catch {
    // 容量超過・プライベートブラウジング等は諦める(保存は補助機能)。
  }
}

function saveModel(provider: Provider, value: string) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(MODEL_STORAGE_KEYS[provider], value);
  } catch {
    // ignore
  }
}

const PHASE_LABEL: Record<GenerateProgress["phase"], string> = {
  generating: "生成中",
  compiling: "検証中",
  solving: "検証中",
  evaluating: "評価中",
};

export interface AiGeneratePanelProps {
  /** パネルを閉じる(「閉じる」ボタン・生成成功時)。 */
  onClose: () => void;
  /**
   * 生成/貼り付けで得られたCadDocumentを読み込む。呼び出し側(App.tsx)が確認ダイアログ・
   * fitToView・loadDocument()を担う(「開く」ボタンと同じ責務分担)。
   */
  onLoad: (doc: CadDocument) => void;
}

/** AI生成パネル(トップレベル、default export。App.tsxからReact.lazy()で読み込む)。 */
export default function AiGeneratePanel({ onClose, onLoad }: AiGeneratePanelProps) {
  const [provider, setProvider] = useState<Provider>(loadStoredProvider);
  const [apiKey, setApiKey] = useState<string>(() => loadStoredApiKey(loadStoredProvider()));
  const [model, setModel] = useState<string>(() => loadStoredModel(loadStoredProvider()));
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<GenerateProgress | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pasteJson, setPasteJson] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!copyNotice) return;
    const timer = setTimeout(() => setCopyNotice(null), 2500);
    return () => clearTimeout(timer);
  }, [copyNotice]);

  function handleProviderChange(value: Provider) {
    setProvider(value);
    saveProvider(value);
    setApiKey(loadStoredApiKey(value));
    setModel(loadStoredModel(value));
  }

  function handleApiKeyChange(value: string) {
    setApiKey(value);
    saveApiKey(provider, value);
  }

  function handleModelChange(value: string) {
    setModel(value);
    saveModel(provider, value);
  }

  async function handleGenerate() {
    if (busy) return;
    if (!apiKey.trim()) {
      setErrorMessage("APIキーを入力してください");
      return;
    }
    if (!prompt.trim()) {
      setErrorMessage("プロンプトを入力してください");
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    setProgress({ attempt: 1, maxAttempts: 3, phase: "generating" });
    try {
      const result = await generateCadDocument({
        apiKey: apiKey.trim(),
        model,
        prompt: prompt.trim(),
        callModel: getCallModelForProvider(provider),
        onProgress: (p) => setProgress(p),
      });
      if (!result.ok) {
        setErrorMessage(result.message);
        return;
      }
      onLoad(result.doc);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  function handlePasteLoad() {
    setPasteError(null);
    let json: unknown;
    try {
      json = JSON.parse(pasteJson);
    } catch (err) {
      setPasteError(`JSONの解析に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const compiled = compileAuthoringModel(json);
    if ("errors" in compiled) {
      setPasteError(compiled.errors.join("\n"));
      return;
    }
    onLoad(compiled.doc);
  }

  async function handleCopyPromptSpec() {
    try {
      await navigator.clipboard.writeText(AUTHORING_SYSTEM_PROMPT);
      setCopyNotice("プロンプト仕様をコピーしました");
    } catch (err) {
      setCopyNotice(`コピーに失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div
      data-testid="ai-generate-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        zIndex: 1000,
        paddingTop: 40,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        data-testid="ai-generate-panel"
        style={{
          background: "#242424",
          color: "#eee",
          border: "1px solid #555",
          borderRadius: 8,
          padding: 16,
          width: 480,
          maxWidth: "90vw",
          maxHeight: "85vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>AI生成</h2>
          <button type="button" data-testid="btn-ai-close" onClick={onClose}>
            閉じる
          </button>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
          プロバイダ
          <select
            data-testid="ai-provider-select"
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value as Provider)}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABEL[p]}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
          APIキー({PROVIDER_LABEL[provider]})
          <input
            type="password"
            data-testid="ai-api-key-input"
            value={apiKey}
            onChange={(e) => handleApiKeyChange(e.target.value)}
            placeholder={API_KEY_PLACEHOLDER[provider]}
            autoComplete="off"
          />
        </label>
        <p style={{ margin: 0, fontSize: 11, color: "#aaa" }}>
          キーはこの端末のlocalStorageにのみ保存され、選択中のプロバイダのAPI以外には送信されません。
        </p>

        {provider === "anthropic" ? (
          <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
            モデル
            <select data-testid="ai-model-select" value={model} onChange={(e) => handleModelChange(e.target.value)}>
              {ANTHROPIC_MODEL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
            モデル(候補から選ぶか、直接入力できます)
            <input
              type="text"
              data-testid="ai-model-input"
              list="ai-openai-model-options"
              value={model}
              onChange={(e) => handleModelChange(e.target.value)}
              placeholder="gpt-5.5"
              autoComplete="off"
            />
            <datalist id="ai-openai-model-options">
              {OPENAI_MODEL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </datalist>
          </label>
        )}

        <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
          プロンプト
          <textarea
            data-testid="ai-prompt-textarea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="例: 幅100 高さ50 厚み10の板の中央にφ20の穴"
          />
        </label>

        <button type="button" data-testid="btn-ai-generate-submit" onClick={handleGenerate} disabled={busy}>
          {busy ? "生成中…" : "生成"}
        </button>

        {progress && (
          <p data-testid="ai-generate-progress" style={{ margin: 0, fontSize: 12, color: "#9cf" }}>
            試行 {progress.attempt}/{progress.maxAttempts} — {PHASE_LABEL[progress.phase]}
          </p>
        )}
        {errorMessage && (
          <p
            data-testid="ai-generate-error"
            role="alert"
            style={{ margin: 0, fontSize: 12, color: "#ff6b6b", whiteSpace: "pre-wrap" }}
          >
            {errorMessage}
          </p>
        )}

        <details
          data-testid="ai-advanced-details"
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
          style={{ borderTop: "1px solid #444", paddingTop: 8 }}
        >
          <summary style={{ cursor: "pointer", fontSize: 12 }}>詳細(APIキー無しで使う)</summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
            <p style={{ margin: 0, fontSize: 11, color: "#aaa" }}>
              外部のAIチャット(ChatGPT等)にプロンプト仕様をコピペして生成させ、返ってきたJSONをここに貼り付けて読み込めます(APIキー不要)。
            </p>
            <button type="button" data-testid="btn-ai-copy-prompt-spec" onClick={handleCopyPromptSpec}>
              プロンプト仕様をコピー
            </button>
            {copyNotice && (
              <p style={{ margin: 0, fontSize: 11, color: "#9cf" }} data-testid="ai-copy-notice">
                {copyNotice}
              </p>
            )}
            <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
              JSONを直接貼り付け
              <textarea
                data-testid="ai-paste-json-textarea"
                value={pasteJson}
                onChange={(e) => setPasteJson(e.target.value)}
                rows={6}
                placeholder='{"sketches": [...], "features": [...]}'
              />
            </label>
            <button type="button" data-testid="btn-ai-paste-load" onClick={handlePasteLoad}>
              読み込む
            </button>
            {pasteError && (
              <p
                data-testid="ai-paste-error"
                role="alert"
                style={{ margin: 0, fontSize: 12, color: "#ff6b6b", whiteSpace: "pre-wrap" }}
              >
                {pasteError}
              </p>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}
