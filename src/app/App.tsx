import { useEffect, useRef, useState } from "react";

import type { BoxParams, WorkerResponse } from "../protocol/messages";
import { CadViewer } from "../viewer/CadViewer";

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

type Status = "initializing" | "ready" | "evaluating" | "error";

export default function App() {
  const viewerContainerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<CadViewer | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const pendingRequests = useRef(new Map<string, (response: WorkerResponse) => void>());

  const [status, setStatus] = useState<Status>("initializing");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [params, setParams] = useState<BoxParams>({ width: 40, height: 30, distance: 20 });

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

  function sendRequest(request: { kind: "generateBox"; params: BoxParams }) {
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
    const response = await sendRequest({ kind: "generateBox", params });
    if (!response) return;

    if (response.kind === "boxGenerated") {
      viewerRef.current?.setMesh(response.mesh);
      setStatus("ready");
    } else if (response.kind === "error") {
      setStatus("error");
      setErrorMessage(response.message);
    }
  }

  function handleParamChange(key: keyof BoxParams, value: string) {
    const num = Number(value);
    if (Number.isNaN(num)) return;
    setParams((prev) => ({ ...prev, [key]: num }));
  }

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
        <h1 style={{ fontSize: 18, margin: 0 }}>light-3dcad — Phase 0</h1>
        <p style={{ fontSize: 13, opacity: 0.8 }}>
          状態: {status}
          {status === "initializing" && " (WASM初期化中…)"}
          {status === "evaluating" && " (形状計算中…)"}
        </p>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          幅 (mm)
          <input
            type="number"
            value={params.width}
            onChange={(e) => handleParamChange("width", e.target.value)}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          高さ (mm)
          <input
            type="number"
            value={params.height}
            onChange={(e) => handleParamChange("height", e.target.value)}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          押し出し距離 (mm)
          <input
            type="number"
            value={params.distance}
            onChange={(e) => handleParamChange("distance", e.target.value)}
          />
        </label>

        <button onClick={handleGenerate} disabled={status === "initializing" || status === "evaluating"}>
          生成
        </button>

        {errorMessage && (
          <p style={{ color: "#ff6b6b", fontSize: 12, whiteSpace: "pre-wrap" }}>{errorMessage}</p>
        )}
      </aside>

      <main style={{ flex: 1 }}>
        <div ref={viewerContainerRef} style={{ width: "100%", height: "100%" }} />
      </main>
    </div>
  );
}
