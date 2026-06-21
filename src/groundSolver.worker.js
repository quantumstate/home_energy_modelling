// Web Worker for the ground slab transient solver.
// Receives a "solve" or "buildMesh" message with all inputs,
// runs the WASM module, and posts the result back.

let modulePromise = null;

function loadModule() {
  if (!modulePromise) {
    modulePromise = import(/* @vite-ignore */ "./wasm/ground_solver.mjs")
      .then((mod) => mod.default())
      .catch((err) => {
        console.error("Failed to load ground solver WASM:", err);
        return null;
      });
  }
  return modulePromise;
}

function toDoubleVector(module, arr) {
  const v = new module.DoubleVector();
  for (const x of arr) v.push_back(x);
  return v;
}

function toLayerVector(module, layers) {
  const v = new module.GroundLayerVector();
  for (const l of layers) v.push_back(l);
  return v;
}

function toConditionVector(module, conds) {
  const v = new module.GroundEdgeConditionVector();
  for (const c of conds) v.push_back(c);
  return v;
}

self.addEventListener("message", async (e) => {
  const { type, id, payload } = e.data;
  const module = await loadModule();

  if (!module) {
    self.postMessage({ type: "error", id, error: "WASM module not available. Run npm run build:wasm:ground:win" });
    return;
  }

  try {
    if (type === "buildMesh") {
      const { layers, config, lineXs, lineYs } = payload;
      const layerVec = toLayerVector(module, layers);
      const lineXVec = toDoubleVector(module, lineXs);
      const lineYVec = toDoubleVector(module, lineYs);
      const line = { xs: lineXVec, ys: lineYVec };

      const meshResult = module.buildGroundMeshDebug(layerVec, config, line);

      const result = {
        cols:    meshResult.cols,
        rows:    meshResult.rows,
        originX: meshResult.originX,
        originY: meshResult.originY,
        nodeXs:  Array.from(meshResult.nodeXs),
        nodeYs:  Array.from(meshResult.nodeYs),
        lambda:  Array.from(meshResult.lambda),
      };

      layerVec.delete();
      lineXVec.delete();
      lineYVec.delete();

      self.postMessage({ type: "meshResult", id, result });

    } else if (type === "solve") {
      const { layers, conditions, lineXs, lineYs, config, surfaceTemp } = payload;

      const layerVec     = toLayerVector(module, layers);
      const condVec      = toConditionVector(module, conditions);
      const lineXVec     = toDoubleVector(module, lineXs);
      const lineYVec     = toDoubleVector(module, lineYs);
      const surfTempVec  = toDoubleVector(module, surfaceTemp);
      const line         = { xs: lineXVec, ys: lineYVec };

      let raw;
      if (typeof module.solveGroundWithProgress === "function") {
        const progressFn = (pct) => self.postMessage({ type: "progress", id, percent: pct });
        raw = module.solveGroundWithProgress(layerVec, condVec, line, config, surfTempVec, progressFn);
      } else {
        raw = module.solveGround(layerVec, condVec, line, config, surfTempVec);
      }

      const result = {
        cols:                 raw.cols,
        rows:                 raw.rows,
        originX:              raw.originX,
        originY:              raw.originY,
        nodeXs:               Array.from(raw.nodeXs),
        nodeYs:               Array.from(raw.nodeYs),
        lambda:               Array.from(raw.lambda),
        weeklyTemps:          Array.from(raw.weeklyTemps),
        monthlyHeatLossKwh:   Array.from(raw.monthlyHeatLossKwh),
        totalSteps:           raw.totalSteps,
        periodicityResidual:  raw.periodicityResidual,
      };

      layerVec.delete();
      condVec.delete();
      lineXVec.delete();
      lineYVec.delete();
      surfTempVec.delete();

      self.postMessage({ type: "solveResult", id, result });
    }
  } catch (err) {
    self.postMessage({ type: "error", id, error: String(err) });
  }
});
