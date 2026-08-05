// フルフローE2E: ロード→ready→初期ボックス表示→上面選択→選択面にスケッチ→
// 円(r=10)追加→押し出し追加(Cut・深さ10・方向反転)→評価エラーなし→STLダウンロード。
// 要求8ステップ(docs/PLAN.md)の一気通貫シナリオ。
import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { buildFaceCutFlow, collectPageErrors, waitForReady } from "./helpers";

test("フルフロー: スケッチ→押し出し→面選択→面上スケッチ→カット→STL出力", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await page.goto("/");

  // 1. ロード直後は初期化中オーバーレイが表示される。
  await expect(page.getByTestId("init-overlay")).toBeVisible();

  // 2. ready状態になるまで待つ(WASM初期化+初期ドキュメント評価)。
  await waitForReady(page);

  // 3. 初期ボックス(XYスケッチ矩形60x40 -> 押し出し20mm)が表示されている。
  await expect(page.getByTestId("feature-item-Sketch1")).toBeVisible();
  await expect(page.getByTestId("feature-item-Extrude1")).toBeVisible();
  await expect(page.locator('[data-testid="viewer-container"] canvas')).toBeVisible();
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // 4〜7. 上面クリック→面選択表示→選択面にスケッチ→円(r=10)→押し出し追加(Cut・深さ10・方向反転)。
  await buildFaceCutFlow(page);

  // 評価エラーが出ていないこと。
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("status-text")).toContainText("状態: ready");

  // 8. STLダウンロード。ファイル内容がSTL形式であることを検証する
  // (replicadのblobSTLはデフォルトでASCII STLを出力するため、"solid"ヘッダと
  //  "facet normal" / "endsolid" キーワードの有無で判定する)。
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("btn-download-stl").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("model.stl");

  const stlPath = await download.path();
  expect(stlPath).toBeTruthy();
  const content = readFileSync(stlPath as string, "utf-8");
  expect(content.slice(0, 5).toLowerCase()).toBe("solid");
  expect(content).toMatch(/facet normal/);
  expect(content.trim().toLowerCase()).toMatch(/endsolid/);

  await expect(page.getByTestId("export-error")).toHaveCount(0);

  // pageerrorが発生していないこと。
  expect(pageErrors).toEqual([]);
});
