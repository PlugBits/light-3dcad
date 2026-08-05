import { useEffect, useRef } from "react";

import { ExtrudeEditor } from "../components/ExtrudeEditor";
import { FeatureTree } from "../components/FeatureTree";
import { SketchEditor } from "../components/SketchEditor";
import { downloadStl } from "../export/downloadStl";
import { findFeature, getDependentFeatureIds } from "../model/document";
import { useCadStore } from "../state/store";
import { CadViewer } from "../viewer/CadViewer";

export default function App() {
  const viewerContainerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<CadViewer | null>(null);

  const doc = useCadStore((s) => s.doc);
  const status = useCadStore((s) => s.status);
  const mesh = useCadStore((s) => s.mesh);
  const faceInfo = useCadStore((s) => s.faceInfo);
  const errorMessage = useCadStore((s) => s.errorMessage);
  const errorFeatureId = useCadStore((s) => s.errorFeatureId);
  const selectedFeatureId = useCadStore((s) => s.selectedFeatureId);
  const selectedFace = useCadStore((s) => s.selectedFace);
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

  // Workerを起動し、初期ドキュメントの評価を1回だけ要求する。
  useEffect(() => {
    initialize();
  }, [initialize]);

  // Three.jsビューア初期化(マウント時に一度だけ)。
  // 面クリック時のコールバックはストアの最新スナップショットを直接参照する
  // (依存配列は空のまま=マウント時に一度だけ生成するビューアに対して安定した参照を渡す)。
  useEffect(() => {
    if (!viewerContainerRef.current) return;
    const viewer = new CadViewer(viewerContainerRef.current, (face) => {
      useCadStore.getState().selectFace(face);
    });
    viewerRef.current = viewer;
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  // ストアのmesh/faceInfoが更新されるたびにビューアへ反映する。
  useEffect(() => {
    if (mesh) {
      viewerRef.current?.setMesh(mesh, faceInfo);
    }
  }, [mesh, faceInfo]);

  // 選択中の面が再評価後のfaceInfoに存在しなくなった場合(トポロジカルネーミングのずれ等)は
  // 選択状態をクリアする。
  useEffect(() => {
    if (selectedFace && !faceInfo.some((f) => f.faceId === selectedFace.faceId)) {
      selectFace(null);
    }
  }, [faceInfo, selectedFace, selectFace]);

  const sketches = doc.features.filter((f) => f.type === "sketch");
  const selectedFeature = selectedFeatureId ? findFeature(doc, selectedFeatureId) : undefined;

  const busy = status === "initializing" || status === "evaluating";

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
        <button type="button" data-testid="btn-add-sketch" onClick={addSketch}>
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
          {status === "initializing" && (
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
          {status === "evaluating" && (
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
