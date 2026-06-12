// Bridge between the "Thermal Bridges" CAD view and the WebAssembly thermal
// solver built from cpp/thermal_solver.cpp (see cpp/build.sh).
//
// The C++ side does not implement the actual heat-conduction solve yet — see
// cpp/thermal_solver.cpp. This module only wires up geometry conversion and
// module loading so the UI can call into it once the numerics land.

import { MATERIALS, isEdgeShared, edgeKey, DEFAULT_CONDITION_ID } from "./thermalBridgeGeometry.js";

let modulePromise = null;

// Lazily loads the compiled wasm module. Returns null if it hasn't been
// built yet (run `npm run build:wasm`).
function loadModule() {
  if (!modulePromise) {
    modulePromise = import("./wasm/thermal_solver.mjs")
      .then((mod) => mod.default())
      .catch(() => null);
  }
  return modulePromise;
}

const lambdaForMaterial = (materialId) =>
  MATERIALS.find((m) => m.id === materialId)?.lambda ?? 0;

// Converts the editor's shapes into the flat Layer list the solver expects.
function shapesToLayers(shapes) {
  return shapes.map((s) => ({
    x: s.x,
    y: s.y,
    w: s.w,
    h: s.h,
    lambda: lambdaForMaterial(s.materialId),
  }));
}

// Converts the editor's per-edge boundary conditions into the flat
// EdgeCondition list the solver expects, indexed by position in `shapes`.
// Shared edges between elements are skipped, since they cannot carry a
// boundary condition.
function shapesToEdgeConditions(shapes, edgeConditions) {
  const conditions = [];
  shapes.forEach((shape, layerIndex) => {
    for (const side of ["top", "right", "bottom", "left"]) {
      if (isEdgeShared(shapes, shape.id, side)) continue;
      const conditionId = edgeConditions[edgeKey(shape.id, side)] || DEFAULT_CONDITION_ID;
      const temperature = conditionId === "inside" ? 21 : conditionId === "outside" ? -2 : 0;
      conditions.push({ layerIndex, side, type: conditionId, temperature });
    }
  });
  return conditions;
}

// Builds the rectangular FEA mesh for the current cross-section, without
// running a solve. Useful for a debug view of the mesh the solver will use.
//
// Returns { cols, rows, cellSizeMm, originX, originY, nodes, elements }
// where `nodes` is an array of { x, y } (mm) and `elements` is an array of
// { n0, n1, n2, n3, lambda } (node indices + conductivity), or null if the
// wasm module hasn't been built.
export async function runBuildMesh(shapes, cellSizeMm = 5) {
  const module = await loadModule();
  if (!module) return null;

  const layers = new module.LayerVector();
  for (const layer of shapesToLayers(shapes)) layers.push_back(layer);

  try {
    const mesh = module.buildMesh(layers, cellSizeMm);
    const nodes = mesh.nodes.toJs ? mesh.nodes.toJs() : Array.from(mesh.nodes);
    const elements = mesh.elements.toJs ? mesh.elements.toJs() : Array.from(mesh.elements);
    return {
      cols: mesh.cols,
      rows: mesh.rows,
      cellSizeMm: mesh.cellSizeMm,
      originX: mesh.originX,
      originY: mesh.originY,
      nodes: nodes.map((n) => ({ x: n.x, y: n.y })),
      elements: elements.map((e) => ({ n0: e.n0, n1: e.n1, n2: e.n2, n3: e.n3, lambda: e.lambda })),
    };
  } finally {
    layers.delete();
  }
}

// Like runBuildMesh, but also runs the heuristic initial-temperature fill
// (see cpp/initial_temperature.h) and includes `temperature`, `groupId`, and
// `boundaryDistance` for each node. Useful for the debug view.
export async function runBuildMeshWithInitialTemperature(shapes, edgeConditions, cellSizeMm = 5) {
  const module = await loadModule();
  if (!module) return null;

  const layers = new module.LayerVector();
  for (const layer of shapesToLayers(shapes)) layers.push_back(layer);

  const conditions = new module.EdgeConditionVector();
  for (const condition of shapesToEdgeConditions(shapes, edgeConditions)) conditions.push_back(condition);

  try {
    const mesh = module.buildMeshWithInitialTemperature(layers, conditions, cellSizeMm);
    const nodes = mesh.nodes.toJs ? mesh.nodes.toJs() : Array.from(mesh.nodes);
    const elements = mesh.elements.toJs ? mesh.elements.toJs() : Array.from(mesh.elements);
    return {
      cols: mesh.cols,
      rows: mesh.rows,
      cellSizeMm: mesh.cellSizeMm,
      originX: mesh.originX,
      originY: mesh.originY,
      nodes: nodes.map((n) => ({
        x: n.x,
        y: n.y,
        temperature: n.temperature,
        groupId: n.groupId,
        boundaryDistance: n.boundaryDistance,
      })),
      elements: elements.map((e) => ({ n0: e.n0, n1: e.n1, n2: e.n2, n3: e.n3, lambda: e.lambda })),
    };
  } finally {
    layers.delete();
    conditions.delete();
  }
}

// Like runBuildMeshWithInitialTemperature, but also refines the heuristic
// guess toward the steady-state solution (see cpp/steady_state_solver.h).
// Useful for the debug view.
export async function runBuildMeshWithSteadyStateTemperature(shapes, edgeConditions, cellSizeMm = 5) {
  const module = await loadModule();
  if (!module) return null;

  const layers = new module.LayerVector();
  for (const layer of shapesToLayers(shapes)) layers.push_back(layer);

  const conditions = new module.EdgeConditionVector();
  for (const condition of shapesToEdgeConditions(shapes, edgeConditions)) conditions.push_back(condition);

  try {
    const mesh = module.buildMeshWithSteadyStateTemperature(layers, conditions, cellSizeMm);
    const nodes = mesh.nodes.toJs ? mesh.nodes.toJs() : Array.from(mesh.nodes);
    const elements = mesh.elements.toJs ? mesh.elements.toJs() : Array.from(mesh.elements);
    return {
      cols: mesh.cols,
      rows: mesh.rows,
      cellSizeMm: mesh.cellSizeMm,
      originX: mesh.originX,
      originY: mesh.originY,
      nodes: nodes.map((n) => ({
        x: n.x,
        y: n.y,
        temperature: n.temperature,
        groupId: n.groupId,
        boundaryDistance: n.boundaryDistance,
      })),
      elements: elements.map((e) => ({ n0: e.n0, n1: e.n1, n2: e.n2, n3: e.n3, lambda: e.lambda })),
    };
  } finally {
    layers.delete();
    conditions.delete();
  }
}

// Runs the thermal solve for the current cross-section.
//
// `shapes` and `edgeConditions` are the same shapes used by the
// ThermalBridgesTab editor's state.
//
// Returns the solver's ThermalResult ({ cols, rows, cellSizeMm, originX,
// originY, temperatures }), or null if the wasm module hasn't been built.
export async function runThermalSolve(shapes, edgeConditions, cellSizeMm = 5) {
  const module = await loadModule();
  if (!module) return null;

  const layers = new module.LayerVector();
  for (const layer of shapesToLayers(shapes)) layers.push_back(layer);

  const conditions = new module.EdgeConditionVector();
  for (const condition of shapesToEdgeConditions(shapes, edgeConditions)) conditions.push_back(condition);

  try {
    const result = module.solveThermal(layers, conditions, cellSizeMm);
    return {
      cols: result.cols,
      rows: result.rows,
      cellSizeMm: result.cellSizeMm,
      originX: result.originX,
      originY: result.originY,
      temperatures: result.temperatures.toJs ? result.temperatures.toJs() : Array.from(result.temperatures),
      lambda: result.lambda.toJs ? result.lambda.toJs() : Array.from(result.lambda),
      iterations: result.iterations,
      maxResidual: result.maxResidual,
      insideLengthM: result.insideLengthM,
      insideU: result.insideU,
      outsideLengthM: result.outsideLengthM,
      outsideU: result.outsideU,
    };
  } finally {
    layers.delete();
    conditions.delete();
  }
}
