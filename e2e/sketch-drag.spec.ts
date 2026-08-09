// スケッチジオメトリのドラッグ編集(Phase 34)のE2E。ユーザー要望の核心機能。
// ①自由な線分の頂点をドラッグ→追従し、Undo1回で元に戻る
// ②水平拘束付き線分の端点ドラッグ→水平のまま伸びる(Y追従は拒否、X方向のみ追従)
// ③一致チェーンの中間頂点ドラッグ→両隣のセグメントが連動する
// ④長さ拘束付き線分の本体ドラッグ→形(長さ)を保ったまま平行移動する
// ⑤円をドラッグ→中心移動、Y距離拘束があればX方向のみ動く
//
// 座標はpoint-dimension.spec.ts/dimension-drag-and-trim.spec.tsと同じく、既定カメラ(align-to-plane後)の
// ビュー内に収まる範囲(おおよそx:-20〜30, y:-20〜20)で選ぶ。
import { expect, type Page, test } from "@playwright/test";

import { collectPageErrors, gotoApp, screenPointForWorld, waitForReady } from "./helpers";

async function newSketchAligned(page: Page) {
  await page.getByTestId("btn-add-sketch").click();
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();
  await waitForReady(page);
  await page.getByTestId("btn-align-to-plane").click();
}

/** 線分ツールで2点チェーン(1本)を描く(click→dblclick)。 */
async function drawSingleSegment(page: Page, p0: [number, number], p1: [number, number]) {
  const s0 = await screenPointForWorld(page, [p0[0], p0[1], 0]);
  await page.mouse.click(s0.x, s0.y);
  const s1 = await screenPointForWorld(page, [p1[0], p1[1], 0]);
  await page.mouse.dblclick(s1.x, s1.y);
}

/** 線分ツールで3点チェーン(2本、中間に一致拘束が自動付与される)を描く(click→click→dblclick)。 */
async function drawTwoSegmentChain(page: Page, p0: [number, number], p1: [number, number], p2: [number, number]) {
  const s0 = await screenPointForWorld(page, [p0[0], p0[1], 0]);
  await page.mouse.click(s0.x, s0.y);
  const s1 = await screenPointForWorld(page, [p1[0], p1[1], 0]);
  await page.mouse.click(s1.x, s1.y);
  const s2 = await screenPointForWorld(page, [p2[0], p2[1], 0]);
  await page.mouse.dblclick(s2.x, s2.y);
}

/**
 * ドラッグ編集(Phase 34)の本体: mousedown→SKETCH_DRAG_MOVE_THRESHOLD_PX(4px)を超えて動かす
 * →最終位置でmouseup。局所座標(ローカル2D、z=0)で指定し、内部でscreenPointForWorld()を使う。
 */
async function dragSketchPoint(page: Page, from: [number, number], to: [number, number]) {
  const start = await screenPointForWorld(page, [from[0], from[1], 0]);
  const end = await screenPointForWorld(page, [to[0], to[1], 0]);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const midX = start.x + (end.x - start.x) * 0.4;
  const midY = start.y + (end.y - start.y) * 0.4;
  await page.mouse.move(midX, midY, { steps: 3 });
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
}

/** segment-row-{index} のテキスト("線分N: (x1, y1) → (x2, y2)")からp1/p2を読み取る。 */
async function segmentRowPoints(page: Page, index: number): Promise<{ p1: [number, number]; p2: [number, number] }> {
  const text = await page.getByTestId(`segment-row-${index}`).innerText();
  const match = text.match(/\(([-\d.]+), ([-\d.]+)\) → \(([-\d.]+), ([-\d.]+)\)/);
  if (!match) throw new Error(`unexpected segment row text: ${text}`);
  return {
    p1: [Number(match[1]), Number(match[2])],
    p2: [Number(match[3]), Number(match[4])],
  };
}

function dist(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

test("①自由な線分の頂点をドラッグすると追従し、Undo1回で元に戻る", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await gotoApp(page);
  await waitForReady(page);
  await newSketchAligned(page);

  // 軸整列していない線分(水平/垂直の自動拘束を避けるため斜め)。拘束は一切無い。
  await page.getByTestId("btn-draw-segment").click();
  await drawSingleSegment(page, [0, 0], [13, 7]);
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");
  await expect(page.getByTestId("segment-count")).toContainText("1");

  const before = await segmentRowPoints(page, 0);
  expect(before.p2[0]).toBeCloseTo(13, 1);
  expect(before.p2[1]).toBeCloseTo(7, 1);

  await page.mouse.move(20, 20); // ホバー状態をリセット(直前のdblclick位置に残らないように)。
  await page.screenshot({ path: "test-results/sketch-drag-1-before.png" });

  // p2(13,7)をドラッグして(22,14)へ動かす。
  await dragSketchPoint(page, [13, 7], [22, 14]);
  await waitForReady(page);

  await page.screenshot({ path: "test-results/sketch-drag-1-after.png" });

  const after = await segmentRowPoints(page, 0);
  // ソフトなドラッグ目標(拘束より弱い)なので厳密一致ではないが、大きく追従する。
  expect(dist(after.p2, [22, 14])).toBeLessThan(1.5);
  // 反対側の端点(拘束で繋がっていない)はほとんど動かない。
  expect(dist(after.p1, [0, 0])).toBeLessThan(1);
  // 実際に動いたことの確認(誤って何もしていない、を排除)。
  expect(dist(after.p2, before.p2)).toBeGreaterThan(5);

  // Undo1回でドラッグ前の状態へ戻る。
  await page.getByTestId("btn-undo").click();
  await waitForReady(page);
  const afterUndo = await segmentRowPoints(page, 0);
  expect(dist(afterUndo.p2, before.p2)).toBeLessThan(0.05);
  expect(dist(afterUndo.p1, before.p1)).toBeLessThan(0.05);

  await page.screenshot({ path: "test-results/sketch-drag-1-after-undo.png" });
  expect(pageErrors).toEqual([]);
});

test("②水平拘束付き線分の端点ドラッグ→水平を維持してX方向のみ追従する(Y追従は拒否される)", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await gotoApp(page);
  await waitForReady(page);
  await newSketchAligned(page);

  // 完全水平(0,0)→(20,0)で描くと軸ロックによりhorizontal拘束が自動付与される。
  await page.getByTestId("btn-draw-segment").click();
  await drawSingleSegment(page, [0, 0], [20, 0]);
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");

  // p1を原点に一致させて固定する(拘束ツール、point-dimension.spec.tsと同じパターン)。
  await page.getByTestId("btn-constraint").click();
  const p1Screen = await screenPointForWorld(page, [0, 0, 0]);
  await page.mouse.click(p1Screen.x, p1Screen.y);
  await expect(page.getByTestId("constraint-pending-status")).toContainText("端点");
  const originScreen = await screenPointForWorld(page, [0, 0, 0]);
  await page.mouse.click(originScreen.x, originScreen.y);
  await expect(page.getByTestId("constraint-tool-popup-coincidentOrigin")).toBeVisible();
  await page.getByTestId("constraint-tool-popup-coincidentOrigin").click();
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await page.getByTestId("btn-constraint").click(); // 拘束ツールを終了する。

  const before = await segmentRowPoints(page, 0);
  expect(before.p1).toEqual([0, 0]);
  expect(before.p2[0]).toBeCloseTo(20, 1);
  expect(before.p2[1]).toBeCloseTo(0, 1);

  await page.mouse.move(20, 20);
  await page.screenshot({ path: "test-results/sketch-drag-2-before.png" });

  // p2(20,0)をY方向へ大きくずらしつつX方向へも動かす目標でドラッグする。
  await dragSketchPoint(page, [20, 0], [12, 9]);
  await waitForReady(page);

  await page.screenshot({ path: "test-results/sketch-drag-2-after.png" });

  const after = await segmentRowPoints(page, 0);
  // p1はfix相当(coincidentOrigin)で完全固定のまま。
  expect(after.p1).toEqual([0, 0]);
  // horizontalが厳密に維持され、Yはp1と同じ0のまま(Y追従は拒否される)。
  expect(Math.abs(after.p2[1])).toBeLessThan(0.05);
  // X方向はカーソルへ大きく追従する(20→12に近づく)。
  expect(after.p2[0]).toBeLessThan(16);
  expect(after.p2[0]).toBeGreaterThan(9);

  expect(pageErrors).toEqual([]);
});

test("③一致チェーンの中間頂点ドラッグ→両隣のセグメントが連動する", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await gotoApp(page);
  await waitForReady(page);
  await newSketchAligned(page);

  // 軸整列していない3点チェーン(joint (9,4) で一致拘束のみ自動付与、水平/垂直は付かない)。
  await page.getByTestId("btn-draw-segment").click();
  await drawTwoSegmentChain(page, [0, 0], [9, 4], [15, 11]);
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");
  await expect(page.getByTestId("segment-count")).toContainText("2");

  const before0 = await segmentRowPoints(page, 0);
  const before1 = await segmentRowPoints(page, 1);
  expect(dist(before0.p2, [9, 4])).toBeLessThan(0.1);
  expect(dist(before1.p1, [9, 4])).toBeLessThan(0.1);

  await page.mouse.move(20, 20);
  await page.screenshot({ path: "test-results/sketch-drag-3-before.png" });

  // 中間の一致頂点(9,4)を(15,9)へドラッグする。
  await dragSketchPoint(page, [9, 4], [15, 9]);
  await waitForReady(page);

  await page.screenshot({ path: "test-results/sketch-drag-3-after.png" });

  const after0 = await segmentRowPoints(page, 0);
  const after1 = await segmentRowPoints(page, 1);
  // 一致拘束(ハード)により、両隣のジョイント側端点は常に厳密に一致したまま動く。
  expect(dist(after0.p2, after1.p1)).toBeLessThan(0.01);
  // ジョイントは目標へ大きく追従する。
  expect(dist(after0.p2, [15, 9])).toBeLessThan(1.5);
  expect(dist(after0.p2, [9, 4])).toBeGreaterThan(5);
  // 遠い方の端点(それぞれ拘束の無い自由端)はほとんど動かない。
  expect(dist(after0.p1, [0, 0])).toBeLessThan(1);
  expect(dist(after1.p2, [15, 11])).toBeLessThan(1);

  expect(pageErrors).toEqual([]);
});

test("④長さ拘束付き線分の本体ドラッグ→形(長さ)を保ったまま平行移動する", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await gotoApp(page);
  await waitForReady(page);
  await newSketchAligned(page);

  // 長さ13(3-4-5系の12,5)の斜め線分。
  await page.getByTestId("btn-draw-segment").click();
  await drawSingleSegment(page, [0, 0], [12, 5]);
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");

  await page.getByTestId("btn-dimension").click();
  const segMid = await screenPointForWorld(page, [6, 2.5, 0]);
  await page.mouse.click(segMid.x, segMid.y);
  const popup = page.getByTestId("dimension-tool-popup");
  await expect(popup).toBeVisible();
  await expect(page.getByTestId("dimension-tool-popup-value")).toHaveValue("13.00");
  await page.getByTestId("dimension-tool-popup-apply").click();
  await expect(popup).toHaveCount(0);
  await waitForReady(page);
  await page.getByTestId("btn-dimension").click(); // 寸法ツールを終了する。

  const before = await segmentRowPoints(page, 0);
  expect(dist(before.p1, before.p2)).toBeCloseTo(13, 1);

  await page.mouse.move(20, 20);
  await page.screenshot({ path: "test-results/sketch-drag-4-before.png" });

  // セグメント本体(中点付近)をつかんで(+5,+5)動かす。
  await dragSketchPoint(page, [6, 2.5], [11, 7.5]);
  await waitForReady(page);

  await page.screenshot({ path: "test-results/sketch-drag-4-after.png" });

  const after = await segmentRowPoints(page, 0);
  // 長さ拘束は厳密に維持される。
  expect(dist(after.p1, after.p2)).toBeCloseTo(13, 1);
  // 両端点とも、掴んだ位置からの移動量(+5,+5)ぶんおおよそ平行移動している。
  expect(dist(after.p1, [5, 5])).toBeLessThan(2);
  expect(dist(after.p2, [17, 10])).toBeLessThan(2);

  expect(pageErrors).toEqual([]);
});

test("⑤円のドラッグ→中心移動、Y距離拘束があればX方向のみ動く", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await gotoApp(page);
  await waitForReady(page);
  await newSketchAligned(page);

  // 自由な円(中心0,0 半径10)を本体ドラッグ(円周上をつかむ)する。
  await page.getByTestId("btn-add-circle").click();
  await waitForReady(page);
  await expect(page.getByTestId("entity-circle-0-center-x")).toHaveValue("0");
  await expect(page.getByTestId("entity-circle-0-center-y")).toHaveValue("0");

  await page.mouse.move(20, 20);
  await page.screenshot({ path: "test-results/sketch-drag-5-before.png" });

  // 円周上の点(10,0)をつかんで(16,4)へ動かす(=中心も同じデルタ(6,4)だけ移動する目標)。
  await dragSketchPoint(page, [10, 0], [16, 4]);
  await waitForReady(page);

  await page.screenshot({ path: "test-results/sketch-drag-5-after.png" });

  const cx = Number(await page.getByTestId("entity-circle-0-center-x").inputValue());
  const cy = Number(await page.getByTestId("entity-circle-0-center-y").inputValue());
  expect(dist([cx, cy], [6, 4])).toBeLessThan(1.5);
  expect(dist([cx, cy], [0, 0])).toBeGreaterThan(3);

  // ---- Y距離拘束がある円は、ドラッグしてもX方向のみ動く ----
  await page.getByTestId("btn-add-circle").click();
  await waitForReady(page);
  await expect(page.getByTestId("entity-circle-1-center-x")).toHaveValue("0");
  await page.getByTestId("entity-circle-1-center-x").fill("30");
  await waitForReady(page);

  // circle1(30,0)の原点からのY距離(現在0)を拘束する。
  await page.getByTestId("btn-dimension").click();
  const c1Screen = await screenPointForWorld(page, [40, 0, 0]); // circle1(center 30,0 r10)の円周
  await page.mouse.click(c1Screen.x, c1Screen.y);
  await expect(page.getByTestId("dimension-pending-status")).toContainText("円");
  const originScreen = await screenPointForWorld(page, [0, 0, 0]);
  await page.mouse.click(originScreen.x, originScreen.y);
  const originPopup = page.getByTestId("dimension-tool-popup");
  await expect(originPopup).toBeVisible();
  await page.getByTestId("dimension-tool-popup-axis-y").check();
  // 軸切替では値欄は自動再計算されない(direct距離30.00のまま、point-dimension.spec.ts②や
  // dimension-sign.spec.ts①と同じ挙動)。Y距離0を明示的に入力する。
  await page.getByTestId("dimension-tool-popup-value").fill("0");
  await page.getByTestId("dimension-tool-popup-apply").click();
  await expect(originPopup).toHaveCount(0);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await page.getByTestId("btn-dimension").click(); // 寸法ツールを終了する。

  await page.mouse.move(20, 20);
  await page.screenshot({ path: "test-results/sketch-drag-5-constrained-before.png" });

  // circle1の円周上の点(40,0)をつかんで、X・Yどちらにもずらす目標でドラッグする。
  await dragSketchPoint(page, [40, 0], [34, -8]);
  await waitForReady(page);

  await page.screenshot({ path: "test-results/sketch-drag-5-constrained-after.png" });

  const cx1 = Number(await page.getByTestId("entity-circle-1-center-x").inputValue());
  const cy1 = Number(await page.getByTestId("entity-circle-1-center-y").inputValue());
  // Y距離拘束(原点からY=0)が厳密に維持され、Yはほぼ0のまま(Y追従は拒否される)。
  expect(Math.abs(cy1)).toBeLessThan(0.05);
  // X方向はカーソルへ大きく追従する(30→24付近まで動く)。
  expect(cx1).toBeLessThan(28);
  expect(cx1).toBeGreaterThan(20);

  expect(pageErrors).toEqual([]);
});
