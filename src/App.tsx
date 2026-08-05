import { useEffect, useRef, useState } from "react";

import type { WorkerResponse } from "./protocol/messages";

type Status = "initializing" | "ready" | "error";

export default function App() {
  const workerRef = useRef<Worker | null>(null);
  const [status, setStatus] = useState<Status>("initializing");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL("./worker/cad.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response.kind === "ready") {
        setStatus("ready");
      } else if (response.kind === "error") {
        setStatus("error");
        setErrorMessage(response.message);
      }
    });

    worker.postMessage({ kind: "init", requestId: "init-1" });

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif" }}>
      <h1>light-3dcad — Phase 0</h1>
      <p>Worker(Replicad/OpenCascade)状態: {status}</p>
      {errorMessage && <p style={{ color: "red" }}>{errorMessage}</p>}
    </div>
  );
}
