// 実機報告3件のE2E(Phase 32)。
// ①一致チェーン(5本、4=水平・5=垂直)+中心固定の円2つに、垂直セグメントと外側の円への接線を
//   追加→矛盾判定にならず成功して線が円に接する位置へ移動する(チェーンが連動)。
// ②セグメントの個別削除(SketchEditorパネルの削除ボタン)+関連する拘束の削除トースト。
// ③スケッチ線のクリック選択(パネル行、ビューア直接選択と同じselectedEntityIdを使う)→
//   Deleteキーでの削除。
// ④真の矛盾(同一セグメントの両端点を原点一致させつつ長さ拘束と両立しない)を作り、
//   矛盾メッセージに具体的な拘束名が含まれることを確認する。
import { expect, type Page, test } from "@playwright/test";

import { collectPageErrors, gotoApp, screenPointForWorld, waitForReady } from "./helpers";

type SegSnapshot = { id: string; p1: [number, number]; p2: [number, number] };

async function dimensionSegmentsSnapshot(page: Page): Promise<SegSnapshot[]> {
  return page.evaluate(() => window.__cadViewerDebug?.dimensionToolSegmentsSnapshot() ?? []);
}

async function newSketchAligned(page: Page) {
  await page.getByTestId("btn-add-sketch").click();
  await waitForReady(page);
  await page.getByTestId("btn-align-to-plane").click();
}

/** 線分ツールでN点のチェーン(N-1本、隣接セグメント間に一致拘束が自動付与される)を描く。 */
async function drawChain(page: Page, points: [number, number][]) {
  for (let i = 0; i < points.length; i += 1) {
    const s = await screenPointForWorld(page, [points[i][0], points[i][1], 0]);
    if (i === points.length - 1) {
      await page.mouse.dblclick(s.x, s.y);
    } else {
      await page.mouse.click(s.x, s.y);
    }
  }
}

test("①一致チェーン(5本、4=水平・5=垂直)+中心固定の円2つ: 垂直セグメントと外側の円への接線が成功し、線が円に接する位置へ移動する(チェーン連動)", async ({
  page,
}) => {
  const pageErrors = collectPageErrors(page);
  await gotoApp(page);
  await waitForReady(page);

  await newSketchAligned(page);

  // 5本の一致チェーン(セグメント4=水平、セグメント5=垂直、軸ロックで自動付与)。
  // p3(-18,-12)→p4(18,-12)は水平、p4(18,-12)→p5(18,10)は垂直。他の辺(セグメント1〜3)は
  // 軸ロックの許容角(±5度)から明確に外れる角度にする(再現デバッグで、境界付近の角度[5度弱]
  // だと実行のたびに軸ロックの有無が揺れ、意図しないセグメントまで水平/垂直になりうることが
  // 判明したため)。各点はクリック精度確保のため互いに10mm以上離し(点同士が近すぎるとクリックが
  // 意図しない端点にヒットしてしまう)、かつ既定カメラのcanvas範囲内(おおよそx:-20〜30,
  // y:-15〜20)に収める(範囲外はクリックがcanvas外に外れて点が追加されない)。
  await page.getByTestId("btn-draw-segment").click();
  await drawChain(page, [
    [25, 5],
    [18, 15],
    [-8, 20],
    [-18, -12],
    [18, -12],
    [18, 10],
  ]);
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");
  await expect(page.getByTestId("segment-count")).toContainText("5");

  // 中心固定の円2つ(内側R10・外側R30、いずれも原点中心)。
  await page.getByTestId("btn-add-circle").click();
  await waitForReady(page);
  await page.getByTestId("entity-circle-0-radius").fill("10");
  await waitForReady(page);
  await page.getByTestId("entity-circle-0-fixed").check();
  await waitForReady(page);

  await page.getByTestId("btn-add-circle").click();
  await waitForReady(page);
  await page.getByTestId("entity-circle-1-radius").fill("30");
  await waitForReady(page);
  await page.getByTestId("entity-circle-1-fixed").check();
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  await page.screenshot({ path: "test-results/tangent-fix-1-before.png" });

  // 拘束ツール: 外側の円(R30)の円周上の点→垂直セグメント(セグメント5、x=18の縦線の中点付近)の
  // 順にクリックし、「接線」を適用する。
  await page.getByTestId("btn-constraint").click();
  const circleRimScreen = await screenPointForWorld(page, [30, 0, 0]);
  await page.mouse.click(circleRimScreen.x, circleRimScreen.y);
  await expect(page.getByTestId("constraint-pending-status")).toContainText("円");

  const verticalSegScreen = await screenPointForWorld(page, [18, -1, 0]);
  await page.mouse.click(verticalSegScreen.x, verticalSegScreen.y);
  await expect(page.getByTestId("constraint-tool-popup")).toBeVisible();
  await expect(page.getByTestId("constraint-tool-popup-tangent")).toBeVisible();
  await page.getByTestId("constraint-tool-popup-tangent").click();

  // 矛盾判定(修正前バグ)になっていないことを確認する: 巻き戻しトーストが出ない、評価エラーも無い。
  await waitForReady(page);
  await expect(page.getByTestId("constraint-conflict-toast")).toHaveCount(0);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  await page.getByTestId("btn-constraint").click(); // 拘束ツールを終了する。

  await page.screenshot({ path: "test-results/tangent-fix-2-after.png" });

  // 実際の座標を確認する(寸法ツールを一時的に開いてスナップショットを読む、既存specと同じ手法)。
  await page.getByTestId("btn-dimension").click();
  const snapshot = await dimensionSegmentsSnapshot(page);
  await page.getByTestId("btn-dimension").click();
  expect(snapshot).toHaveLength(5);

  // x≈±30(円2の半径)に接した垂直セグメントを探す(他の辺がたまたま軸ロックされていた場合でも
  // 誤って拾わないよう、半径との近さも条件にする)。
  const verticalSeg = snapshot.find((s) => Math.abs(s.p1[0] - s.p2[0]) < 1e-3 && Math.abs(Math.abs(s.p1[0]) - 30) < 5);
  if (!verticalSeg) throw new Error(`接した垂直セグメントが見つかりません: ${JSON.stringify(snapshot)}`);
  // 円2(R30)に接する位置(x=±30)まで移動している。
  expect(Math.abs(verticalSeg.p1[0])).toBeCloseTo(30, 1);
  // 退化(セグメントが1点に潰れる、修正前バグ)していないこと。
  const length = Math.hypot(verticalSeg.p2[0] - verticalSeg.p1[0], verticalSeg.p2[1] - verticalSeg.p1[1]);
  expect(length).toBeGreaterThan(3);

  // チェーンが連動している: 水平セグメント(セグメント4、y≈-12)の一方の端点が、垂直セグメントの
  // 移動後のx座標と一致する(coincidentで繋がっているため)。
  const horizontalSeg = snapshot.find((s) => Math.abs(s.p1[1] - s.p2[1]) < 1e-3 && Math.abs(s.p1[1] - -12) < 5);
  if (!horizontalSeg) throw new Error(`水平なセグメントが見つかりません: ${JSON.stringify(snapshot)}`);
  const horizontalTouchesVertical =
    Math.abs(horizontalSeg.p1[0] - verticalSeg.p1[0]) < 1e-2 || Math.abs(horizontalSeg.p2[0] - verticalSeg.p1[0]) < 1e-2;
  expect(horizontalTouchesVertical).toBe(true);

  expect(pageErrors).toEqual([]);
});

test("②セグメントの個別削除(パネルの削除ボタン)で、参照する拘束も一緒に削除され件数が通知される", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await gotoApp(page);
  await waitForReady(page);

  await newSketchAligned(page);

  // s1(水平、0,0→10,0)・s2(垂直、10,0→10,10)・s3(斜め、10,10→20,15)の3本チェーン。
  await page.getByTestId("btn-draw-segment").click();
  await drawChain(page, [
    [0, 0],
    [10, 0],
    [10, 10],
    [20, 15],
  ]);
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");
  await expect(page.getByTestId("segment-count")).toContainText("3");

  // s1に長さ拘束を付ける(現在値10のまま適用)。
  await page.getByTestId("btn-dimension").click();
  const s1Mid = await screenPointForWorld(page, [5, 0, 0]);
  await page.mouse.click(s1Mid.x, s1Mid.y);
  await expect(page.getByTestId("dimension-tool-popup")).toBeVisible();
  await page.getByTestId("dimension-tool-popup-apply").click();
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await page.getByTestId("btn-dimension").click(); // 寸法ツールを終了する。

  // s1を参照する拘束: horizontal(s1) + coincident(s1.p2=s2.p1) + length(s1) の3件。
  await page.screenshot({ path: "test-results/segment-delete-1-before.png" });
  await page.getByTestId("segment-row-0-delete").click();
  await waitForReady(page);

  await expect(page.getByTestId("segment-count")).toContainText("2");
  await expect(page.getByTestId("constraint-conflict-toast")).toContainText("関連する拘束3件も削除しました");
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await page.screenshot({ path: "test-results/segment-delete-2-after.png" });

  expect(pageErrors).toEqual([]);
});

test("③スケッチ線をクリック選択(パネル行)→Deleteキーで削除できる(入力欄フォーカス中は無効)", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await gotoApp(page);
  await waitForReady(page);

  await newSketchAligned(page);

  await page.getByTestId("btn-draw-segment").click();
  await drawChain(page, [
    [0, 0],
    [10, 0],
    [10, 10],
  ]);
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");
  await expect(page.getByTestId("segment-count")).toContainText("2");

  // 入力欄にフォーカスがある間はDeleteキーが無効であることを確認する(名前欄にフォーカス→Delete)。
  await page.getByRole("textbox").first().focus();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("segment-count")).toContainText("2");

  // セグメント一覧の行をクリックして選択する(ビューア直接選択と同じselectedEntityIdを使う)。
  await page.getByTestId("segment-row-1").click();
  await expect(page.getByTestId("segment-row-1")).toHaveCSS("border-color", "rgb(74, 144, 217)");

  await page.keyboard.press("Delete");
  await waitForReady(page);
  await expect(page.getByTestId("segment-count")).toContainText("1");
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test("④真の矛盾(同一セグメントの両端点を原点一致させつつ長さ拘束と両立しない)で、具体的な拘束名を含むメッセージが表示される", async ({
  page,
}) => {
  const pageErrors = collectPageErrors(page);
  await gotoApp(page);
  await waitForReady(page);

  await newSketchAligned(page);

  // 原点から離れた位置に、方向・長さが厳密にわかる線分(10,10)→(20,10)を描く。
  await page.getByTestId("btn-draw-segment").click();
  await drawChain(page, [
    [10, 10],
    [20, 10],
  ]);
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");

  // 長さ拘束(現在値10のまま適用)。
  await page.getByTestId("btn-dimension").click();
  const mid = await screenPointForWorld(page, [15, 10, 0]);
  await page.mouse.click(mid.x, mid.y);
  await expect(page.getByTestId("dimension-tool-popup")).toBeVisible();
  await expect(page.getByTestId("dimension-tool-popup-value")).toHaveValue("10.00");
  await page.getByTestId("dimension-tool-popup-apply").click();
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await page.getByTestId("btn-dimension").click();

  // p1(10,10)を原点一致させる(単独では矛盾しない: p2は方向・長さを保ったまま(10,0)へ平行移動する)。
  await page.getByTestId("btn-constraint").click();
  const p1Screen = await screenPointForWorld(page, [10, 10, 0]);
  await page.mouse.click(p1Screen.x, p1Screen.y);
  await expect(page.getByTestId("constraint-pending-status")).toContainText("端点");
  const originScreen = await screenPointForWorld(page, [0, 0, 0]);
  await page.mouse.click(originScreen.x, originScreen.y);
  await expect(page.getByTestId("constraint-tool-popup-coincidentOrigin")).toBeVisible();
  await page.getByTestId("constraint-tool-popup-coincidentOrigin").click();
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("constraint-conflict-toast")).toHaveCount(0);

  // p2(解いた結果、方向維持のため(10,0)にいるはず)も原点一致させる: p1と同じ点になり、
  // 長さ拘束(10mm)と両立しない真の矛盾になる。
  const p2Screen = await screenPointForWorld(page, [10, 0, 0]);
  await page.mouse.click(p2Screen.x, p2Screen.y);
  await expect(page.getByTestId("constraint-pending-status")).toContainText("端点");
  const originScreen2 = await screenPointForWorld(page, [0, 0, 0]);
  await page.mouse.click(originScreen2.x, originScreen2.y);
  await expect(page.getByTestId("constraint-tool-popup-coincidentOrigin")).toBeVisible();
  await page.getByTestId("constraint-tool-popup-coincidentOrigin").click();

  await page.screenshot({ path: "test-results/conflict-message-1.png" });

  const toast = page.getByTestId("constraint-conflict-toast");
  await expect(toast).toBeVisible();
  const message = (await toast.textContent()) ?? "";
  // 拘束一覧パネルと同じ表記(種類ラベル)が含まれる: 「原点一致」または「長さ」のいずれか
  // (どちらが残差最大になるかは実装の内部詳細のため、いずれかを含んでいれば良しとする)。
  expect(message.includes("原点一致") || message.includes("長さ")).toBe(true);
  expect(message).toContain("セグメント1");

  await page.getByTestId("btn-constraint").click(); // 拘束ツールを終了する。

  expect(pageErrors).toEqual([]);
});
