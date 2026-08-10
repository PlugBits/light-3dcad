// src/ai/generate.ts の単体テスト(Phase 37/39)。callModel/dryRunEvaluate/solveSketchesはすべて
// フェイクを注入する(実際のAnthropic API・Worker・PlaneGCS WASMには一切触れない)。
// Phase 39: AI応答はエンベロープ形式({design, questions, model})になったため、フィクスチャも
// それに合わせた。質問モード(questions)の分岐・回答フロー(conversation引き継ぎ)・
// 質問ラウンドの上限(1回、超えたら自動「おまかせ」応答→なお質問したら失敗)のテストを追加した。
import { describe, expect, it, vi } from "vitest";

import { generateCadDocument, type CallModelFn, type DryRunEvaluateFn, type SolveSketchesFn } from "../../src/ai/generate";
import type { CadDocument } from "../../src/model/types";
import type { WorkerResponse } from "../../src/protocol/messages";

const VALID_MODEL = {
  sketches: [
    {
      id: "s1",
      plane: "XY",
      entities: [{ kind: "rectangle", id: "e1", center: [0, 0], width: 100, height: 50 }],
      segments: [],
      constraints: [],
    },
  ],
  features: [{ type: "extrude", id: null, sketch: "s1", distance: 10, operation: "newBody", direction: 1, targetBody: null }],
};

const VALID_ENVELOPE = { design: "## 対象物の実寸\n該当なし\n", questions: null, model: VALID_MODEL };

const INVALID_MODEL = {
  sketches: [
    { id: "s1", plane: "XY", entities: [{ kind: "rectangle", id: "e1", center: [0, 0], width: -1, height: 50 }], segments: [], constraints: [] },
  ],
  features: [{ type: "extrude", id: null, sketch: "s1", distance: 10, operation: "newBody", direction: 1, targetBody: null }],
};

const INVALID_ENVELOPE = { design: "invalid", questions: null, model: INVALID_MODEL };

const QUESTIONS_ENVELOPE = {
  design: null,
  questions: [
    { question: "置き方は?", options: ["横置き", "縦置き", "おまかせ"] },
    { question: "充電ケーブルを通しますか?", options: ["通す", "通さない"] },
  ],
  model: null,
};

function okDryRunEvaluate(): DryRunEvaluateFn {
  return vi.fn(async (doc: CadDocument): Promise<WorkerResponse> => ({
    kind: "evaluated",
    requestId: "req-1",
    mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(), faceGroups: [], edges: new Float32Array(), edgeGroups: [] },
    faceInfo: [],
    edgeInfo: [],
    sketchPlanes: [],
    referenceEdges: [],
    bodyGroups: [],
    solvedPlacements: [],
    threadAnnotations: [],
  }));
}

function passthroughSolveSketches(): SolveSketchesFn {
  return vi.fn(async (doc: CadDocument) => ({ doc, conflict: null }));
}

describe("generateCadDocument: 成功系(生成結果)", () => {
  it("1回目の生成で成功する(compile→solve→dry-run評価まで全て通過)", async () => {
    const callModel: CallModelFn = vi.fn(async () => ({ text: JSON.stringify(VALID_ENVELOPE), stopReason: "end_turn" }));
    const dryRunEvaluate = okDryRunEvaluate();
    const solveSketches = passthroughSolveSketches();
    const progressEvents: string[] = [];

    const result = await generateCadDocument({
      apiKey: "sk-ant-test",
      model: "claude-opus-5",
      prompt: "幅100 高さ50の板を10mm押し出す",
      callModel,
      dryRunEvaluate,
      solveSketches,
      onProgress: (p) => progressEvents.push(`${p.attempt}/${p.maxAttempts}:${p.phase}`),
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "document") throw new Error("unreachable");
    expect(result.doc.features).toHaveLength(2);
    expect(result.design).toBe(VALID_ENVELOPE.design);
    expect(result.transcript.attempts).toBe(1);
    expect(result.transcript.repaired).toEqual([]);
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(dryRunEvaluate).toHaveBeenCalledTimes(1);
    expect(progressEvents).toEqual(["1/3:generating", "1/3:compiling", "1/3:solving", "1/3:evaluating"]);
  });

  it("エラー→修復→成功: コンパイルエラーの後、次の試行で有効なJSONを返せば成功する", async () => {
    let call = 0;
    const callModel: CallModelFn = vi.fn(async (params) => {
      call += 1;
      if (call === 1) {
        return { text: JSON.stringify(INVALID_ENVELOPE), stopReason: "end_turn" };
      }
      const lastUserMessage = params.messages[params.messages.length - 1];
      expect(lastUserMessage.role).toBe("user");
      expect(lastUserMessage.content).toContain("正の数である必要があります");
      return { text: JSON.stringify(VALID_ENVELOPE), stopReason: "end_turn" };
    });
    const dryRunEvaluate = okDryRunEvaluate();
    const solveSketches = passthroughSolveSketches();

    const result = await generateCadDocument({
      apiKey: "sk-ant-test",
      model: "claude-opus-5",
      prompt: "幅-1の板(壊れたプロンプトの想定)",
      callModel,
      dryRunEvaluate,
      solveSketches,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "document") throw new Error("unreachable");
    expect(result.transcript.attempts).toBe(2);
    expect(result.transcript.repaired).toHaveLength(1);
    expect(result.transcript.repaired[0].attempt).toBe(1);
    expect(result.transcript.repaired[0].errors.length).toBeGreaterThan(0);
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("ドライラン評価が失敗した場合もエラーを伝えて修復リトライする", async () => {
    let call = 0;
    const callModel: CallModelFn = vi.fn(async () => {
      call += 1;
      return { text: JSON.stringify(VALID_ENVELOPE), stopReason: "end_turn" };
    });
    const dryRunEvaluate: DryRunEvaluateFn = vi.fn(async (): Promise<WorkerResponse> => {
      if (call === 1) return { kind: "error", requestId: "req-1", message: "テスト用の評価失敗" };
      return {
        kind: "evaluated",
        requestId: "req-2",
        mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(), faceGroups: [], edges: new Float32Array(), edgeGroups: [] },
        faceInfo: [],
        edgeInfo: [],
        sketchPlanes: [],
        referenceEdges: [],
        bodyGroups: [],
        solvedPlacements: [],
        threadAnnotations: [],
      };
    });
    const solveSketches = passthroughSolveSketches();

    const result = await generateCadDocument({
      apiKey: "sk-ant-test",
      model: "claude-opus-5",
      prompt: "評価が最初は失敗する想定",
      callModel,
      dryRunEvaluate,
      solveSketches,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "document") throw new Error("unreachable");
    expect(result.transcript.attempts).toBe(2);
    expect(result.transcript.repaired[0].errors[0]).toContain("テスト用の評価失敗");
  });
});

describe("generateCadDocument: 質問モード", () => {
  it("AIがquestionsを返すと、生成せずquestions結果を返す(conversationにアシスタント応答を含む)", async () => {
    const callModel: CallModelFn = vi.fn(async () => ({ text: JSON.stringify(QUESTIONS_ENVELOPE), stopReason: "end_turn" }));
    const dryRunEvaluate = okDryRunEvaluate();
    const solveSketches = passthroughSolveSketches();

    const result = await generateCadDocument({
      apiKey: "sk-ant-test",
      model: "claude-opus-5",
      prompt: "iPhone用スタンド作って",
      callModel,
      dryRunEvaluate,
      solveSketches,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "questions") throw new Error("unreachable");
    expect(result.questions).toHaveLength(2);
    expect(result.questions[0].question).toBe("置き方は?");
    expect(result.conversation).toHaveLength(2);
    expect(result.conversation[0]).toEqual({ role: "user", content: "iPhone用スタンド作って" });
    expect(result.conversation[1].role).toBe("assistant");
    expect(dryRunEvaluate).not.toHaveBeenCalled();
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("質問への回答(conversation引き継ぎ+answeringQuestions:true)を送ると生成に進む", async () => {
    let call = 0;
    const callModel: CallModelFn = vi.fn(async (params) => {
      call += 1;
      if (call === 1) {
        expect(params.messages[params.messages.length - 1].content).toContain("横置き");
        return { text: JSON.stringify(VALID_ENVELOPE), stopReason: "end_turn" };
      }
      throw new Error("unreachable: 2回目の呼び出しは想定外");
    });
    const dryRunEvaluate = okDryRunEvaluate();
    const solveSketches = passthroughSolveSketches();

    const priorConversation = [
      { role: "user" as const, content: "iPhone用スタンド作って" },
      { role: "assistant" as const, content: JSON.stringify(QUESTIONS_ENVELOPE) },
    ];

    const result = await generateCadDocument({
      apiKey: "sk-ant-test",
      model: "claude-opus-5",
      prompt: "iPhone用スタンド作って",
      conversation: [...priorConversation, { role: "user", content: "1. 横置き / 2. おまかせ" }],
      answeringQuestions: true,
      callModel,
      dryRunEvaluate,
      solveSketches,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "document") throw new Error("unreachable");
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("回答フローでAIが再度questionsを返した場合、1回だけ自動で「おまかせ」応答して生成へ進む", async () => {
    let call = 0;
    const callModel: CallModelFn = vi.fn(async (params) => {
      call += 1;
      if (call === 1) {
        return { text: JSON.stringify(QUESTIONS_ENVELOPE), stopReason: "end_turn" };
      }
      // 自動応答されたメッセージが会話に含まれているはず。
      const lastUserMessage = params.messages[params.messages.length - 1];
      expect(lastUserMessage.role).toBe("user");
      expect(lastUserMessage.content).toBe("すべておまかせで生成してください");
      return { text: JSON.stringify(VALID_ENVELOPE), stopReason: "end_turn" };
    });
    const dryRunEvaluate = okDryRunEvaluate();
    const solveSketches = passthroughSolveSketches();

    const result = await generateCadDocument({
      apiKey: "sk-ant-test",
      model: "claude-opus-5",
      prompt: "iPhone用スタンド作って",
      conversation: [
        { role: "user", content: "iPhone用スタンド作って" },
        { role: "assistant", content: JSON.stringify(QUESTIONS_ENVELOPE) },
        { role: "user", content: "1. 横置き" },
      ],
      answeringQuestions: true,
      callModel,
      dryRunEvaluate,
      solveSketches,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "document") throw new Error("unreachable");
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(result.transcript.repaired).toHaveLength(1);
    expect(result.transcript.repaired[0].errors[0]).toContain("再度質問しました");
  });

  it("自動応答後もAIが3回目の質問をしてきた場合は失敗として返す", async () => {
    const callModel: CallModelFn = vi.fn(async () => ({ text: JSON.stringify(QUESTIONS_ENVELOPE), stopReason: "end_turn" }));
    const dryRunEvaluate = okDryRunEvaluate();
    const solveSketches = passthroughSolveSketches();

    const result = await generateCadDocument({
      apiKey: "sk-ant-test",
      model: "claude-opus-5",
      prompt: "iPhone用スタンド作って",
      conversation: [
        { role: "user", content: "iPhone用スタンド作って" },
        { role: "assistant", content: JSON.stringify(QUESTIONS_ENVELOPE) },
        { role: "user", content: "1. 横置き" },
      ],
      answeringQuestions: true,
      callModel,
      dryRunEvaluate,
      solveSketches,
      maxAttempts: 3,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("再度質問してきた");
    // 1回目(質問→自動おまかせ応答)+2回目(それでも質問→失敗)で2回呼ばれる。
    expect(callModel).toHaveBeenCalledTimes(2);
  });
});

describe("generateCadDocument: 失敗系", () => {
  it("最大試行回数(既定3回)すべて失敗すると失敗として返す", async () => {
    const callModel: CallModelFn = vi.fn(async () => ({ text: JSON.stringify(INVALID_ENVELOPE), stopReason: "end_turn" }));
    const dryRunEvaluate = okDryRunEvaluate();
    const solveSketches = passthroughSolveSketches();

    const result = await generateCadDocument({
      apiKey: "sk-ant-test",
      model: "claude-opus-5",
      prompt: "常に無効なJSONを返すフェイク",
      callModel,
      dryRunEvaluate,
      solveSketches,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.transcript.attempts).toBe(3);
    expect(result.transcript.repaired).toHaveLength(3);
    expect(callModel).toHaveBeenCalledTimes(3);
    expect(dryRunEvaluate).not.toHaveBeenCalled();
  });

  it("stop_reason:refusalの場合は即座に失敗として返す(リトライしない)", async () => {
    const callModel: CallModelFn = vi.fn(async () => ({ text: "", stopReason: "refusal" }));
    const dryRunEvaluate = okDryRunEvaluate();
    const solveSketches = passthroughSolveSketches();

    const result = await generateCadDocument({
      apiKey: "sk-ant-test",
      model: "claude-opus-5",
      prompt: "危険な内容(想定)",
      callModel,
      dryRunEvaluate,
      solveSketches,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("拒否");
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(result.transcript.attempts).toBe(1);
  });

  it("callModelが例外(APIキー無効等)を投げた場合は即座に失敗として返す(リトライしない)", async () => {
    const callModel: CallModelFn = vi.fn(async () => {
      throw new Error("APIキーが無効です。設定を確認してください。");
    });
    const dryRunEvaluate = okDryRunEvaluate();
    const solveSketches = passthroughSolveSketches();

    const result = await generateCadDocument({
      apiKey: "invalid-key",
      model: "claude-opus-5",
      prompt: "何か作って",
      callModel,
      dryRunEvaluate,
      solveSketches,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toBe("APIキーが無効です。設定を確認してください。");
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("JSONとして解析できない応答は修復リトライの対象になる", async () => {
    let call = 0;
    const callModel: CallModelFn = vi.fn(async () => {
      call += 1;
      if (call === 1) return { text: "これはJSONではありません", stopReason: "end_turn" };
      return { text: JSON.stringify(VALID_ENVELOPE), stopReason: "end_turn" };
    });
    const dryRunEvaluate = okDryRunEvaluate();
    const solveSketches = passthroughSolveSketches();

    const result = await generateCadDocument({
      apiKey: "sk-ant-test",
      model: "claude-opus-5",
      prompt: "壊れたJSONを返す想定",
      callModel,
      dryRunEvaluate,
      solveSketches,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "document") throw new Error("unreachable");
    expect(result.transcript.repaired[0].errors[0]).toContain("JSONとして解析できませんでした");
  });

  it("エンベロープの形式が不正(design/questions/modelどちらの形でもない)な場合も修復リトライの対象になる", async () => {
    let call = 0;
    const callModel: CallModelFn = vi.fn(async () => {
      call += 1;
      if (call === 1) return { text: JSON.stringify({ foo: "bar" }), stopReason: "end_turn" };
      return { text: JSON.stringify(VALID_ENVELOPE), stopReason: "end_turn" };
    });
    const dryRunEvaluate = okDryRunEvaluate();
    const solveSketches = passthroughSolveSketches();

    const result = await generateCadDocument({
      apiKey: "sk-ant-test",
      model: "claude-opus-5",
      prompt: "不正な形のエンベロープを返す想定",
      callModel,
      dryRunEvaluate,
      solveSketches,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "document") throw new Error("unreachable");
    expect(result.transcript.repaired[0].errors[0]).toContain("応答の形式が仕様");
  });

  it("スケッチ拘束の矛盾(conflict)も修復リトライの対象になる", async () => {
    let call = 0;
    const callModel: CallModelFn = vi.fn(async () => {
      call += 1;
      return { text: JSON.stringify(VALID_ENVELOPE), stopReason: "end_turn" };
    });
    const dryRunEvaluate = okDryRunEvaluate();
    const solveSketches: SolveSketchesFn = vi.fn(async (doc: CadDocument) => {
      if (call === 1) return { doc, conflict: { featureId: "sketch-x", message: "テスト用の矛盾" } };
      return { doc, conflict: null };
    });

    const result = await generateCadDocument({
      apiKey: "sk-ant-test",
      model: "claude-opus-5",
      prompt: "拘束が矛盾する想定",
      callModel,
      dryRunEvaluate,
      solveSketches,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "document") throw new Error("unreachable");
    expect(result.transcript.repaired[0].errors[0]).toContain("テスト用の矛盾");
  });
});
