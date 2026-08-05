/// <reference lib="webworker" />

// Replicad(opencascade.js WASM)のimportはこのファイル内に限定する。
// UI側バンドルにOpenCascadeを含めないため。
import initOpenCascadeUntyped from "replicad-opencascadejs/src/replicad_single.js";
import wasmUrl from "replicad-opencascadejs/src/replicad_single.wasm?url";
import { setOC, drawRectangle, type AnyShape } from "replicad";
import type { OpenCascadeInstance } from "replicad-opencascadejs/src/replicad_single.js";

import type { BoxParams, MeshData, UiRequest, WorkerResponse } from "../protocol/messages";

// replicad-opencascadejsのd.tsは引数なしの署名しか宣言していないが、実装(emscripten生成の
// モジュールファクトリ)は `{ locateFile }` などのModuleオーバーライドを受け取れる。
// 実物は node_modules/replicad-opencascadejs/src/replicad_single.js の末尾で
// `function(Module) { Module = Module || {}; ... }` という形のファクトリになっている。
const initOpenCascade = initOpenCascadeUntyped as unknown as (moduleOverrides: {
  locateFile: (path: string) => string;
}) => Promise<OpenCascadeInstance>;

let ocReady: Promise<void> | null = null;

function ensureOC(): Promise<void> {
  if (!ocReady) {
    ocReady = initOpenCascade({ locateFile: () => wasmUrl }).then((OC) => {
      setOC(OC);
    });
  }
  return ocReady;
}

function buildBox(params: BoxParams): AnyShape {
  const { width, height, distance } = params;
  return drawRectangle(width, height).sketchOnPlane("XY").extrude(distance);
}

function toMeshData(shape: AnyShape): MeshData {
  const shapeMesh = shape.mesh({ tolerance: 0.1, angularTolerance: 30 });

  return {
    vertices: Float32Array.from(shapeMesh.vertices),
    normals: Float32Array.from(shapeMesh.normals),
    triangles: Uint32Array.from(shapeMesh.triangles),
    faceGroups: shapeMesh.faceGroups,
  };
}

function postResponse(response: WorkerResponse, transfer: Transferable[] = []) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(response, transfer);
}

self.addEventListener("message", (event: MessageEvent<UiRequest>) => {
  const request = event.data;

  (async () => {
    try {
      switch (request.kind) {
        case "init": {
          await ensureOC();
          postResponse({ kind: "ready", requestId: request.requestId });
          break;
        }
        case "generateBox": {
          await ensureOC();
          const shape = buildBox(request.params);
          const mesh = toMeshData(shape);
          shape.delete();
          postResponse(
            { kind: "boxGenerated", requestId: request.requestId, mesh },
            [mesh.vertices.buffer, mesh.normals.buffer, mesh.triangles.buffer],
          );
          break;
        }
        case "exportStl": {
          await ensureOC();
          const shape = buildBox(request.params);
          const blob = shape.blobSTL({ tolerance: 0.1, angularTolerance: 30 });
          shape.delete();
          postResponse({ kind: "stlReady", requestId: request.requestId, blob });
          break;
        }
      }
    } catch (err) {
      postResponse({
        kind: "error",
        requestId: request.requestId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});
