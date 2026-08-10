// Phase 37/37b/39/45: AIモデル生成パネル(自然言語プロンプト→設計メモ+アウソリングJSON→CadDocument)。
// src/app/App.tsx から React.lazy() 経由でのみ読み込まれる(@anthropic-ai/sdk・openaiはこのチャンクからも
// 直接importせず、src/ai/generate.ts・src/ai/openaiClient.tsの中でさらに動的importする。
// メインバンドルには一切含まれない)。
// Phase 45: 「OSS/無料優先」の方針(docs/PLAN.md参照)により、コピー&ペースト経由の生成
// (外部のAIチャットにプロンプト仕様を貼り付けて生成させ、返ってきたJSONを本アプリに貼り付ける、
// APIキー不要)をPRIMARYフローに格上げした。従来PRIMARYだったAPIキー直接生成(プロバイダ選択+
// APIキー入力+プロンプト+生成、自己修復リトライ込み)は、`<details>`で折りたたむSECONDARYフロー
// 「APIキーで直接生成(上級者向け)」として温存する(機能・testidは変更しない)。
// Phase 39: AI応答が質問(questions)を返した場合はチップUIで回答を選ばせ、回答を含めて
// 再度generateCadDocument()を呼ぶ(会話を引き継ぐ)。生成成功時は設計メモ(design)を
// 折りたたみ表示し、パネルは閉じずに残す(寸法を確認しながら繰り返し生成できるようにするため)。
import { useEffect, useState } from "react";

import { compileAuthoringModel } from "../ai/compile";
import { generateCadDocument, type AiQuestion, type GenerateProgress, type ModelMessage } from "../ai/generate";
import { parsePastePayload, type GallerySubmitMeta } from "../ai/pastePayload";
import { AUTHORING_PASTE_PROMPT } from "../ai/promptSpec";
import { getCallModelForProvider, PROVIDER_LABEL, PROVIDERS, type Provider } from "../ai/provider";
import { useCadStore } from "../state/store";
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

  // Phase 39: 質問モード(AIが寸法確定に必要な質問を返した場合)の状態。
  const [questions, setQuestions] = useState<AiQuestion[] | null>(null);
  const [conversation, setConversation] = useState<ModelMessage[] | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [freeText, setFreeText] = useState<Record<number, string>>({});

  // Phase 39: 生成成功後の設計メモ表示用状態(パネルは閉じずに残す)。
  const [design, setDesign] = useState<string | null>(null);
  const [designOpen, setDesignOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pasteJson, setPasteJson] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  // Phase 45: 貼り付け読み込み成功後の確認表示(パネルは自動で閉じない。寸法を見ながら
  // 続けて別のモデルを貼り付けたり、確認してから手動で「閉じる」を押せるようにするため)。
  const [pasteLoaded, setPasteLoaded] = useState(false);
  const [pasteLoadedMeta, setPasteLoadedMeta] = useState<GallerySubmitMeta | null>(null);

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
    setQuestions(null);
    setConversation(null);
    setAnswers({});
    setFreeText({});
    setLoaded(false);
    setProgress({ attempt: 1, maxAttempts: 3, phase: "generating" });
    try {
      const result = await generateCadDocument({
        apiKey: apiKey.trim(),
        model,
        prompt: prompt.trim(),
        callModel: getCallModelForProvider(provider),
        onProgress: (p) => setProgress(p),
      });
      applyGenerateResult(result);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  /** 質問への回答(またはすべて「おまかせ」)を送信し、会話を引き継いで再度生成する。 */
  async function handleAnswerSubmit(useAllOmakase: boolean) {
    if (busy || !conversation || !questions) return;
    const answerText = questions
      .map((_, i) => {
        const override = freeText[i]?.trim();
        const chosen = useAllOmakase ? "おまかせ" : override || answers[i] || "おまかせ";
        return `${i + 1}. ${chosen}`;
      })
      .join(" / ");
    setBusy(true);
    setErrorMessage(null);
    setProgress({ attempt: 1, maxAttempts: 3, phase: "generating" });
    try {
      const result = await generateCadDocument({
        apiKey: apiKey.trim(),
        model,
        prompt: prompt.trim(),
        conversation: [...conversation, { role: "user", content: answerText }],
        answeringQuestions: true,
        callModel: getCallModelForProvider(provider),
        onProgress: (p) => setProgress(p),
      });
      applyGenerateResult(result);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  /** generateCadDocument()の結果を質問モード/生成成功/失敗のいずれかとして状態へ反映する共通処理。 */
  function applyGenerateResult(result: Awaited<ReturnType<typeof generateCadDocument>>) {
    if (!result.ok) {
      setErrorMessage(result.message);
      return;
    }
    if (result.kind === "questions") {
      setQuestions(result.questions);
      setConversation(result.conversation);
      setAnswers({});
      setFreeText({});
      return;
    }
    setQuestions(null);
    setConversation(null);
    setDesign(result.design);
    setLoaded(true);
    onLoad(result.doc);
  }

  /**
   * 貼り付けモード(PRIMARYフロー)の「読み込む」ボタン。Phase 45から、
   * - コードフェンス([```json ... ```])を自動で剥がす
   * - 新形式({model, meta})・旧形式({sketches, features}、後方互換)のどちらも受け付ける
   * - meta(ギャラリー投稿用のタイトル/説明/タグ提案)があればstore(pendingGalleryMeta)へ保存する
   * (src/ai/pastePayload.ts の parsePastePayload() 参照)。読み込み成功後もパネルは自動的には
   * 閉じない(確認できてから手動で「閉じる」、または続けて別のモデルを貼り付けられるようにするため)。
   */
  function handlePasteLoad() {
    setPasteError(null);
    setPasteLoaded(false);
    setPasteLoadedMeta(null);

    const parsed = parsePastePayload(pasteJson);
    if (!parsed.ok) {
      setPasteError(parsed.error);
      return;
    }
    const compiled = compileAuthoringModel(parsed.model);
    if ("errors" in compiled) {
      setPasteError(compiled.errors.join("\n"));
      return;
    }
    onLoad(compiled.doc);
    if (parsed.meta) {
      // loadDocument()(onLoad経由)がpendingGalleryMetaをnullへリセットした「後」に、
      // ここで改めて新しいmetaを設定する(store.tsのpendingGalleryMetaコメント参照)。
      useCadStore.getState().setPendingGalleryMeta(parsed.meta);
    }
    setPasteLoaded(true);
    setPasteLoadedMeta(parsed.meta);
  }

  async function handleCopyPromptSpec() {
    try {
      await navigator.clipboard.writeText(AUTHORING_PASTE_PROMPT);
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

        {/* ------------------------------------------------------------------------------- */}
        {/* PRIMARY: コピー&ペースト経由の生成(Phase 45。APIキー不要)。                          */}
        {/* ------------------------------------------------------------------------------- */}
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: "#ccc" }}>
          ChatGPTやClaudeなど、お好みのAIチャットで使えます。APIキー不要。
        </p>

        <button type="button" data-testid="btn-ai-copy-prompt-spec" onClick={handleCopyPromptSpec}>
          プロンプト仕様をコピー
        </button>
        {copyNotice && (
          <p style={{ margin: 0, fontSize: 11, color: "#9cf" }} data-testid="ai-copy-notice">
            {copyNotice}
          </p>
        )}

        <ol data-testid="ai-usage-steps" style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: "#aaa", lineHeight: 1.7 }}>
          <li>上のボタンでプロンプト仕様をコピー</li>
          <li>AIチャットに貼って要望を伝える</li>
          <li>返ってきたJSONを下に貼り付け</li>
        </ol>

        <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
          AIチャットの返答(JSON)を貼り付け
          <textarea
            data-testid="ai-paste-json-textarea"
            value={pasteJson}
            onChange={(e) => setPasteJson(e.target.value)}
            rows={6}
            placeholder='{"model": {"sketches": [...], "features": [...]}, "meta": {"title": "...", "description": "...", "tags": ["..."]}}'
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
        {pasteLoaded && (
          <div data-testid="ai-paste-loaded" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <p style={{ margin: 0, fontSize: 12, color: "#8f8" }}>読み込み完了 — ドキュメントに反映しました</p>
            {pasteLoadedMeta && (
              <p data-testid="ai-paste-meta-notice" style={{ margin: 0, fontSize: 12, color: "#9cf" }}>
                投稿用メタ情報を読み込みました: {pasteLoadedMeta.title}
              </p>
            )}
          </div>
        )}

        {/* ------------------------------------------------------------------------------- */}
        {/* SECONDARY: APIキー直接生成(上級者向け)。従来PRIMARYだったフロー、機能は変更しない。      */}
        {/* ------------------------------------------------------------------------------- */}
        <details
          data-testid="ai-advanced-details"
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
          style={{ borderTop: "1px solid #444", paddingTop: 8 }}
        >
          <summary style={{ cursor: "pointer", fontSize: 12 }}>APIキーで直接生成(上級者向け)</summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
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

            {questions && (
              <div
                data-testid="ai-questions-panel"
                style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px solid #444", paddingTop: 8 }}
              >
                <p style={{ margin: 0, fontSize: 12, color: "#9cf" }} data-testid="ai-generate-awaiting-answers">
                  質問に回答待ち — 設計を確定するためにいくつか確認させてください
                </p>
                {questions.map((q, i) => (
                  <div key={i} data-testid={`ai-question-${i}`} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <p style={{ margin: 0, fontSize: 12 }}>
                      {i + 1}. {q.question}
                    </p>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {q.options.map((opt, j) => {
                        const selected = answers[i] === opt;
                        return (
                          <button
                            key={j}
                            type="button"
                            data-testid={`ai-question-${i}-option-${j}`}
                            onClick={() => setAnswers((a) => ({ ...a, [i]: opt }))}
                            style={{
                              fontSize: 11,
                              padding: "4px 8px",
                              borderRadius: 12,
                              border: selected ? "1px solid #9cf" : "1px solid #555",
                              background: selected ? "#2c4a5e" : "transparent",
                              color: "#eee",
                              cursor: "pointer",
                            }}
                          >
                            {opt}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        data-testid={`ai-question-${i}-omakase`}
                        onClick={() => setAnswers((a) => ({ ...a, [i]: "おまかせ" }))}
                        style={{
                          fontSize: 11,
                          padding: "4px 8px",
                          borderRadius: 12,
                          border: answers[i] === "おまかせ" ? "1px solid #9cf" : "1px dashed #777",
                          background: answers[i] === "おまかせ" ? "#2c4a5e" : "transparent",
                          color: "#ccc",
                          cursor: "pointer",
                        }}
                      >
                        おまかせ
                      </button>
                    </div>
                    <details style={{ fontSize: 11 }}>
                      <summary style={{ cursor: "pointer", color: "#888" }}>自由回答で上書き</summary>
                      <input
                        type="text"
                        data-testid={`ai-question-${i}-freetext`}
                        value={freeText[i] ?? ""}
                        onChange={(e) => setFreeText((f) => ({ ...f, [i]: e.target.value }))}
                        style={{ width: "100%", marginTop: 4 }}
                      />
                    </details>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" data-testid="btn-ai-answer-submit" onClick={() => handleAnswerSubmit(false)} disabled={busy}>
                    回答して生成
                  </button>
                  <button type="button" data-testid="btn-ai-answer-all-omakase" onClick={() => handleAnswerSubmit(true)} disabled={busy}>
                    全部おまかせで生成
                  </button>
                </div>
              </div>
            )}

            {loaded && (
              <div
                data-testid="ai-generate-loaded"
                style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid #444", paddingTop: 8 }}
              >
                <p style={{ margin: 0, fontSize: 12, color: "#8f8" }}>読み込み完了 — ドキュメントに反映しました</p>
                {design && (
                  <details
                    data-testid="ai-design-details"
                    open={designOpen}
                    onToggle={(e) => setDesignOpen((e.target as HTMLDetailsElement).open)}
                  >
                    <summary style={{ cursor: "pointer", fontSize: 12 }}>設計メモを表示</summary>
                    <pre
                      data-testid="ai-design-text"
                      style={{ whiteSpace: "pre-wrap", fontSize: 11, color: "#ccc", margin: "6px 0 0", fontFamily: "inherit" }}
                    >
                      {design}
                    </pre>
                  </details>
                )}
              </div>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}
