import { useState, useMemo, useRef, useEffect } from "react";
import { parseEPW } from "./epwParser.js";
import { solarPosition } from "./solarGain.js";
import kewEPWRaw from "./assets/GBR_ENG_Kew.Observatory.037750_TMYx.2011-2025.epw?raw";
import {
  offsetPolygon,
  isInsidePoly,
  distSqToSeg,
  computeRoofLines,
  computeRoofPlanePolygon,
  computeRoofPlaneAreas,
} from "./roofGeometry.js";

const VIEW_PAD = 0.4; // padding in metres around roofs in canvas view
const PLANE_PALETTE = ['#f59e0b', '#3b82f6', '#10b981', '#f43f5e', '#8b5cf6', '#06b6d4', '#f97316', '#a855f7'];

// ─── Solar calculations ───────────────────────────────────────────────────────

const D2R = Math.PI / 180;

/**
 * Incident irradiance (W/m²) on a surface tilted at `tiltDeg` from horizontal,
 * facing `surfaceBearing` (degrees CW from north). Isotropic sky diffuse model.
 */
function tiltedSurfaceIncident(altDeg, azSun, surfaceBearing, tiltDeg, dni, dhi, ghi) {
  const tilt   = tiltDeg * D2R;
  const diffuse = Math.max(0, dhi) * (1 + Math.cos(tilt)) / 2;
  const ground  = Math.max(0, ghi) * 0.2 * (1 - Math.cos(tilt)) / 2;
  if (altDeg <= 0) return diffuse + ground;
  const alt    = altDeg * D2R;
  const dAz    = (azSun - surfaceBearing) * D2R;
  const cosTheta = Math.sin(alt) * Math.cos(tilt) + Math.cos(alt) * Math.sin(tilt) * Math.cos(dAz);
  const beam   = cosTheta > 0 ? Math.max(0, dni) * cosTheta : 0;
  return beam + diffuse + ground;
}

/**
 * Compass bearing (0–360 CW from north) of the outward normal of edge i
 * in the given polygon, accounting for building rotation.
 */
function edgeBearing(pts, i, buildingRotation) {
  const n = pts.length;
  const a = pts[i], b = pts[(i + 1) % n];
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-10) return 0;
  // Two candidate normals
  const n1 = { x:  dy / len, y: -dx / len };
  const n2 = { x: -dy / len, y:  dx / len };
  // Pick the one pointing away from the polygon centroid
  const cx = pts.reduce((s, p) => s + p.x, 0) / n;
  const cy = pts.reduce((s, p) => s + p.y, 0) / n;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const normal = (n1.x * (mx - cx) + n1.y * (my - cy)) > 0 ? n1 : n2;
  // SVG coords: north = (0, -1), so local bearing = atan2(nx, -ny)
  const localBearing = Math.atan2(normal.x, -normal.y) * (180 / Math.PI);
  return ((localBearing - buildingRotation) % 360 + 360) % 360;
}

/**
 * Annual irradiation (kWh/m²/yr) and monthly breakdown (kWh/m²) for a
 * tilted surface at the given bearing and pitch, from EPW hourly data.
 */
function computeAnnualIrradiation(bearing, tiltDeg, hourly, location) {
  const { latitude, longitude, timezone } = location;
  let annualWh = 0;
  const monthlyWh = new Array(12).fill(0);
  for (const { month, day, hour, dni, dhi, ghi } of hourly) {
    if ((ghi ?? 0) <= 0 && (dhi ?? 0) <= 0 && (dni ?? 0) <= 0) continue;
    const pos = solarPosition(latitude, longitude, timezone, month, day, hour);
    const w   = tiltedSurfaceIncident(pos.altitude, pos.azimuth, bearing, tiltDeg, dni, dhi, ghi);
    annualWh += w;
    monthlyWh[month - 1] += w;
  }
  return {
    annualKwhPerM2:  annualWh / 1000,
    monthlyKwhPerM2: monthlyWh.map(v => v / 1000),
  };
}

function bearingToLabel(deg) {
  const dirs = ["N","NE","E","SE","S","SW","W","NW"];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

// ─── Panel layout ─────────────────────────────────────────────────────────────

/**
 * Fit rectangular panels onto a single roof plane (the Voronoi region of one
 * bottom edge). Works in a local 2D coordinate system: eu along eave, ev into slope.
 *
 * Returns null if the edge is degenerate, otherwise an object with:
 *   panels       – [{u,v,w,h}] panel rectangles in local plan coords
 *   uMin/uMax/vMin/vMax – full-polygon bounding box in local coords
 *   origin, eu, ev    – local frame origin and axes (for canvas pixel → world)
 *   pH, panelW        – panel dims in plan coords
 *   eaveU0, eaveU1    – eave u-extents (always v=0)
 *   pts, bottomEdges, edgeIdx – passed through for canvas rendering
 *   insetPoly         – cleared polygon (for canvas rendering)
 */
function computePanelLayout(pts, edgeIdx, edgeTypes, pitch, config) {
  const { w: panelW, h: panelH, clearance, gap } = config;
  const n = pts.length;
  const a = pts[edgeIdx], b = pts[(edgeIdx + 1) % n];
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-10) return null;

  // Local frame: eu along eave, ev perpendicular into polygon
  const eu = { x: dx / len, y: dy / len };
  const cen = { x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n };
  const n1 = { x: -eu.y, y: eu.x };
  const ev = (n1.x * (cen.x - a.x) + n1.y * (cen.y - a.y)) > 0 ? n1 : { x: eu.y, y: -eu.x };

  const toLocal = (px, py) => ({
    u: (px - a.x) * eu.x + (py - a.y) * eu.y,
    v: (px - a.x) * ev.x + (py - a.y) * ev.y,
  });
  const toWorld = (u, v) => ({
    x: a.x + u * eu.x + v * ev.x,
    y: a.y + u * eu.y + v * ev.y,
  });

  // Bounding box of the full polygon in local coords
  const localPts = pts.map(p => toLocal(p.x, p.y));
  const uMin = Math.min(...localPts.map(p => p.u));
  const uMax = Math.max(...localPts.map(p => p.u));
  const vMin = Math.min(...localPts.map(p => p.v));
  const vMax = Math.max(...localPts.map(p => p.v));

  // Project slope measurements to plan
  const cosP = Math.cos(pitch * Math.PI / 180);
  const pH = panelH * cosP;    // panel height in plan
  const cV = clearance * cosP; // vertical clearance in plan
  const cU = clearance;        // horizontal clearance
  const gV = gap * cosP;

  // Inset polygon for clearance check
  const insetPoly = offsetPolygon(pts, -clearance);
  const inInset = insetPoly.length >= 3
    ? (px, py) => isInsidePoly(px, py, insetPoly)
    : () => false;

  // Bottom edges for Voronoi membership
  const bottomEdges = [];
  for (let i = 0; i < n; i++) {
    if ((edgeTypes[i] ?? 'bottom') === 'bottom')
      bottomEdges.push({ i, a: pts[i], b: pts[(i + 1) % n] });
  }
  const inVoronoi = (px, py) => {
    if (!isInsidePoly(px, py, pts)) return false;
    if (bottomEdges.length <= 1) return true;
    let minD2 = Infinity, best = edgeIdx;
    for (const e of bottomEdges) {
      const d2 = distSqToSeg(px, py, e.a.x, e.a.y, e.b.x, e.b.y);
      if (d2 < minD2) { minD2 = d2; best = e.i; }
    }
    return best === edgeIdx;
  };

  // Fit panels
  const panels = [];
  for (let u = uMin + cU; u + panelW <= uMax - cU + 1e-9; u += panelW + gap) {
    for (let v = vMin + cV; v + pH <= vMax - cV + 1e-9; v += pH + gV) {
      const corners = [
        toWorld(u, v), toWorld(u + panelW, v),
        toWorld(u + panelW, v + pH), toWorld(u, v + pH),
      ];
      if (corners.every(c => inVoronoi(c.x, c.y) && inInset(c.x, c.y)))
        panels.push({ u, v, w: panelW, h: pH });
    }
  }

  // World bounding box of the polygon (for canvas orientation matching roof planes view)
  const wxMin = Math.min(...pts.map(p => p.x));
  const wxMax = Math.max(...pts.map(p => p.x));
  const wyMin = Math.min(...pts.map(p => p.y));
  const wyMax = Math.max(...pts.map(p => p.y));

  // Eave endpoints in world coords (for SVG overlay)
  const eaveAWorld = { x: a.x, y: a.y };
  const eaveBWorld = { x: b.x, y: b.y };

  // Panels stored as world-coord corner lists for easy SVG rendering
  const panelsWorld = panels.map(p => ({
    corners: [
      toWorld(p.u, p.v), toWorld(p.u + p.w, p.v),
      toWorld(p.u + p.w, p.v + p.h), toWorld(p.u, p.v + p.h),
    ],
  }));

  return {
    panels, panelsWorld, uMin, uMax, vMin, vMax, pH, panelW,
    origin: a, eu, ev,
    wxMin, wxMax, wyMin, wyMax,
    eaveAWorld, eaveBWorld,
    // Pass through for canvas rendering
    pts, bottomEdges, edgeIdx, insetPoly,
  };
}

/**
 * Panel layout view: raster canvas for the exact roof plane shape rendered
 * in world coordinates (same orientation as the roof planes canvas on the left),
 * with an SVG overlay for panels and the eave highlight.
 */
function PanelLayoutView({ layout, plane, panelConfig, efficiency, perfRatio }) {
  const canvasRef = useRef(null);

  // Rasterise the roof plane shape into the canvas using world coordinates
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout) return;
    const { wxMin, wxMax, wyMin, wyMax, pts, bottomEdges, edgeIdx, insetPoly } = layout;

    const SVG_W = canvas.width;
    const PAD   = 0.3;
    const spanX = wxMax - wxMin;
    const spanY = wyMax - wyMin;
    const scale = SVG_W / (spanX + 2 * PAD);
    const H     = Math.max(60, Math.round((spanY + 2 * PAD) * scale));
    canvas.height = H;

    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(SVG_W, H);
    const d = imgData.data;

    const inVoronoi = (wx, wy) => {
      if (!isInsidePoly(wx, wy, pts)) return false;
      if (bottomEdges.length <= 1) return true;
      let minD2 = Infinity, best = edgeIdx;
      for (const e of bottomEdges) {
        const d2 = distSqToSeg(wx, wy, e.a.x, e.a.y, e.b.x, e.b.y);
        if (d2 < minD2) { minD2 = d2; best = e.i; }
      }
      return best === edgeIdx;
    };

    const inInset = insetPoly.length >= 3
      ? (wx, wy) => isInsidePoly(wx, wy, insetPoly)
      : () => false;

    for (let cy = 0; cy < H; cy++) {
      for (let cx = 0; cx < SVG_W; cx++) {
        // Canvas pixel → world coords (same mapping as RoofPlanesCanvas)
        const wx = wxMin - PAD + cx / scale;
        const wy = wyMin - PAD + cy / scale;
        const i4 = (cy * SVG_W + cx) * 4;

        if (inVoronoi(wx, wy)) {
          if (inInset(wx, wy)) {
            d[i4]=25; d[i4+1]=55; d[i4+2]=110; d[i4+3]=230;
          } else {
            d[i4]=15; d[i4+1]=35; d[i4+2]=75; d[i4+3]=180;
          }
        } else if (isInsidePoly(wx, wy, pts)) {
          d[i4]=12; d[i4+1]=20; d[i4+2]=35; d[i4+3]=140;
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);

    // Draw eave line directly on canvas (pixel-perfect, no SVG overlay offset)
    const scx = (wx) => (wx - wxMin + PAD) * scale;
    const scy = (wy) => (wy - wyMin + PAD) * scale;
    const { eaveAWorld, eaveBWorld } = layout;
    ctx.beginPath();
    ctx.moveTo(scx(eaveAWorld.x), scy(eaveAWorld.y));
    ctx.lineTo(scx(eaveBWorld.x), scy(eaveBWorld.y));
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    // Eave label
    const midX = scx((eaveAWorld.x + eaveBWorld.x) / 2);
    const midY = scy((eaveAWorld.y + eaveBWorld.y) / 2);
    ctx.fillStyle = 'rgba(245,158,11,0.6)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('EAVE', midX, midY + 12);
  }, [layout]);

  if (!layout) return (
    <div style={{ color: "#1a3050", fontSize: 10, textAlign: "center", padding: 20 }}>
      No layout computed.
    </div>
  );

  const { panelsWorld, wxMin, wxMax, wyMin, wyMax } = layout;
  const { w: panelW_cfg, h: panelH_cfg } = panelConfig;

  const SVG_W = 400;
  const PAD   = 0.3;
  const spanX = wxMax - wxMin;
  const spanY = wyMax - wyMin;
  const scale = SVG_W / (spanX + 2 * PAD);
  const svgH  = Math.max(60, Math.round((spanY + 2 * PAD) * scale));

  // World coord → canvas pixel
  const scx = (wx) => (wx - wxMin + PAD) * scale;
  const scy = (wy) => (wy - wyMin + PAD) * scale;

  const panelSlopeArea = panelW_cfg * panelH_cfg;
  const count          = panelsWorld.length;
  const totalSlopeArea = count * panelSlopeArea;
  const installedKwp   = totalSlopeArea * (efficiency / 100);
  const annualOutput   = installedKwp * plane.annualIrradiation * (perfRatio / 100);
  const coverage       = plane.slopeArea > 0 ? (totalSlopeArea / plane.slopeArea * 100) : 0;

  return (
    <div>
      <div style={{ position: 'relative', marginBottom: 10, borderRadius: 4, border: '1px solid #1e3a6b', overflow: 'hidden' }}>
        {/* Canvas: raster plane shape + eave line drawn directly */}
        <canvas ref={canvasRef} width={SVG_W} height={svgH}
          style={{ display: 'block', width: '100%' }} />
        {/* SVG overlay: panels only */}
        <svg width={SVG_W} height={svgH}
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}>
          {panelsWorld.map((p, i) => {
            const pd = p.corners.map((c, j) =>
              `${j ? 'L' : 'M'}${scx(c.x).toFixed(1)},${scy(c.y).toFixed(1)}`
            ).join(' ') + 'Z';
            return <path key={i} d={pd}
              fill="rgba(59,130,246,0.5)" stroke="#60a5fa" strokeWidth={0.75} />;
          })}
        </svg>
      </div>
      <MetricRow label="Panels"             value={count} />
      <MetricRow label="Panel area"         value={totalSlopeArea.toFixed(1)} unit="m²" />
      <MetricRow label="Coverage"           value={coverage.toFixed(0)} unit="%" />
      <MetricRow label="Installed"          value={installedKwp.toFixed(2)} unit="kWp" />
      <MetricRow label="Est. annual output" value={annualOutput.toFixed(0)} unit="kWh/yr" />
    </div>
  );
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

function NorthOverlay({ rotation }) {
  const S = 44, cx = S / 2, cy = S / 2, len = 15;
  const r  = -rotation * Math.PI / 180;
  const nx = cx - Math.sin(r) * len;
  const ny = cy - Math.cos(r) * len;
  const px = -Math.cos(r), py = Math.sin(r);
  const hw = 4, hl = 7;
  const tip = { x: nx, y: ny };
  const b   = { x: cx - Math.sin(r) * (len - hl), y: cy - Math.cos(r) * (len - hl) };
  return (
    <svg width={S} height={S} style={{ display: "block" }}>
      <circle cx={cx} cy={cy} r={S / 2 - 1} fill="#070d1acc" stroke="#1e3a6b" strokeWidth={1.5}/>
      <line x1={cx} y1={cy} x2={tip.x} y2={tip.y} stroke="#38bdf8" strokeWidth={1.4}/>
      <polygon
        points={`${tip.x},${tip.y} ${b.x + px * hw},${b.y + py * hw} ${b.x - px * hw},${b.y - py * hw}`}
        fill="#38bdf8"
      />
      <text x={tip.x - Math.sin(r) * 6} y={tip.y - Math.cos(r) * 6}
        textAnchor="middle" dominantBaseline="central"
        fontSize={7} fill="#38bdf8" fontWeight="bold"
        style={{ userSelect: "none", fontFamily: "monospace" }}
      >N</text>
    </svg>
  );
}

function RoofPlanesCanvas({ roofsByStorey, planeColorMap, selectedKey, onSelect, buildingRotation }) {
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
      <div style={{ position: 'absolute', bottom: 8, right: 8, pointerEvents: 'none' }}>
        <NorthOverlay rotation={buildingRotation} />
      </div>
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
  const [efficiency, setEfficiency] = useState(20); // percent
  const [perfRatio, setPerfRatio] = useState(80); // percent
  const [panelConfig, setPanelConfig] = useState({ w: 1.722, h: 1.134, clearance: 0.3, gap: 0.02 });

  const roofsByStorey = useMemo(() => loadRoofsByStorey(projectId), [projectId]);

  const buildingRotation = useMemo(() => {
    try { const s = localStorage.getItem(`${projectId}_floorplan_rotation`); return s ? JSON.parse(s) : 0; }
    catch { return 0; }
  }, [projectId]);

  const epw = useMemo(() => parseEPW(kewEPWRaw), []);

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
        const offsetPts = offsetPolygon(roof.points, roof.overhang ?? 0);
        const areas = computeRoofPlaneAreas(roof.points, edgeTypes, roof.overhang ?? 0, pitch);
        let planeNum = 0;
        Object.entries(areas).forEach(([edgeIdxStr, area]) => {
          planeNum++;
          const edgeIdx = parseInt(edgeIdxStr);
          const bearing = edgeBearing(offsetPts, edgeIdx, buildingRotation);
          const solar   = computeAnnualIrradiation(bearing, pitch, epw.hourly, epw.location);
          result.push({
            key: `${si}:${roof.id}:${edgeIdxStr}`,
            storeyIdx: si,
            roofLabel: roofs.length > 1 ? `Roof ${ri + 1}` : null,
            planeLabel: `Plane ${planeNum}`,
            pitch,
            bearing,
            projectedArea: area.projected,
            slopeArea: area.slope,
            annualIrradiation: solar.annualKwhPerM2,
            monthlyIrradiation: solar.monthlyKwhPerM2,
          });
        });
      });
    }
    return result;
  }, [roofsByStorey, buildingRotation, epw]);

  const planeColorMap = useMemo(() => {
    const map = {};
    planes.forEach((p, idx) => { map[p.key] = PLANE_PALETTE[idx % PLANE_PALETTE.length]; });
    return map;
  }, [planes]);

  const selectedPlane = planes.find(p => p.key === selectedKey) ?? null;

  const panelLayout = useMemo(() => {
    if (!selectedPlane) return null;
    const [si, roofId, edgeIdxStr] = selectedPlane.key.split(':');
    const roofs = roofsByStorey[parseInt(si)] || [];
    const roof = roofs.find(r => r.id === roofId);
    if (!roof?.points?.length) return null;
    const edgeIdx = parseInt(edgeIdxStr);
    const pts = offsetPolygon(roof.points, roof.overhang ?? 0);
    const edgeTypes = roof.edgeTypes || pts.map(() => 'bottom');
    return computePanelLayout(pts, edgeIdx, edgeTypes, roof.pitch ?? 35, panelConfig);
  }, [selectedPlane, roofsByStorey, panelConfig]);

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
            buildingRotation={buildingRotation}
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
        {/* Panel efficiency — always visible */}
        <div style={{ background: "#070d1a", border: "1px solid #132040", borderRadius: 6, padding: "14px 16px", marginBottom: 16, maxWidth: 480 }}>
          <SectionHeader label="PANEL SETTINGS" />
          {[
            { label: "Panel efficiency", value: efficiency, set: setEfficiency, min: 1, max: 100, step: 1 },
            { label: "Performance ratio", value: perfRatio,  set: setPerfRatio,  min: 50, max: 100, step: 1 },
          ].map(({ label, value, set, min, max, step }) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{ color: "#4a7fa5", fontSize: 11, flex: 1 }}>{label}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#0a1628", border: "1px solid #1e3a6b", borderRadius: 5, padding: "4px 8px" }}>
                <button onClick={() => set(v => Math.max(min, v - step))}
                  style={{ width: 22, height: 22, background: "#070d1a", border: "1px solid #1e3a6b", color: "#93c5fd", borderRadius: 3, cursor: "pointer", fontSize: 14, lineHeight: 1 }}>−</button>
                <input type="number" min={min} max={max} step={step} value={value}
                  onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v)) set(Math.max(min, Math.min(max, v))); }}
                  style={{ width: 36, textAlign: "center", background: "transparent", border: "none", color: "#c8d8f0", fontSize: 14, fontFamily: "monospace", outline: "none" }} />
                <button onClick={() => set(v => Math.min(max, v + step))}
                  style={{ width: 22, height: 22, background: "#070d1a", border: "1px solid #1e3a6b", color: "#93c5fd", borderRadius: 3, cursor: "pointer", fontSize: 14, lineHeight: 1 }}>+</button>
                <span style={{ color: "#2d5a8a", fontSize: 11, fontFamily: "monospace" }}>%</span>
              </div>
            </div>
          ))}
        </div>

        {selectedPlane ? (() => {
          const eff = efficiency / 100;
          const pr  = perfRatio / 100;
          const annualOutput = selectedPlane.annualIrradiation * eff * pr; // kWh/m²/yr
          const totalOutput  = annualOutput * selectedPlane.slopeArea;     // kWh/yr
          const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
          const maxMonthly = Math.max(...selectedPlane.monthlyIrradiation);
          return (
            <div style={{ maxWidth: 480 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ width: 12, height: 12, borderRadius: 2, background: planeColorMap[selectedPlane.key], flexShrink: 0 }} />
                <span style={{ color: "#fde68a", fontSize: 14 }}>{selectedPlane.planeLabel}</span>
              </div>
              <div style={{ color: "#2d5a8a", fontSize: 9, letterSpacing: "0.1em", marginBottom: 16 }}>
                {STOREY_LABELS[selectedPlane.storeyIdx] ?? `Storey ${selectedPlane.storeyIdx}`}
                {selectedPlane.roofLabel ? ` · ${selectedPlane.roofLabel}` : ""}
                {` · ${selectedPlane.pitch}° pitch · ${bearingToLabel(selectedPlane.bearing)}-facing`}
              </div>

              <div style={{ background: "#070d1a", border: "1px solid #1e3a6b", borderRadius: 6, padding: "14px 16px", marginBottom: 14 }}>
                <SectionHeader label="AREA" />
                <MetricRow label="Slope area" value={selectedPlane.slopeArea.toFixed(2)} unit="m²" />
                <MetricRow label="Projected (plan) area" value={selectedPlane.projectedArea.toFixed(2)} unit="m²" />
              </div>

              <div style={{ background: "#070d1a", border: "1px solid #1e4a1e", borderRadius: 6, padding: "14px 16px", marginBottom: 14 }}>
                <SectionHeader label="PANEL LAYOUT" />
                {/* Config row */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", marginBottom: 12 }}>
                  {[
                    { label: "Width", key: "w", unit: "m", min: 0.5, max: 3, step: 0.001 },
                    { label: "Height", key: "h", unit: "m", min: 0.5, max: 3, step: 0.001 },
                    { label: "Clearance", key: "clearance", unit: "m", min: 0, max: 1, step: 0.05 },
                    { label: "Gap", key: "gap", unit: "m", min: 0, max: 0.2, step: 0.005 },
                  ].map(({ label, key, unit, min, max, step }) => (
                    <div key={key} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ color: "#2d5a8a", fontSize: 9, fontFamily: "monospace", letterSpacing: "0.05em" }}>{label}</span>
                      <input type="number" min={min} max={max} step={step}
                        value={panelConfig[key]}
                        onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) setPanelConfig(c => ({ ...c, [key]: Math.max(min, Math.min(max, v)) })); }}
                        style={{ width: 52, background: "#0a1628", border: "1px solid #1e4a1e", borderRadius: 3, color: "#c8d8f0", fontSize: 11, fontFamily: "monospace", padding: "2px 4px", outline: "none" }}
                      />
                      <span style={{ color: "#2d5a8a", fontSize: 9, fontFamily: "monospace" }}>{unit}</span>
                    </div>
                  ))}
                </div>
                <PanelLayoutView
                  layout={panelLayout}
                  plane={selectedPlane}
                  panelConfig={panelConfig}
                  efficiency={efficiency}
                  perfRatio={perfRatio}
                />
              </div>

              <div style={{ background: "#070d1a", border: "1px solid #78350f", borderRadius: 6, padding: "14px 16px", marginBottom: 14 }}>
                <SectionHeader label="SOLAR POTENTIAL" />
                <MetricRow label="Annual irradiation" value={selectedPlane.annualIrradiation.toFixed(0)} unit="kWh/m²/yr" />
                <MetricRow label="Specific yield" value={(selectedPlane.annualIrradiation * pr).toFixed(0)} unit="kWh/kWp" />
                <MetricRow label={`Output per m² (${efficiency}% · PR ${perfRatio}%)`} value={annualOutput.toFixed(0)} unit="kWh/m²/yr" />
                <MetricRow label="Total annual output" value={totalOutput.toFixed(0)} unit="kWh/yr" />
              </div>

              <div style={{ background: "#070d1a", border: "1px solid #1e3a6b", borderRadius: 6, padding: "14px 16px" }}>
                <SectionHeader label="MONTHLY IRRADIATION (kWh/m²)" />
                <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 60, marginBottom: 4 }}>
                  {selectedPlane.monthlyIrradiation.map((v, i) => (
                    <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                      <div style={{
                        width: "100%", background: "#f59e0b",
                        height: maxMonthly > 0 ? `${(v / maxMonthly) * 52}px` : 0,
                        borderRadius: "2px 2px 0 0", opacity: 0.8,
                      }} />
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 3 }}>
                  {MONTHS.map((m, i) => (
                    <div key={i} style={{ flex: 1, textAlign: "center", fontSize: 7, color: "#1a3050", fontFamily: "monospace" }}>{m[0]}</div>
                  ))}
                </div>
              </div>
            </div>
          );
        })() : (
          <div style={{ color: "#1a3050", fontSize: 11, marginTop: 20, textAlign: "center" }}>
            Click a roof plane to view solar potential.
          </div>
        )}
      </div>
    </div>
  );
}
