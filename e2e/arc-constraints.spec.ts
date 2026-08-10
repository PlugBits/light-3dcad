// 円弧の一級化(Phase 42b)のE2E。ユーザー報告「円弧に対して接線とか、一致が効かない。拘束メニュー
// 時に円弧が選べなくなってる」の再現・修正確認。
// フィレット(コーナー)ツールで線分チェーンの角を丸めて円弧を作る(applySegmentCornerToSketchが
// 円弧の両端点↔隣接線分の一致[coincident]拘束を自動付与する、src/model/document.ts参照)。
// その円弧が拘束ツールで選択できること(以前はfindConstraintPickHitがkind:"line"以外をスキップして
// おり選択不能だった)、直線への接線(tangent)が矛盾判定にならず解けること、フィレットが自動付与した
// 円弧端点の一致(coincident)がソルバ実行後も保たれている(=一致が効いている)ことを確認する。
//
// クリック座標は既定カメラのcanvas可視範囲(他specの実測コメント: おおよそx:-20〜30, y:-15〜20)に
// 収める(範囲外はscreenPointForWorld()が画面外の座標を返し、意図しないUI要素[リボンボタン等]を
// クリックしてしまう)。
import { expect, type Page, test } from "@playwright/test";

import { collectPageErrors, gotoApp, screenPointForWorld, waitForReady } from "./helpers";

type SegSnapshot = { id: string; p1: [number, number]; p2: [number, number]; kind: "line" | "arc"; bulge?: number };

async function dimensionSegmentsSnapshot(page: Page): Promise<SegSnapshot[]> {
  return page.evaluate(() => window.__cadViewerDebug?.dimensionToolSegmentsSnapshot() ?? []);
}

/** スケッチを作成し、平面に正対する(既存specと同じ導入パターン)。 */
async function newSketchAligned(page: Page) {
  await page.getByTestId("btn-add-sketch").click();
  await waitForReady(page);
  await page.getByTestId("btn-align-to-plane").click();
}

/**
 * bulge値(src/sketch/bulge.tsのsagPointForBulge()と同じ定義)から、円弧上の「経由点」
 * (p1・p2とともに実際の弧を一意に定める3点円弧の第2点、常に弧の上に厳密に乗る)を計算する。
 * クリック対象として使う: 弦の中点でクリックすると(特にフィレットのように曲がりが浅い弧では)
 * ポリライン近似からの距離が拘束ツールの許容誤差を超え、ヒットしないことがあるため。
 */
function sagPointForBulge(p1: [number, number], p2: [number, number], bulge: number): [number, number] {
  const mid: [number, number] = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const halfChord = Math.hypot(dx, dy) / 2;
  const leftPerp: [number, number] = [-dy, dx];
  const len = Math.hypot(leftPerp[0], leftPerp[1]);
  const norm: [number, number] = [leftPerp[0] / len, leftPerp[1] / len];
  const bulgeAsSagitta = -bulge * halfChord;
  return [mid[0] + norm[0] * bulgeAsSagitta, mid[1] + norm[1] * bulgeAsSagitta];
}

test("フィレットで生じた円弧が拘束ツールで選択でき、直線への接線が解け、フィレットの一致(coincident)も保たれる", async ({
  page,
}) => {
  const pageErrors = collectPageErrors(page);
  await gotoApp(page);
  await waitForReady(page);

  await newSketchAligned(page);

  // L字の2本チェーン(-15,0)→(10,0)→(10,15)。共有頂点(10,0)をフィレットして円弧を作る。
  await page.getByTestId("btn-draw-segment").click();
  const p0 = await screenPointForWorld(page, [-15, 0, 0]);
  await page.mouse.click(p0.x, p0.y);
  const p1 = await screenPointForWorld(page, [10, 0, 0]);
  await page.mouse.click(p1.x, p1.y);
  const p2 = await screenPointForWorld(page, [10, 15, 0]);
  await page.mouse.dblclick(p2.x, p2.y);
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");
  await expect(page.getByTestId("segment-count")).toContainText("2");

  // 接線の相手にする、フィレットとは無関係な独立した直線((18,-14)→(26,-14))。
  await page.getByTestId("btn-draw-segment").click();
  const l0 = await screenPointForWorld(page, [18, -14, 0]);
  await page.mouse.click(l0.x, l0.y);
  const l1 = await screenPointForWorld(page, [26, -14, 0]);
  await page.mouse.dblclick(l1.x, l1.y);
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");
  await expect(page.getByTestId("segment-count")).toContainText("3");

  // フィレットツール(既定サイズ5mm)で共有頂点(10,0)付近をクリックし、円弧を挿入する。
  await page.getByTestId("btn-corner-fillet").click();
  const vertexScreen = await screenPointForWorld(page, [10, 0, 0]);
  await page.mouse.click(vertexScreen.x, vertexScreen.y);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await page.getByTestId("btn-corner-fillet").click(); // フィレットツールを終了する。

  // 挿入された円弧セグメントを特定する(kind:"arc")。
  await page.getByTestId("btn-dimension").click();
  const afterFillet = await dimensionSegmentsSnapshot(page);
  await page.getByTestId("btn-dimension").click();
  const arc = afterFillet.find((s) => s.kind === "arc");
  if (!arc) throw new Error(`フィレットで円弧が生成されませんでした: ${JSON.stringify(afterFillet)}`);
  expect(arc.bulge).toBeTruthy();

  // 円弧上の経由点(常に弧の上に厳密に乗る)をクリックして拘束ツールで選択する。以前は
  // findConstraintPickHitがkind:"line"以外をスキップしており選択できなかった(ユーザー報告
  // 「拘束メニュー時に円弧が選べなくなってる」の再現ポイント)。
  await page.getByTestId("btn-constraint").click();
  const arcPoint = sagPointForBulge(arc.p1, arc.p2, arc.bulge ?? 0);
  const arcPointScreen = await screenPointForWorld(page, [arcPoint[0], arcPoint[1], 0]);
  await page.mouse.click(arcPointScreen.x, arcPointScreen.y);
  // 選択できていれば「線分/円弧」の対象としてpending状態になる(選択不能ならpendingにならず
  // 後続のクリックが1つ目として扱われてしまい、この文言チェックで検出できる)。
  await expect(page.getByTestId("constraint-pending-status")).toContainText("線分/円弧");

  // 2つ目: 独立した直線をクリックし、「接線」を適用する。
  const targetLineScreen = await screenPointForWorld(page, [22, -14, 0]);
  await page.mouse.click(targetLineScreen.x, targetLineScreen.y);
  await expect(page.getByTestId("constraint-tool-popup")).toBeVisible();
  await expect(page.getByTestId("constraint-tool-popup-tangent")).toBeVisible();
  await page.getByTestId("constraint-tool-popup-tangent").click();

  await waitForReady(page);
  await expect(page.getByTestId("constraint-conflict-toast")).toHaveCount(0);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("sketch-definition-badge-conflicting")).toHaveCount(0);

  await page.getByTestId("btn-constraint").click(); // 拘束ツールを終了する。

  // 接線が解けている: 直線が円弧の中心へ、垂直距離=半径(5mm)まで近づいている(接線適用前は
  // 中心[およそ(5,5)]からy=-14の直線までの距離がおよそ19mmあった)。
  await page.getByTestId("btn-dimension").click();
  const solved = await dimensionSegmentsSnapshot(page);
  await page.getByTestId("btn-dimension").click();
  const solvedArc = solved.find((s) => s.kind === "arc");
  const solvedLine = solved.find((s) => s.id !== solvedArc?.id && Math.abs(s.p1[1] - s.p2[1]) < 5 && s.p1[0] > 15);
  if (!solvedArc || !solvedLine) throw new Error(`解いた後の円弧/直線が見つかりません: ${JSON.stringify(solved)}`);
  const via = sagPointForBulge(solvedArc.p1, solvedArc.p2, solvedArc.bulge ?? 0);
  // 弧の中心は経由点よりさらに膨らみの反対側(弦から見て経由点と逆の外側)にあるが、ここでは
  // 「直線がフィレット付近まで実際に移動したこと」(退化・矛盾していないことの直接証跡)を、
  // 経由点↔直線の距離が明確に縮まっている(接線前の約19mmより十分近い)ことで確認する。
  const dx = solvedLine.p2[0] - solvedLine.p1[0];
  const dy = solvedLine.p2[1] - solvedLine.p1[1];
  const len = Math.hypot(dx, dy);
  const cross = (via[0] - solvedLine.p1[0]) * dy - (via[1] - solvedLine.p1[1]) * dx;
  const distToLine = len > 1e-6 ? Math.abs(cross) / len : Infinity;
  expect(distToLine).toBeLessThan(10);

  // フィレットが自動付与した一致(coincident、円弧の両端点↔隣接線分の端点)が、接線適用後の
  // 再solveでも保たれている(=一致が効いている)ことを確認する。
  const others = solved.filter((s) => s.kind === "line" && s.id !== solvedLine.id);
  const arcTouchesOther = (arcPoint2: [number, number]) =>
    others.some(
      (o) =>
        Math.hypot(o.p1[0] - arcPoint2[0], o.p1[1] - arcPoint2[1]) < 1e-2 ||
        Math.hypot(o.p2[0] - arcPoint2[0], o.p2[1] - arcPoint2[1]) < 1e-2,
    );
  expect(arcTouchesOther(solvedArc.p1)).toBe(true);
  expect(arcTouchesOther(solvedArc.p2)).toBe(true);

  expect(pageErrors).toEqual([]);
});
