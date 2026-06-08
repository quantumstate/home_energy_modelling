import { useState, useMemo, useRef, useEffect } from "react";

const PPM = 60;
const VIEW_PAD = 20; // extra SVG-unit padding around roofs in canvas view
const PLANE_PALETTE = ['#f59e0b', '#3b82f6', '#10b981', '#f43f5e', '#8b5cf6', '#06b6d4', '#f97316', '#a855f7'];

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function offsetPolygon(points, distance) {
  const n = points.length;
  if (n < 3 || Math.abs(distance) < 1e-10) return points;
  const cen = { x: points.reduce((s, p) => s + p.x, 0) / n, y: points.reduce((s, p) => s + p.y, 0) / n };
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

function isInsidePoly(px, py, pts) {
  let inside = false;
  const n = pts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > py) !== (yj > py)) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distSqToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  if (len2 < 1e-10) return (px - ax) ** 2 + (py - ay) ** 2;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
}

// Straight skeleton – returns [{x1,y1,x2,y2}] ridge/hip segments.
function computeRoofLines(points, edgeTypes) {
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
  let verts = points.map(p => ({ ...p }));
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
    for (const i of coll) { const j = (i + 1) % m; nv[i] = { x: (nv[i].x + nv[j].x) / 2, y: (nv[i].y + nv[j].y) / 2 }; rem.add(j); }
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

// Returns { [edgeIdx]: { projected, slope } } for each bottom edge.
function computeRoofPlaneAreas(points, edgeTypes, overhang, pitch) {
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
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const step = 2;
  const cellAreaM2 = (step / PPM) ** 2;
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

// ─── Data loading ─────────────────────────────────────────────────────────────

function loadRoofsByStorey(projectId) {
  try {
    const raw = localStorage.getItem(`${projectId}_floorplan_roofs`);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

// ─── Graphical canvas view ────────────────────────────────────────────────────

function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function RoofPlanesCanvas({ roofsByStorey, planeColorMap, selectedKey, onSelect }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [panelW, setPanelW] = useState(300);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(([e]) => setPanelW(e.contentRect.width));
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // Tight bounding box of all offset roof polygons (no padding)
  const contentBox = useMemo(() => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const roofs of Object.values(roofsByStorey)) {
      for (const roof of (roofs || [])) {
        if (!roof.points?.length) continue;
        const pts = offsetPolygon(roof.points, roof.overhang ?? 0);
        for (const p of pts) {
          minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        }
      }
    }
    if (!isFinite(minX)) return null;
    return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY };
  }, [roofsByStorey]);

  // Scale so roof content fills 80% of canvas width; centre it
  const scale = contentBox && panelW > 0 ? 0.8 * panelW / contentBox.w : 1;
  const marginPx = panelW * 0.1; // 10% each side → 80% fill
  const canvasH = contentBox ? Math.max(60, Math.round(contentBox.h * scale + 2 * marginPx)) : 60;
  // Derived viewBox (SVG-coord window that maps 1:1 to the canvas at `scale`)
  const viewBox = contentBox ? {
    minX: (contentBox.minX + contentBox.maxX) / 2 - panelW / (2 * scale),
    minY: (contentBox.minY + contentBox.maxY) / 2 - canvasH / (2 * scale),
  } : null;

  // Per-roof render data: offset polygon + bottom edge lookup
  const roofRenderData = useMemo(() => {
    const data = [];
    for (const [si, roofs] of Object.entries(roofsByStorey)) {
      for (const roof of (roofs || [])) {
        if (!roof.points?.length) continue;
        const pts = offsetPolygon(roof.points, roof.overhang ?? 0);
        const edgeTypes = roof.edgeTypes || pts.map(() => 'bottom');
        const bottomEdges = [];
        for (let i = 0; i < pts.length; i++) {
          if (edgeTypes[i] === 'bottom') {
            const key = `${si}:${roof.id}:${i}`;
            bottomEdges.push({ key, a: pts[i], b: pts[(i + 1) % pts.length] });
          }
        }
        const ridgeLines = computeRoofLines(pts, edgeTypes);
        data.push({ pts, bottomEdges, ridgeLines, roofId: roof.id });
      }
    }
    return data;
  }, [roofsByStorey]);

  // Pixel-fill canvas with plane colors
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !viewBox) return;
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const imgData = ctx.createImageData(W, H);
    const d = imgData.data;

    for (let cy = 0; cy < H; cy++) {
      for (let cx = 0; cx < W; cx++) {
        const sx = viewBox.minX + cx / scale;
        const sy = viewBox.minY + cy / scale;
        for (const roof of roofRenderData) {
          if (!isInsidePoly(sx, sy, roof.pts)) continue;
          if (!roof.bottomEdges.length) break;
          let minD2 = Infinity, closestKey = null;
          for (const e of roof.bottomEdges) {
            const d2 = distSqToSeg(sx, sy, e.a.x, e.a.y, e.b.x, e.b.y);
            if (d2 < minD2) { minD2 = d2; closestKey = e.key; }
          }
          if (closestKey) {
            const color = planeColorMap[closestKey] || '#888888';
            const isSelected = selectedKey !== null && closestKey !== selectedKey;
            const [r, g, b] = hexToRgb(color);
            const alpha = isSelected ? 60 : 180;
            const i4 = (cy * W + cx) * 4;
            d[i4] = r; d[i4 + 1] = g; d[i4 + 2] = b; d[i4 + 3] = alpha;
          }
          break;
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }, [roofRenderData, planeColorMap, selectedKey, scale, canvasH, viewBox]);

  // SVG overlay: outlines + ridge lines
  const svgOverlay = useMemo(() => {
    if (!viewBox) return null;
    const toX = (sx) => (sx - viewBox.minX) * scale;
    const toY = (sy) => (sy - viewBox.minY) * scale;
    return roofRenderData.map((roof, ri) => {
      const pts = roof.pts;
      const polyPts = pts.map(p => `${toX(p.x)},${toY(p.y)}`).join(' ');
      return (
        <g key={ri}>
          <polygon points={polyPts} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={1} />
          {roof.ridgeLines.map((seg, si) => (
            <line key={si}
              x1={toX(seg.x1)} y1={toY(seg.y1)} x2={toX(seg.x2)} y2={toY(seg.y2)}
              stroke="rgba(255,255,255,0.55)" strokeWidth={1} strokeDasharray="3 2"
            />
          ))}
        </g>
      );
    });
  }, [roofRenderData, viewBox, scale]);

  const handleClick = (e) => {
    if (!viewBox || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = viewBox.minX + (e.clientX - rect.left) / scale;
    const sy = viewBox.minY + (e.clientY - rect.top) / scale;
    for (const roof of roofRenderData) {
      if (!isInsidePoly(sx, sy, roof.pts)) continue;
      if (!roof.bottomEdges.length) break;
      let minD2 = Infinity, closestKey = null;
      for (const e of roof.bottomEdges) {
        const d2 = distSqToSeg(sx, sy, e.a.x, e.a.y, e.b.x, e.b.y);
        if (d2 < minD2) { minD2 = d2; closestKey = e.key; }
      }
      if (closestKey) onSelect(closestKey === selectedKey ? null : closestKey);
      return;
    }
    onSelect(null);
  };

  if (!viewBox) return null;
  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', background: '#040912' }}>
      <canvas
        ref={canvasRef}
        width={Math.round(panelW)}
        height={canvasH}
        onClick={handleClick}
        style={{ display: 'block', cursor: 'crosshair', width: '100%', height: canvasH }}
      />
      <svg
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: canvasH, pointerEvents: 'none' }}
        viewBox={`0 0 ${Math.round(panelW)} ${canvasH}`}
      >
        {svgOverlay}
      </svg>
    </div>
  );
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

function SectionHeader({ label }) {
  return (
    <div style={{
      color: "#2d5a8a", fontSize: 9, letterSpacing: "0.18em",
      borderBottom: "1px solid #132040", paddingBottom: 6, marginBottom: 12,
    }}>
      {label}
    </div>
  );
}

function MetricRow({ label, value, unit }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      padding: "6px 0", borderBottom: "1px solid #0a1628",
    }}>
      <span style={{ color: "#4a7fa5", fontSize: 11 }}>{label}</span>
      <span style={{ fontFamily: "monospace", fontSize: 13, color: "#c8d8f0" }}>
        {value}
        {unit && <span style={{ fontSize: 9, color: "#2d5a8a", marginLeft: 4 }}>{unit}</span>}
      </span>
    </div>
  );
}

const STOREY_LABELS = ["Ground floor", "First floor", "Second floor", "Third floor"];

// ─── Main component ───────────────────────────────────────────────────────────

export default function SolarTab({ projectId }) {
  const [selectedKey, setSelectedKey] = useState(null);

  const roofsByStorey = useMemo(() => loadRoofsByStorey(projectId), [projectId]);

  const planes = useMemo(() => {
    const result = [];
    const storeyKeys = Object.keys(roofsByStorey).map(Number).sort((a, b) => a - b);
    for (const si of storeyKeys) {
      const roofs = roofsByStorey[si];
      if (!roofs?.length) continue;
      roofs.forEach((roof, ri) => {
        if (!roof.points?.length) return;
        const edgeTypes = roof.edgeTypes || roof.points.map(() => 'bottom');
        const pitch = roof.pitch ?? 35;
        const areas = computeRoofPlaneAreas(roof.points, edgeTypes, roof.overhang ?? 0, pitch);
        let planeNum = 0;
        Object.entries(areas).forEach(([edgeIdxStr, area]) => {
          planeNum++;
          result.push({
            key: `${si}:${roof.id}:${edgeIdxStr}`,
            storeyIdx: si,
            roofLabel: roofs.length > 1 ? `Roof ${ri + 1}` : null,
            planeLabel: `Plane ${planeNum}`,
            pitch,
            projectedArea: area.projected,
            slopeArea: area.slope,
          });
        });
      });
    }
    return result;
  }, [roofsByStorey]);

  const planeColorMap = useMemo(() => {
    const map = {};
    planes.forEach((p, idx) => { map[p.key] = PLANE_PALETTE[idx % PLANE_PALETTE.length]; });
    return map;
  }, [planes]);

  const selectedPlane = planes.find(p => p.key === selectedKey) ?? null;

  if (planes.length === 0) {
    return (
      <div style={{
        flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
        background: "#040912", color: "#2d5a8a", fontSize: 12, fontFamily: "monospace",
        letterSpacing: "0.1em",
      }}>
        No roof planes defined. Draw a roof with bottom edges in the Floor Plan tab.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", background: "#040912", fontFamily: "monospace", overflow: "hidden" }}>
      {/* Graphical plan view – left */}
      <div style={{ flex: 1, borderRight: "1px solid #0d1f38", display: "flex", flexDirection: "column", overflow: "hidden", flexShrink: 0 }}>
        <div style={{ color: "#2d5a8a", fontSize: 9, letterSpacing: "0.18em", padding: "10px 16px 8px", flexShrink: 0 }}>
          ROOF PLANES — click to select
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          <RoofPlanesCanvas
            roofsByStorey={roofsByStorey}
            planeColorMap={planeColorMap}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
          />
          {/* Colour key */}
          <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "10px 16px 14px" }}>
            {planes.map(p => (
              <button
                key={p.key}
                onClick={() => setSelectedKey(p.key === selectedKey ? null : p.key)}
                style={{
                  display: "flex", alignItems: "center", gap: 7, background: "none",
                  border: "none", cursor: "pointer", padding: "4px 0", textAlign: "left",
                }}
              >
                <span style={{
                  width: 10, height: 10, borderRadius: 2, flexShrink: 0,
                  background: planeColorMap[p.key],
                  opacity: selectedKey && p.key !== selectedKey ? 0.35 : 1,
                  outline: p.key === selectedKey ? `2px solid ${planeColorMap[p.key]}` : 'none',
                  outlineOffset: 1,
                }} />
                <span style={{
                  fontSize: 9, fontFamily: "monospace", letterSpacing: "0.05em",
                  color: p.key === selectedKey ? "#c8d8f0" : "#2d5a8a",
                }}>
                  {p.roofLabel ? `${p.roofLabel} · ` : ""}{p.planeLabel}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Detail panel – right */}
      <div style={{ flex: 2, overflowY: "auto", padding: 20 }}>
        {selectedPlane ? (
          <div style={{ maxWidth: 480 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ width: 12, height: 12, borderRadius: 2, background: planeColorMap[selectedPlane.key], flexShrink: 0 }} />
              <span style={{ color: "#fde68a", fontSize: 14 }}>{selectedPlane.planeLabel}</span>
            </div>
            <div style={{ color: "#2d5a8a", fontSize: 9, letterSpacing: "0.1em", marginBottom: 18 }}>
              {STOREY_LABELS[selectedPlane.storeyIdx] ?? `Storey ${selectedPlane.storeyIdx}`}
              {selectedPlane.roofLabel ? ` · ${selectedPlane.roofLabel}` : ""}
              {` · ${selectedPlane.pitch}° pitch`}
            </div>
            <div style={{ background: "#070d1a", border: "1px solid #1e3a6b", borderRadius: 6, padding: "14px 16px" }}>
              <SectionHeader label="AREA" />
              <MetricRow label="Slope area" value={selectedPlane.slopeArea.toFixed(2)} unit="m²" />
              <MetricRow label="Projected (plan) area" value={selectedPlane.projectedArea.toFixed(2)} unit="m²" />
            </div>
          </div>
        ) : (
          <div style={{ color: "#1a3050", fontSize: 11, marginTop: 20, textAlign: "center" }}>
            Click a roof plane above to view details.
          </div>
        )}
      </div>
    </div>
  );
}
