/**
 * roofGeometry.js
 *
 * Canonical roof geometry functions shared by FloorPlanUI, ThreeDView, and
 * SolarTab.  All coordinates are in METRES (the same units used to store
 * roof.points – the SVG scale(zoom*PPM) transform is NOT baked in here).
 *
 * Exports
 * -------
 *   offsetPolygon(points, distance)           – outward (positive) or inward offset
 *   isInsidePoly(px, py, pts)                 – ray-casting point-in-polygon test
 *   distSqToSeg(px,py, ax,ay, bx,by)         – squared distance to LINE SEGMENT
 *   computeRoofLines(points, edgeTypes)       – straight skeleton → [{x1,y1,x2,y2}]
 *   computeRoofPlanePolygon(pts, edgeIdx, edgeTypes)
 *                                             – Voronoi region polygon for one plane
 *   computeRoofPlaneAreas(points, edgeTypes, overhang, pitch)
 *                                             – { [edgeIdx]: { projected, slope } }
 */

// ─── Basic geometry helpers ───────────────────────────────────────────────────

/**
 * Offset a polygon outward (positive distance) or inward (negative) using the
 * angular bisector formula.  Returns a new array of {x,y} points.
 */
export function offsetPolygon(points, distance) {
  const n = points.length;
  if (n < 3 || Math.abs(distance) < 1e-10) return points;
  const cen = {
    x: points.reduce((s, p) => s + p.x, 0) / n,
    y: points.reduce((s, p) => s + p.y, 0) / n,
  };
  const outNorm = (a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-10) return { x: 0, y: 0 };
    let nx = dy / len, ny = -dx / len;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if ((cen.x - mx) * nx + (cen.y - my) * ny > 0) { nx = -nx; ny = -ny; }
    return { x: nx, y: ny };
  };
  const norms = points.map((p, i) => outNorm(p, points[(i + 1) % n]));
  return points.map((p, i) => {
    const n1 = norms[(i - 1 + n) % n], n2 = norms[i];
    const denom = 1 + n1.x * n2.x + n1.y * n2.y;
    if (Math.abs(denom) < 1e-10) return { x: p.x + n2.x * distance, y: p.y + n2.y * distance };
    return { x: p.x + (n1.x + n2.x) / denom * distance, y: p.y + (n1.y + n2.y) / denom * distance };
  });
}

/** Ray-casting point-in-polygon test. */
export function isInsidePoly(px, py, pts) {
  let inside = false;
  const n = pts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > py) !== (yj > py)) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Squared distance from point (px,py) to line SEGMENT (ax,ay)–(bx,by). */
export function distSqToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  if (len2 < 1e-10) return (px - ax) ** 2 + (py - ay) ** 2;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
}

/**
 * Squared perpendicular distance from point (px,py) to the INFINITE LINE
 * through (ax,ay)–(bx,by).  Used for Voronoi bisectors.
 */
function lineDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  if (len2 < 1e-10) return (px - ax) ** 2 + (py - ay) ** 2;
  const d = (px - ax) * dy - (py - ay) * dx; // signed area × |AB|
  return d * d / len2;
}

// ─── Straight skeleton ────────────────────────────────────────────────────────

/**
 * Compute the straight skeleton of a polygon given its edge types.
 * Returns an array of ridge/hip line segments [{x1,y1,x2,y2}].
 * Only segments whose two flanking edges are both "bottom" are returned.
 *
 * @param {Array<{x,y}>} points   – polygon vertices in metres
 * @param {string[]}     edgeTypes – 'bottom' | 'gable' for each edge
 * @returns {Array<{x1,y1,x2,y2}>}
 */
export function computeRoofLines(points, edgeTypes) {
  const n = points.length;
  if (n < 3) return [];

  const inwardNormal = (a, b, cen) => {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-10) return { x: 0, y: 0 };
    let nx = -dy / len, ny = dx / len;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if ((cen.x - mx) * nx + (cen.y - my) * ny < 0) { nx = -nx; ny = -ny; }
    return { x: nx, y: ny };
  };

  let verts  = points.map(p => ({ ...p }));
  let active = edgeTypes.map(e => e === 'bottom');
  const segments = [];

  for (let iter = 0; iter < 200; iter++) {
    const m = verts.length;
    if (m < 3) {
      if (m === 2 && active.some(a => a)) {
        const dx = verts[1].x - verts[0].x, dy = verts[1].y - verts[0].y;
        if (dx * dx + dy * dy > 1e-6)
          segments.push({ x1: verts[0].x, y1: verts[0].y, x2: verts[1].x, y2: verts[1].y });
      }
      break;
    }
    if (!active.some(a => a)) break;

    const cen = { x: verts.reduce((s, v) => s + v.x, 0) / m, y: verts.reduce((s, v) => s + v.y, 0) / m };
    const norms = verts.map((v, i) => inwardNormal(v, verts[(i + 1) % m], cen));

    const bisect = (i) => {
      const pe = (i - 1 + m) % m;
      const pa = active[pe], ca = active[i];
      if (!pa && !ca) return { x: 0, y: 0 };
      const np = norms[pe], nc = norms[i];
      if (pa && ca) {
        const d = 1 + np.x * nc.x + np.y * nc.y;
        return Math.abs(d) < 1e-10 ? { x: 0, y: 0 } : { x: (np.x + nc.x) / d, y: (np.y + nc.y) / d };
      }
      const ie = pa ? i : pe;
      const a = verts[ie], b = verts[(ie + 1) % m];
      const edx = b.x - a.x, edy = b.y - a.y, el = Math.sqrt(edx * edx + edy * edy);
      if (el < 1e-10) return { x: 0, y: 0 };
      let ex = edx / el, ey = edy / el;
      let dot = (pa ? np : nc).x * ex + (pa ? np : nc).y * ey;
      if (dot < 0) { ex = -ex; ey = -ey; dot = -dot; }
      if (dot < 1e-6) return { x: 0, y: 0 };
      return { x: ex / dot, y: ey / dot };
    };

    const bs = verts.map((_, i) => bisect(i));
    let minT = Infinity;
    const coll = [];
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const bi = bs[i], bj = bs[j];
      const rx = verts[i].x - verts[j].x, ry = verts[i].y - verts[j].y;
      const dvx = bi.x - bj.x, dvy = bi.y - bj.y;
      const dv2 = dvx * dvx + dvy * dvy;
      if (dv2 < 1e-12) continue;
      const tc = -(rx * dvx + ry * dvy) / dv2;
      if (tc < 1e-9) continue;
      const fx = rx + tc * dvx, fy = ry + tc * dvy;
      if (fx * fx + fy * fy < 1e-3) {
        if (tc < minT - 1e-9) { minT = tc; coll.length = 0; coll.push(i); }
        else if (tc < minT + 1e-9) coll.push(i);
      }
    }
    if (!coll.length || minT > 1e6) break;

    const nv = verts.map((v, i) => ({ x: v.x + bs[i].x * minT, y: v.y + bs[i].y * minT }));
    for (let i = 0; i < m; i++) {
      const pe = (i - 1 + m) % m;
      if (!active[pe] || !active[i]) continue;
      const dx = nv[i].x - verts[i].x, dy = nv[i].y - verts[i].y;
      if (dx * dx + dy * dy > 1e-8)
        segments.push({ x1: verts[i].x, y1: verts[i].y, x2: nv[i].x, y2: nv[i].y });
    }

    const rem = new Set();
    for (const i of coll) {
      const j = (i + 1) % m;
      nv[i] = { x: (nv[i].x + nv[j].x) / 2, y: (nv[i].y + nv[j].y) / 2 };
      rem.add(j);
    }
    const nVerts = [], nActive = [];
    for (let i = 0; i < m; i++) {
      if (rem.has(i)) continue;
      nVerts.push({ ...nv[i] });
      nActive.push(coll.includes(i) ? active[(i + 1) % m] : active[i]);
    }
    verts = nVerts; active = nActive;
  }
  return segments;
}

// ─── Voronoi region polygon ───────────────────────────────────────────────────

/**
 * Clip a polygon to the half-plane "closer to thisEdge than to otherEdge",
 * measured as perpendicular distance to the INFINITE LINE through each edge.
 *
 * Using infinite-line distance (not segment distance) gives the correct
 * straight-skeleton Voronoi bisectors regardless of endpoint proximity.
 */
function voronoiClip(polygon, thisEdge, otherEdge) {
  const side = (p) =>
    lineDist2(p.x, p.y, thisEdge.a.x, thisEdge.a.y, thisEdge.b.x, thisEdge.b.y) <=
    lineDist2(p.x, p.y, otherEdge.a.x, otherEdge.a.y, otherEdge.b.x, otherEdge.b.y);

  const bisect = (p, q) => {
    let lo = 0, hi = 1;
    for (let k = 0; k < 52; k++) {
      const mid = (lo + hi) / 2;
      const mx = p.x + mid * (q.x - p.x), my = p.y + mid * (q.y - p.y);
      if (lineDist2(mx, my, thisEdge.a.x, thisEdge.a.y, thisEdge.b.x, thisEdge.b.y) <=
          lineDist2(mx, my, otherEdge.a.x, otherEdge.a.y, otherEdge.b.x, otherEdge.b.y))
        lo = mid; else hi = mid;
    }
    const t = (lo + hi) / 2;
    return { x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) };
  };

  const out = [];
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const cur = polygon[i], nxt = polygon[(i + 1) % n];
    const cIn = side(cur), nIn = side(nxt);
    if (cIn) out.push(cur);
    if (cIn !== nIn) out.push(bisect(cur, nxt));
  }
  // Remove duplicate consecutive vertices that arise at shared corners
  const deduped = [];
  for (let i = 0; i < out.length; i++) {
    const p = out[i], q = out[(i + 1) % out.length];
    if ((p.x - q.x) ** 2 + (p.y - q.y) ** 2 > 1e-10) deduped.push(p);
  }
  return deduped;
}

/**
 * Compute the Voronoi region polygon for bottom edge `edgeIdx` of the polygon
 * `pts` (already offset for overhang).  Clips against all other bottom edges.
 *
 * @param {Array<{x,y}>} pts       – polygon vertices in metres (after overhang offset)
 * @param {number}        edgeIdx  – index of the bottom edge whose plane to extract
 * @param {string[]}      edgeTypes – 'bottom' | 'gable' for each edge
 * @returns {Array<{x,y}>} polygon vertices for this plane (in metres)
 */
export function computeRoofPlanePolygon(pts, edgeIdx, edgeTypes) {
  const n = pts.length;
  const thisEdge = { a: pts[edgeIdx], b: pts[(edgeIdx + 1) % n] };
  let region = [...pts];
  for (let i = 0; i < n; i++) {
    if (i === edgeIdx || (edgeTypes[i] ?? 'bottom') !== 'bottom') continue;
    const otherEdge = { a: pts[i], b: pts[(i + 1) % n] };
    region = voronoiClip(region, thisEdge, otherEdge);
    if (region.length < 3) break;
  }
  return region;
}

// ─── Roof plane areas ─────────────────────────────────────────────────────────

/**
 * Grid-sample the roof polygon to compute projected and slope areas for each
 * bottom edge (Voronoi cell).
 *
 * @param {Array<{x,y}>} points
 * @param {string[]}     edgeTypes
 * @param {number}       overhang   – metres
 * @param {number}       pitch      – degrees
 * @returns {{ [edgeIdx]: { projected: number, slope: number } }}
 */
export function computeRoofPlaneAreas(points, edgeTypes, overhang, pitch) {
  const pts = offsetPolygon(points, overhang);
  const n = pts.length;
  if (n < 3) return {};
  const bottomEdges = [];
  for (let i = 0; i < n; i++) {
    if ((edgeTypes[i] ?? 'bottom') === 'bottom')
      bottomEdges.push({ i, a: pts[i], b: pts[(i + 1) % n] });
  }
  if (bottomEdges.length === 0) return {};
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const step = 0.05; // metres
  const cellAreaM2 = step * step;
  const counts = {};
  bottomEdges.forEach(e => { counts[e.i] = 0; });
  for (let x = minX + step / 2; x <= maxX; x += step) {
    for (let y = minY + step / 2; y <= maxY; y += step) {
      if (!isInsidePoly(x, y, pts)) continue;
      let minD2 = Infinity, closest = bottomEdges[0].i;
      for (const e of bottomEdges) {
        const d2 = distSqToSeg(x, y, e.a.x, e.a.y, e.b.x, e.b.y);
        if (d2 < minD2) { minD2 = d2; closest = e.i; }
      }
      counts[closest]++;
    }
  }
  const cosP = Math.cos(pitch * Math.PI / 180);
  const result = {};
  for (const e of bottomEdges) {
    const projected = counts[e.i] * cellAreaM2;
    result[e.i] = { projected, slope: projected / cosP };
  }
  return result;
}
