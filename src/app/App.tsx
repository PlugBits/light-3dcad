import { useEffect, useRef, useState } from "react";

import {
  addExtrudeFeature,
  addSketchFeature,
  createEmptyDocument,
  createRectangleEntity,
  findFeature,
  patchExtrudeFeature,
  updateSketchEntity,
  type CadDocument,
  type ExtrudeFeature,
  type SketchFeature,
} from "../model";
import type { WorkerResponse } from "../protocol/messages";
import { CadViewer } from "../viewer/CadViewer";
import { downloadStl } from "../export/downloadStl";

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

type Status = "initializing" | "ready" | "evaluating" | "error";

/** 初期ドキュメント: XYスケッチ(矩形60x40) -> 押し出し20mm(newBody)。 */
function createInitialDocument(): { doc: CadDocument; sketchId: string; entityId: string; extrudeId: string } {
  const empty = createEmptyDocument();
  const rect = createRectangleEntity({ width: 60, height: 40 });
  const { doc: docWithSketch, feature: sketch } = addSketchFeature(empty, {
    name: "Sketch1",
    plane: { kind: "world", plane: "XY" },
    entities: [rect],
  });
  const { doc, feature: extrude } = addExtrudeFeature(docWithSketch, {
    name: "Extrude1",
    sketchId: sketch.id,
    distance: 20,
    direction: 1,
    operation: "newBody",
  });
  return { doc, sketchId: sketch.id, entityId: rect.id, extrudeId: extrude.id };
}

export default function App() {
  const viewerContainerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<CadViewer | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const pendingRequests = useRef(new Map<string, (response: WorkerResponse) => void>());

  const [status, setStatus] = useState<Status>("initializing");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [initial] = useState(createInitialDocument);
  const [doc, setDoc] = useState<CadDocument>(initial.doc);

  const sketch = findFeature(doc, initial.sketchId) as SketchFeature;
  const rectEntity = sketch.entities.find((e) => e.id === initial.entityId);
  const extrude = findFeature(doc, initial.extrudeId) as ExtrudeFeature;

  // Worker初期化(マウント時に一度だけ)
  useEffect(() => {
    const worker = new Worker(new URL("../worker/cad.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const resolver = pendingRequests.current.get(response.requestId);
      if (resolver) {
        pendingRequests.current.delete(response.requestId);
        resolver(response);
      }
    });

    const requestId = nextRequestId();
    pendingRequests.current.set(requestId, (response) => {
      if (response.kind === "ready") {
        setStatus("ready");
      } else if (response.kind === "error") {
        setStatus("error");
        setErrorMessage(response.message);
      }
    });
    worker.postMessage({ kind: "init", requestId });

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

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

  function sendRequest(request: { kind: "evaluate" | "exportStl"; doc: CadDocument }) {
    const worker = workerRef.current;
    if (!worker) return;

    const requestId = nextRequestId();
    return new Promise<WorkerResponse>((resolve) => {
      pendingRequests.current.set(requestId, resolve);
      worker.postMessage({ ...request, requestId });
    });
  }

  async function handleGenerate() {
    setStatus("evaluating");
    setErrorMessage(null);
    const response = await sendRequest({ kind: "evaluate", doc });
    if (!response) return;

    if (response.kind === "evaluated") {
      viewerRef.current?.setMesh(response.mesh);
      setStatus("ready");
    } else if (response.kind === "error") {
      setStatus("error");
      setErrorMessage(response.message);
    }
  }

  async function handleDownloadStl() {
    setErrorMessage(null);
    const response = await sendRequest({ kind: "exportStl", doc });
    if (!response) return;

    if (response.kind === "stl") {
      downloadStl(response.blob, "model.stl");
    } else if (response.kind === "error") {
      setStatus("error");
      setErrorMessage(response.message);
    }
  }

  function handleRectChange(key: "width" | "height", value: string) {
    const num = Number(value);
    if (Number.isNaN(num)) return;
    setDoc((prev) => updateSketchEntity(prev, initial.sketchId, initial.entityId, { [key]: num }));
  }

  function handleDistanceChange(value: string) {
    const num = Number(value);
    if (Number.isNaN(num)) return;
    setDoc((prev) => patchExtrudeFeature(prev, initial.extrudeId, { distance: num }));
  }

  const rectWidth = rectEntity?.kind === "rectangle" ? rectEntity.width : 0;
  const rectHeight = rectEntity?.kind === "rectangle" ? rectEntity.height : 0;

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

        <button onClick={handleGenerate} disabled={status === "initializing" || status === "evaluating"}>
          生成
        </button>
        <button onClick={handleDownloadStl} disabled={status === "initializing" || status === "evaluating"}>
          STLダウンロード
        </button>

        {errorMessage && (
          <p style={{ color: "#ff6b6b", fontSize: 12, whiteSpace: "pre-wrap" }}>{errorMessage}</p>
        )}

        <p style={{ fontSize: 11, opacity: 0.6, marginTop: "auto" }}>
          面をクリックするとブラウザのコンソールにfaceIdが出力されます。
        </p>
      </aside>

      <main style={{ flex: 1 }}>
        <div ref={viewerContainerRef} style={{ width: "100%", height: "100%" }} />
      </main>
    </div>
  );
}
