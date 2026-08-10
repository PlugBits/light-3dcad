// AIモデル生成(Phase 37/37b/39/45)のE2E。5ケース:
// (a) 貼り付けモード(Phase 45からPRIMARYフロー): AI生成パネルを開くと(詳細を開かずに)最初から
//     貼り付けUIが見えている。投稿用メタ情報(タイトル/説明/タグ)つきの新形式({model, meta})の
//     アウソリングJSONを貼り付けて読み込み、フィーチャーツリーにsketch+extrudeが現れ、ビューアに
//     形状が表示されることを確認する。読み込み後もパネルは自動的には閉じず、メタ情報読み込みの
//     確認メッセージが現れる(Phase 45)ので、明示的に「閉じる」を押してから検証する。続けて
//     「ギャラリーに投稿」を開き、タイトル/説明/タグがプレフィルされることも確認する。
// (b) 生成パス(Anthropic、SECONDARYフロー「APIキーで直接生成」): page.route()で
//     https://api.anthropic.com/** をインターセプトし、エンベロープ形式({design, questions:null,
//     model})のJSONをテキストブロックに含む(stop_reason: end_turn の)Messages APIストリーミング
//     応答を模擬する。実際のAPIには一切アクセスしない。生成成功後はパネルが自動的には閉じず、
//     「読み込み完了」+設計メモの折りたたみ表示が現れる(Phase 39)ので、明示的に「閉じる」を
//     押してから検証する。
// (c) 生成パス(OpenAI、SECONDARYフロー): 同様にhttps://api.openai.com/**をインターセプトし、
//     エンベロープ形式のJSONをoutput_textに含むResponses API応答を模擬する。実際のAPIには
//     一切アクセスしない。
// (d) 質問モード→回答フロー(SECONDARYフロー): 1回目の応答をquestions付きエンベロープにして、
//     チップUIが描画されることを確認し、「全部おまかせで生成」をクリック→2回目の応答(model付き
//     エンベロープ)でドキュメントが読み込まれることを確認する。
// (e) 後方互換: Phase 39以前の素の形式({sketches, features}、meta無し)を貼り付けても読み込める
//     ことを確認する(コードフェンス付きでも解析できることも併せて確認する)。
import { expect, test, type Page } from "@playwright/test";

import { collectPageErrors, gotoApp, waitForReady } from "./helpers";

const VALID_AUTHORING_JSON = {
  sketches: [
    {
      id: "s1",
      plane: "XY",
      entities: [
        { kind: "rectangle", id: "outer", center: [0, 0], width: 80, height: 40 },
        { kind: "circle", id: "hole", center: [0, 0], radius: 8 },
      ],
      segments: [],
      constraints: [],
    },
  ],
  features: [
    { type: "extrude", id: null, sketch: "s1", distance: 15, operation: "newBody", direction: 1, targetBody: null },
  ],
};

/** Phase 45: 貼り付けモードの新形式({model, meta})が提案するギャラリー投稿用メタ情報。 */
const VALID_PASTE_META = {
  title: "テスト用穴あきプレート",
  description: "幅80mm・高さ40mmの板の中央にφ16の穴を開けたE2Eテスト用モデル。",
  tags: ["テスト", "プレート"],
};

const VALID_PASTE_WRAPPER = { model: VALID_AUTHORING_JSON, meta: VALID_PASTE_META };

/** src/ai/envelopeSchema.ts の AiResponseEnvelope 形式(生成結果: design+model、questions:null)。 */
const VALID_ENVELOPE = {
  design: "## 対象物の実寸\n該当なし\n## 機能要件\nテスト用の板。\n## 主要寸法\n| 項目 | 値 | 根拠 |\n|---|---|---|\n| 幅 | 80mm | 指示どおり |\n## 造形方針\n矩形の内側に円を追加する。",
  questions: null,
  model: VALID_AUTHORING_JSON,
};

/** src/ai/envelopeSchema.ts の AiResponseEnvelope 形式(質問モード: questionsのみ、design/modelはnull)。 */
const QUESTIONS_ENVELOPE = {
  design: null,
  questions: [
    { question: "置き方は?", options: ["横置き", "縦置き", "おまかせ"] },
    { question: "穴の用途は?", options: ["ネジ止め", "ケーブル通し"] },
  ],
  model: null,
};

/**
 * AI生成パネルを開き、SECONDARYフロー「APIキーで直接生成(上級者向け)」を展開する
 * (APIキー生成テスト(b)(c)(d)の共通前準備、Phase 45)。PRIMARYフロー(貼り付け)は
 * 詳細を開かなくても最初から見えているため、この関数は使わない。
 */
async function openAiPanelAdvanced(page: Page) {
  await page.getByTestId("btn-ai-generate").click();
  await expect(page.getByTestId("ai-generate-panel")).toBeVisible();
  await page.locator('[data-testid="ai-advanced-details"] summary').click();
  await expect(page.getByTestId("ai-api-key-input")).toBeVisible();
}

test("AI生成: 貼り付けモード(PRIMARY)でメタ情報つきのアウソリングJSONを読み込むとsketch+extrudeが反映され、ギャラリー投稿にプレフィルされる", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  page.on("dialog", (dialog) => dialog.accept());

  await gotoApp(page);
  await waitForReady(page);

  // 貼り付けUIはパネルを開いた直後から見えている(詳細を開く必要が無い、Phase 45)。
  await page.getByTestId("btn-ai-generate").click();
  await expect(page.getByTestId("ai-generate-panel")).toBeVisible();
  await expect(page.getByTestId("ai-paste-json-textarea")).toBeVisible();

  await page.getByTestId("ai-paste-json-textarea").fill(JSON.stringify(VALID_PASTE_WRAPPER));
  await page.getByTestId("btn-ai-paste-load").click();

  // 読み込み完了後もパネルは自動的には閉じず、メタ情報読み込みの確認メッセージが現れる。
  await expect(page.getByTestId("ai-paste-loaded")).toBeVisible();
  await expect(page.getByTestId("ai-paste-meta-notice")).toContainText(VALID_PASTE_META.title);
  await page.getByTestId("btn-ai-close").click();

  await expect(page.getByTestId("ai-generate-panel")).toHaveCount(0);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  await expect(page.getByTestId("feature-item-Sketch1")).toBeVisible();
  await expect(page.getByTestId("feature-item-Extrude1")).toBeVisible();
  await expect(page.locator('[data-testid="viewer-container"] canvas')).toBeVisible();
  const mesh = await page.evaluate(() => window.__cadViewerDebug?.cameraDistance() ?? 0);
  expect(mesh).toBeGreaterThan(0);

  // ギャラリー投稿ダイアログにタイトル/説明/タグがプレフィルされていることを確認する(Phase 45)。
  await page.getByTestId("btn-gallery-submit").click();
  await expect(page.getByTestId("gallery-submit-dialog")).toBeVisible();
  await expect(page.getByTestId("gallery-submit-title-input")).toHaveValue(VALID_PASTE_META.title);
  await expect(page.getByTestId("gallery-submit-description-input")).toHaveValue(VALID_PASTE_META.description);
  await expect(page.getByTestId("gallery-submit-tags-input")).toHaveValue(VALID_PASTE_META.tags.join(", "));
  await page.getByTestId("btn-gallery-submit-close").click();

  expect(pageErrors).toEqual([]);
});

test("AI生成: 貼り付けモードは後方互換で旧形式(素の{sketches,features}、meta無し)もコードフェンス付きで読み込める", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  page.on("dialog", (dialog) => dialog.accept());

  await gotoApp(page);
  await waitForReady(page);

  await page.getByTestId("btn-ai-generate").click();
  await expect(page.getByTestId("ai-generate-panel")).toBeVisible();
  await page.getByTestId("ai-paste-json-textarea").fill("```json\n" + JSON.stringify(VALID_AUTHORING_JSON) + "\n```");
  await page.getByTestId("btn-ai-paste-load").click();

  await expect(page.getByTestId("ai-paste-loaded")).toBeVisible();
  // 旧形式にはmetaが無いため、メタ情報の確認メッセージは出ない。
  await expect(page.getByTestId("ai-paste-meta-notice")).toHaveCount(0);
  await page.getByTestId("btn-ai-close").click();

  await expect(page.getByTestId("ai-generate-panel")).toHaveCount(0);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("feature-item-Sketch1")).toBeVisible();
  await expect(page.getByTestId("feature-item-Extrude1")).toBeVisible();

  expect(pageErrors).toEqual([]);
});

/** Anthropic Messages APIのストリーミング(SSE)応答を模擬するボディを組み立てる。 */
function buildFakeMessagesSseBody(jsonText: string): string {
  const events: { event: string; data: unknown }[] = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_e2e_fake",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-opus-5",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      },
    },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: jsonText } },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 200 } },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
}

test("AI生成: 生成パス(Anthropic APIをインターセプト)で得たエンベロープが読み込まれる", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  page.on("dialog", (dialog) => dialog.accept());

  await page.route("https://api.anthropic.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: buildFakeMessagesSseBody(JSON.stringify(VALID_ENVELOPE)),
    });
  });
  const requestPromise = page.waitForRequest((req) => req.url().startsWith("https://api.anthropic.com/"));

  await gotoApp(page);
  await waitForReady(page);

  await openAiPanelAdvanced(page);
  await page.getByTestId("ai-api-key-input").fill("sk-ant-e2e-test-fake-key");
  await page.getByTestId("ai-prompt-textarea").fill("幅80 高さ40の板の中央にφ16の穴");
  await page.getByTestId("btn-ai-generate-submit").click();

  const request = await requestPromise;
  const sentBody = request.postDataJSON() as { model?: string; stream?: boolean };
  expect(sentBody.model).toBe("claude-opus-5");
  expect(sentBody.stream).toBe(true);

  // Phase 39: 生成成功後もパネルは自動的には閉じず、「読み込み完了」+設計メモの折りたたみが現れる。
  await expect(page.getByTestId("ai-generate-loaded")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("ai-design-details")).toBeVisible();
  await page.locator('[data-testid="ai-design-details"] summary').click();
  await expect(page.getByTestId("ai-design-text")).toContainText("対象物の実寸");
  await page.getByTestId("btn-ai-close").click();

  await expect(page.getByTestId("ai-generate-panel")).toHaveCount(0);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("feature-item-Sketch1")).toBeVisible();
  await expect(page.getByTestId("feature-item-Extrude1")).toBeVisible();

  expect(pageErrors).toEqual([]);
});

/** OpenAI Responses API(非ストリーミング)の応答を模擬するJSONボディを組み立てる。 */
function buildFakeResponsesApiBody(jsonText: string): unknown {
  return {
    id: "resp_e2e_fake",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    model: "gpt-5.5",
    output: [
      {
        id: "msg_e2e_fake",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: jsonText, annotations: [] }],
      },
    ],
    output_text: jsonText,
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 },
  };
}

test("AI生成: 生成パス(OpenAI APIをインターセプト)で得たエンベロープが読み込まれる", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  page.on("dialog", (dialog) => dialog.accept());

  await page.route("https://api.openai.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildFakeResponsesApiBody(JSON.stringify(VALID_ENVELOPE))),
    });
  });
  const requestPromise = page.waitForRequest((req) => req.url().startsWith("https://api.openai.com/"));

  await gotoApp(page);
  await waitForReady(page);

  await openAiPanelAdvanced(page);
  await page.getByTestId("ai-provider-select").selectOption("openai");
  await page.getByTestId("ai-api-key-input").fill("sk-e2e-test-fake-key");
  await page.getByTestId("ai-prompt-textarea").fill("幅80 高さ40の板の中央にφ16の穴");
  await page.getByTestId("btn-ai-generate-submit").click();

  const request = await requestPromise;
  const sentBody = request.postDataJSON() as { model?: string; text?: { format?: { type?: string; strict?: boolean } } };
  expect(sentBody.model).toBe("gpt-5.5");
  expect(sentBody.text?.format?.type).toBe("json_schema");
  expect(sentBody.text?.format?.strict).toBe(true);

  await expect(page.getByTestId("ai-generate-loaded")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("btn-ai-close").click();

  await expect(page.getByTestId("ai-generate-panel")).toHaveCount(0);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("feature-item-Sketch1")).toBeVisible();
  await expect(page.getByTestId("feature-item-Extrude1")).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test("AI生成: 質問モード→チップUIで「全部おまかせで生成」→2回目の応答でドキュメントが読み込まれる", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  page.on("dialog", (dialog) => dialog.accept());

  let callCount = 0;
  await page.route("https://api.anthropic.com/**", async (route) => {
    callCount += 1;
    const jsonText = callCount === 1 ? JSON.stringify(QUESTIONS_ENVELOPE) : JSON.stringify(VALID_ENVELOPE);
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: buildFakeMessagesSseBody(jsonText),
    });
  });

  await gotoApp(page);
  await waitForReady(page);

  await openAiPanelAdvanced(page);
  await page.getByTestId("ai-api-key-input").fill("sk-ant-e2e-test-fake-key");
  await page.getByTestId("ai-prompt-textarea").fill("iPhone用スタンド作って");

  const firstRequestPromise = page.waitForRequest((req) => req.url().startsWith("https://api.anthropic.com/"));
  await page.getByTestId("btn-ai-generate-submit").click();
  await firstRequestPromise;

  await expect(page.getByTestId("ai-questions-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("ai-question-0")).toContainText("置き方は?");
  await expect(page.getByTestId("ai-question-1")).toContainText("穴の用途は?");
  await expect(page.getByTestId("ai-question-0-option-0")).toContainText("横置き");

  const secondRequestPromise = page.waitForRequest((req) => req.url().startsWith("https://api.anthropic.com/"));
  await page.getByTestId("btn-ai-answer-all-omakase").click();
  const secondRequest = await secondRequestPromise;
  const secondBody = secondRequest.postDataJSON() as { messages?: { role: string; content: string }[] };
  const lastMessage = secondBody.messages?.[secondBody.messages.length - 1];
  expect(lastMessage?.role).toBe("user");
  expect(lastMessage?.content).toContain("おまかせ");

  await expect(page.getByTestId("ai-generate-loaded")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("ai-questions-panel")).toHaveCount(0);
  await page.getByTestId("btn-ai-close").click();

  await expect(page.getByTestId("ai-generate-panel")).toHaveCount(0);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("feature-item-Sketch1")).toBeVisible();
  await expect(page.getByTestId("feature-item-Extrude1")).toBeVisible();

  expect(callCount).toBe(2);
  expect(pageErrors).toEqual([]);
});
