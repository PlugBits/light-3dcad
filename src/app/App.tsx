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
  const errorMessage = useCadStore((s) => s.errorMessage);
  const errorFeatureId = useCadStore((s) => s.errorFeatureId);
  const selectedFeatureId = useCadStore((s) => s.selectedFeatureId);
  const exporting = useCadStore((s) => s.exporting);
  const exportError = useCadStore((s) => s.exportError);
  const initialize = useCadStore((s) => s.initialize);
  const selectFeature = useCadStore((s) => s.selectFeature);
  const addSketch = useCadStore((s) => s.addSketch);
  const addExtrude = useCadStore((s) => s.addExtrude);
  const removeFeature = useCadStore((s) => s.removeFeature);
  const exportStl = useCadStore((s) => s.exportStl);

  // Workerを起動し、初期ドキュメントの評価を1回だけ要求する。
  useEffect(() => {
    initialize();
  }, [initialize]);

  // Three.jsビューア初期化(マウント時に一度だけ)
  useEffect(() => {
    if (!viewerContainerRef.current) return;
    const viewer = new CadViewer(viewerContainerRef.current);
    viewerRef.current = viewer;
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  // ストアのmeshが更新されるたびにビューアへ反映する。
  useEffect(() => {
    if (mesh) {
      viewerRef.current?.setMesh(mesh);
    }
  }, [mesh]);

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
        <h1 style={{ fontSize: 16, margin: 0 }}>light-3dcad — Phase 2</h1>
        <button type="button" onClick={addSketch}>
          スケッチ追加
        </button>
        <button type="button" onClick={handleAddExtrude} disabled={sketches.length === 0}>
          押し出し追加
        </button>
        <button type="button" onClick={handleDownloadStl} disabled={busy || exporting}>
          {exporting ? "STL出力中…" : "STLダウンロード"}
        </button>
        <span style={{ fontSize: 12, opacity: 0.8, marginLeft: "auto" }}>
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

          {errorMessage && (
            <p style={{ color: "#ff6b6b", fontSize: 12, whiteSpace: "pre-wrap", margin: 0 }}>
              評価エラー: {errorMessage}
            </p>
          )}
          {exportError && (
            <p style={{ color: "#ff6b6b", fontSize: 12, whiteSpace: "pre-wrap", margin: 0 }}>
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

        <main style={{ flex: 1 }}>
          <div ref={viewerContainerRef} style={{ width: "100%", height: "100%" }} />
        </main>
      </div>
    </div>
  );
}
