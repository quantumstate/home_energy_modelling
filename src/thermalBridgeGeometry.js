// Shared data and geometry helpers for the "Thermal Bridges" cross-section
// editor (ThermalBridgesTab.jsx) and the WebAssembly solver bridge
// (thermalSolver.js). Kept in their own module so both can import it without
// upsetting React Fast Refresh.

// ─── Materials ────────────────────────────────────────────────────────────────
export const MATERIALS = [
  { id: "insulation", name: "Insulation (PIR)", color: "#34d399", lambda: 0.022 },
  { id: "mineral-wool", name: "Mineral wool", color: "#86efac", lambda: 0.037 },
  { id: "blockwork", name: "Blockwork", color: "#fbbf24", lambda: 0.51 },
  { id: "brick", name: "Brick", color: "#f47272", lambda: 0.77 },
  { id: "concrete", name: "Concrete", color: "#9ca3af", lambda: 1.13 },
  { id: "timber", name: "Timber", color: "#c08552", lambda: 0.13 },
  { id: "plasterboard", name: "Plasterboard", color: "#e5e7eb", lambda: 0.25 },
  { id: "render", name: "Render", color: "#d4d4d8", lambda: 0.7 },
  { id: "screed", name: "Screed", color: "#a8a29e", lambda: 0.41 },
  { id: "dpc-cavity", name: "Cavity / DPC", color: "#60a5fa", lambda: 0.025 },
  { id: "steel", name: "Steel", color: "#7dd3fc", lambda: 50 },
];

// ─── Boundary conditions ────────────────────────────────────────────────────
export const CONDITIONS = [
  { id: "inside", name: "Inside", temperature: 21, color: "#f97316" },
  { id: "outside", name: "Outside", temperature: -2, color: "#38bdf8" },
  { id: "adiabatic", name: "Adiabatic", temperature: null, color: "#6b7280" },
  { id: "psi-reference", name: "Ψ reference", temperature: null, color: "#a78bfa" },
];
export const DEFAULT_CONDITION_ID = "adiabatic";

export const SIDES = ["top", "right", "bottom", "left"];
const EDGE_EPS = 0.5; // mm tolerance for detecting shared edges

// Returns the world-space line segment for one side of a shape's rectangle.
export function getEdgeSegment(shape, side) {
  const { x, y, w, h } = shape;
  switch (side) {
    case "top": return { a: { x, y }, b: { x: x + w, y } };
    case "right": return { a: { x: x + w, y }, b: { x: x + w, y: y + h } };
    case "bottom": return { a: { x, y: y + h }, b: { x: x + w, y: y + h } };
    case "left": return { a: { x, y }, b: { x, y: y + h } };
    default: return null;
  }
}

// An edge is "shared" (between two elements) if it is collinear with, and
// overlaps, an edge of another shape. Shared edges may not have a boundary
// condition assigned.
export function isEdgeShared(shapes, shapeId, side) {
  const shape = shapes.find((s) => s.id === shapeId);
  if (!shape) return false;
  const seg = getEdgeSegment(shape, side);
  const horizontal = side === "top" || side === "bottom";
  for (const other of shapes) {
    if (other.id === shapeId) continue;
    for (const oside of SIDES) {
      const oHorizontal = oside === "top" || oside === "bottom";
      if (horizontal !== oHorizontal) continue;
      const oseg = getEdgeSegment(other, oside);
      if (horizontal) {
        if (Math.abs(seg.a.y - oseg.a.y) < EDGE_EPS) {
          const overlap = Math.min(seg.b.x, oseg.b.x) - Math.max(seg.a.x, oseg.a.x);
          if (overlap > EDGE_EPS) return true;
        }
      } else {
        if (Math.abs(seg.a.x - oseg.a.x) < EDGE_EPS) {
          const overlap = Math.min(seg.b.y, oseg.b.y) - Math.max(seg.a.y, oseg.a.y);
          if (overlap > EDGE_EPS) return true;
        }
      }
    }
  }
  return false;
}

export const edgeKey = (shapeId, side) => `${shapeId}:${side}`;

// Removes the range [lo, hi] from an array of non-overlapping [lo, hi] intervals.
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

// Returns the sub-segments of an edge that are NOT collinearly shared with any
// other shape. For a fully internal edge returns []. For a fully exposed edge
// returns the full segment. For a partially-shared edge (e.g. the inner step
// of an L-shape) returns only the exposed intervals as separate segments.
export function getExposedSegments(shapes, shapeId, side) {
  const shape = shapes.find((s) => s.id === shapeId);
  if (!shape) return [];
  const seg = getEdgeSegment(shape, side);
  const horizontal = side === "top" || side === "bottom";

  let intervals = horizontal
    ? [[seg.a.x, seg.b.x]]
    : [[seg.a.y, seg.b.y]];

  for (const other of shapes) {
    if (other.id === shapeId) continue;
    for (const oside of SIDES) {
      const oHorizontal = oside === "top" || oside === "bottom";
      if (horizontal !== oHorizontal) continue;
      const oseg = getEdgeSegment(other, oside);
      if (horizontal) {
        if (Math.abs(seg.a.y - oseg.a.y) < EDGE_EPS) {
          intervals = subtractInterval(intervals, oseg.a.x, oseg.b.x);
        }
      } else {
        if (Math.abs(seg.a.x - oseg.a.x) < EDGE_EPS) {
          intervals = subtractInterval(intervals, oseg.a.y, oseg.b.y);
        }
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

// Computes the linear thermal transmittance (Ψ, W/(m·K)) for the modelled
// junction. For each exposed adiabatic edge the 1D U-value is computed by
// tracing the material layers in series from the outside face to the inside
// face at that cut-plane; the reference length b is the flanking element's
// extent perpendicular to the heat-flow direction.
//
// Returns two values — one derived from the inside boundary heat flux, one
// from the outside — which should converge to the same figure in a well-
// solved model (energy conservation). Any difference indicates residual
// solver error and acts as a built-in sanity check.
export function computePsi(shapes, edgeConditions, solveResult) {
  const { insideU, insideLengthM, outsideU, outsideLengthM } = solveResult;
  const l2dInside  = insideU  * insideLengthM;
  const l2dOutside = outsideU * outsideLengthM;

  // Group psi-reference edges by their geometric line (same orientation + position).
  // Adjacent shapes on the same reference line must produce ONE component, not N,
  // because _u1dAtAdiabatic already collects all shapes at that position.
  const lineGroups = []; // [{ isH, pos, shapes: [{shape, side}] }]
  for (const shape of shapes) {
    for (const side of SIDES) {
      if (getExposedSegments(shapes, shape.id, side).length === 0) continue;
      const condId = edgeConditions[edgeKey(shape.id, side)] ?? DEFAULT_CONDITION_ID;
      if (condId !== "psi-reference") continue;

      const isH = side === "top" || side === "bottom";
      const pos = isH
        ? (side === "top" ? shape.y : shape.y + shape.h)
        : (side === "right" ? shape.x + shape.w : shape.x);

      const existing = lineGroups.find((g) => g.isH === isH && Math.abs(g.pos - pos) < EDGE_EPS);
      if (existing) {
        existing.shapes.push({ shape, side });
      } else {
        lineGroups.push({ isH, pos, shapes: [{ shape, side }] });
      }
    }
  }

  const components = [];
  for (const { isH, shapes: group } of lineGroups) {
    const { shape, side } = group[0];
    const { u1d } = _u1dAtAdiabatic(shapes, shape, side);
    // For merged groups take the largest b — the shape with the greatest
    // perpendicular extent defines the element boundary length.
    const bMm = Math.max(...group.map(({ shape: s }) => isH ? s.h : s.w));
    const b = bMm / 1000;
    const matNames = [...new Set(group.map(({ shape: s }) =>
      MATERIALS.find((m) => m.id === s.materialId)?.name ?? s.materialId
    ))];
    components.push({
      shapeId: shape.id,
      side,
      materialName: matNames.join(" + "),
      u1d,
      b,
      contribution: u1d * b,
    });
  }

  const ref = components.reduce((s, c) => s + c.contribution, 0);
  return {
    psiInside:      l2dInside  - ref,
    psiOutside:     l2dOutside - ref,
    l2dInside,
    l2dOutside,
    referenceTotal: ref,
    components,
  };
}

// Computes the 1D U-value (W/m²K) at a given adiabatic edge and the
// perpendicular span b (mm) of that flanking element.
function _u1dAtAdiabatic(shapes, shape, side) {
  const horizontal = side === "top" || side === "bottom";

  if (horizontal) {
    // Heat flows left→right (x-direction). Cross-section is at this y.
    // Filter is directional: "top" collects shapes from below that reach y;
    // "bottom" collects shapes from above that start at y. This avoids
    // accidentally including shapes on the other side of a shared boundary
    // (e.g. a concrete slab whose bottom coincides with a brick wall's top).
    // "top" = shape.y (visual top, matching getEdgeSegment convention)
    // "bottom" = shape.y + shape.h (visual bottom)
    const y = side === "top" ? shape.y : shape.y + shape.h;
    const column = shapes
      .filter((s) =>
        side === "top"
          ? s.y < y + EDGE_EPS && s.y + s.h > y + EDGE_EPS   // shapes starting at top, going down
          : s.y < y - EDGE_EPS && s.y + s.h > y - EDGE_EPS   // shapes from above reaching bottom
      )
      .sort((a, b) => a.x - b.x);
    const rTot = column.reduce((r, s) => {
      const lam = MATERIALS.find((m) => m.id === s.materialId)?.lambda ?? 1;
      return r + (s.w / 1000) / lam;
    }, 0);
    return { u1d: rTot > 0 ? 1 / rTot : 0, bMm: shape.h };
  } else {
    // Heat flows top→bottom (y-direction). Cross-section is at this x.
    const x = side === "right" ? shape.x + shape.w : shape.x;
    const row = shapes
      .filter((s) =>
        side === "right"
          ? s.x < x - EDGE_EPS && s.x + s.w > x - EDGE_EPS
          : s.x < x + EDGE_EPS && s.x + s.w > x + EDGE_EPS
      )
      .sort((a, b) => a.y - b.y);
    const rTot = row.reduce((r, s) => {
      const lam = MATERIALS.find((m) => m.id === s.materialId)?.lambda ?? 1;
      return r + (s.h / 1000) / lam;
    }, 0);
    return { u1d: rTot > 0 ? 1 / rTot : 0, bMm: shape.w };
  }
}

export function distToSegment(pt, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-10) return Math.hypot(pt.x - a.x, pt.y - a.y);
  const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2));
  return Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy));
}
