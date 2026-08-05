import { useEffect, useRef, useState } from "react";

import { findFeature, patchExtrudeFeature, updateSketchEntity } from "../model/document";
import type { ExtrudeFeature, SketchFeature } from "../model/types";
import { useCadStore } from "../state/store";
import { CadViewer } from "../viewer/CadViewer";
import { downloadStl } from "../export/downloadStl";

export default function App() {
  const viewerContainerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<CadViewer | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const doc = useCadStore((s) => s.doc);
  const status = useCadStore((s) => s.status);
  const mesh = useCadStore((s) => s.mesh);
  const errorMessage = useCadStore((s) => s.errorMessage);
  const initialSketchId = useCadStore((s) => s.initialSketchId);
  const initialEntityId = useCadStore((s) => s.initialEntityId);
  const initialExtrudeId = useCadStore((s) => s.initialExtrudeId);
  const initialize = useCadStore((s) => s.initialize);
  const updateDocument = useCadStore((s) => s.updateDocument);
  const exportStl = useCadStore((s) => s.exportStl);

  const sketch = findFeature(doc, initialSketchId) as SketchFeature;
  const rectEntity = sketch.entities.find((e) => e.id === initialEntityId);
  const extrude = findFeature(doc, initialExtrudeId) as ExtrudeFeature;

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

  function handleRectChange(key: "width" | "height", value: string) {
    const num = Number(value);
    if (Number.isNaN(num) || num <= 0) return;
    updateDocument((prev) => updateSketchEntity(prev, initialSketchId, initialEntityId, { [key]: num }));
  }

  function handleDistanceChange(value: string) {
    const num = Number(value);
    if (Number.isNaN(num) || num <= 0) return;
    updateDocument((prev) => patchExtrudeFeature(prev, initialExtrudeId, { distance: num }));
  }

  async function handleDownloadStl() {
    setExportError(null);
    setExporting(true);
    try {
      const blob = await exportStl();
      downloadStl(blob, "model.stl");
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  const rectWidth = rectEntity?.kind === "rectangle" ? rectEntity.width : 0;
  const rectHeight = rectEntity?.kind === "rectangle" ? rectEntity.height : 0;
  const busy = status === "initializing" || status === "evaluating" || exporting;

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "sans-serif" }}>
      <aside
        style={{
          width: 280,
          padding: 16,
          borderRight: "1px solid #444",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <h1 style={{ fontSize: 18, margin: 0 }}>light-3dcad — Phase 1</h1>
        <p style={{ fontSize: 13, opacity: 0.8 }}>
          状態: {status}
          {status === "initializing" && " (WASM初期化中…)"}
          {status === "evaluating" && " (形状計算中…)"}
        </p>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          幅 (mm)
          <input
            type="number"
            value={rectWidth}
            onChange={(e) => handleRectChange("width", e.target.value)}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          高さ (mm)
          <input
            type="number"
            value={rectHeight}
            onChange={(e) => handleRectChange("height", e.target.value)}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          押し出し距離 (mm)
          <input
            type="number"
            value={extrude.distance}
            onChange={(e) => handleDistanceChange(e.target.value)}
          />
        </label>

        <button onClick={handleDownloadStl} disabled={busy}>
          STLダウンロード
        </button>

        {errorMessage && (
          <p style={{ color: "#ff6b6b", fontSize: 12, whiteSpace: "pre-wrap" }}>{errorMessage}</p>
        )}
        {exportError && (
          <p style={{ color: "#ff6b6b", fontSize: 12, whiteSpace: "pre-wrap" }}>
            STL出力エラー: {exportError}
          </p>
        )}

        <p style={{ fontSize: 11, opacity: 0.6, marginTop: "auto" }}>
          寸法を変更すると自動的に再評価されます。面をクリックするとブラウザのコンソールにfaceIdが出力されます。
        </p>
      </aside>

      <main style={{ flex: 1 }}>
        <div ref={viewerContainerRef} style={{ width: "100%", height: "100%" }} />
      </main>
    </div>
  );
}
