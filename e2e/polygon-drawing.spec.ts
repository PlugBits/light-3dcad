// 多角形ツール(Phase 8で導入、Phase 21で「正多角形」から改名・仕様変更)のE2E。
// Phase 21より前は自由な頂点列クリックで閉多角形を描く専用ツールだったが、フリー描画は
// 「線分」ツール(Phase 19b、segments)に一本化され、「多角形」ボタンは2クリック(中心→頂点、
// 辺数セレクタで固定)の正多角形作図に変わった。作成されるエンティティは引き続きpolygon
// (頂点を計算済み、regularPolygonではない)なので、既存の頂点編集・フィレット/面取りUIが
// そのまま使える。
// 初期ドキュメントには既にNew Bodyの押し出し(Extrude1)がある(Phase 13以降、押し出し追加時の
// デフォルトoperationはボディの有無に応じて自動的に"add"になるため、この時点ではエラーにならない)。
// 新規スケッチの押し出しは最終的にCut(初期ボックスをZ方向に貫通させる穴)にする
// (sketchPlanesはWorkerの直近の評価成功時のものが保持され続けるため、ドキュメントを常に
// 評価成功する状態に保っておかないと「平面に正対」「多角形」ボタンが有効化されない)。
import { expect, test } from "@playwright/test";

import { collectPageErrors, gotoApp, screenPointForWorld, waitForReady, waitForStatus } from "./helpers";

test("多角形ツールで正六角形を描き、押し出し(Cut)できる", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page);
  await waitForReady(page);

  // 新規スケッチ(XY)を追加すると自動的に選択状態になる。初期ボディはまだ残っているため
  // ドキュメントは評価成功したまま(sketchPlanesに新スケッチの平面基底が反映される)。
  await page.getByTestId("btn-add-sketch").click();
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();
  await waitForReady(page);

  // 平面に正対してから多角形ツールに入る(既定の辺数6のまま)。
  await page.getByTestId("btn-align-to-plane").click();
  await expect(page.getByTestId("polygon-sides-select")).toHaveValue("6");
  await page.getByTestId("btn-draw-polygon").click();
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("多角形キャンセル(Esc)");

  // 中心(0,0)→頂点(10,0)の2クリックで外接円半径10mmの正六角形を描く。
  const center = await screenPointForWorld(page, [0, 0, 0]);
  await page.mouse.click(center.x, center.y);
  const vertex = await screenPointForWorld(page, [10, 0, 0]);
  await page.mouse.click(vertex.x, vertex.y);
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("多角形");

  // polygonエンティティ(regularPolygonではない)としてスケッチ編集パネルに反映され、
  // 頂点ごとの数値編集フィールド(6頂点)が使える。
  await expect(page.getByTestId("entity-polygon-0-vertex-0-x")).toHaveValue("10");
  await expect(page.getByTestId("entity-polygon-0-vertex-0-y")).toHaveValue("0");
  await expect(page.locator('[data-testid^="entity-polygon-0-vertex-"][data-testid$="-x"]')).toHaveCount(6);

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

  await gotoApp(page);
  await waitForReady(page);

  await page.getByTestId("btn-add-sketch").click();
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();
  await waitForReady(page);

  await page.getByTestId("btn-align-to-plane").click();
  // 辺数を4(正方形)に変更してから描く。
  await page.getByTestId("polygon-sides-select").selectOption("4");
  await page.getByTestId("btn-draw-polygon").click();
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("多角形キャンセル(Esc)");

  const center = await screenPointForWorld(page, [0, 0, 0]);
  await page.mouse.click(center.x, center.y);
  const vertex = await screenPointForWorld(page, [10, 0, 0]);
  await page.mouse.click(vertex.x, vertex.y);
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("多角形");
  await expect(page.locator('[data-testid^="entity-polygon-0-vertex-"][data-testid$="-x"]')).toHaveCount(4);

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

test("Escキーで描画中の多角形ツールを中断してモードを終了できる", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page);
  await waitForReady(page);

  await page.getByTestId("feature-item-Sketch1").click();
  await page.getByTestId("btn-align-to-plane").click();
  await page.getByTestId("btn-draw-polygon").click();
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("多角形キャンセル(Esc)");

  // 1クリック目(中心)のみ入力した状態でEscする。
  const pt = await screenPointForWorld(page, [5, 5, 0]);
  await page.mouse.click(pt.x, pt.y);

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("多角形");

  // 1クリックのみでキャンセルしたため、多角形エンティティは追加されていない。
  await expect(page.locator('[data-testid^="entity-polygon-"]')).toHaveCount(0);
  // ドキュメントは変更されていないため再評価も走っておらず、既にready状態のまま。
  await waitForStatus(page, "ready");

  expect(pageErrors).toEqual([]);
});
