// モデルギャラリー(Phase 40c)のE2E。
// リポジトリルートのmodels/(vite.config.tsのmodelsGalleryAssetsPluginがdevサーバーで配信)から
// "?g=<slug>"起動時ロードでモデルが読み込まれることを確認する。
import { expect, test } from "@playwright/test";

import { collectPageErrors, gotoApp, waitForReady } from "./helpers";

test("?g=plate-with-holeでギャラリーモデルが読み込まれる", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page, "/?g=plate-with-hole");
  await waitForReady(page);

  // 読み込み完了のトーストが表示され、クエリはURLから取り除かれる。
  await expect(page.getByTestId("constraint-conflict-toast")).toContainText("ギャラリーモデルを読み込みました");
  await expect(async () => {
    expect(await page.evaluate(() => window.location.search)).toBe("");
  }).toPass();

  // 穴あきプレートのフィーチャー(Sketch1: 矩形+穴の円、Extrude1)が反映されている。
  await expect(page.getByTestId("feature-item-Sketch1")).toBeVisible();
  await expect(page.getByTestId("feature-item-Extrude1")).toBeVisible();
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test("存在しないslugの?g=はエラートーストの上、通常起動になる", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page, "/?g=does-not-exist-slug");
  await waitForReady(page);

  await expect(page.getByTestId("constraint-conflict-toast")).toContainText("ギャラリーモデルの読み込みに失敗しました");
  await expect(async () => {
    expect(await page.evaluate(() => window.location.search)).toBe("");
  }).toPass();

  // 通常起動(初期ボックスのSketch1/Extrude1)のまま。
  await expect(page.getByTestId("feature-item-Sketch1")).toBeVisible();
  await expect(page.getByTestId("feature-item-Extrude1")).toBeVisible();
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test("リボンの「ギャラリー」リンクがgallery/を新しいタブで指す", async ({ page }) => {
  await gotoApp(page);
  await waitForReady(page);

  const link = page.getByTestId("btn-open-gallery");
  await expect(link).toBeVisible();
  // devサーバーのbaseは"/"のため、リンク先は"/gallery/"になる。
  await expect(link).toHaveAttribute("href", "/gallery/");
  await expect(link).toHaveAttribute("target", "_blank");
});
