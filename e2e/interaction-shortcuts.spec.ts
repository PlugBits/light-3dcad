// 操作感パック(Phase 49)の focused E2E: キーボードショートカット(Ctrl+Z)・
// 右クリックコンテキストメニュー(フィーチャーツリー行・キャンバス空クリック)・Fキーのフィットを
// それぞれ最小限で検証する。マウス操作・ショートカット一覧オーバーレイ自体の細部はVitest
// (tests/viewer/zoomToCursor.test.ts, tests/app/shortcuts.test.ts)でカバー済みのため、ここでは
// 実際のDOM/ブラウザイベント経由での結線のみを確認する(Keep lean)。
import { expect, test } from "@playwright/test";

import { collectPageErrors, gotoApp, screenPointForWorld, waitForReady } from "./helpers";

test("Ctrl+Zで矩形の描画を取り消せる", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await gotoApp(page);
  await waitForReady(page);

  // 新規スケッチ(Sketch2)を追加し、矩形ツールで1つ作図する(nested-hole.spec.tsと同じパターン)。
  await page.getByTestId("btn-add-sketch").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();

  await page.getByTestId("btn-draw-rect").click();
  const corner1 = await screenPointForWorld(page, [-10, -5, 0]);
  const corner2 = await screenPointForWorld(page, [10, 5, 0]);
  await page.mouse.click(corner1.x, corner1.y);
  await page.mouse.click(corner2.x, corner2.y);
  await waitForReady(page);
  await expect(page.getByTestId("entity-rectangle-0-width")).toHaveValue("20");

  // Ctrl+Zで矩形の追加そのものが取り消される(エンティティが消える)。
  await page.keyboard.press("Control+z");
  await waitForReady(page);
  await expect(page.getByTestId("entity-rectangle-0-width")).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test("フィーチャーツリー行の右クリックメニュー: 削除できる", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await gotoApp(page);
  await waitForReady(page);

  // 依存フィーチャーの無い空のSketch2を追加する(削除確認ダイアログが出ないようにするため)。
  await page.getByTestId("btn-add-sketch").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();

  await page.getByTestId("feature-item-Sketch2").click({ button: "right" });
  const menu = page.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  await expect(page.getByTestId("context-menu-item-edit-select")).toBeVisible();
  await expect(page.getByTestId("context-menu-item-rename")).toBeVisible();
  await expect(page.getByTestId("context-menu-item-delete")).toBeVisible();

  await page.getByTestId("context-menu-item-delete").click();
  await expect(menu).toHaveCount(0);
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-Sketch2")).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test("キャンバス空クリックの右クリックメニュー: フィット/等角/正面が表示される", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await gotoApp(page);
  await waitForReady(page);

  // 初期ボックス(60x40x20)は自動フィットで画面中央付近に収まっているため、canvas左上隅は
  // ボディに重ならない空クリックになるはず。
  const canvas = page.locator('[data-testid="viewer-container"] canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error("viewer canvas が見つかりません");
  await page.mouse.click(box.x + box.width * 0.05, box.y + box.height * 0.05, { button: "right" });

  const menu = page.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  await expect(page.getByTestId("context-menu-item-fit-empty")).toHaveText("フィット");
  await expect(page.getByTestId("context-menu-item-view-iso")).toHaveText("等角");
  await expect(page.getByTestId("context-menu-item-view-front")).toHaveText("正面");

  // Escapeで閉じられる。
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test("Fキーでフィットする(ズーム→Fで概ね元のカメラ距離に戻る)", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await gotoApp(page);
  await waitForReady(page);

  const initialDistance = await page.evaluate(() => window.__cadViewerDebug?.cameraDistance() ?? 0);
  expect(initialDistance).toBeGreaterThan(0);

  const canvas = page.locator('[data-testid="viewer-container"] canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error("viewer canvas が見つかりません");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // deltaY>0側がdolly()の実際の計算上ズームイン方向になる(handleWheel参照)。
  await page.mouse.wheel(0, 1200);

  const zoomedDistance = await page.evaluate(() => window.__cadViewerDebug?.cameraDistance() ?? 0);
  expect(zoomedDistance).toBeLessThan(initialDistance * 0.9);

  await page.keyboard.press("f");
  const fitDistance = await page.evaluate(() => window.__cadViewerDebug?.cameraDistance() ?? 0);
  expect(fitDistance).toBeGreaterThan(zoomedDistance);
  expect(fitDistance).toBeGreaterThan(initialDistance * 0.9);
  expect(fitDistance).toBeLessThan(initialDistance * 1.1);

  expect(pageErrors).toEqual([]);
});
