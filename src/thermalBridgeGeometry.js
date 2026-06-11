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

export function distToSegment(pt, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-10) return Math.hypot(pt.x - a.x, pt.y - a.y);
  const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2));
  return Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy));
}
