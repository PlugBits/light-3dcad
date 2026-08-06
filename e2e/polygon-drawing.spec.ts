// 線描画モード(Phase 8)のE2E: 新規スケッチ→平面に正対→線描画モードで矩形を4クリック+
// 始点付近クリックで確定→押し出し追加、までを一気通貫で検証する。
// 初期ドキュメントには既にNew Bodyの押し出し(Extrude1)がある(Phase 13以降、押し出し追加時の
// デフォルトoperationはボディの有無に応じて自動的に"add"になるため、この時点ではエラーにならない)。
// 新規スケッチの押し出しは最終的にCut(初期ボックスをZ方向に貫通させる穴)にする
// (sketchPlanesはWorkerの直近の評価成功時のものが保持され続けるため、ドキュメントを常に
// 評価成功する状態に保っておかないと「平面に正対」「線描画」ボタンが有効化されない)。
import { expect, test } from "@playwright/test";

import { collectPageErrors, screenPointForWorld, waitForReady, waitForStatus } from "./helpers";

test("線描画モードでクリックして矩形を描き、閉じて押し出し(Cut)できる", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await page.goto("/");
  await waitForReady(page);

  // 新規スケッチ(XY)を追加すると自動的に選択状態になる。初期ボディはまだ残っているため
  // ドキュメントは評価成功したまま(sketchPlanesに新スケッチの平面基底が反映される)。
  await page.getByTestId("btn-add-sketch").click();
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();
  await waitForReady(page);

  // 平面に正対してから線描画モードに入る。
  await page.getByTestId("btn-align-to-plane").click();
  await page.getByTestId("btn-draw-polygon").click();
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("線描画キャンセル(Esc)");

  // 一辺20mmの正方形(4頂点、初期ボックスの60x40の範囲内)をクリックで描く。
  // 1mmスナップはデフォルトONのまま。
  const corners: [number, number, number][] = [
    [-10, -10, 0],
    [10, -10, 0],
    [10, 10, 0],
    [-10, 10, 0],
  ];
  for (const corner of corners) {
    const pt = await screenPointForWorld(page, corner);
    await page.mouse.click(pt.x, pt.y);
  }

  // 始点付近(数px以内)をクリックして閉じる。5クリック目で確定し、描画モードを抜ける。
  const start = await screenPointForWorld(page, corners[0]);
  await page.mouse.click(start.x + 2, start.y + 2);
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("線描画");

  // 多角形エンティティがスケッチ編集パネルに反映されている(頂点4点)。
  await expect(page.getByTestId("entity-polygon-0-vertex-0-x")).toHaveValue("-10");
  await expect(page.getByTestId("entity-polygon-0-vertex-2-y")).toHaveValue("10");

  // 押し出し追加(既にボディが存在するためデフォルトoperationは"add"であり、直ちに評価が成功する。Phase 13)。
  await page.getByTestId("btn-add-extrude").click();
  await waitForReady(page);

  // Cutに変更し、距離を箱の高さ(20mm)より大きくして貫通させる。
  await page.getByTestId("extrude-operation-select").selectOption("cut");
  await page.getByTestId("extrude-distance-input").fill("25");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("status-text")).toContainText("状態: ready");

  expect(pageErrors).toEqual([]);
});

test("多角形の頂点にフィレットを設定すると、エラーなく再評価できる(Phase 11)", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await page.goto("/");
  await waitForReady(page);

  await page.getByTestId("btn-add-sketch").click();
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();
  await waitForReady(page);

  await page.getByTestId("btn-align-to-plane").click();
  await page.getByTestId("btn-draw-polygon").click();
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("線描画キャンセル(Esc)");

  // 一辺20mmの正方形(4頂点)をクリックで描く。
  const corners: [number, number, number][] = [
    [-10, -10, 0],
    [10, -10, 0],
    [10, 10, 0],
    [-10, 10, 0],
  ];
  for (const corner of corners) {
    const pt = await screenPointForWorld(page, corner);
    await page.mouse.click(pt.x, pt.y);
  }
  const start = await screenPointForWorld(page, corners[0]);
  await page.mouse.click(start.x + 2, start.y + 2);
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("線描画");
  await expect(page.getByTestId("entity-polygon-0-vertex-0-x")).toHaveValue("-10");

  // 頂点0にフィレット(サイズ5)を設定する。
  await page.getByTestId("entity-polygon-0-vertex-0-corner-kind").selectOption("fillet");
  await page.getByTestId("entity-polygon-0-vertex-0-corner-size").fill("5");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // Cutに変更して押し出し(貫通)し、フィレット付きプロファイルの押し出しが成功することを確認する。
  // 既にボディが存在するためデフォルトoperationは"add"であり、一旦readyになってからcutへ変更する(Phase 13)。
  await page.getByTestId("btn-add-extrude").click();
  await waitForReady(page);
  await page.getByTestId("extrude-operation-select").selectOption("cut");
  await page.getByTestId("extrude-distance-input").fill("25");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("status-text")).toContainText("状態: ready");

  expect(pageErrors).toEqual([]);
});

test("Escキーで描画中の頂点列を破棄してモードを終了できる", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await page.goto("/");
  await waitForReady(page);

  await page.getByTestId("feature-item-Sketch1").click();
  await page.getByTestId("btn-align-to-plane").click();
  await page.getByTestId("btn-draw-polygon").click();
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("線描画キャンセル(Esc)");

  const pt = await screenPointForWorld(page, [5, 5, 0]);
  await page.mouse.click(pt.x, pt.y);

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("線描画");

  // 頂点1点のみでキャンセルしたため、多角形エンティティは追加されていない。
  await expect(page.locator('[data-testid^="entity-polygon-"]')).toHaveCount(0);
  // ドキュメントは変更されていないため再評価も走っておらず、既にready状態のまま。
  await waitForStatus(page, "ready");

  expect(pageErrors).toEqual([]);
});
