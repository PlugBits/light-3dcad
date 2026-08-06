import { useEffect, useMemo, useRef, useState } from "react";

import { DimensionOverlay } from "../components/DimensionOverlay";
import { ExtrudeEditor } from "../components/ExtrudeEditor";
import { FeatureTree } from "../components/FeatureTree";
import { SketchEditor } from "../components/SketchEditor";
import { downloadStl } from "../export/downloadStl";
import { addSketchEntity, findFeature, getDependentFeatureIds } from "../model/document";
import { createPolygonEntity } from "../model/entity";
import { useCadStore } from "../state/store";
import { CadViewer, type SketchOverlayEntry } from "../viewer/CadViewer";

export default function App() {
  const viewerContainerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<CadViewer | null>(null);

  const doc = useCadStore((s) => s.doc);
  const status = useCadStore((s) => s.status);
  const mesh = useCadStore((s) => s.mesh);
  const faceInfo = useCadStore((s) => s.faceInfo);
  const sketchPlanes = useCadStore((s) => s.sketchPlanes);
  const errorMessage = useCadStore((s) => s.errorMessage);
  const errorFeatureId = useCadStore((s) => s.errorFeatureId);
  const selectedFeatureId = useCadStore((s) => s.selectedFeatureId);
  const selectedFace = useCadStore((s) => s.selectedFace);
  const showSketches = useCadStore((s) => s.showSketches);
  const exporting = useCadStore((s) => s.exporting);
  const exportError = useCadStore((s) => s.exportError);
  const initialize = useCadStore((s) => s.initialize);
  const selectFeature = useCadStore((s) => s.selectFeature);
  const selectFace = useCadStore((s) => s.selectFace);
  const addSketch = useCadStore((s) => s.addSketch);
  const addExtrude = useCadStore((s) => s.addExtrude);
  const addFaceSketch = useCadStore((s) => s.addFaceSketch);
  const removeFeature = useCadStore((s) => s.removeFeature);
  const exportStl = useCadStore((s) => s.exportStl);
  const setShowSketches = useCadStore((s) => s.setShowSketches);
  const updateDocument = useCadStore((s) => s.updateDocument);

  // 線描画モード中かどうか(UI側の表示状態。実体はCadViewerが持つ)。
  const [drawingMode, setDrawingMode] = useState(false);
  // 描画モード開始時点で対象だったスケッチID。選択が他に移ったら自動キャンセルするために使う。
  const [drawingSketchId, setDrawingSketchId] = useState<string | null>(null);
  // 1mmグリッドスナップ(デフォルトON)。
  const [gridSnap, setGridSnap] = useState(true);
  // 「スケッチ追加」ボタンで使う平面選択(Phase 13)。基準平面クリックと同等の機能をUIからも操作できるようにする。
  const [newSketchPlane, setNewSketchPlane] = useState<"XY" | "XZ" | "YZ">("XY");

  // Workerを起動し、初期ドキュメントの評価を1回だけ要求する。
  useEffect(() => {
    initialize();
  }, [initialize]);

  // Three.jsビューア初期化(マウント時に一度だけ)。
  // 面クリック時のコールバックはストアの最新スナップショットを直接参照する
  // (依存配列は空のまま=マウント時に一度だけ生成するビューアに対して安定した参照を渡す)。
  useEffect(() => {
    if (!viewerContainerRef.current) return;
    const viewer = new CadViewer(
      viewerContainerRef.current,
      (face) => {
        useCadStore.getState().selectFace(face);
      },
      (plane) => {
        // 基準平面クリック(Phase 13): その平面で新規スケッチを作り、選択状態にする。
        useCadStore.getState().addSketch(plane);
      },
    );
    viewerRef.current = viewer;
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  // ストアのmesh/faceInfoが更新されるたびにビューアへ反映する。
  // mesh===nullは初回未評価のみ(Phase 13以降、ボディなしは空配列のmeshとして届くため、
  // ここでのnullチェックは「まだ一度もWorkerから応答が無い」ケースのみを意味する)。
  useEffect(() => {
    if (mesh) {
      viewerRef.current?.setMesh(mesh, faceInfo);
    }
  }, [mesh, faceInfo]);

  // ドキュメントに1つもフィーチャーが無い(=空ドキュメント、ボディなし)間だけ基準平面3枚を表示する。
  // 基準平面クリック等で最初のスケッチが作られた時点(features.length>0)で非表示になる(Phase 13)。
  useEffect(() => {
    viewerRef.current?.setReferencePlanesVisible(doc.features.length === 0);
  }, [doc.features.length]);

  // doc(スケッチのentities)とsketchPlanes(Workerが解決した平面基底)を突き合わせて
  // ビューア描画用のオーバーレイ入力を作る。平面解決に失敗したスケッチ(sketchPlanesに無い)は
  // 描画対象から外れる(エラーは既存のeval-errorで表示される)。
  const sketchOverlays = useMemo<SketchOverlayEntry[]>(() => {
    const planeById = new Map(sketchPlanes.map((p) => [p.sketchId, p]));
    const overlays: SketchOverlayEntry[] = [];
    for (const feature of doc.features) {
      if (feature.type !== "sketch") continue;
      const plane = planeById.get(feature.id);
      if (!plane) continue;
      overlays.push({
        sketchId: feature.id,
        entities: feature.entities,
        origin: plane.origin,
        xDir: plane.xDir,
        yDir: plane.yDir,
        normal: plane.normal,
      });
    }
    return overlays;
  }, [doc, sketchPlanes]);

  // オーバーレイ入力・選択スケッチ・表示トグルが変わるたびにビューアへ反映する。
  useEffect(() => {
    viewerRef.current?.setSketchOverlay(sketchOverlays, selectedFeatureId, showSketches);
  }, [sketchOverlays, selectedFeatureId, showSketches]);

  // 選択中の面が再評価後のfaceInfoに存在しなくなった場合(トポロジカルネーミングのずれ等)は
  // 選択状態をクリアする。
  useEffect(() => {
    if (selectedFace && !faceInfo.some((f) => f.faceId === selectedFace.faceId)) {
      selectFace(null);
    }
  }, [faceInfo, selectedFace, selectFace]);

  // 描画モード中にフィーチャーツリーの選択が別のフィーチャーに移った場合は、描画モードを
  // 自動的にキャンセルする(ビューア側のcancelPolygonDrawing()がonCancelを呼び、
  // drawingModeのReact stateもそこで false に戻る)。
  useEffect(() => {
    if (drawingMode && selectedFeatureId !== drawingSketchId) {
      viewerRef.current?.cancelPolygonDrawing();
    }
  }, [drawingMode, selectedFeatureId, drawingSketchId]);

  const sketches = doc.features.filter((f) => f.type === "sketch");
  const selectedFeature = selectedFeatureId ? findFeature(doc, selectedFeatureId) : undefined;
  // 選択中フィーチャーがスケッチで、かつWorkerが平面基底を解決済みの場合のみ取得できる。
  // (未評価・面解決失敗中はundefinedになり、線描画・平面正対ボタンが無効化される)
  const selectedSketchPlane =
    selectedFeature?.type === "sketch"
      ? sketchPlanes.find((p) => p.sketchId === selectedFeature.id)
      : undefined;

  const busy = status === "initializing" || status === "evaluating";
  // WASM初期化は"evaluate"リクエストの中で行われる(initialize()参照)ため、
  // 初回ロード中は mesh がまだ無い状態で status が "evaluating" になる期間が長く続く。
  // そのためオーバーレイは「初回のmesh取得が完了するまで」を基準に表示する
  // (status==="initializing"のみだと、実際にWASMを読み込んでいる間表示されない)。
  const showInitOverlay = mesh === null && (status === "initializing" || status === "evaluating");

  function handleDelete(featureId: string) {
    const dependentIds = getDependentFeatureIds(doc, featureId);
    if (dependentIds.length > 0) {
      const names = dependentIds
        .map((id) => findFeature(doc, id)?.name ?? id)
        .join(", ");
      const ok = window.confirm(
        `このフィーチャーには依存するフィーチャーがあります: ${names}\n一緒に削除します。よろしいですか?`,
      );
      if (!ok) return;
    }
    removeFeature(featureId);
  }

  function handleAddExtrude() {
    if (sketches.length === 0) return;
    // デフォルトは最後のスケッチ。作成後の編集パネルで変更できる。
    const target = sketches[sketches.length - 1];
    addExtrude(target.id);
  }

  async function handleDownloadStl() {
    try {
      const blob = await exportStl();
      downloadStl(blob, "model.stl");
    } catch {
      // エラーはストアのexportErrorに反映済み。
    }
  }

  function handleAlignToPlane() {
    if (!selectedSketchPlane) return;
    viewerRef.current?.lookAtPlane(selectedSketchPlane);
  }

  function handleStartDrawing() {
    if (!viewerRef.current || !selectedFeature || selectedFeature.type !== "sketch" || !selectedSketchPlane) return;
    const sketchId = selectedFeature.id;
    viewerRef.current.startPolygonDrawing(selectedSketchPlane, gridSnap, selectedFeature.entities, {
      onComplete: (points: [number, number][]) => {
        const entity = createPolygonEntity({ points });
        updateDocument((d) => addSketchEntity(d, sketchId, entity));
        setDrawingMode(false);
        setDrawingSketchId(null);
      },
      onCancel: () => {
        setDrawingMode(false);
        setDrawingSketchId(null);
      },
    });
    setDrawingSketchId(sketchId);
    setDrawingMode(true);
  }

  function handleCancelDrawing() {
    viewerRef.current?.cancelPolygonDrawing();
  }

  function handleGridSnapChange(checked: boolean) {
    setGridSnap(checked);
    viewerRef.current?.setPolygonDrawingSnap(checked);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "sans-serif" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px 16px",
          borderBottom: "1px solid #444",
        }}
      >
        <h1 style={{ fontSize: 16, margin: 0 }}>light-3dcad — Phase 5</h1>
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
          <select
            data-testid="new-sketch-plane-select"
            value={newSketchPlane}
            onChange={(e) => setNewSketchPlane(e.target.value as "XY" | "XZ" | "YZ")}
            title="新規スケッチを作成する基準平面(基準平面クリックと同等)"
          >
            <option value="XY">XY</option>
            <option value="XZ">XZ</option>
            <option value="YZ">YZ</option>
          </select>
        </label>
        <button type="button" data-testid="btn-add-sketch" onClick={() => addSketch(newSketchPlane)}>
          スケッチ追加
        </button>
        <button
          type="button"
          data-testid="btn-add-extrude"
          onClick={handleAddExtrude}
          disabled={sketches.length === 0}
        >
          押し出し追加
        </button>
        <button
          type="button"
          data-testid="btn-add-face-sketch"
          onClick={addFaceSketch}
          disabled={!selectedFace?.isPlanar}
        >
          選択面にスケッチ
        </button>
        <button type="button" data-testid="btn-download-stl" onClick={handleDownloadStl} disabled={busy || exporting}>
          {exporting ? "STL出力中…" : "STLダウンロード"}
        </button>
        <button
          type="button"
          data-testid="btn-fit-view"
          onClick={() => viewerRef.current?.fitToView()}
          title="モデル全体が画面に収まるようにカメラを調整します"
        >
          フィット
        </button>
        <button
          type="button"
          data-testid="btn-align-to-plane"
          onClick={handleAlignToPlane}
          disabled={!selectedSketchPlane}
          title="選択中スケッチの平面に正対する視点へカメラを移動します"
        >
          平面に正対
        </button>
        <button
          type="button"
          data-testid="btn-draw-polygon"
          onClick={drawingMode ? handleCancelDrawing : handleStartDrawing}
          disabled={!drawingMode && !selectedSketchPlane}
          title="クリックで頂点を追加して閉じた多角形を描きます(始点付近クリックまたはEnterで確定、Escでキャンセル)"
        >
          {drawingMode ? "線描画キャンセル(Esc)" : "線描画"}
        </button>
        <label
          style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}
          title="頂点・中心・中点・原点・グリッドへのスナップ、水平/垂直の軸ロックをまとめてON/OFFします(1mmグリッド)"
        >
          <input
            type="checkbox"
            data-testid="toggle-snap"
            checked={gridSnap}
            onChange={(e) => handleGridSnapChange(e.target.checked)}
          />
          スナップ
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
          <input
            type="checkbox"
            data-testid="toggle-sketch-visibility"
            checked={showSketches}
            onChange={(e) => setShowSketches(e.target.checked)}
          />
          スケッチ表示
        </label>
        {drawingMode && (
          <span data-testid="drawing-shift-hint" style={{ fontSize: 11, opacity: 0.7 }}>
            Shift押下中はスナップ・軸ロックを一時無効化(フリー入力)
          </span>
        )}
        <span data-testid="status-text" style={{ fontSize: 12, opacity: 0.8, marginLeft: "auto" }}>
          状態: {status}
          {status === "initializing" && " (WASM初期化中…)"}
          {status === "evaluating" && " (形状計算中…)"}
        </span>
      </header>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <aside
          style={{
            width: 320,
            padding: 16,
            borderRight: "1px solid #444",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            overflowY: "auto",
          }}
        >
          <div>
            <h2 style={{ fontSize: 13, margin: "0 0 8px", opacity: 0.8 }}>フィーチャーツリー</h2>
            <FeatureTree
              doc={doc}
              selectedFeatureId={selectedFeatureId}
              errorFeatureId={errorFeatureId}
              onSelect={selectFeature}
              onDelete={handleDelete}
            />
          </div>

          {selectedFace && (
            <div
              data-testid="selected-face-panel"
              style={{
                borderTop: "1px solid #444",
                paddingTop: 12,
                fontSize: 12,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <strong>選択中の面</strong>
              <span data-testid="selected-face-center">
                中心: {selectedFace.center.map((v) => v.toFixed(2)).join(", ")}
              </span>
              <span data-testid="selected-face-normal">
                法線: {selectedFace.normal.map((v) => v.toFixed(2)).join(", ")}
              </span>
              {!selectedFace.isPlanar && (
                <span style={{ color: "#ff6b6b" }}>
                  この面は平面ではないため、スケッチ平面にできません。
                </span>
              )}
            </div>
          )}

          {errorMessage && (
            <p
              data-testid="eval-error"
              role="alert"
              style={{ color: "#ff6b6b", fontSize: 12, whiteSpace: "pre-wrap", margin: 0 }}
            >
              評価エラー: {errorMessage}
            </p>
          )}
          {exportError && (
            <p
              data-testid="export-error"
              role="alert"
              style={{ color: "#ff6b6b", fontSize: 12, whiteSpace: "pre-wrap", margin: 0 }}
            >
              STL出力エラー: {exportError}
            </p>
          )}

          {selectedFeature && (
            <div style={{ borderTop: "1px solid #444", paddingTop: 12 }}>
              {selectedFeature.type === "sketch" && <SketchEditor sketch={selectedFeature} />}
              {selectedFeature.type === "extrude" && <ExtrudeEditor extrude={selectedFeature} doc={doc} />}
            </div>
          )}

          <p style={{ fontSize: 11, opacity: 0.6, marginTop: "auto" }}>
            フィーチャーをクリックすると編集パネルが表示されます。値を変更すると自動的に再評価されます。
          </p>
        </aside>

        <main style={{ flex: 1, position: "relative" }}>
          <div ref={viewerContainerRef} data-testid="viewer-container" style={{ width: "100%", height: "100%" }} />
          {selectedFeature?.type === "sketch" && selectedSketchPlane && (
            <DimensionOverlay
              sketch={selectedFeature}
              basis={selectedSketchPlane}
              viewerRef={viewerRef}
              visible={showSketches && !drawingMode}
            />
          )}
          {showInitOverlay && (
            <div
              data-testid="init-overlay"
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                background: "rgba(34, 38, 48, 0.85)",
                color: "#fff",
                fontSize: 14,
                pointerEvents: "none",
              }}
            >
              <div
                aria-hidden="true"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "50%",
                  border: "3px solid rgba(255,255,255,0.25)",
                  borderTopColor: "#5b8def",
                  animation: "cad-spin 0.8s linear infinite",
                }}
              />
              <span>CADカーネルを初期化中…(初回は数秒〜数十秒かかります)</span>
            </div>
          )}
          {!showInitOverlay && status === "evaluating" && (
            <div
              data-testid="evaluating-overlay"
              style={{
                position: "absolute",
                top: 12,
                right: 12,
                padding: "6px 12px",
                borderRadius: 4,
                background: "rgba(91, 141, 239, 0.9)",
                color: "#fff",
                fontSize: 12,
                pointerEvents: "none",
              }}
            >
              形状を再計算中…
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
