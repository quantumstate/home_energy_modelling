// Shared data and geometry helpers for the Ground tab and ground WASM solver.

// ── Materials ─────────────────────────────────────────────────────────────
// Each material has lambda (W/m·K), density (kg/m³), and specificHeat (J/kg·K).
// rhoC = density * specificHeat (J/m³·K) is computed when sending to the solver.
export const GROUND_MATERIALS = [
  { id: "ground",       name: "Ground (soil)",    color: "#92400e", lambda: 1.5,  density: 1900, specificHeat: 1000 },
  { id: "concrete",     name: "Concrete slab",    color: "#9ca3af", lambda: 1.13, density: 2300, specificHeat: 880  },
  { id: "insulation",   name: "Insulation (PIR)", color: "#34d399", lambda: 0.022,density: 30,   specificHeat: 1400 },
  { id: "mineral-wool", name: "Mineral wool",     color: "#86efac", lambda: 0.037,density: 30,   specificHeat: 1000 },
  { id: "blockwork",    name: "Blockwork",        color: "#fbbf24", lambda: 0.51, density: 1400, specificHeat: 840  },
  { id: "brick",        name: "Brick",            color: "#f47272", lambda: 0.77, density: 1700, specificHeat: 800  },
  { id: "timber",       name: "Timber",           color: "#c08552", lambda: 0.13, density: 500,  specificHeat: 1600 },
  { id: "screed",       name: "Screed",           color: "#a8a29e", lambda: 0.41, density: 1200, specificHeat: 840  },
];

export function getRhoC(materialId) {
  const m = GROUND_MATERIALS.find((m) => m.id === materialId);
  if (!m) return 1.9e6;
  return m.density * m.specificHeat;
}

export function getLambda(materialId) {
  return GROUND_MATERIALS.find((m) => m.id === materialId)?.lambda ?? 1.0;
}

// ── Boundary conditions ───────────────────────────────────────────────────
export const GROUND_CONDITIONS = [
  { id: "inside",    name: "Inside",  color: "#f97316", description: "Fixed indoor temperature" },
  { id: "surface",   name: "Surface", color: "#38bdf8", description: "EPW exterior air temperature" },
  { id: "adiabatic", name: "Adiabat", color: "#6b7280", description: "Zero flux (symmetry / far field)" },
];
export const DEFAULT_GROUND_CONDITION_ID = "adiabatic";

// ── Default solver configuration ──────────────────────────────────────────
export const DEFAULT_GROUND_CONFIG = {
  nearCellMm:        50,    // mm
  growthRatio:       1.2,
  maxCellMm:         500,   // mm
  domainDepthM:      15,    // m
  domainHalfWidthM:  15,    // m
  dtSeconds:         3600,  // 1 hour
  indoorTemp:        21,    // °C
  stepsPerYear:      8760,  // hourly
  spinupYears:       3,
};

// ── Geometry helpers ──────────────────────────────────────────────────────
export const SIDES = ["top", "right", "bottom", "left"];
const EDGE_EPS = 0.5;  // mm

export function getEdgeSegment(shape, side) {
  const { x, y, w, h } = shape;
  switch (side) {
    case "top":    return { a: { x, y },         b: { x: x + w, y       } };
    case "right":  return { a: { x: x + w, y },  b: { x: x + w, y: y+h } };
    case "bottom": return { a: { x, y: y + h },  b: { x: x + w, y: y+h } };
    case "left":   return { a: { x, y },          b: { x,        y: y+h } };
    default:       return null;
  }
}

export const edgeKey = (shapeId, side) => `${shapeId}:${side}`;

function subtractInterval(intervals, lo, hi) {
  const result = [];
  for (const [a, b] of intervals) {
    const overlapLo = Math.max(a, lo);
    const overlapHi = Math.min(b, hi);
    if (overlapHi <= overlapLo + EDGE_EPS) {
      result.push([a, b]);
    } else {
      if (a < overlapLo - EDGE_EPS) result.push([a, overlapLo]);
      if (overlapHi < b - EDGE_EPS) result.push([overlapHi, b]);
    }
  }
  return result;
}

// Returns the sub-segments of an edge that are not shared with another shape.
export function getExposedSegments(shapes, shapeId, side) {
  const shape = shapes.find((s) => s.id === shapeId);
  if (!shape) return [];
  const seg = getEdgeSegment(shape, side);
  const horizontal = side === "top" || side === "bottom";

  let intervals = horizontal ? [[seg.a.x, seg.b.x]] : [[seg.a.y, seg.b.y]];

  for (const other of shapes) {
    if (other.id === shapeId) continue;
    for (const oside of SIDES) {
      const oHorizontal = oside === "top" || oside === "bottom";
      if (horizontal !== oHorizontal) continue;
      const oseg = getEdgeSegment(other, oside);
      if (horizontal) {
        if (Math.abs(seg.a.y - oseg.a.y) < EDGE_EPS)
          intervals = subtractInterval(intervals, oseg.a.x, oseg.b.x);
      } else {
        if (Math.abs(seg.a.x - oseg.a.x) < EDGE_EPS)
          intervals = subtractInterval(intervals, oseg.a.y, oseg.b.y);
      }
    }
  }

  if (horizontal) {
    const y = seg.a.y;
    return intervals.map(([lo, hi]) => ({ a: { x: lo, y }, b: { x: hi, y } }));
  } else {
    const x = seg.a.x;
    return intervals.map(([lo, hi]) => ({ a: { x, y: lo }, b: { x, y: hi } }));
  }
}

export function distToSegment(pt, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-10) return Math.hypot(pt.x - a.x, pt.y - a.y);
  const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2));
  return Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy));
}

// Distance from point to the nearest segment of a polyline.
export function distToPolyline(pt, vertices) {
  let best = Infinity;
  for (let i = 0; i + 1 < vertices.length; i++)
    best = Math.min(best, distToSegment(pt, vertices[i], vertices[i + 1]));
  return best;
}

// ── EPW surface temperature series ────────────────────────────────────────

// Converts EPW hourly records into a flat array of stepsPerYear temperatures.
// For hourly (stepsPerYear = 8760): direct passthrough of dryBulb.
// For daily (stepsPerYear = 365): daily means.
export function epwToSurfaceSeries(hourly, stepsPerYear) {
  if (stepsPerYear === 8760 || stepsPerYear === 8784) {
    return hourly.map((h) => h.dryBulb);
  }
  // Daily aggregation.
  if (stepsPerYear === 365 || stepsPerYear === 366) {
    const days = [];
    for (let d = 0; d < stepsPerYear; d++) {
      const slice = hourly.slice(d * 24, d * 24 + 24);
      const mean = slice.reduce((s, h) => s + h.dryBulb, 0) / Math.max(1, slice.length);
      days.push(mean);
    }
    return days;
  }
  // 6-hourly.
  if (stepsPerYear === 1460) {
    const result = [];
    for (let s = 0; s < 1460; s++) {
      const slice = hourly.slice(s * 6, s * 6 + 6);
      const mean = slice.reduce((s, h) => s + h.dryBulb, 0) / Math.max(1, slice.length);
      result.push(mean);
    }
    return result;
  }
  // Fallback: interpolate.
  return Array.from({ length: stepsPerYear }, (_, i) => {
    const t = (i / stepsPerYear) * hourly.length;
    const idx = Math.min(Math.floor(t), hourly.length - 1);
    return hourly[idx].dryBulb;
  });
}

// ── Shape → solver conversion ─────────────────────────────────────────────

// Converts editor shapes to GroundLayer objects for the solver.
// The ground box (isGround: true) gets priority 0; building shapes get priority 1.
export function shapesToGroundLayers(shapes) {
  return shapes.map((s) => ({
    x:        s.x,
    y:        s.y,
    w:        s.w,
    h:        s.h,
    lambda:   getLambda(s.materialId),
    rhoC:     getRhoC(s.materialId),
    priority: s.isGround ? 0 : 1,
  }));
}

// Converts editor edge conditions to the solver's GroundEdgeCondition list.
export function shapesToGroundEdgeConditions(shapes, edgeConditions) {
  const conditions = [];
  shapes.forEach((shape, layerIndex) => {
    for (const side of SIDES) {
      if (getExposedSegments(shapes, shape.id, side).length === 0) continue;
      const condId = edgeConditions[edgeKey(shape.id, side)] || DEFAULT_GROUND_CONDITION_ID;
      conditions.push({ layerIndex, side, type: condId, temperature: 0 });
    }
  });
  return conditions;
}
