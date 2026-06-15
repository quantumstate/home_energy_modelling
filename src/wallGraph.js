// ─── Wall graph utilities ───────────────────────────────────────────────────
// Pure geometry helpers for deriving enclosed "areas" (rooms) from a set of
// wall segments, Rayon-Design style. No React dependencies.

const vKey = (p, tol) => `${Math.round(p.x / tol)},${Math.round(p.y / tol)}`;

/**
 * Snap wall endpoints into shared vertex ids (within `tol` metres).
 * Returns { vertices: [{id,x,y}], edges: [{wall, a, b}] } where `a`/`b` are
 * vertex objects (shared between walls whose endpoints coincide).
 */
export function mergeVertices(walls, tol = 0.05) {
  const verts = new Map();
  let idCounter = 0;
  const getVertex = (p) => {
    const k = vKey(p, tol);
    if (!verts.has(k)) verts.set(k, { id: idCounter++, x: p.x, y: p.y });
    return verts.get(k);
  };
  const edges = walls.map((w) => ({ wall: w, a: getVertex(w.a), b: getVertex(w.b) }));
  return { vertices: [...verts.values()], edges };
}

/**
 * Split edges at "T-junctions" — vertices that land on the interior of
 * another wall's segment (e.g. a partition wall drawn from one wall to the
 * middle of the opposite wall). Each affected edge is broken into a chain of
 * sub-edges through the intersecting vertices, all referencing the original
 * wall, so the resulting graph has a proper vertex at every junction.
 */
function splitAtTJunctions(vertices, edges, tol) {
  const result = [];
  for (const e of edges) {
    const { a, b } = e;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) { result.push(e); continue; }
    const onEdge = [];
    for (const v of vertices) {
      if (v.id === a.id || v.id === b.id) continue;
      const t = ((v.x - a.x) * dx + (v.y - a.y) * dy) / len2;
      if (t <= 0 || t >= 1) continue;
      const projx = a.x + t * dx, projy = a.y + t * dy;
      const d = Math.hypot(v.x - projx, v.y - projy);
      if (d < tol) onEdge.push({ v, t });
    }
    if (onEdge.length === 0) { result.push(e); continue; }
    onEdge.sort((p, q) => p.t - q.t);
    let prev = a;
    for (const { v } of onEdge) {
      result.push({ wall: e.wall, a: prev, b: v });
      prev = v;
    }
    result.push({ wall: e.wall, a: prev, b });
  }
  return result;
}

/**
 * Find enclosed areas formed by a set of wall segments via planar
 * straight-line-graph face tracing.
 *
 * Returns one entry per bounded face: { wallIds, points }, where
 * `points[i]` -> `points[i+1]` is the edge formed by `wallIds[i]`.
 */
export function findClosedAreas(walls, tol = 0.05) {
  const { vertices, edges } = mergeVertices(walls, tol);
  const splitEdges = splitAtTJunctions(vertices, edges, tol);
  const validEdges = splitEdges.filter((e) => e.a.id !== e.b.id);
  if (validEdges.length === 0) return [];

  // Build half-edge adjacency lists per vertex, sorted by outgoing angle.
  const adj = new Map();
  const addHalf = (from, to, edge) => {
    if (!adj.has(from.id)) adj.set(from.id, []);
    adj.get(from.id).push({ from, to, edge });
  };
  for (const e of validEdges) {
    addHalf(e.a, e.b, e);
    addHalf(e.b, e.a, e);
  }
  for (const halfs of adj.values()) {
    halfs.sort((h1, h2) => {
      const a1 = Math.atan2(h1.to.y - h1.from.y, h1.to.x - h1.from.x);
      const a2 = Math.atan2(h2.to.y - h2.from.y, h2.to.x - h2.from.x);
      return a1 - a2;
    });
  }

  const visited = new Set();
  const faces = [];

  for (const e of validEdges) {
    for (const [start, end] of [[e.a, e.b], [e.b, e.a]]) {
      const startKey = `${start.id}->${end.id}`;
      if (visited.has(startKey)) continue;

      const faceHalfEdges = [];
      let curFrom = start, curTo = end, curEdge = e;
      let safety = 0;
      while (true) {
        const k = `${curFrom.id}->${curTo.id}`;
        if (visited.has(k)) break;
        visited.add(k);
        faceHalfEdges.push({ from: curFrom, to: curTo, edge: curEdge });

        const halfs = adj.get(curTo.id);
        let idx = halfs.findIndex((h) => h.to.id === curFrom.id && h.edge === curEdge);
        if (idx === -1) idx = halfs.findIndex((h) => h.to.id === curFrom.id);
        const next = halfs[(idx - 1 + halfs.length) % halfs.length];

        if (curTo.id === start.id && next.to.id === end.id && next.edge === e) break;

        curFrom = next.from; curTo = next.to; curEdge = next.edge;
        if (++safety > validEdges.length * 2 + 10) break;
      }

      if (faceHalfEdges.length >= 3) {
        const points = faceHalfEdges.map((h) => ({ x: h.from.x, y: h.from.y }));
        let signedArea = 0;
        for (let i = 0; i < points.length; i++) {
          const p = points[i], q = points[(i + 1) % points.length];
          signedArea += p.x * q.y - q.x * p.y;
        }
        signedArea /= 2;
        if (signedArea > 1e-6) {
          faces.push({ wallIds: faceHalfEdges.map((h) => h.edge.wall.id), points });
        }
      }
    }
  }

  return faces;
}

/** True if the storey has no walls, or its walls enclose at least one area. */
export function hasClosedBoundary(walls, tol = 0.05) {
  return walls.length === 0 || findClosedAreas(walls, tol).length > 0;
}
