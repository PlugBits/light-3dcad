// 頂点ベースの寸法指定(Phase 30)のE2E。ユーザー報告シナリオの再現検証。
// ①線分チェーン(一致拘束付き)の中間頂点をクリック(頂点マーカー確認)→下の線分からの距離指定→
//   頂点がその位置まで動き、長さ拘束の無い線分が伸びる(遠い方の端点は動かない)。
// ②長さ・水平・円のY距離が付いた線分に対し、繋がった別線分の端点↔原点のX距離を指定→
//   エラーにならずX位置だけが決まり、一致で繋がった線分が全部連動する。
// ③direct距離(端点↔原点)で解なし値を入れる→誘導メッセージが表示される。
//
// 座標はすべて既定カメラ(align-to-plane後)のビュー内に収まる範囲(おおよそx:-20〜30, y:-20〜20)で
// 選ぶ(範囲外はcanvas外にクリックが飛んでしまい、クリックが空振りするため)。拘束の「値」自体
// (適用後に頂点が実際に動く先の座標)はJS評価(dimensionToolSegmentsSnapshot)でのみ検証し、
// クリックはしないため、この制約を受けない。
import { expect, type Page, test } from "@playwright/test";

import { collectPageErrors, gotoApp, screenPointForWorld, waitForReady } from "./helpers";

type SegSnapshot = { id: string; p1: [number, number]; p2: [number, number] };

async function dimensionSegmentsSnapshot(page: Page): Promise<SegSnapshot[]> {
  return page.evaluate(() => window.__cadViewerDebug?.dimensionToolSegmentsSnapshot() ?? []);
}

/** p1/p2(順不同)がおおよそ一致するセグメントを探す(自動生成IDでは直接引けないため座標で照合する)。 */
function findSegmentByPoints(
  snapshot: SegSnapshot[],
  a: [number, number],
  b: [number, number],
  tol = 0.6,
): SegSnapshot {
  const close = (u: [number, number], v: [number, number]) => Math.hypot(u[0] - v[0], u[1] - v[1]) <= tol;
  const found = snapshot.find((s) => (close(s.p1, a) && close(s.p2, b)) || (close(s.p1, b) && close(s.p2, a)));
  if (!found) throw new Error(`segment matching ${JSON.stringify(a)}-${JSON.stringify(b)} not found in ${JSON.stringify(snapshot)}`);
  return found;
}

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

/** 線分ツールで3点チェーン(2本、中間に一致拘束)を描く(click→click→dblclick)。 */
async function drawTwoSegmentChain(page: Page, p0: [number, number], p1: [number, number], p2: [number, number]) {
  const s0 = await screenPointForWorld(page, [p0[0], p0[1], 0]);
  await page.mouse.click(s0.x, s0.y);
  const s1 = await screenPointForWorld(page, [p1[0], p1[1], 0]);
  await page.mouse.click(s1.x, s1.y);
  const s2 = await screenPointForWorld(page, [p2[0], p2[1], 0]);
  await page.mouse.dblclick(s2.x, s2.y);
}

test("①一致頂点をクリック(頂点マーカー)→下の線分からの距離指定で頂点が伸びる(遠い方の端点は動かない)", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await gotoApp(page);
  await waitForReady(page);
  await newSketchAligned(page);

  // 線分ツール: 縦のsegA(0,0)-(0,10) → 横のsegB(0,10)-(15,10)(中間頂点(0,10)にcoincident自動付与)。
  await page.getByTestId("btn-draw-segment").click();
  await drawTwoSegmentChain(page, [0, 0], [0, 10], [15, 10]);
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");

  // 下の線分segC(-10,0)-(15,0)。原点に一致させて完全に固定する(拘束ツール)ことで、
  // 「頂点が伸びる/線が動かない」を決定的に検証できるようにする。
  await page.getByTestId("btn-draw-segment").click();
  await drawSingleSegment(page, [-10, 0], [15, 0]);
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");

  await page.getByTestId("btn-constraint").click();
  const segCP1Screen = await screenPointForWorld(page, [-10, 0, 0]);
  await page.mouse.click(segCP1Screen.x, segCP1Screen.y);
  await expect(page.getByTestId("constraint-pending-status")).toContainText("端点");
  const originForConstraint = await screenPointForWorld(page, [0, 0, 0]);
  await page.mouse.click(originForConstraint.x, originForConstraint.y);
  await expect(page.getByTestId("constraint-tool-popup-coincidentOrigin")).toBeVisible();
  await page.getByTestId("constraint-tool-popup-coincidentOrigin").click();
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await page.getByTestId("btn-constraint").click(); // 拘束ツールを終了する。

  // 寸法ツールを開始し、対象セグメントのスナップショットを取ってIDで追跡できるようにする。
  await page.getByTestId("btn-dimension").click();
  await expect(page.getByTestId("dimension-tool-hint")).toBeVisible();
  const before = await dimensionSegmentsSnapshot(page);
  const segABefore = findSegmentByPoints(before, [0, 0], [0, 10]);
  const segBBefore = findSegmentByPoints(before, [0, 10], [15, 10]);

  // 中間の一致頂点(0,10)にマウスを移動: ホバーで頂点マーカーが出ることを確認する(スクリーンショット)。
  const vertexScreen = await screenPointForWorld(page, [0, 10, 0]);
  await page.mouse.move(vertexScreen.x, vertexScreen.y);
  await page.screenshot({ path: "test-results/point-dimension-1-vertex-hover.png" });

  // クリック: セグメント本体ではなく端点(頂点)としてヒットすることを確認する。
  await page.mouse.click(vertexScreen.x, vertexScreen.y);
  await expect(page.getByTestId("dimension-pending-status")).toContainText("端点");

  // 下の線分(segC、y=0、固定済み)をクリック: point-distance-line ターゲットになる。
  const lineScreen = await screenPointForWorld(page, [5, 0, 0]);
  await page.mouse.click(lineScreen.x, lineScreen.y);
  const popup = page.getByTestId("dimension-tool-popup");
  await expect(popup).toBeVisible();
  await expect(popup).toContainText("辺");
  // 現在の垂直距離は|10-0|=10。
  await expect(page.getByTestId("dimension-tool-popup-value")).toHaveValue("10.00");

  // 18に変更して適用: 頂点(0,10)がy=18まで伸びるはず(固定されたsegCはy=0のまま動かない)。
  await page.getByTestId("dimension-tool-popup-value").fill("18");
  await page.getByTestId("dimension-tool-popup-apply").click();
  await expect(popup).toHaveCount(0);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  const after = await dimensionSegmentsSnapshot(page);
  const segAAfter = after.find((s) => s.id === segABefore.id)!;
  const segBAfter = after.find((s) => s.id === segBBefore.id)!;

  // 遠い方の端点(segAのp1、原点)は動いていない。
  expect(Math.hypot(segAAfter.p1[0] - 0, segAAfter.p1[1] - 0)).toBeLessThan(0.05);
  // 頂点(segAのp2)が距離18を満たす位置(0,18)まで伸びている(固定線segCはy=0のまま)。
  expect(segAAfter.p2[0]).toBeCloseTo(0, 1);
  expect(segAAfter.p2[1]).toBeCloseTo(18, 1);
  // coincidentで繋がったsegBのp1も追従している。
  expect(segBAfter.p1[0]).toBeCloseTo(0, 1);
  expect(segBAfter.p1[1]).toBeCloseTo(18, 1);
  // segBはhorizontalを維持したまま、もう一端(p2)もy=18に連動して動く(x側は不変=15付近)。
  expect(segBAfter.p2[1]).toBeCloseTo(18, 1);
  expect(segBAfter.p2[0]).toBeCloseTo(15, 1);

  await page.screenshot({ path: "test-results/point-dimension-1-after.png" });
  expect(pageErrors).toEqual([]);
});

test("②長さ・水平・円のY距離が付いた線分に、繋がった別線分の端点↔原点のX距離を指定してもエラーにならず連動する", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await gotoApp(page);
  await waitForReady(page);
  await newSketchAligned(page);

  // 円を2つ追加し、片方を離れた位置へ移動してからdistanceEntityEntity(axis:y)を付ける
  // (「円のY距離」が付いた状態を作る。この円自体は後続の線分↔原点の寸法とは独立)。
  await page.getByTestId("btn-add-circle").click();
  await waitForReady(page);
  await page.getByTestId("btn-add-circle").click();
  await waitForReady(page);
  await page.getByTestId("entity-circle-1-center-x").fill("20");
  await waitForReady(page);

  await page.getByTestId("btn-dimension").click();
  const c1 = await screenPointForWorld(page, [10, 0, 0]); // circle1(center 0,0 r10)の円周
  await page.mouse.click(c1.x, c1.y);
  await expect(page.getByTestId("dimension-pending-status")).toContainText("円");
  const c2 = await screenPointForWorld(page, [30, 0, 0]); // circle2(center 20,0 r10)の円周
  await page.mouse.click(c2.x, c2.y);
  const circlePopup = page.getByTestId("dimension-tool-popup");
  await expect(circlePopup).toBeVisible();
  await page.getByTestId("dimension-tool-popup-axis-y").check();
  await page.getByTestId("dimension-tool-popup-value").fill("12");
  await page.getByTestId("dimension-tool-popup-apply").click();
  await expect(circlePopup).toHaveCount(0);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // 円寸法ツールをキャンセルしてから、線分チェーンを描く:
  // segD(水平、0,-15 → 15,-15)+segE(垂直、15,-15 → 15,-3、coincidentで接続)。
  await page.getByTestId("btn-dimension").click();
  await expect(page.getByTestId("dimension-tool-hint")).toHaveCount(0);
  await page.getByTestId("btn-draw-segment").click();
  await drawTwoSegmentChain(page, [0, -15], [15, -15], [15, -3]);
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");

  // segDに長さ拘束(現在の長さ15のまま=形状は変えず「長さ拘束が付いている」状態を作るだけ)。
  await page.getByTestId("btn-dimension").click();
  const before = await dimensionSegmentsSnapshot(page);
  const segDBefore = findSegmentByPoints(before, [0, -15], [15, -15]);
  const segEBefore = findSegmentByPoints(before, [15, -15], [15, -3]);
  const segDMid = await screenPointForWorld(page, [7.5, -15, 0]);
  await page.mouse.click(segDMid.x, segDMid.y);
  const lengthPopup = page.getByTestId("dimension-tool-popup");
  await expect(lengthPopup).toBeVisible();
  await expect(page.getByTestId("dimension-tool-popup-value")).toHaveValue("15.00");
  await page.getByTestId("dimension-tool-popup-apply").click();
  await expect(lengthPopup).toHaveCount(0);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // 寸法ツールを再起動し、直前のsegDクリックで残っていた「1点目保持(線分)」状態を確実にリセットする
  // (line-lineへの誤爆を避けるため)。
  await page.getByTestId("btn-dimension").click();
  await page.getByTestId("btn-dimension").click();

  // segEの遠い方の端点(15,-3)↔原点のX距離を指定する(axis:x)。Yは拘束しないため、
  // 既存の水平線(segD)の位置とは無関係に解ける=エラーにならない。
  const farEnd = await screenPointForWorld(page, [15, -3, 0]);
  await page.mouse.click(farEnd.x, farEnd.y);
  await expect(page.getByTestId("dimension-pending-status")).toContainText("端点");
  const originScreen = await screenPointForWorld(page, [0, 0, 0]);
  await page.mouse.click(originScreen.x, originScreen.y);
  const originPopup = page.getByTestId("dimension-tool-popup");
  await expect(originPopup).toBeVisible();
  await page.getByTestId("dimension-tool-popup-axis-x").check();
  await page.getByTestId("dimension-tool-popup-value").fill("40");
  await page.getByTestId("dimension-tool-popup-apply").click();
  await expect(originPopup).toHaveCount(0);
  await waitForReady(page);

  // エラーにならないこと(巻き戻しトーストも出ないこと)。
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("constraint-conflict-toast")).toHaveCount(0);

  const after = await dimensionSegmentsSnapshot(page);
  const segDAfter = after.find((s) => s.id === segDBefore.id)!;
  const segEAfter = after.find((s) => s.id === segEBefore.id)!;

  // X位置だけが決まる: segEの遠い方の端点のxが40になる(符号は元の向き[正]を維持)。
  expect(Math.abs(segEAfter.p2[0])).toBeCloseTo(40, 1);
  // verticalによりsegEのp1のxも40に追従。
  expect(Math.abs(segEAfter.p1[0])).toBeCloseTo(40, 1);
  // coincidentで繋がったsegDのp2(=segEのp1)も追従。
  expect(Math.abs(segDAfter.p2[0])).toBeCloseTo(40, 1);
  // segDは長さ15・horizontalを維持したまま全体がX方向に連動して動く。
  expect(Math.hypot(segDAfter.p2[0] - segDAfter.p1[0], segDAfter.p2[1] - segDAfter.p1[1])).toBeCloseTo(15, 1);
  expect(segDAfter.p1[1]).toBeCloseTo(segDAfter.p2[1], 1);

  expect(pageErrors).toEqual([]);
});

test("③direct距離で解なし値を入れると誘導メッセージが表示される", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await gotoApp(page);
  await waitForReady(page);
  await newSketchAligned(page);

  // segF(垂直、3,0 → 3,15。原点マーカーと重ならない位置から描く)。
  await page.getByTestId("btn-draw-segment").click();
  await drawSingleSegment(page, [3, 0], [3, 15]);
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");

  // p1を原点に一致させる(拘束ツール)。distancePointOriginのupsertは同じ点なら値を差し替える
  // だけで新しい拘束にならないため、わざと別種の拘束[vertical(軸ロック由来)+coincidentOrigin+
  // length]の組み合わせでY方向の位置を確定させ、後からdirect距離を追加したときに初めて
  // 解なしになるようにする(この構成の方が「既に別の拘束でY方向が固定されている」という
  // 典型的な状況に近い)。
  await page.getByTestId("btn-constraint").click();
  const p1Screen = await screenPointForWorld(page, [3, 0, 0]);
  await page.mouse.click(p1Screen.x, p1Screen.y);
  await expect(page.getByTestId("constraint-pending-status")).toContainText("端点");
  const originForConstraint = await screenPointForWorld(page, [0, 0, 0]);
  await page.mouse.click(originForConstraint.x, originForConstraint.y);
  await expect(page.getByTestId("constraint-tool-popup-coincidentOrigin")).toBeVisible();
  await page.getByTestId("constraint-tool-popup-coincidentOrigin").click();
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await page.getByTestId("btn-constraint").click(); // 拘束ツールを終了する。

  // p1が原点(0,0)に一致し、verticalによりp2のxも0に追従しているはず(yはまだ未確定=regularization
  // により入力[15]付近を維持)。実際の座標を読み、以降のクリックに使う(小さな数値誤差に頑健にする)。
  await page.getByTestId("btn-dimension").click();
  const afterAnchor = await dimensionSegmentsSnapshot(page);
  const segFAfterAnchor = afterAnchor[0];
  expect(segFAfterAnchor.p1[0]).toBeCloseTo(0, 3);
  expect(segFAfterAnchor.p1[1]).toBeCloseTo(0, 3);

  // segF本体(length)をクリックし、現在の長さのまま適用: vertical+coincidentOrigin(p1)+lengthで、
  // p2はこの時点の座標に完全に固定される。
  const midScreen = await screenPointForWorld(page, [
    (segFAfterAnchor.p1[0] + segFAfterAnchor.p2[0]) / 2,
    (segFAfterAnchor.p1[1] + segFAfterAnchor.p2[1]) / 2,
    0,
  ]);
  await page.mouse.click(midScreen.x, midScreen.y);
  const lengthPopup = page.getByTestId("dimension-tool-popup");
  await expect(lengthPopup).toBeVisible();
  const currentLength = await page.getByTestId("dimension-tool-popup-value").inputValue();
  await page.getByTestId("dimension-tool-popup-apply").click();
  await expect(lengthPopup).toHaveCount(0);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // 寸法ツールを再起動し、直前のsegFクリックで残った「1点目保持(線分)」状態をリセットする。
  await page.getByTestId("btn-dimension").click();
  await page.getByTestId("btn-dimension").click();

  const afterLength = await dimensionSegmentsSnapshot(page);
  const segFAfterLength = afterLength[0];
  const p2Y = segFAfterLength.p2[1];
  expect(Math.abs(p2Y)).toBeCloseTo(Number(currentLength), 1);

  // p2↔原点にdirect距離(既定)で、現在のY距離より明らかに小さい値を指定する: Y成分だけで
  // |p2Y|必要なので解なし。
  const p2Screen = await screenPointForWorld(page, [segFAfterLength.p2[0], segFAfterLength.p2[1], 0]);
  await page.mouse.click(p2Screen.x, p2Screen.y);
  await expect(page.getByTestId("dimension-pending-status")).toContainText("端点");
  const originScreen = await screenPointForWorld(page, [0, 0, 0]);
  await page.mouse.click(originScreen.x, originScreen.y);
  const popup2 = page.getByTestId("dimension-tool-popup");
  await expect(popup2).toBeVisible();
  // 既定は「距離」(direct)のまま。
  const tooSmallValue = Math.abs(p2Y) / 2;
  await page.getByTestId("dimension-tool-popup-value").fill(tooSmallValue.toFixed(2));
  await page.getByTestId("dimension-tool-popup-apply").click();
  await expect(popup2).toHaveCount(0);
  await waitForReady(page);

  // 矛盾検出→自動巻き戻し+具体的な誘導メッセージ。
  const toast = page.getByTestId("constraint-conflict-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(`Y方向の位置が${Math.abs(p2Y).toFixed(1)}mmに拘束されている`);
  await expect(toast).toContainText("X距離指定も使えます");
  await page.screenshot({ path: "test-results/point-dimension-3-conflict-toast.png" });

  // 巻き戻し後、拘束は変わっていない(依然としてエラー無し)ことを確認する。
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});
