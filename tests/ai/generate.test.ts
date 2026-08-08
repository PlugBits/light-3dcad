// src/ai/generate.ts の単体テスト(Phase 37)。callModel/dryRunEvaluate/solveSketchesはすべて
// フェイクを注入する(実際のAnthropic API・Worker・PlaneGCS WASMには一切触れない)。
import { describe, expect, it, vi } from "vitest";

import { generateCadDocument, type CallModelFn, type DryRunEvaluateFn, type SolveSketchesFn } from "../../src/ai/generate";
import type { CadDocument } from "../../src/model/types";
import type { WorkerResponse } from "../../src/protocol/messages";

const VALID_AUTHORING_JSON = {
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

const INVALID_AUTHORING_JSON = {
  sketches: [
    { id: "s1", plane: "XY", entities: [{ kind: "rectangle", id: "e1", center: [0, 0], width: -1, height: 50 }], segments: [], constraints: [] },
  ],
  features: [{ type: "extrude", id: null, sketch: "s1", distance: 10, operation: "newBody", direction: 1, targetBody: null }],
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
  }));
}

function passthroughSolveSketches(): SolveSketchesFn {
  return vi.fn(async (doc: CadDocument) => ({ doc, conflict: null }));
}

describe("generateCadDocument: 成功系", () => {
  it("1回目の生成で成功する(compile→solve→dry-run評価まで全て通過)", async () => {
    const callModel: CallModelFn = vi.fn(async () => ({ text: JSON.stringify(VALID_AUTHORING_JSON), stopReason: "end_turn" }));
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
    if (!result.ok) throw new Error("unreachable");
    expect(result.doc.features).toHaveLength(2);
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
        return { text: JSON.stringify(INVALID_AUTHORING_JSON), stopReason: "end_turn" };
      }
      // 2回目の呼び出しでは、直前のエラーが会話履歴(user側の修復プロンプト)に含まれているはず。
      const lastUserMessage = params.messages[params.messages.length - 1];
      expect(lastUserMessage.role).toBe("user");
      expect(lastUserMessage.content).toContain("正の数である必要があります");
      return { text: JSON.stringify(VALID_AUTHORING_JSON), stopReason: "end_turn" };
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
    if (!result.ok) throw new Error("unreachable");
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
      return { text: JSON.stringify(VALID_AUTHORING_JSON), stopReason: "end_turn" };
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
    if (!result.ok) throw new Error("unreachable");
    expect(result.transcript.attempts).toBe(2);
    expect(result.transcript.repaired[0].errors[0]).toContain("テスト用の評価失敗");
  });
});

describe("generateCadDocument: 失敗系", () => {
  it("最大試行回数(既定3回)すべて失敗すると失敗として返す", async () => {
    const callModel: CallModelFn = vi.fn(async () => ({ text: JSON.stringify(INVALID_AUTHORING_JSON), stopReason: "end_turn" }));
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
      return { text: JSON.stringify(VALID_AUTHORING_JSON), stopReason: "end_turn" };
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
    if (!result.ok) throw new Error("unreachable");
    expect(result.transcript.repaired[0].errors[0]).toContain("JSONとして解析できませんでした");
  });

  it("スケッチ拘束の矛盾(conflict)も修復リトライの対象になる", async () => {
    let call = 0;
    const callModel: CallModelFn = vi.fn(async () => {
      call += 1;
      return { text: JSON.stringify(VALID_AUTHORING_JSON), stopReason: "end_turn" };
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
    if (!result.ok) throw new Error("unreachable");
    expect(result.transcript.repaired[0].errors[0]).toContain("テスト用の矛盾");
  });
});
