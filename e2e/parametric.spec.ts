// パラメトリック再評価E2E: 寸法変更→再評価成功、および面上スケッチ作成後の
// 上流寸法変更でも(トポロジカルネーミングの幾何マッチングにより)エラーが出ないことを確認する。
import { expect, test } from "@playwright/test";

import { buildFaceCutFlow, collectPageErrors, waitForReady } from "./helpers";

test("矩形の寸法を変更すると再評価に成功しreadyへ復帰する", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await page.goto("/");
  await waitForReady(page);

  await page.getByTestId("feature-item-Sketch1").click();
  await expect(page.getByTestId("entity-rectangle-0-width")).toBeVisible();

  await page.getByTestId("entity-rectangle-0-width").fill("80");
  await page.getByTestId("entity-rectangle-0-height").fill("50");

  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test("面上スケッチ(穴)作成後も上流の矩形寸法を変更してエラーにならない", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await page.goto("/");
  await waitForReady(page);

  // 上面に穴(カット)を作成する。
  await buildFaceCutFlow(page);

  // 上流のSketch1(ベースとなる矩形)の寸法を変更する。
  await page.getByTestId("feature-item-Sketch1").click();
  await page.getByTestId("entity-rectangle-0-width").fill("70");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // 面参照(FaceSketch1)は面のトポロジカルなずれを幾何マッチングで解決するため、
  // 寸法変更後もエラーバナーが出ないままである(=穴を含むフィーチャー列が維持されている)。
  await page.getByTestId("entity-rectangle-0-height").fill("45");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("feature-item-FaceSketch1")).toBeVisible();

  expect(pageErrors).toEqual([]);
});
