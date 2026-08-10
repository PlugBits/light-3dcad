// 実機報告2件のE2E(Phase 31a)。
// ①寸法ラベル(実測)をドラッグ→寸法線ごと移動→リロード(自動保存)後も位置が維持される。
// ②一致+水平+垂直+寸法(長さ)が付いた線分チェーンをトリム→水平・垂直・一致・(残せる)長さ寸法
//   (トリム対象外のsegB)は残る、トリムで断片化したsegAの長さ寸法だけが通知付きで消える。
import { expect, type Page, test } from "@playwright/test";

import { collectPageErrors, gotoApp, screenPointForWorld, waitForReady } from "./helpers";

/** 線分ツールで2点チェーン(1本)を描く(click→dblclick)。point-dimension.spec.tsと同じパターン。 */
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
 * 拘束一覧パネル(SketchEditor.tsxのConstraintListPanel)の各行のテキストを返す。
 * data-testidは`constraint-{index}`(数字のみ)の行だけを対象にする(削除ボタンの
 * `constraint-{index}-delete`や、無関係な`constraint-conflict-toast`[一時トースト]と
 * 前方一致で誤って拾わないようにするため)。
 */
async function constraintListTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="constraint-"]'));
    return rows
      .filter((el) => /^constraint-\d+$/.test(el.dataset.testid ?? ""))
      .map((el) => el.textContent ?? "");
  });
}

test("①寸法ラベルをドラッグすると寸法線ごと移動し、リロード(自動保存)後も位置が維持される", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  // gotoApp()のlocalStorageクリアinitScriptは以後のnavigation(page.reload()含む)すべてに
  // 適用されてしまい、リロード後のlocalStorage(自動保存)を消してしまうため、ここでは使わない
  // (Playwrightはテストごとに新しいブラウザコンテキストのため、素のgoto()でも初期状態はクリーン)。
  await page.goto("/");
  await waitForReady(page);

  await page.getByTestId("btn-add-sketch").click();
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();
  await waitForReady(page);
  await page.getByTestId("btn-align-to-plane").click();

  // 20x20mmの矩形を原点に追加する(実測寸法: 幅・高さのラベルが即座に表示される)。
  await page.getByTestId("btn-add-rectangle").click();
  await waitForReady(page);

  const widthLabel = page.locator('[data-testid^="dim-label-"][data-testid$="-w"]');
  await expect(widthLabel).toBeVisible();
  const before = await widthLabel.boundingBox();
  if (!before) throw new Error("幅ラベルのbounding boxが取得できません");

  const startX = before.x + before.width / 2;
  const startY = before.y + before.height / 2;
  const dx = 70;
  const dy = 45;

  await page.screenshot({ path: "test-results/dim-drag-1-before.png" });

  // mousedown後、閾値を超えて動かす(クリックではなくドラッグと判定させる)。
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 15, startY + 10, { steps: 3 });
  await page.mouse.move(startX + dx, startY + dy, { steps: 5 });
  await page.mouse.up();

  // クリック扱いにならず、編集ポップアップは開かない。
  await expect(page.getByTestId("dim-edit-popup")).toHaveCount(0);

  const afterDrag = await widthLabel.boundingBox();
  if (!afterDrag) throw new Error("ドラッグ後の幅ラベルのbounding boxが取得できません");
  expect(afterDrag.x - before.x).toBeGreaterThan(40);
  expect(afterDrag.y - before.y).toBeGreaterThan(25);

  await page.screenshot({ path: "test-results/dim-drag-2-after-drag.png" });

  // 自動保存のデバウンス(500ms)を待つ。
  await page.waitForTimeout(800);

  await page.reload();
  await waitForReady(page);
  // 選択状態(selectedFeatureId)は自動保存に含まれないため、リロード後は再選択する。
  await page.getByTestId("feature-item-Sketch2").click();
  await waitForReady(page);
  await page.getByTestId("btn-align-to-plane").click();

  const widthLabelAfterReload = page.locator('[data-testid^="dim-label-"][data-testid$="-w"]');
  await expect(widthLabelAfterReload).toBeVisible();
  const afterReload = await widthLabelAfterReload.boundingBox();
  if (!afterReload) throw new Error("リロード後の幅ラベルのbounding boxが取得できません");

  // ドラッグ後の位置とほぼ一致する(数px程度の誤差は許容)。ドラッグ前の位置とは明確に異なる。
  expect(Math.abs(afterReload.x - afterDrag.x)).toBeLessThan(6);
  expect(Math.abs(afterReload.y - afterDrag.y)).toBeLessThan(6);
  expect(Math.abs(afterReload.x - before.x)).toBeGreaterThan(30);

  await page.screenshot({ path: "test-results/dim-drag-3-after-reload.png" });
  expect(pageErrors).toEqual([]);
});

test("①b 拘束由来の寸法ラベル(長さ)をドラッグすると移動し、リロード後も位置が維持される(実機報告の根本原因の回帰テスト、Phase 33)", async ({
  page,
}) => {
  // 実機報告の根本原因: DimensionOverlay.commitOffset()がconstraintDimensionKey()の返す
  // "c-"+constraintId をそのままsetConstraintLabelOffset()のconstraintId引数へ渡していたため、
  // c.id(プレフィックス無し)と一致せず書き込みが常に無効だった(=拘束由来の寸法ラベルは
  // 実測寸法[矩形の幅/高さ等]と異なりドラッグしても一切動かなかった)。寸法ツールで作る
  // 長さ・距離・X/Y距離・半径は全てこの「拘束由来」に該当するため、実機で最も使われる経路が
  // 影響を受けていた。
  const pageErrors = collectPageErrors(page);
  await page.goto("/");
  await waitForReady(page);

  await page.getByTestId("btn-add-sketch").click();
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();
  await waitForReady(page);
  await page.getByTestId("btn-align-to-plane").click();

  await page.getByTestId("btn-draw-segment").click();
  await drawSingleSegment(page, [0, 0], [20, 0]);
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");

  // 長さ拘束(現在の長さ20のまま)を付ける→拘束由来の寸法ラベルが表示される。
  await page.getByTestId("btn-dimension").click();
  const segMid = await screenPointForWorld(page, [10, 0, 0]);
  await page.mouse.click(segMid.x, segMid.y);
  const popup = page.getByTestId("dimension-tool-popup");
  await expect(popup).toBeVisible();
  await expect(page.getByTestId("dimension-tool-popup-value")).toHaveValue("20.00");
  await page.getByTestId("dimension-tool-popup-apply").click();
  await expect(popup).toHaveCount(0);
  await waitForReady(page);
  await page.getByTestId("btn-dimension").click(); // 寸法ツールを終了する。

  const lengthLabel = page.locator('[data-testid^="dim-label-c-"]').filter({ hasText: "20.0" });
  await expect(lengthLabel).toBeVisible();
  const before = await lengthLabel.boundingBox();
  if (!before) throw new Error("長さラベルのbounding boxが取得できません");

  const startX = before.x + before.width / 2;
  const startY = before.y + before.height / 2;
  const dx = 60;
  const dy = 40;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 15, startY + 10, { steps: 3 });
  await page.mouse.move(startX + dx, startY + dy, { steps: 5 });
  await page.mouse.up();

  // クリック扱いにならず、編集ポップアップは開かない。
  await expect(page.getByTestId("dim-edit-popup")).toHaveCount(0);
  await expect(page.getByTestId("dimension-tool-popup")).toHaveCount(0);

  const afterDrag = await lengthLabel.boundingBox();
  if (!afterDrag) throw new Error("ドラッグ後の長さラベルのbounding boxが取得できません");
  // 修正前はここが0(全く動かない)だった。
  expect(afterDrag.x - before.x).toBeGreaterThan(30);
  expect(afterDrag.y - before.y).toBeGreaterThan(20);

  await page.screenshot({ path: "test-results/dim-drag-constraint-1-after-drag.png" });

  // 自動保存のデバウンス(500ms)を待ってリロードし、位置が維持されることを確認する。
  await page.waitForTimeout(800);
  await page.reload();
  await waitForReady(page);
  await page.getByTestId("feature-item-Sketch2").click();
  await waitForReady(page);
  await page.getByTestId("btn-align-to-plane").click();

  const labelAfterReload = page.locator('[data-testid^="dim-label-c-"]').filter({ hasText: "20.0" });
  await expect(labelAfterReload).toBeVisible();
  const afterReload = await labelAfterReload.boundingBox();
  if (!afterReload) throw new Error("リロード後の長さラベルのbounding boxが取得できません");
  expect(Math.abs(afterReload.x - afterDrag.x)).toBeLessThan(6);
  expect(Math.abs(afterReload.y - afterDrag.y)).toBeLessThan(6);

  await page.screenshot({ path: "test-results/dim-drag-constraint-2-after-reload.png" });
  expect(pageErrors).toEqual([]);
});

test("②一致+水平+垂直+長さが付いた線分チェーンをトリム→水平・垂直・一致・(残せる)長さ寸法は残り、断片化した長さ寸法だけが通知付きで消える", async ({
  page,
}) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page);
  await waitForReady(page);

  await page.getByTestId("btn-add-sketch").click();
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();
  await waitForReady(page);
  await page.getByTestId("btn-align-to-plane").click();

  // segA(水平、0,0→24,0)+segB(垂直、24,0→24,10)。線分ツールのチェーン確定時、自動的に
  // coincident(segA.p2-segB.p1)・horizontal(segA)・vertical(segB)が付与される(軸ロック由来)。
  await page.getByTestId("btn-draw-segment").click();
  await drawTwoSegmentChain(page, [0, 0], [24, 0], [24, 10]);
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");

  // segAを横切る、チェーンとは繋がっていない縦線を2本(x=8, x=16)追加する(トリムの区間分割用)。
  await page.getByTestId("btn-draw-segment").click();
  await drawSingleSegment(page, [8, -5], [8, 5]);
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");

  await page.getByTestId("btn-draw-segment").click();
  await drawSingleSegment(page, [16, -5], [16, 5]);
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");

  // segAに長さ拘束(現在の長さ24のまま)。
  await page.getByTestId("btn-dimension").click();
  const segAMid = await screenPointForWorld(page, [4, 0, 0]); // クロス線(x=8)より内側(左)をクリック
  await page.mouse.click(segAMid.x, segAMid.y);
  let popup = page.getByTestId("dimension-tool-popup");
  await expect(popup).toBeVisible();
  await expect(page.getByTestId("dimension-tool-popup-value")).toHaveValue("24.00");
  await page.getByTestId("dimension-tool-popup-apply").click();
  await expect(popup).toHaveCount(0);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // dimensionツールを再起動し、直前の「1点目保持」状態をリセットしてからsegBにも長さ拘束を付ける
  // (point-dimension.spec.tsと同じパターン)。
  await page.getByTestId("btn-dimension").click();
  await page.getByTestId("btn-dimension").click();
  const segBMid = await screenPointForWorld(page, [24, 5, 0]);
  await page.mouse.click(segBMid.x, segBMid.y);
  popup = page.getByTestId("dimension-tool-popup");
  await expect(popup).toBeVisible();
  await expect(page.getByTestId("dimension-tool-popup-value")).toHaveValue("10.00");
  await page.getByTestId("dimension-tool-popup-apply").click();
  await expect(popup).toHaveCount(0);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // dimensionツールを終了する。
  await page.getByTestId("btn-dimension").click();

  const before = await constraintListTexts(page);
  expect(before.filter((t) => t.includes("長さ"))).toHaveLength(2);
  expect(before.filter((t) => t.includes("水平"))).toHaveLength(1);
  // 垂直はsegBに加え、クロス線2本(いずれも軸ロックで確定した縦線)にも自動付与されるため3件。
  expect(before.filter((t) => t.includes("垂直"))).toHaveLength(3);
  expect(before.filter((t) => t.includes("一致"))).toHaveLength(1);

  await page.screenshot({ path: "test-results/trim-constraints-1-before.png" });

  // トリムツール: segAの中間区間(x=8〜16、2本のクロス線の間)をクリックして削除する
  // (segAは[0,8](元のIDを引き継ぐ)・[16,24](新IDを引き継ぐ、coincidentでsegBに接続)の
  // 2断片に分かれる)。
  await page.getByTestId("btn-trim").click();
  const trimClick = await screenPointForWorld(page, [12, 0, 0]);
  await page.mouse.click(trimClick.x, trimClick.y);
  await waitForReady(page);
  await page.getByTestId("btn-trim").click(); // トリムツールを終了する。

  // 一時トースト: 長さ寸法1件が削除されたことを通知する。
  const toast = page.getByTestId("constraint-conflict-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("トリムにより長さ寸法1件を削除しました");
  await page.screenshot({ path: "test-results/trim-constraints-2-toast.png" });

  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  const after = await constraintListTexts(page);
  // segAの長さ拘束だけが削除され、segBの長さ拘束(トリム対象外)は残る。
  expect(after.filter((t) => t.includes("長さ"))).toHaveLength(1);
  // 水平(segA、元IDを引き継いだ断片にそのまま有効)・垂直(segB+クロス線2本、無関係)・
  // 一致(座標一致で付け替え)は件数不変のまま残る。
  expect(after.filter((t) => t.includes("水平"))).toHaveLength(1);
  expect(after.filter((t) => t.includes("垂直"))).toHaveLength(3);
  expect(after.filter((t) => t.includes("一致"))).toHaveLength(1);

  // 残った長さ寸法ラベル(segBの10.0)が実際にビューア上へ表示され続けている(値も変わらない)。
  const remainingLengthLabel = page.locator('[data-testid^="dim-label-c-"]').filter({ hasText: "10.0" });
  await expect(remainingLengthLabel).toHaveCount(1);

  await page.screenshot({ path: "test-results/trim-constraints-3-after.png" });
  expect(pageErrors).toEqual([]);
});

test("③実機報告(Phase 42): 固定円(fixEntity)+2本の線分への接線をトリムしても矛盾判定にならず、押し出しも成功する", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page);
  await waitForReady(page);

  await page.getByTestId("btn-add-sketch").click();
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();
  await waitForReady(page);
  await page.getByTestId("btn-align-to-plane").click();

  // 水平・垂直の2本チェーン(L字、12,-14→27,-14→27,18)を描く
  // (実機報告の「チェーンの2本の線分に接線」を模した最小構成)。矩形(押し出し用の閉ループ)は
  // 円のentities配列インデックス([entity-circle-0-...]テストID)を狂わせないよう、
  // 円をトリムし終えた後(entitiesが空になった後)に追加する。
  await page.getByTestId("btn-draw-segment").click();
  await drawTwoSegmentChain(page, [12, -14], [27, -14], [27, 18]);
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");

  // 半径5の円を、L字の角(27,-14)に内接する位置(中心22,-9)へ配置し、固定する
  // (実機報告の「円1・円2が固定[fixEntity]」に相当)。
  await page.getByTestId("btn-add-circle").click();
  await waitForReady(page);
  await page.getByTestId("entity-circle-0-radius").fill("5");
  await waitForReady(page);
  await page.getByTestId("entity-circle-0-center-x").fill("22");
  await waitForReady(page);
  await page.getByTestId("entity-circle-0-center-y").fill("-9");
  await waitForReady(page);
  await page.getByTestId("entity-circle-0-fixed").check();
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // 拘束ツール: 円周上の点→水平線分、円周上の点→垂直線分の順に「接線」を適用する
  // (実機報告の「接線: circle ↔ 線分7、circle ↔ 線分4」に相当)。あらかじめ幾何的に
  // 接する位置へ置いているため、適用は数値的にほぼ無変化(安定に成功する)。
  await page.getByTestId("btn-constraint").click();
  const circleLeftRim = await screenPointForWorld(page, [17, -9, 0]);
  await page.mouse.click(circleLeftRim.x, circleLeftRim.y);
  await expect(page.getByTestId("constraint-pending-status")).toContainText("円");
  const horizSegPt = await screenPointForWorld(page, [14, -14, 0]);
  await page.mouse.click(horizSegPt.x, horizSegPt.y);
  await expect(page.getByTestId("constraint-tool-popup-tangent")).toBeVisible();
  await page.getByTestId("constraint-tool-popup-tangent").click();
  await waitForReady(page);
  await expect(page.getByTestId("constraint-conflict-toast")).toHaveCount(0);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  await page.mouse.click(circleLeftRim.x, circleLeftRim.y);
  await expect(page.getByTestId("constraint-pending-status")).toContainText("円");
  const vertSegPt = await screenPointForWorld(page, [27, 10, 0]);
  await page.mouse.click(vertSegPt.x, vertSegPt.y);
  await expect(page.getByTestId("constraint-tool-popup-tangent")).toBeVisible();
  await page.getByTestId("constraint-tool-popup-tangent").click();
  await waitForReady(page);
  await expect(page.getByTestId("constraint-conflict-toast")).toHaveCount(0);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await page.getByTestId("btn-constraint").click(); // 拘束ツールを終了する。

  await page.screenshot({ path: "test-results/trim-fixed-circle-1-before.png" });

  // 拘束一覧に円entityを参照する拘束(円の固定・接線×2)が3件あることを確認してからトリムする。
  const beforeTrim = await constraintListTexts(page);
  expect(beforeTrim.filter((t) => t.includes("円の固定"))).toHaveLength(1);
  expect(beforeTrim.filter((t) => t.includes("接線"))).toHaveLength(2);

  // トリムツール: 円周上、いずれの接点(下端(22,-14)・右端(27,-9))とも異なる上端(22,-4)をクリックし、
  // 円entityをトリムする(円弧片へ分解される)。
  await page.getByTestId("btn-trim").click();
  const trimClick = await screenPointForWorld(page, [22, -4, 0]);
  await page.mouse.click(trimClick.x, trimClick.y);
  await waitForReady(page);
  await page.getByTestId("btn-trim").click(); // トリムツールを終了する。

  await page.screenshot({ path: "test-results/trim-fixed-circle-2-after.png" });

  // 実機報告バグの修正確認: 「拘束矛盾」ロールバックトーストが出ない(fixEntity/tangentは
  // 全て移行/凍結により無害に処理されるためremovedConstraintCountは0、トースト自体が出ない)、
  // 評価エラーも無い、スケッチの定義状態バッジが「矛盾あり」にならない。
  await expect(page.getByTestId("constraint-conflict-toast")).toHaveCount(0);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("sketch-definition-badge-conflicting")).toHaveCount(0);

  // tell-tale sign: 拘束一覧に解決不能な生ID(entity-...)がそのまま表示され続けていない
  // (fixEntity/tangentが円entityIdへの参照切れのまま残っていた、というのがバグの根本原因だった)。
  const afterTrim = await constraintListTexts(page);
  expect(afterTrim.some((t) => t.includes("entity-"))).toBe(false);
  // fixEntityはトリムで生じた円弧片へ移行され、tangentは凍結により無害に削除されるため、
  // 「円の固定」「接線」表記は消える。
  expect(afterTrim.filter((t) => t.includes("円の固定"))).toHaveLength(0);
  expect(afterTrim.filter((t) => t.includes("接線"))).toHaveLength(0);
  // Phase 42b: 円弧がPlaneGCSのネイティブarcプリミティになったため、fixEntityの移行先は
  // 「断片の両端点をfix」ではなく「断片(円弧)の中心・半径をfixArc」に変わった(端点は元の円の
  // 上を自由に滑れる、= 円弧の固定)。「円弧の固定」表記が断片数分残る。
  expect(afterTrim.filter((t) => t.startsWith("円弧の固定:")).length).toBeGreaterThan(0);

  // 押し出し用の閉ループ(20x20矩形、原点)を追加する(L字チェーン+トリム後の円弧片は開いた
  // ままで領域を構成しないため、押し出し可能な形状にはこの矩形が必要。本題は「トリムが
  // 壊れていないこと」の確認であり、この矩形自体はトリム対象の円とは無関係)。
  await page.getByTestId("btn-add-rectangle").click();
  await waitForReady(page);

  // 押し出し(既にボディが存在するため既定operationは"add")も引き続き成功する。
  await page.getByTestId("btn-add-extrude").click();
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  await page.screenshot({ path: "test-results/trim-fixed-circle-3-extruded.png" });
  expect(pageErrors).toEqual([]);
});
