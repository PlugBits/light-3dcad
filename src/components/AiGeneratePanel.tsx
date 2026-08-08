// Phase 37: AIモデル生成パネル(自然言語プロンプト→アウソリングJSON→CadDocument)。
// src/app/App.tsx から React.lazy() 経由でのみ読み込まれる(@anthropic-ai/sdkはこのチャンクからも
// 直接importせず、src/ai/generate.tsの中でさらに動的importする。メインバンドルには一切含まれない)。
import { useEffect, useState } from "react";

import { compileAuthoringModel } from "../ai/compile";
import { generateCadDocument, type GenerateProgress } from "../ai/generate";
import { AUTHORING_SYSTEM_PROMPT } from "../ai/promptSpec";
import type { CadDocument } from "../model/types";

/** APIキーのlocalStorage保存キー(この端末のみに保存し、Anthropic API以外へは送信しない)。 */
const API_KEY_STORAGE_KEY = "light-3dcad:ai:apiKey:v1";
const MODEL_STORAGE_KEY = "light-3dcad:ai:model:v1";

const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: "claude-opus-5", label: "Claude Opus 5(既定・高精度)" },
  { value: "claude-sonnet-5", label: "Claude Sonnet 5(バランス)" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5(高速・低コスト)" },
];

const DEFAULT_MODEL = "claude-opus-5";

function loadStoredApiKey(): string {
  if (typeof localStorage === "undefined") return "";
  try {
    return localStorage.getItem(API_KEY_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function loadStoredModel(): string {
  if (typeof localStorage === "undefined") return DEFAULT_MODEL;
  try {
    return localStorage.getItem(MODEL_STORAGE_KEY) ?? DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

function saveApiKey(value: string) {
  if (typeof localStorage === "undefined") return;
  try {
    if (value) localStorage.setItem(API_KEY_STORAGE_KEY, value);
    else localStorage.removeItem(API_KEY_STORAGE_KEY);
  } catch {
    // 容量超過・プライベートブラウジング等は諦める(保存は補助機能)。
  }
}

function saveModel(value: string) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, value);
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
  const [apiKey, setApiKey] = useState<string>(loadStoredApiKey);
  const [model, setModel] = useState<string>(loadStoredModel);
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

  function handleApiKeyChange(value: string) {
    setApiKey(value);
    saveApiKey(value);
  }

  function handleModelChange(value: string) {
    setModel(value);
    saveModel(value);
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
          APIキー(Anthropic)
          <input
            type="password"
            data-testid="ai-api-key-input"
            value={apiKey}
            onChange={(e) => handleApiKeyChange(e.target.value)}
            placeholder="sk-ant-..."
            autoComplete="off"
          />
        </label>
        <p style={{ margin: 0, fontSize: 11, color: "#aaa" }}>
          キーはこの端末のlocalStorageにのみ保存され、Anthropic API以外には送信されません。
        </p>

        <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
          モデル
          <select data-testid="ai-model-select" value={model} onChange={(e) => handleModelChange(e.target.value)}>
            {MODEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

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
