// AIモデル生成(Phase 37)のE2E。2ケース:
// (a) 貼り付けモード: AI生成パネルを開き、小さな有効なアウソリングJSONを貼り付けて読み込み、
//     フィーチャーツリーにsketch+extrudeが現れ、ビューアに形状が表示されることを確認する。
// (b) 生成パス: page.route()で https://api.anthropic.com/** をインターセプトし、
//     有効なアウソリングJSONをテキストブロックに含む(stop_reason: end_turn の)Messages API
//     ストリーミング応答を模擬する。実際のAPIには一切アクセスしない。
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

/** AI生成パネルを開き、「詳細」を展開する(貼り付けモードの共通前準備)。 */
async function openAiPanelAdvanced(page: Page) {
  await page.getByTestId("btn-ai-generate").click();
  await expect(page.getByTestId("ai-generate-panel")).toBeVisible();
  await page.locator('[data-testid="ai-advanced-details"] summary').click();
  await expect(page.getByTestId("ai-paste-json-textarea")).toBeVisible();
}

test("AI生成: 貼り付けモードでアウソリングJSONを読み込むとsketch+extrudeが反映される", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  page.on("dialog", (dialog) => dialog.accept());

  await gotoApp(page);
  await waitForReady(page);

  await openAiPanelAdvanced(page);
  await page.getByTestId("ai-paste-json-textarea").fill(JSON.stringify(VALID_AUTHORING_JSON));
  await page.getByTestId("btn-ai-paste-load").click();

  // 確認ダイアログ承諾後、パネルが閉じて再評価が完了する。
  await expect(page.getByTestId("ai-generate-panel")).toHaveCount(0);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  await expect(page.getByTestId("feature-item-Sketch1")).toBeVisible();
  await expect(page.getByTestId("feature-item-Extrude1")).toBeVisible();
  await expect(page.locator('[data-testid="viewer-container"] canvas')).toBeVisible();
  const mesh = await page.evaluate(() => window.__cadViewerDebug?.cameraDistance() ?? 0);
  expect(mesh).toBeGreaterThan(0);

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

test("AI生成: 生成パス(Anthropic APIをインターセプト)で得たJSONが読み込まれる", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  page.on("dialog", (dialog) => dialog.accept());

  await page.route("https://api.anthropic.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: buildFakeMessagesSseBody(JSON.stringify(VALID_AUTHORING_JSON)),
    });
  });
  const requestPromise = page.waitForRequest((req) => req.url().startsWith("https://api.anthropic.com/"));

  await gotoApp(page);
  await waitForReady(page);

  await page.getByTestId("btn-ai-generate").click();
  await expect(page.getByTestId("ai-generate-panel")).toBeVisible();
  await page.getByTestId("ai-api-key-input").fill("sk-ant-e2e-test-fake-key");
  await page.getByTestId("ai-prompt-textarea").fill("幅80 高さ40の板の中央にφ16の穴");
  await page.getByTestId("btn-ai-generate-submit").click();

  const request = await requestPromise;
  const sentBody = request.postDataJSON() as { model?: string; stream?: boolean };
  expect(sentBody.model).toBe("claude-opus-5");
  expect(sentBody.stream).toBe(true);

  await expect(page.getByTestId("ai-generate-panel")).toHaveCount(0, { timeout: 30_000 });
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("feature-item-Sketch1")).toBeVisible();
  await expect(page.getByTestId("feature-item-Extrude1")).toBeVisible();

  expect(pageErrors).toEqual([]);
});
