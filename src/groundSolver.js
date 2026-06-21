// JS bridge to the ground solver Web Worker.
// Spawns one worker per call and resolves a Promise when it finishes.
// For the mesh-preview path, uses the same worker protocol.

import {
  shapesToGroundLayers,
  shapesToGroundEdgeConditions,
  epwToSurfaceSeries,
} from "./groundGeometry.js";
import { getKewEPW } from "./epwParser.js";

let _worker = null;
let _pendingCallbacks = {};
let _nextId = 1;

function getWorker() {
  if (!_worker) {
    _worker = new Worker(
      new URL("./groundSolver.worker.js", import.meta.url),
      { type: "module" }
    );
    _worker.addEventListener("message", (e) => {
      const { type, id, result, error, percent } = e.data;
      const cb = _pendingCallbacks[id];
      if (!cb) return;
      if (type === "progress") {
        cb.onProgress?.(percent);
        return;  // keep callback alive until result arrives
      }
      delete _pendingCallbacks[id];
      if (type === "error") cb.reject(new Error(error));
      else cb.resolve(result);
    });
    _worker.addEventListener("error", (e) => {
      // Reject all pending on unrecoverable worker error.
      for (const id of Object.keys(_pendingCallbacks)) {
        _pendingCallbacks[id].reject(new Error("Worker error: " + e.message));
        delete _pendingCallbacks[id];
      }
      _worker = null;
    });
  }
  return _worker;
}

function send(type, payload, onProgress) {
  const id = _nextId++;
  return new Promise((resolve, reject) => {
    _pendingCallbacks[id] = { resolve, reject, onProgress };
    getWorker().postMessage({ type, id, payload });
  });
}

// Builds a mesh preview from shapes and config (no solve).
export async function runBuildGroundMesh(shapes, config) {
  const layers = shapesToGroundLayers(shapes);
  if (layers.length === 0) return null;
  try {
    return await send("buildMesh", {
      layers,
      config,
      lineXs: [],
      lineYs: [],
    });
  } catch {
    return null;
  }
}

// Runs the full transient ground solve.
// `measureLineVertices`: array of {x, y} world-mm points for the heat-loss line.
// `onUnavailable`: called if WASM not built yet.
export async function runGroundSolve(shapes, edgeConditions, measureLineVertices, config, onProgress) {
  const layers     = shapesToGroundLayers(shapes);
  const conditions = shapesToGroundEdgeConditions(shapes, edgeConditions);

  if (layers.length === 0) return null;

  const epw         = getKewEPW();
  const surfaceTemp = epwToSurfaceSeries(epw.hourly, config.stepsPerYear);

  const lineXs = measureLineVertices.map((v) => v.x);
  const lineYs = measureLineVertices.map((v) => v.y);

  try {
    const result = await send("solve", {
      layers,
      conditions,
      lineXs,
      lineYs,
      config,
      surfaceTemp,
    }, onProgress);
    return result;
  } catch (err) {
    if (err.message && err.message.includes("not available")) return "unavailable";
    throw err;
  }
}
