import { useState, useRef, useCallback, useEffect, useMemo, useLayoutEffect } from "react";
import { buildingModelFromState } from "./geometryProcessor.js";
import { STOREY_LABELS as STOREY_LABELS_CONST, DEFAULT_U_VALUES } from "./constants.js";
import { recorder } from "./sessionRecorder.js";
import ReplayPanel from "./ReplayPanel.jsx";
import { offsetPolygon, computeRoofLines } from "./roofGeometry.js";
import { findClosedAreas, hasClosedBoundary } from "./wallGraph.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const PPM  = 60;
const GRID = 0.5;
const WALL_HOVER_THRESHOLD = 0.35;
const VERTEX_TOL = 0.05;
const SNAP_PX = 10; // geometry-snap radius, in screen pixels
const SRC_PRIORITY = { last: 0, endpoint: 1 };

// Build a faint guide line from the resolved point to the existing-wall
// endpoint that an axis snapped into alignment with (priority 3 only —
// `last`-based snapping doesn't get a guide since `last` is already visible
// on screen as the previous drafted point).
const axisGuide = (axis, point, ax) => {
  const ref = axis === "x" ? ax.xRef : ax.yRef;
  const src = axis === "x" ? ax.xSrc : ax.ySrc;
  if (src !== "endpoint" || !ref) return null;
  return { x1: point.x, y1: point.y, x2: ref.x, y2: ref.y };
};

const OPENING_DEFAULTS = {
  window: { width: 1.2, height: 1.2, sillHeight: 0.9 },
  door:   { width: 0.9, height: 2.1, sillHeight: 0.0 },
};

const PALETTE = [
  { bg: "#60a5fa18", line: "#60a5fa", label: "#93c5fd" },
  { bg: "#34d39918", line: "#34d399", label: "#6ee7b7" },
  { bg: "#fbbf2418", line: "#fbbf24", label: "#fde68a" },
  { bg: "#f4727218", line: "#f47272", label: "#fca5a5" },
  { bg: "#c084fc18", line: "#c084fc", label: "#e9d5ff" },
  { bg: "#fb923c18", line: "#fb923c", label: "#fed7aa" },
];

// ─── Geometry ─────────────────────────────────────────────────────────────────
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const area = (pts) => {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  return Math.abs(a) / 2;
};
const centroid = (pts) => ({
  x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
  y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
});
const pointInPoly = (pt, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const { x: xi, y: yi } = poly[i], { x: xj, y: yj } = poly[j];
    if (((yi > pt.y) !== (yj > pt.y)) && pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
};
const distToSegment = (pt, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx*dx + dy*dy;
  if (len2 < 1e-10) return dist(pt, a);
  const t = Math.max(0, Math.min(1, ((pt.x-a.x)*dx + (pt.y-a.y)*dy) / len2));
  return dist(pt, { x: a.x + t*dx, y: a.y + t*dy });
};
const projectOntoWall = (pt, a, b) => {
  const dx = b.x-a.x, dy = b.y-a.y, len2 = dx*dx+dy*dy;
  if (len2 < 1e-10) return { t: 0, len: 0 };
  const t = Math.max(0, Math.min(1, ((pt.x-a.x)*dx+(pt.y-a.y)*dy)/len2));
  return { t, len: Math.sqrt(len2) };
};

// Use crypto.randomUUID() (not a module-level counter) so ids stay unique
// across dev HMR reloads, which re-execute this module and would otherwise
// reset a counter and produce colliding ids with rooms already on screen.
const uid = () => `id${crypto.randomUUID()}`;

const areaKey = (wallIds) => [...wallIds].sort().join("|");

// ─── Roof geometry ────────────────────────────────────────────────────────────
// offsetPolygon and computeRoofLines are imported from roofGeometry.js above.

const ROOF_DEFAULT_PITCH = 35;

// ─── Migration: legacy room-polygon data → wall graph ──────────────────────────
function migrateRoomsToWalls(roomsByStorey) {
  const wallsByStorey = {}, openingsByStorey = {}, areaMetaByStorey = {};
  for (const storey of Object.keys(roomsByStorey)) {
    const walls = [], openings = [], areaMeta = {};
    const close = (p, q) => Math.abs(p.x-q.x) < VERTEX_TOL && Math.abs(p.y-q.y) < VERTEX_TOL;
    const findWall = (a, b) => walls.find(w =>
      (close(w.a, a) && close(w.b, b)) || (close(w.a, b) && close(w.b, a)));
    for (const room of (roomsByStorey[storey] || [])) {
      const pts = room.points || [];
      const wallIds = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i+1) % pts.length];
        let w = findWall(a, b);
        if (!w) {
          w = { id: uid(), a, b, uValue: room.wallUs?.[i] ?? null };
          walls.push(w);
        }
        wallIds.push(w.id);
        for (const o of (room.openings || []).filter(o => o.wallIdx === i)) {
          let offset = o.offset;
          if (!close(w.a, a)) offset = dist(w.a, w.b) - o.offset - o.width;
          openings.push({ id: o.id, wallId: w.id, type: o.type, offset,
            width: o.width, height: o.height, sillHeight: o.sillHeight,
            uValue: o.uValue, glazing: o.glazing });
        }
      }
      if (wallIds.length) {
        areaMeta[areaKey(wallIds)] = {
          name: room.name, use: room.use, isHeated: room.isHeated,
          floorU: room.floorU, roofU: room.roofU,
          bg: room.bg, line: room.line, label: room.label,
        };
      }
    }
    wallsByStorey[storey] = walls;
    openingsByStorey[storey] = openings;
    areaMetaByStorey[storey] = areaMeta;
  }
  return { wallsByStorey, openingsByStorey, areaMetaByStorey };
}

// ─── Opening symbols ──────────────────────────────────────────────────────────
function wallWithOpenings(ptA, ptB, openings, wallColor, lw, isPreview) {
  const wLen = dist(ptA, ptB);
  if (wLen < 0.01) return null;
  const dir  = { x: (ptB.x-ptA.x)/wLen, y: (ptB.y-ptA.y)/wLen };
  const perp = { x: -dir.y, y: dir.x };
  const pt   = (off) => ({ x: ptA.x + dir.x*off, y: ptA.y + dir.y*off });
  const sorted = [...openings].sort((a, b) => a.offset - b.offset);
  const els = [];
  let pos = 0;
  const seg = (from, to, key) => {
    if (to - from < 0.001) return;
    const a = pt(from), b = pt(to);
    els.push(<line key={key} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
      stroke={wallColor} strokeWidth={lw*2} strokeLinecap="round" />);
  };
  for (const o of sorted) {
    const oS = Math.max(0, o.offset), oE = Math.min(wLen, o.offset+o.width);
    if (oE <= oS || oS >= wLen) continue;
    const ow = oE - oS;
    seg(pos, oS, `ws-${o.id}-${pos}`);
    pos = oE;
    const os = pt(oS), oe = pt(oE);
    const alpha = isPreview ? 0.5 : 1;
    if (o.type === "window") {
      const fw = Math.min(0.1, ow*0.12);
      els.push(
        <line key={`wg-${o.id}`} x1={os.x} y1={os.y} x2={oe.x} y2={oe.y}
          stroke="#38bdf8" strokeWidth={lw*4} opacity={alpha*0.45} />,
        <line key={`wgi-${o.id}`} x1={os.x} y1={os.y} x2={oe.x} y2={oe.y}
          stroke="#7dd3fc" strokeWidth={lw*1.2} opacity={alpha*0.9} />,
        <line key={`wj1-${o.id}`}
          x1={os.x-perp.x*fw} y1={os.y-perp.y*fw} x2={os.x+perp.x*fw} y2={os.y+perp.y*fw}
          stroke={wallColor} strokeWidth={lw*2} opacity={alpha} />,
        <line key={`wj2-${o.id}`}
          x1={oe.x-perp.x*fw} y1={oe.y-perp.y*fw} x2={oe.x+perp.x*fw} y2={oe.y+perp.y*fw}
          stroke={wallColor} strokeWidth={lw*2} opacity={alpha} />,
      );
    } else {
      const tip = { x: os.x+perp.x*ow, y: os.y+perp.y*ow };
      els.push(
        <circle key={`dh-${o.id}`} cx={os.x} cy={os.y} r={lw*1.5} fill={wallColor} opacity={alpha} />,
        <path key={`dp-${o.id}`}
          d={`M ${os.x} ${os.y} L ${tip.x} ${tip.y} A ${ow} ${ow} 0 0 0 ${oe.x} ${oe.y}`}
          fill="none" stroke="#a78bfa" strokeWidth={lw*1.4}
          strokeDasharray={isPreview ? `${0.06} ${0.05}` : "none"} opacity={alpha} />,
      );
    }
  }
  seg(pos, wLen, "ws-tail");
  return els;
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function Stat({ label, value }) {
  return (
    <div style={{ background: "#0a1628", border: "1px solid #1a2d4d", padding: "6px 8px", borderRadius: 3 }}>
      <div style={{ color: "#2d5a8a", fontSize: 8, marginBottom: 2, letterSpacing: "0.12em" }}>{label}</div>
      <div style={{ color: "#7dd3fc", fontSize: 11, fontFamily: "monospace" }}>{value}</div>
    </div>
  );
}

// U-value row: shows default pill or editable override
function URow({ label, value, defaultVal, onChange, accent = "#38bdf8" }) {
  const isDefault = value === null || value === undefined;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 0",
      borderBottom: "1px solid #0a1628" }}>
      <span style={{ color: "#4a7fa5", fontSize: 9, width: 68, flexShrink: 0 }}>{label}</span>
      {isDefault ? (
        <button onClick={() => onChange(defaultVal)}
          style={{ flex: 1, fontSize: 8, padding: "2px 5px", background: "#0a1628",
            border: "1px solid #132040", color: "#2d5a8a", borderRadius: 3,
            cursor: "pointer", fontFamily: "monospace", textAlign: "left",
            letterSpacing: "0.05em" }}>
          {defaultVal.toFixed(2)} <span style={{ color: "#1a3050" }}>DEFAULT</span>
        </button>
      ) : (
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 4 }}>
          <input type="number" step="0.01" min="0.01" max="20"
            value={value}
            onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(v); }}
            style={{ flex: 1, minWidth: 0, background: "#0a1628",
              border: `1px solid ${accent}60`, color: "#7dd3fc",
              padding: "2px 5px", borderRadius: 3, fontFamily: "monospace",
              fontSize: 10, outline: "none" }} />
          <button onClick={() => onChange(null)} title="Revert to default"
            style={{ background: "none", border: "none", color: "#2d5a8a",
              cursor: "pointer", fontSize: 11, padding: "0 2px", lineHeight: 1 }}>↩</button>
        </div>
      )}
      <span style={{ color: "#1a3050", fontSize: 7, flexShrink: 0 }}>W/m²K</span>
    </div>
  );
}

// Collapsible section header
function Section({ label, open, onToggle, children, accent }) {
  return (
    <div style={{ marginTop: 16 }}>
      <button onClick={onToggle}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "none", border: "none", borderBottom: `1px solid ${open ? (accent||"#1e3a6b") : "#132040"}`,
          color: accent || "#2d5a8a", fontSize: 9, letterSpacing: "0.15em",
          cursor: "pointer", padding: "0 0 5px", fontFamily: "monospace" }}>
        {label}
        <span style={{ fontSize: 8 }}>{open ? "▴" : "▾"}</span>
      </button>
      {open && <div style={{ paddingTop: 8 }}>{children}</div>}
    </div>
  );
}

// ─── Compass helpers ──────────────────────────────────────────────────────────

/** Convert a bearing (0–360, CW from north) to an 8-point cardinal label. */
function bearingLabel(deg) {
  const dirs = ["N","NE","E","SE","S","SW","W","NW"];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/**
 * Full interactive compass rose.
 *
 * buildingRotation = degrees CW from north to the floor plan's +X (rightward) axis.
 *   0°  → north is UP   on the floor plan (standard map orientation)
 *   90° → north is LEFT on the floor plan (+X = east)
 *
 * The needle always points toward north. SVG rotation of needle = -buildingRotation.
 */
function CompassWidget({ rotation }) {
  const S = 112, cx = S / 2, cy = S / 2, R = 46;
  const toRad = d => d * Math.PI / 180;

  // Eight tick marks; major = cardinal (0/90/180/270)
  const ticks = Array.from({ length: 16 }, (_, i) => i * 22.5);

  return (
    <svg width={S} height={S} style={{ display: "block", margin: "0 auto" }}>
      {/* Outer ring — fixed, never rotates */}
      <circle cx={cx} cy={cy} r={R} fill="#0a1628" stroke="#1e3a6b" strokeWidth={1.5}/>

      {/* Everything inside rotates together so north always points up on screen.
          rotation = degrees CW from north to +X axis; rotating the rose by +rotation
          keeps north fixed at screen-top while the rest of the rose spins. */}
      <g transform={`rotate(${rotation}, ${cx}, ${cy})`}>

        {/* Tick marks */}
        {ticks.map(deg => {
          const rad     = toRad(deg - 90);
          const isMaj   = deg % 90 === 0;
          const isMinor = deg % 45 === 0 && !isMaj;
          const r1 = R - 1;
          const r2 = R - (isMaj ? 9 : isMinor ? 6 : 4);
          return (
            <line key={deg}
              x1={cx + r1 * Math.cos(rad)} y1={cy + r1 * Math.sin(rad)}
              x2={cx + r2 * Math.cos(rad)} y2={cy + r2 * Math.sin(rad)}
              stroke={isMaj ? "#2d5a8a" : "#1a3050"}
              strokeWidth={isMaj ? 1.5 : 1}
            />
          );
        })}

        {/* Cardinal labels */}
        {[
          { l: "N", dx:  0,       dy: -(R-12), color: "#38bdf8", fw: "bold",   fs: 10 },
          { l: "S", dx:  0,       dy:   R-12,  color: "#2d5a8a", fw: "normal", fs: 8  },
          { l: "E", dx:  R-12,    dy:  0,      color: "#2d5a8a", fw: "normal", fs: 8  },
          { l: "W", dx: -(R-12),  dy:  0,      color: "#2d5a8a", fw: "normal", fs: 8  },
        ].map(({ l, dx, dy, color, fw, fs }) => (
          <text key={l}
            x={cx + dx} y={cy + dy}
            textAnchor="middle" dominantBaseline="middle"
            fontSize={fs} fill={color} fontWeight={fw}
            style={{ userSelect: "none", fontFamily: "monospace" }}
          >{l}</text>
        ))}

        {/* Needle */}
        {/* North half — bright */}
        <polygon
          points={`
            ${cx},         ${cy - R + 14}
            ${cx - 5.5},   ${cy + 3}
            ${cx},         ${cy + 1}
            ${cx + 5.5},   ${cy + 3}
          `}
          fill="#38bdf8"
        />
        {/* South half — dim */}
        <polygon
          points={`
            ${cx},         ${cy + R - 14}
            ${cx - 5.5},   ${cy - 3}
            ${cx},         ${cy - 1}
            ${cx + 5.5},   ${cy - 3}
          `}
          fill="#1e3a6b"
        />
        {/* Centre pivot */}
        <circle cx={cx} cy={cy} r={3} fill="#070d1a" stroke="#2d5a8a" strokeWidth={1.2}/>

      </g>
    </svg>
  );
}

/**
 * Tiny north arrow shown as a canvas overlay.
 * size=36, arrow points in the direction of north relative to the floor plan.
 * North SVG direction: (-sin(r), -cos(r)) where r is in radians.
 */
function NorthOverlay({ rotation }) {
  const S = 36, cx = S / 2, cy = S / 2, len = 13;
  const r   = -rotation * Math.PI / 180;
  const nx  = cx - Math.sin(r) * len;
  const ny  = cy - Math.cos(r) * len;
  // Perpendicular unit for arrowhead
  const px  = -Math.cos(r), py = Math.sin(r);
  const hw  = 3.5, hl = 6;
  const tip = { x: nx, y: ny };
  const b   = { x: cx - Math.sin(r) * (len - hl), y: cy - Math.cos(r) * (len - hl) };
  return (
    <svg width={S} height={S} style={{ display: "block", overflow: "visible" }}>
      <circle cx={cx} cy={cy} r={S / 2 - 1} fill="#070d1a99" stroke="#1e3a6b" strokeWidth={1}/>
      {/* Shaft */}
      <line x1={cx} y1={cy} x2={tip.x} y2={tip.y} stroke="#38bdf8" strokeWidth={1.2}/>
      {/* Arrowhead */}
      <polygon
        points={`${tip.x},${tip.y} ${b.x + px * hw},${b.y + py * hw} ${b.x - px * hw},${b.y - py * hw}`}
        fill="#38bdf8"
      />
      {/* N label — placed just past the arrowhead along the north direction */}
      <text x={tip.x - Math.sin(r) * 5} y={tip.y - Math.cos(r) * 5}
        textAnchor="middle" dominantBaseline="central"
        fontSize={6} fill="#38bdf8" fontWeight="bold"
        style={{ userSelect: "none", fontFamily: "monospace" }}
      >N</text>
    </svg>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function FloorPlanUI({ projectId }) {
  const pk = (key) => `${projectId}_${key}`;
  const svgRef = useRef(null);

  // ── View ──
  const [zoom, setZoom] = useState(1);
  const [pan,  setPan]  = useState({ x: 280, y: 220 });
  const zoomRef = useRef(1), panRef = useRef({ x: 280, y: 220 });
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { panRef.current  = pan;  }, [pan]);

  // ── Storeys ──
  const STOREY_LABELS = STOREY_LABELS_CONST;
  const [activeStorey, setActiveStorey] = useState(0);

  // ── Wall-graph state (source of truth) ──
  const [wallsByStorey, setWallsByStorey] = useState(() => {
    try {
      const s = localStorage.getItem(pk("floorplan_walls"));
      if (s) return JSON.parse(s);
      const legacy = localStorage.getItem(pk("floorplan_rooms"));
      if (legacy) return migrateRoomsToWalls(JSON.parse(legacy)).wallsByStorey;
      return { 0:[], 1:[], 2:[] };
    } catch { return { 0:[], 1:[], 2:[] }; }
  });
  const [openingsByStorey, setOpeningsByStorey] = useState(() => {
    try {
      const s = localStorage.getItem(pk("floorplan_openings"));
      if (s) return JSON.parse(s);
      const legacy = localStorage.getItem(pk("floorplan_rooms"));
      if (legacy) return migrateRoomsToWalls(JSON.parse(legacy)).openingsByStorey;
      return { 0:[], 1:[], 2:[] };
    } catch { return { 0:[], 1:[], 2:[] }; }
  });
  const [areaMetaByStorey, setAreaMetaByStorey] = useState(() => {
    try {
      const s = localStorage.getItem(pk("floorplan_area_meta"));
      if (s) return JSON.parse(s);
      const legacy = localStorage.getItem(pk("floorplan_rooms"));
      if (legacy) return migrateRoomsToWalls(JSON.parse(legacy)).areaMetaByStorey;
      return { 0:{}, 1:{}, 2:{} };
    } catch { return { 0:{}, 1:{}, 2:{} }; }
  });

  const [ceilingHeights, setCeilingHeights] = useState(() => {
    try { const s = localStorage.getItem(pk("floorplan_ceilings")); return s ? JSON.parse(s) : { 0:3.0, 1:2.7, 2:2.5 }; }
    catch { return { 0:3.0, 1:2.7, 2:2.5 }; }
  });
  const [globalU, setGlobalU] = useState(() => {
    try { const s = localStorage.getItem(pk("floorplan_uvalues")); return s ? JSON.parse(s) : { ...DEFAULT_U_VALUES }; }
    catch { return { ...DEFAULT_U_VALUES }; }
  });
  const [buildingRotation, setBuildingRotation] = useState(() => {
    try { const s = localStorage.getItem(pk("floorplan_rotation")); return s ? JSON.parse(s) : 0; }
    catch { return 0; }
  });

  const [roofsByStorey, setRoofsByStorey] = useState(() => {
    try { const s = localStorage.getItem(pk("floorplan_roofs")); return s ? JSON.parse(s) : { 0:[], 1:[], 2:[] }; }
    catch { return { 0:[], 1:[], 2:[] }; }
  });

  // ── Derived areas (rooms) from wall graph ──
  const derivedAreasByStorey = useMemo(() => {
    const result = {};
    for (let s = 0; s < STOREY_LABELS.length; s++) {
      const sWalls = wallsByStorey[s] || [];
      const sOpenings = openingsByStorey[s] || [];
      const meta = areaMetaByStorey[s] || {};
      const faces = findClosedAreas(sWalls);
      result[s] = faces.map((face, idx) => {
        const key = areaKey(face.wallIds);
        const m = meta[key] || {};
        const pal = PALETTE[idx % PALETTE.length];
        const wallUs = {};
        const faceOpenings = [];
        face.wallIds.forEach((wid, i) => {
          const w = sWalls.find(ww => ww.id === wid);
          if (w && w.uValue != null) wallUs[i] = w.uValue;
          for (const o of sOpenings.filter(oo => oo.wallId === wid)) {
            faceOpenings.push({ ...o, wallIdx: i });
          }
        });
        return {
          id: key,
          wallIds: face.wallIds,
          name: m.name || `Room ${idx+1}`,
          points: face.points,
          openings: faceOpenings,
          wallUs,
          floorU: m.floorU ?? null,
          roofU: m.roofU ?? null,
          use: m.use, isHeated: m.isHeated,
          bg: m.bg || pal.bg, line: m.line || pal.line, label: m.label || pal.label,
        };
      });
    }
    return result;
  }, [wallsByStorey, openingsByStorey, areaMetaByStorey]);

  // Lazily seed area metadata (name + palette) for newly-enclosed areas so
  // they keep a stable identity/colour even as other areas are added/removed.
  useEffect(() => {
    setAreaMetaByStorey(prev => {
      let changed = false;
      const next = { ...prev };
      for (let s = 0; s < STOREY_LABELS.length; s++) {
        const faces = findClosedAreas(wallsByStorey[s] || []);
        const meta = { ...(next[s] || {}) };
        for (const face of faces) {
          const key = areaKey(face.wallIds);
          if (!meta[key]) {
            const pal = PALETTE[Object.keys(meta).length % PALETTE.length];
            meta[key] = { name: `Room ${Object.keys(meta).length+1}`, ...pal };
            changed = true;
          }
        }
        next[s] = meta;
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallsByStorey]);

  // roomsByStorey shape, derived — kept for geometryProcessor / other views
  const roomsByStorey = useMemo(() => {
    const r = {};
    for (let s = 0; s < STOREY_LABELS.length; s++) r[s] = derivedAreasByStorey[s] || [];
    return r;
  }, [derivedAreasByStorey]);

  // Storey validity — every storey's walls must form at least one closed loop
  // (or have no walls at all).
  const floorplanValid = useMemo(
    () => Array.from({ length: STOREY_LABELS.length }).every((_, s) => hasClosedBoundary(wallsByStorey[s] || [])),
    [wallsByStorey]
  );

  // ── Centre view on existing geometry when opening an existing project ──
  // useLayoutEffect runs before the browser paints, so the recentred pan
  // is applied to the very first frame and avoids a visible flicker.
  useLayoutEffect(() => {
    const allPts = Object.values(wallsByStorey).flat().flatMap(w => [w.a, w.b]);
    if (allPts.length === 0) return;
    const xs = allPts.map(p => p.x), ys = allPts.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const W = svgRef.current?.clientWidth || 900, H = svgRef.current?.clientHeight || 600;
    const np = { x: W / 2 - cx * zoomRef.current * PPM, y: H / 2 - cy * zoomRef.current * PPM };
    setPan(np); panRef.current = np;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const roofs = roofsByStorey[activeStorey] || [];
  const setRoofs = useCallback((updater) => {
    setRoofsByStorey(prev => ({
      ...prev,
      [activeStorey]: typeof updater === "function" ? updater(prev[activeStorey] || []) : updater,
    }));
  }, [activeStorey]);

  const ceilingH = ceilingHeights[activeStorey];
  const adjustCeiling = (delta) => {
    setCeilingHeights(h => {
      const newH = Math.round(Math.max(1.8, Math.min(6.0, h[activeStorey]+delta))*10)/10;
      recorder.record("ceiling_adjust", { storey: activeStorey, height: newH });
      return { ...h, [activeStorey]: newH };
    });
  };

  const walls = wallsByStorey[activeStorey] || [];
  const wallsRef = useRef(walls);
  useEffect(() => { wallsRef.current = walls; }, [walls]);
  const setWalls = useCallback((updater) => {
    setWallsByStorey(prev => ({
      ...prev,
      [activeStorey]: typeof updater === "function" ? updater(prev[activeStorey] || []) : updater,
    }));
  }, [activeStorey]);

  const openings = openingsByStorey[activeStorey] || [];
  const setOpenings = useCallback((updater) => {
    setOpeningsByStorey(prev => ({
      ...prev,
      [activeStorey]: typeof updater === "function" ? updater(prev[activeStorey] || []) : updater,
    }));
  }, [activeStorey]);

  const areas = derivedAreasByStorey[activeStorey] || [];

  // ── Persist ──
  const [savedAt, setSavedAt] = useState(null);
  useEffect(() => { try { localStorage.setItem(pk("floorplan_walls"), JSON.stringify(wallsByStorey)); } catch {} }, [wallsByStorey]);
  useEffect(() => { try { localStorage.setItem(pk("floorplan_openings"), JSON.stringify(openingsByStorey)); } catch {} }, [openingsByStorey]);
  useEffect(() => { try { localStorage.setItem(pk("floorplan_area_meta"), JSON.stringify(areaMetaByStorey)); } catch {} }, [areaMetaByStorey]);
  useEffect(() => { try { localStorage.setItem(pk("floorplan_rooms"), JSON.stringify(roomsByStorey)); setSavedAt(new Date()); } catch {} }, [roomsByStorey]);
  useEffect(() => { try { localStorage.setItem(pk("floorplan_ceilings"), JSON.stringify(ceilingHeights)); } catch {} }, [ceilingHeights]);
  useEffect(() => { try { localStorage.setItem(pk("floorplan_uvalues"),   JSON.stringify(globalU));           } catch {} }, [globalU]);
  useEffect(() => { try { localStorage.setItem(pk("floorplan_rotation"), JSON.stringify(buildingRotation));   } catch {} }, [buildingRotation]);
  useEffect(() => { try { localStorage.setItem(pk("floorplan_roofs"),    JSON.stringify(roofsByStorey));      } catch {} }, [roofsByStorey]);
  useEffect(() => { try { localStorage.setItem(pk("floorplan_valid"), floorplanValid ? "true" : "false"); } catch {} }, [floorplanValid]);

  // Persist BuildingModel so other views (3D, energy model) can consume it.
  useEffect(() => {
    try {
      const model = buildingModelFromState({
        roomsByStorey, ceilingHeights, globalU,
        site: { buildingRotation },
      });
      localStorage.setItem(pk("building_model"), JSON.stringify(model));
    } catch {}
  }, [roomsByStorey, ceilingHeights, globalU, buildingRotation]);

  const clearStorage = () => {
    if (!window.confirm("Clear all floors and start over?")) return;
    recorder.record("clear_all");
    try {
      ["floorplan_walls","floorplan_openings","floorplan_area_meta","floorplan_rooms","floorplan_ceilings","floorplan_uvalues","floorplan_rotation","floorplan_roofs","floorplan_valid"]
        .forEach(k => localStorage.removeItem(pk(k)));
    } catch {}
    setWallsByStorey({ 0:[], 1:[], 2:[] });
    setOpeningsByStorey({ 0:[], 1:[], 2:[] });
    setAreaMetaByStorey({ 0:{}, 1:{}, 2:{} });
    setCeilingHeights({ 0:3.0, 1:2.7, 2:2.5 });
    setGlobalU({ ...DEFAULT_U_VALUES });
    setBuildingRotation(0);
    setRoofsByStorey({ 0:[], 1:[], 2:[] });
    setSelectedId(null); setSelectedWallId(null); setSelectedOpening(null); setDraft([]);
    setSelectedRoofId(null); setRoofDraft([]);
    undoStack.current = []; redoStack.current = []; pendingBase.current = null;
    if (historyTimer.current) { clearTimeout(historyTimer.current); historyTimer.current = null; }
    skipHistory.current = true;
    setUndoAvailable(false); setRedoAvailable(false);
  };

  // ── Undo / Redo ──
  // Snapshot-based history over the floor plan's drawn geometry (walls,
  // openings, area metadata and roofs per storey). Rapid successive changes
  // (e.g. dragging a vertex) are coalesced into a single undo step via a
  // short debounce.
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const skipHistory = useRef(false);
  const historySnapshot = useRef({ wallsByStorey, openingsByStorey, areaMetaByStorey, roofsByStorey });
  const pendingBase = useRef(null);
  const historyTimer = useRef(null);
  const [undoAvailable, setUndoAvailable] = useState(false);
  const [redoAvailable, setRedoAvailable] = useState(false);

  useEffect(() => {
    if (skipHistory.current) {
      skipHistory.current = false;
      historySnapshot.current = { wallsByStorey, openingsByStorey, areaMetaByStorey, roofsByStorey };
      return;
    }
    if (pendingBase.current === null) pendingBase.current = historySnapshot.current;
    historySnapshot.current = { wallsByStorey, openingsByStorey, areaMetaByStorey, roofsByStorey };
    redoStack.current = [];
    setRedoAvailable(false);
    setUndoAvailable(true);
    if (historyTimer.current) clearTimeout(historyTimer.current);
    historyTimer.current = setTimeout(() => {
      undoStack.current.push(pendingBase.current);
      if (undoStack.current.length > 100) undoStack.current.shift();
      pendingBase.current = null;
      historyTimer.current = null;
    }, 400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallsByStorey, openingsByStorey, areaMetaByStorey, roofsByStorey]);

  useEffect(() => () => { if (historyTimer.current) clearTimeout(historyTimer.current); }, []);

  const flushHistory = () => {
    if (historyTimer.current) { clearTimeout(historyTimer.current); historyTimer.current = null; }
    if (pendingBase.current !== null) {
      undoStack.current.push(pendingBase.current);
      if (undoStack.current.length > 100) undoStack.current.shift();
      pendingBase.current = null;
    }
  };

  const undo = useCallback(() => {
    flushHistory();
    if (undoStack.current.length === 0) return;
    const prevState = undoStack.current.pop();
    redoStack.current.push({ wallsByStorey, openingsByStorey, areaMetaByStorey, roofsByStorey });
    skipHistory.current = true;
    setWallsByStorey(prevState.wallsByStorey);
    setOpeningsByStorey(prevState.openingsByStorey);
    setAreaMetaByStorey(prevState.areaMetaByStorey);
    setRoofsByStorey(prevState.roofsByStorey);
    setSelectedId(null); setSelectedWallId(null); setSelectedOpening(null); setSelectedRoofId(null); setSelectedRoofEdge(null);
    setUndoAvailable(undoStack.current.length > 0);
    setRedoAvailable(true);
    recorder.record("undo");
  }, [wallsByStorey, openingsByStorey, areaMetaByStorey, roofsByStorey]);

  const redo = useCallback(() => {
    if (redoStack.current.length === 0) return;
    const nextState = redoStack.current.pop();
    flushHistory();
    undoStack.current.push({ wallsByStorey, openingsByStorey, areaMetaByStorey, roofsByStorey });
    skipHistory.current = true;
    setWallsByStorey(nextState.wallsByStorey);
    setOpeningsByStorey(nextState.openingsByStorey);
    setAreaMetaByStorey(nextState.areaMetaByStorey);
    setRoofsByStorey(nextState.roofsByStorey);
    setSelectedId(null); setSelectedWallId(null); setSelectedOpening(null); setSelectedRoofId(null); setSelectedRoofEdge(null);
    setUndoAvailable(true);
    setRedoAvailable(redoStack.current.length > 0);
    recorder.record("redo");
  }, [wallsByStorey, openingsByStorey, areaMetaByStorey, roofsByStorey]);

  // ── Session recording ──
  // Keep refs so the state getter always reads the latest values without re-registering.
  const _recWalls    = useRef(wallsByStorey);
  const _recOpenings = useRef(openingsByStorey);
  const _recAreaMeta = useRef(areaMetaByStorey);
  const _recCeilings = useRef(ceilingHeights);
  const _recGlobalU  = useRef(globalU);
  const _recRotation = useRef(buildingRotation);
  useEffect(() => { _recWalls.current    = wallsByStorey;    }, [wallsByStorey]);
  useEffect(() => { _recOpenings.current = openingsByStorey; }, [openingsByStorey]);
  useEffect(() => { _recAreaMeta.current = areaMetaByStorey; }, [areaMetaByStorey]);
  useEffect(() => { _recCeilings.current = ceilingHeights;   }, [ceilingHeights]);
  useEffect(() => { _recGlobalU.current  = globalU;          }, [globalU]);
  useEffect(() => { _recRotation.current = buildingRotation; }, [buildingRotation]);

  useEffect(() => {
    recorder.setStateGetter(() => ({
      wallsByStorey:    _recWalls.current,
      openingsByStorey: _recOpenings.current,
      areaMetaByStorey: _recAreaMeta.current,
      ceilingHeights:   _recCeilings.current,
      globalU:          _recGlobalU.current,
      buildingRotation: _recRotation.current,
    }));
    recorder.start();
  }, []);

  // ── Replay ──
  const [showReplay, setShowReplay] = useState(false);

  // ── Tool & drawing ──
  const [tool,      setTool]      = useState("wall");
  const [draft,     setDraft]     = useState([]);
  const [cursor,    setCursor]    = useState({ x:0, y:0 });
  const [snapOn,    setSnapOn]    = useState(true);
  const [gridSnap,  setGridSnap]  = useState(false);
  const [snapGuides, setSnapGuides] = useState([]);
  const [lengthInput, setLengthInput] = useState(""); // typed wall-length override (metres)
  const [showGhost, setShowGhost] = useState(true);

  // ── Roof drawing & selection ──
  const [roofDraft,      setRoofDraft]      = useState([]);
  const [selectedRoofId, setSelectedRoofId] = useState(null);
  const [selectedRoofEdge, setSelectedRoofEdge] = useState(null); // { roofId, edgeIdx }

  // ── Selection ──
  const [selectedId,      setSelectedId]      = useState(null); // derived area id
  const [selectedWallId,  setSelectedWallId]  = useState(null);
  const [selectedOpening, setSelectedOpening] = useState(null); // { openingId }
  const [hoveredId,       setHoveredId]       = useState(null);
  const [wallHover,       setWallHover]       = useState(null);

  // ── Panel sections open/closed ──
  const [secU,    setSecU]    = useState(true);  // U-values in panel
  const [secWall, setSecWall] = useState(false); // Wall list in area panel
  const [secDef,  setSecDef]  = useState(false); // Global defaults always-on at panel bottom

  // ── Pointer ──
  const panState   = useRef({ active: false, origin: null, startPan: null });
  const dragVertex = useRef(null);

  // ── Coords ──
  const svgPt = useCallback((e) => {
    const r = svgRef.current.getBoundingClientRect();
    return { x: (e.clientX-r.left-panRef.current.x)/(zoomRef.current*PPM), y: (e.clientY-r.top-panRef.current.y)/(zoomRef.current*PPM) };
  }, []);
  const snapPt = useCallback((pt) => {
    if (!snapOn) return pt;
    return { x: Math.round(pt.x/GRID)*GRID, y: Math.round(pt.y/GRID)*GRID };
  }, [snapOn]);

  const lw = 1.5 / (zoom * PPM);
  const closeThreshold = 20 / (zoom * PPM);

  // Snap a candidate point onto an existing wall endpoint, if close enough —
  // lets new wall chains connect to / close against existing geometry.
  const snapToExisting = useCallback((pt) => {
    let best = closeThreshold, found = null;
    for (const w of wallsRef.current) {
      for (const ep of [w.a, w.b]) {
        const d = dist(pt, ep);
        if (d < best) { best = d; found = ep; }
      }
    }
    return found;
  }, [closeThreshold]);

  // ── Geometry snapping ──
  // Priority 1: snap straight onto existing wall geometry — either an
  // endpoint, or any point along a wall (for T-junction/partition walls).
  // Returns which axes the snap actually constrains: an endpoint constrains
  // both x and y. A projection onto an axis-aligned wall only constrains the
  // axis perpendicular to it — the other axis is left free for axis-snapping
  // (priorities 2 & 3) to combine. A projection onto a diagonal wall
  // constrains the point to lie on that `line`, but leaves one degree of
  // freedom (position along the line) for axis-snapping to resolve.
  const wallGeometrySnap = useCallback((pt) => {
    const r = SNAP_PX / (zoomRef.current * PPM);
    let bestD = r, snapped = null, lockX = false, lockY = false, line = null;
    for (const w of wallsRef.current) {
      for (const ep of [w.a, w.b]) {
        const d = dist(pt, ep);
        if (d < bestD) { bestD = d; snapped = { x: ep.x, y: ep.y }; lockX = true; lockY = true; line = null; }
      }
    }
    for (const w of wallsRef.current) {
      const d = distToSegment(pt, w.a, w.b);
      if (d < bestD) {
        const { t } = projectOntoWall(pt, w.a, w.b);
        bestD = d;
        snapped = { x: w.a.x + t * (w.b.x - w.a.x), y: w.a.y + t * (w.b.y - w.a.y) };
        const dx = w.b.x - w.a.x, dy = w.b.y - w.a.y;
        if (Math.abs(dx) < 1e-9) { lockX = true; lockY = false; line = null; }
        else if (Math.abs(dy) < 1e-9) { lockX = false; lockY = true; line = null; }
        else { lockX = false; lockY = false; line = { a: w.a, b: w.b }; }
      }
    }
    return snapped ? { point: snapped, lockX, lockY, line } : null;
  }, []);

  // Priorities 2 & 3, applied per-axis: snap to horizontal/vertical relative
  // to the previous drafted point (`last`), then snap to be aligned with the
  // x/y of any existing wall endpoint. Each axis (x, y) is resolved
  // independently, so e.g. a horizontal snap (which fixes y) doesn't prevent
  // x from separately snapping into alignment with another endpoint. Also
  // reports *how* each axis was snapped (xSrc/ySrc), so a diagonal-wall
  // projection can pick whichever axis snapped with higher priority and
  // slide along its line to match it.
  const axisSnap = useCallback((pt, last) => {
    const r = SNAP_PX / (zoomRef.current * PPM);
    let { x, y } = pt, xSrc = null, ySrc = null, xRef = null, yRef = null;

    if (last) {
      if (Math.abs(pt.y - last.y) < r) { y = last.y; ySrc = "last"; }
      if (Math.abs(pt.x - last.x) < r) { x = last.x; xSrc = "last"; }
    }
    if (!xSrc || !ySrc) {
      let bestXd = r, bestYd = r;
      for (const w of wallsRef.current) {
        for (const ep of [w.a, w.b]) {
          if (!xSrc) { const d = Math.abs(pt.x - ep.x); if (d < bestXd) { bestXd = d; x = ep.x; xSrc = "endpoint"; xRef = ep; } }
          if (!ySrc) { const d = Math.abs(pt.y - ep.y); if (d < bestYd) { bestYd = d; y = ep.y; ySrc = "endpoint"; yRef = ep; } }
        }
      }
    }
    return { x, y, xSrc, ySrc, xRef, yRef };
  }, []);

  // Resolve a candidate point under the cursor, given the previous drafted
  // point (`last`, if any). Grid-snap mode keeps the legacy behaviour;
  // geometry-snap (the default) follows the priority order: existing wall
  // geometry > horizontal/vertical from `last` > alignment with endpoints.
  // Wall-geometry snapping only locks the axis (or, for a diagonal wall, the
  // line) it actually constrains, so it combines with axis-snapping on the
  // remaining degree of freedom.
  const getSnappedPoint = useCallback((pt, last = null) => {
    if (gridSnap) return { ...(snapToExisting(pt) || (snapOn ? snapPt(pt) : pt)), guides: [] };
    if (!snapOn) return { ...pt, guides: [] };
    const geo = wallGeometrySnap(pt);
    if (geo && geo.lockX && geo.lockY) return { ...geo.point, guides: [] };
    const ax = axisSnap(pt, last);
    if (geo && geo.line) {
      const { a, b } = geo.line;
      const dx = b.x - a.x, dy = b.y - a.y;
      const xRank = ax.xSrc ? SRC_PRIORITY[ax.xSrc] : Infinity;
      const yRank = ax.ySrc ? SRC_PRIORITY[ax.ySrc] : Infinity;
      if (xRank <= yRank && xRank < Infinity) {
        const point = { x: ax.x, y: a.y + (ax.x - a.x) * dy / dx };
        const g = axisGuide("x", point, ax);
        return { ...point, guides: g ? [g] : [] };
      }
      if (yRank < Infinity) {
        const point = { x: a.x + (ax.y - a.y) * dx / dy, y: ax.y };
        const g = axisGuide("y", point, ax);
        return { ...point, guides: g ? [g] : [] };
      }
      return { ...geo.point, guides: [] };
    }
    const point = {
      x: geo && geo.lockX ? geo.point.x : ax.x,
      y: geo && geo.lockY ? geo.point.y : ax.y,
    };
    const guides = [];
    if (!(geo && geo.lockX)) { const g = axisGuide("x", point, ax); if (g) guides.push(g); }
    if (!(geo && geo.lockY)) { const g = axisGuide("y", point, ax); if (g) guides.push(g); }
    return { ...point, guides };
  }, [gridSnap, snapOn, snapToExisting, snapPt, wallGeometrySnap, axisSnap]);

  // When a wall length has been typed, the new point is placed exactly
  // `length` away from `last`, along the cursor direction — but horizontal
  // and vertical snapping (relative to `last`) still applies to that
  // direction. No other snapping (wall geometry, endpoint alignment) applies.
  const lengthSnappedPoint = useCallback((raw, last, length) => {
    const r = SNAP_PX / (zoomRef.current * PPM);
    let dx = raw.x - last.x, dy = raw.y - last.y;
    if (snapOn) {
      if (Math.abs(dy) < r) dy = 0;
      if (Math.abs(dx) < r) dx = 0;
    }
    let mag = Math.hypot(dx, dy);
    if (mag < 1e-9) { dx = 1; dy = 0; mag = 1; }
    return { x: last.x + (dx / mag) * length, y: last.y + (dy / mag) * length };
  }, [snapOn]);

  // ── Wall hover (for placing windows/doors) ──
  const findWallHover = useCallback((cursor, walls, openingWidth) => {
    let best = WALL_HOVER_THRESHOLD, result = null;
    for (const w of walls) {
      const d = distToSegment(cursor, w.a, w.b);
      if (d < best) {
        const { t, len } = projectOntoWall(cursor, w.a, w.b);
        const half = openingWidth / 2;
        if (len < openingWidth + 0.1) continue;
        best = d;
        result = { wallId: w.id, offset: Math.max(half, Math.min(len-half, t*len))-half, wallLen: len };
      }
    }
    return result;
  }, []);

  // ── U-value / metadata helpers ──
  const effU = (override, defaultVal) => (override !== null && override !== undefined) ? override : defaultVal;
  const updateAreaMeta = useCallback((areaId, key, value) => {
    recorder.record("uvalue_room", { areaId, key, value });
    setAreaMetaByStorey(prev => {
      const meta = { ...(prev[activeStorey] || {}) };
      meta[areaId] = { ...(meta[areaId] || {}), [key]: value };
      return { ...prev, [activeStorey]: meta };
    });
  }, [activeStorey]);
  const renameArea = useCallback((areaId, name) => {
    recorder.record("room_rename", { areaId, name });
    setAreaMetaByStorey(prev => {
      const meta = { ...(prev[activeStorey] || {}) };
      meta[areaId] = { ...(meta[areaId] || {}), name };
      return { ...prev, [activeStorey]: meta };
    });
  }, [activeStorey]);
  const updateWallU = useCallback((wallId, value) => {
    recorder.record("uvalue_wall", { wallId, value });
    setWalls(ws => ws.map(w => w.id === wallId ? { ...w, uValue: value } : w));
  }, [setWalls]);
  const updateOpeningU = useCallback((openingId, value) => {
    recorder.record("uvalue_opening", { openingId, value });
    setOpenings(os => os.map(o => o.id === openingId ? { ...o, uValue: value } : o));
  }, [setOpenings]);
  const updateOpeningSHGC = useCallback((openingId, value) => {
    recorder.record("shgc_opening", { openingId, value });
    setOpenings(os => os.map(o => o.id === openingId
      ? { ...o, glazing: { ...(o.glazing ?? {}), solarHeatGainCoeff: value } } : o));
  }, [setOpenings]);

  // ── New opening factory ──
  const newOpening = useCallback((tool, wh) => ({
    id: uid(), wallId: wh.wallId, type: tool, offset: wh.offset,
    width: OPENING_DEFAULTS[tool].width, height: OPENING_DEFAULTS[tool].height,
    sillHeight: OPENING_DEFAULTS[tool].sillHeight, uValue: null,
  }), []);

  // ── Mouse ──
  const onMouseMove = useCallback((e) => {
    const p = panState.current;
    if (p.active) { const np = { x: p.startPan.x+e.clientX-p.origin.x, y: p.startPan.y+e.clientY-p.origin.y }; setPan(np); panRef.current = np; return; }
    const raw = svgPt(e);
    const last = tool === "wall" ? (draft.length ? draft[draft.length-1] : null)
      : tool === "roof" ? (roofDraft.length ? roofDraft[roofDraft.length-1] : null)
      : null;
    let pt;
    if (dragVertex.current) {
      // While dragging a vertex, skip geometry snapping (which would snap to the
      // vertex's own old position) and use only axis alignment against other endpoints.
      if (snapOn && !gridSnap) {
        const { draggedWallIds } = dragVertex.current;
        const r = SNAP_PX / (zoomRef.current * PPM);
        let { x, y } = raw;
        let bestXd = r, bestYd = r;
        for (const w of wallsRef.current) {
          if (draggedWallIds.has(w.id)) continue; // skip walls containing the dragged vertex
          for (const ep of [w.a, w.b]) {
            const dx = Math.abs(raw.x - ep.x);
            const dy = Math.abs(raw.y - ep.y);
            if (dx < bestXd) { bestXd = dx; x = ep.x; }
            if (dy < bestYd) { bestYd = dy; y = ep.y; }
          }
        }
        pt = { x, y };
      } else {
        pt = raw;
      }
      setSnapGuides([]);
    } else if (tool === "wall" && draft.length > 0 && lengthInput) {
      pt = lengthSnappedPoint(raw, draft[draft.length-1], parseFloat(lengthInput) || 0);
      setSnapGuides([]);
    } else {
      const snapped = getSnappedPoint(raw, last);
      pt = { x: snapped.x, y: snapped.y };
      setSnapGuides(snapped.guides);
    }
    setCursor(pt);
    if (dragVertex.current) {
      const origin = dragVertex.current.point;
      setWalls(ws => ws.map(w => {
        let a = w.a, b = w.b;
        if (dist(w.a, origin) < VERTEX_TOL) a = pt;
        if (dist(w.b, origin) < VERTEX_TOL) b = pt;
        return (a !== w.a || b !== w.b) ? { ...w, a, b } : w;
      }));
      dragVertex.current.point = pt;
      return;
    }
    if (tool === "window" || tool === "door") setWallHover(findWallHover(raw, wallsRef.current, OPENING_DEFAULTS[tool].width));
    else setWallHover(null);
  }, [svgPt, getSnappedPoint, tool, draft, roofDraft, findWallHover, setWalls, lengthInput, lengthSnappedPoint, snapOn, gridSnap]);

  const onMouseDown = useCallback((e) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      panState.current = { active: true, origin: { x:e.clientX, y:e.clientY }, startPan: {...panRef.current} };
      e.preventDefault();
    }
  }, []);
  const onMouseUp = useCallback(() => {
    panState.current.active = false;
    if (dragVertex.current) {
      recorder.record("vertex_drag_end", { point: dragVertex.current.point });
      dragVertex.current = null;
    }
  }, []);

  const onCanvasClick = useCallback((e) => {
    if (panState.current.active) return;
    const rawPt = svgPt(e);
    const last = tool === "wall" ? (draft.length ? draft[draft.length-1] : null)
      : tool === "roof" ? (roofDraft.length ? roofDraft[roofDraft.length-1] : null)
      : null;
    let pt;
    if (tool === "wall" && draft.length > 0 && lengthInput) {
      pt = lengthSnappedPoint(rawPt, draft[draft.length-1], parseFloat(lengthInput) || 0);
    } else {
      const snapped = getSnappedPoint(rawPt, last);
      pt = { x: snapped.x, y: snapped.y };
    }

    if (tool === "window" || tool === "door") {
      const wh = findWallHover(rawPt, walls, OPENING_DEFAULTS[tool].width);
      if (wh) {
        setOpenings(os => [...os, newOpening(tool, wh)]);
        recorder.record("opening_add", { type: tool, wallId: wh.wallId, offset: wh.offset });
      }
      return;
    }

    if (tool === "select") {
      // Openings first
      for (const o of openings) {
        const w = walls.find(ww => ww.id === o.wallId);
        if (!w) continue;
        const wLen = dist(w.a, w.b);
        const dir = { x:(w.b.x-w.a.x)/wLen, y:(w.b.y-w.a.y)/wLen };
        const mid = { x:w.a.x+dir.x*(o.offset+o.width/2), y:w.a.y+dir.y*(o.offset+o.width/2) };
        if (dist(rawPt, mid) < Math.max(0.25, o.width/2)) {
          setSelectedOpening({ openingId: o.id }); setSelectedId(null); setSelectedWallId(null);
          setSelectedRoofId(null); setSelectedRoofEdge(null);
          recorder.record("select_opening", { openingId: o.id });
          return;
        }
      }
      // Roof edge (when a roof is already selected)
      if (selectedRoofId) {
        const selRoof = roofs.find(r => r.id === selectedRoofId);
        if (selRoof) {
          const { points: rp } = selRoof;
          for (let i = 0; i < rp.length; i++) {
            const j = (i + 1) % rp.length;
            if (distToSegment(rawPt, rp[i], rp[j]) < WALL_HOVER_THRESHOLD) {
              setSelectedRoofEdge({ roofId: selectedRoofId, edgeIdx: i });
              return;
            }
          }
        }
      }
      // Roof body
      const hitRoof = [...roofs].reverse().find(r => pointInPoly(rawPt, r.points));
      if (hitRoof) {
        setSelectedRoofId(hitRoof.id); setSelectedRoofEdge(null);
        setSelectedId(null); setSelectedWallId(null); setSelectedOpening(null);
        return;
      }
      // Walls
      let bestWall = null, bestD = WALL_HOVER_THRESHOLD;
      for (const w of walls) {
        const d = distToSegment(rawPt, w.a, w.b);
        if (d < bestD) { bestD = d; bestWall = w; }
      }
      if (bestWall) {
        setSelectedWallId(bestWall.id); setSelectedId(null); setSelectedOpening(null);
        setSelectedRoofId(null); setSelectedRoofEdge(null);
        recorder.record("select_wall", { wallId: bestWall.id });
        return;
      }
      // Areas
      const hit = [...areas].reverse().find(a => pointInPoly(rawPt, a.points));
      if (hit) {
        setSelectedId(hit.id); setSelectedWallId(null); setSelectedOpening(null);
        setSelectedRoofId(null); setSelectedRoofEdge(null);
        recorder.record("select_room", { areaId: hit.id });
      } else {
        setSelectedId(null); setSelectedWallId(null); setSelectedOpening(null);
        setSelectedRoofId(null); setSelectedRoofEdge(null);
        recorder.record("select_clear");
      }
      return;
    }

    if (tool === "roof") {
      if (selectedRoofId) {
        const selRoof = roofs.find(r => r.id === selectedRoofId);
        if (selRoof) {
          const { points: rp } = selRoof;
          for (let i = 0; i < rp.length; i++) {
            const j = (i + 1) % rp.length;
            if (distToSegment(rawPt, rp[i], rp[j]) < WALL_HOVER_THRESHOLD) {
              setSelectedRoofEdge({ roofId: selectedRoofId, edgeIdx: i });
              return;
            }
          }
        }
      }
      const snappedPt = pt;
      if (roofDraft.length >= 3 && dist(snappedPt, roofDraft[0]) < closeThreshold) {
        const newRoof = {
          id: uid(), points: [...roofDraft], pitch: ROOF_DEFAULT_PITCH, overhang: 0,
          edgeTypes: roofDraft.map(() => 'bottom'),
        };
        setRoofs(rs => [...rs, newRoof]);
        setSelectedRoofId(newRoof.id);
        setSelectedRoofEdge(null);
        recorder.record("roof_close", { points: [...roofDraft] });
        setRoofDraft([]);
      } else {
        recorder.record("roof_point", { pt: snappedPt });
        setRoofDraft(d => [...d, snappedPt]);
      }
      return;
    }

    if (tool !== "wall") return;
    // Wall drawing: each click commits a new wall segment immediately —
    // there is no "Enter to close"; loops close themselves once the wall
    // graph encloses an area.
    if (draft.length === 0) {
      setDraft([pt]);
      recorder.record("wall_start", { pt });
      return;
    }
    if (dist(pt, last) < 0.02) return;
    const newWall = { id: uid(), a: last, b: pt, uValue: null };
    setWalls(ws => [...ws, newWall]);
    recorder.record("wall_add", { a: last, b: pt });
    setDraft(d => [...d, pt]);
    setLengthInput("");
  }, [tool, getSnappedPoint, svgPt, draft, closeThreshold, walls, openings, areas, setWalls, setOpenings, findWallHover, newOpening, roofDraft, roofs, setRoofs, selectedRoofId, lengthInput, lengthSnappedPoint]);

  const onVertexMouseDown = useCallback((e, point) => {
    if (tool !== "select") return;
    e.stopPropagation();
    // Record which wall IDs contain this vertex so the drag snap can exclude them
    // without relying on distance comparisons that break at high mouse speed.
    const draggedWallIds = new Set(
      wallsRef.current
        .filter(w => dist(w.a, point) < VERTEX_TOL || dist(w.b, point) < VERTEX_TOL)
        .map(w => w.id)
    );
    dragVertex.current = { point, draggedWallIds };
  }, [tool]);


  // ── Keyboard ──
  useEffect(() => {
    const fn = (e) => {
      if (e.target.tagName === "INPUT") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); return; }
      if (tool === "wall" && draft.length > 0) {
        if (/^[0-9]$/.test(e.key) || (e.key === "." && !lengthInput.includes("."))) {
          setLengthInput(s => s + e.key);
          return;
        }
        if (e.key === "Backspace" && lengthInput) {
          setLengthInput(s => s.slice(0, -1));
          return;
        }
        if (e.key === "Enter" && lengthInput) {
          const pt = lengthSnappedPoint(cursor, draft[draft.length-1], parseFloat(lengthInput) || 0);
          const last = draft[draft.length-1];
          if (dist(pt, last) >= 0.02) {
            const newWall = { id: uid(), a: last, b: pt, uValue: null };
            setWalls(ws => [...ws, newWall]);
            recorder.record("wall_add", { a: last, b: pt });
            setDraft(d => [...d, pt]);
          }
          setLengthInput("");
          return;
        }
        if (e.key === "Escape" && lengthInput) {
          setLengthInput("");
          return;
        }
      }
      if (e.key === "Escape") { setDraft([]); setRoofDraft([]); setSelectedId(null); setSelectedWallId(null); setSelectedOpening(null); setSelectedRoofId(null); setSelectedRoofEdge(null); setLengthInput(""); recorder.record("key_escape"); }
      if (e.key === "d") { setTool("wall"); setRoofDraft([]); setLengthInput(""); recorder.record("tool_change", { tool: "wall" }); }
      if (e.key === "s") { setTool("select"); setDraft([]); setRoofDraft([]); setLengthInput(""); recorder.record("tool_change", { tool: "select" }); }
      if (e.key === "w") { setTool("window"); setDraft([]); setLengthInput(""); recorder.record("tool_change", { tool: "window" }); }
      if (e.key === "r") { setTool("door"); setDraft([]); setLengthInput(""); recorder.record("tool_change", { tool: "door" }); }
      if (e.key === "f") { setTool("roof"); setDraft([]); setLengthInput(""); recorder.record("tool_change", { tool: "roof" }); }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedOpening) {
          const { openingId } = selectedOpening;
          setOpenings(os => os.filter(o => o.id !== openingId));
          recorder.record("opening_delete", { openingId });
          setSelectedOpening(null);
        } else if (selectedWallId) {
          recorder.record("wall_delete", { wallId: selectedWallId });
          setWalls(ws => ws.filter(w => w.id !== selectedWallId));
          setOpenings(os => os.filter(o => o.wallId !== selectedWallId));
          setSelectedWallId(null);
        } else if (selectedRoofId) {
          recorder.record("roof_delete", { roofId: selectedRoofId });
          setRoofs(rs => rs.filter(r => r.id !== selectedRoofId));
          setSelectedRoofId(null); setSelectedRoofEdge(null);
        }
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [selectedWallId, selectedOpening, selectedRoofId, setWalls, setOpenings, setRoofs, undo, redo, tool, draft, lengthInput, cursor, lengthSnappedPoint]);

  // ── Scroll zoom ──
  useEffect(() => {
    const svg = svgRef.current;
    const fn = (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect(), mx = e.clientX-r.left, my = e.clientY-r.top;
      const factor = e.deltaY < 0 ? 1.12 : 1/1.12;
      const pz = zoomRef.current, pp = panRef.current;
      const nz = Math.min(8, Math.max(0.15, pz*factor));
      const np = { x: mx-(mx-pp.x)*nz/pz, y: my-(my-pp.y)*nz/pz };
      zoomRef.current = nz; panRef.current = np;
      setZoom(nz); setPan(np);
    };
    svg.addEventListener("wheel", fn, { passive: false });
    return () => svg.removeEventListener("wheel", fn);
  }, []);

  // ── Grid ──
  const renderGrid = () => {
    const W = svgRef.current?.clientWidth||900, H = svgRef.current?.clientHeight||600;
    const s = zoom*PPM;
    const x0=Math.floor(-pan.x/s/GRID)*GRID-GRID, x1=Math.ceil((W-pan.x)/s/GRID)*GRID+GRID;
    const y0=Math.floor(-pan.y/s/GRID)*GRID-GRID, y1=Math.ceil((H-pan.y)/s/GRID)*GRID+GRID;
    const lines=[];
    for (let x=x0;x<=x1;x+=GRID) { const maj=Math.abs(Math.round(x)-x)<0.001; lines.push(<line key={`v${x.toFixed(2)}`} x1={x} y1={y0} x2={x} y2={y1} stroke={maj?"#1b3660":"#0d1e38"} strokeWidth={maj?1.2/s:0.5/s}/>); }
    for (let y=y0;y<=y1;y+=GRID) { const maj=Math.abs(Math.round(y)-y)<0.001; lines.push(<line key={`h${y.toFixed(2)}`} x1={x0} y1={y} x2={x1} y2={y} stroke={maj?"#1b3660":"#0d1e38"} strokeWidth={maj?1.2/s:0.5/s}/>); }
    return lines;
  };

  const renderMeasurement = (a, b, key, label) => {
    const len = dist(a,b); if (len<0.25 && !label) return null;
    const mx=(a.x+b.x)/2, my=(a.y+b.y)/2, ang=Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI;
    const fs=9.5/(zoom*PPM), off=0.14, nx=-(b.y-a.y)/len*off, ny=(b.x-a.x)/len*off;
    const rot=ang>90||ang<-90?ang+180:ang;
    return <text key={key} x={mx+nx} y={my+ny} fontSize={fs} fill={label?"#facc15":"#4a85b8"} textAnchor="middle" dominantBaseline="middle" transform={`rotate(${rot},${mx+nx},${my+ny})`} style={{userSelect:"none",fontFamily:"monospace",pointerEvents:"none"}}>{label ?? `${len.toFixed(2)}m`}</text>;
  };

  // ── Derived ──
  const selectedArea = areas.find(a => a.id === selectedId);
  const selectedWall = walls.find(w => w.id === selectedWallId);
  const selOO    = openings.find(o => o.id === selectedOpening?.openingId);
  const selOWall = selOO ? walls.find(w => w.id === selOO.wallId) : null;
  const totalArea = areas.reduce((s,a) => s+area(a.points), 0);
  const perimeter = (pts) => pts.reduce((s,p,i) => s+dist(p,pts[(i+1)%pts.length]), 0);

  const updateOpeningProp = (prop, delta, min, max) => {
    if (!selectedOpening) return;
    const { openingId } = selectedOpening;
    setOpenings(os => os.map(o => {
      if (o.id !== openingId) return o;
      return { ...o, [prop]: Math.round(Math.max(min, Math.min(max, (o[prop]??0)+delta))*10)/10 };
    }));
  };
  const deleteSelectedOpening = () => {
    if (!selectedOpening) return;
    setOpenings(os => os.filter(o => o.id !== selectedOpening.openingId));
    setSelectedOpening(null);
  };

  const tools = [
    { id:"wall",   label:"WALL",   key:"D" },
    { id:"select", label:"SELECT", key:"S" },
    { id:"window", label:"WINDOW", key:"W" },
    { id:"door",   label:"DOOR",   key:"R" },
    { id:"roof",   label:"ROOF",   key:"F" },
  ];
  const toolColors = {
    wall:   { active:"#1e4a7a", border:"#2563eb", text:"#7dd3fc" },
    select: { active:"#1e4a7a", border:"#2563eb", text:"#7dd3fc" },
    window: { active:"#0c3050", border:"#38bdf8", text:"#7dd3fc" },
    door:   { active:"#1e1040", border:"#a78bfa", text:"#c4b5fd" },
    roof:   { active:"#3a2000", border:"#f59e0b", text:"#fde68a" },
  };

  // ─── Properties panel ─────────────────────────────────────────────────────
  const renderPanelContent = () => {

    // ── Opening selected ──
    if (selOO) {
      const isWindow = selOO.type === "window";
      const accent   = isWindow ? "#38bdf8" : "#a78bfa";
      const sill     = selOO.sillHeight ?? (isWindow ? 0.9 : 0.0);
      const openH    = selOO.height     ?? (isWindow ? 1.2 : 2.1);
      const headH    = sill + openH;
      const defKey   = isWindow ? "window" : "door";

      const DW=100, DH=110, PAD={t:8,b:8,l:14,r:14};
      const availH=DH-PAD.t-PAD.b, availW=DW-PAD.l-PAD.r, scl=availH/ceilingH;
      const yFloor=PAD.t+availH, ySill=yFloor-sill*scl, yHead=yFloor-headH*scl, yCeil=PAD.t;
      const xL=PAD.l, xR=DW-PAD.r, xOL=xL+availW*0.15, xOR=xR-availW*0.15;

      const Stepper = ({ label, value, onMinus, onPlus, min, max, ac }) => (
        <div style={{ marginBottom:10 }}>
          <div style={{ color:"#2d5a8a", fontSize:9, marginBottom:4, letterSpacing:"0.12em" }}>{label}</div>
          <div style={{ display:"flex", alignItems:"center", gap:6, background:"#0a1628", border:"1px solid #132040", borderRadius:5, padding:"5px 8px" }}>
            <button onClick={onMinus} disabled={value<=min} style={{ width:26,height:26,background:"#070d1a",border:`1px solid ${(ac||accent)+"60"}`,color:value<=min?"#1e3a6b":(ac||accent),borderRadius:4,cursor:value<=min?"default":"pointer",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"monospace" }}>−</button>
            <span style={{ flex:1,textAlign:"center",color:"#7dd3fc",fontSize:13,fontFamily:"monospace" }}>{value.toFixed(1)}<span style={{fontSize:9,color:"#4a7fa5"}}>m</span></span>
            <button onClick={onPlus} disabled={value>=max} style={{ width:26,height:26,background:"#070d1a",border:`1px solid ${(ac||accent)+"60"}`,color:value>=max?"#1e3a6b":(ac||accent),borderRadius:4,cursor:value>=max?"default":"pointer",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"monospace" }}>+</button>
          </div>
        </div>
      );

      return (
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14 }}>
            <div style={{ width:8,height:8,borderRadius:"50%",background:accent }}/>
            <span style={{ color:accent, fontWeight:700, fontSize:12, letterSpacing:"0.1em" }}>{isWindow?"WINDOW":"DOOR"}</span>
            {selOWall && <span style={{ color:"#1e3a6b", fontSize:9 }}>{dist(selOWall.a,selOWall.b).toFixed(1)}m wall</span>}
          </div>

          {/* Elevation diagram */}
          <div style={{ marginBottom:14, display:"flex", gap:8, alignItems:"flex-start" }}>
            <svg width={DW} height={DH} style={{ flexShrink:0 }}>
              <rect x={xL} y={yCeil} width={availW} height={availH} fill="#0a1628" stroke="#1e3a6b" strokeWidth={1}/>
              <rect x={xL} y={yFloor} width={availW} height={4} fill="#1e3a6b"/>
              <rect x={xOL} y={yHead} width={xOR-xOL} height={(headH-sill)*scl} fill={accent+"25"} stroke={accent} strokeWidth={1.2}/>
              {sill>0 && <line x1={xOL} y1={ySill} x2={xOR} y2={ySill} stroke={accent} strokeWidth={0.8} strokeDasharray="2 2" opacity={0.6}/>}
              {sill>0 && <><line x1={xL-6} y1={yFloor} x2={xL-6} y2={ySill} stroke="#2d5a8a" strokeWidth={0.8}/>
                <text x={xL-8} y={(yFloor+ySill)/2} fontSize={6} fill="#2d5a8a" textAnchor="middle" dominantBaseline="middle" transform={`rotate(-90,${xL-8},${(yFloor+ySill)/2})`}>{sill.toFixed(1)}</text></>}
              <text x={xR+10} y={(yHead+Math.min(ySill,yFloor))/2} fontSize={6} fill="#2d5a8a" textAnchor="middle" dominantBaseline="middle" transform={`rotate(90,${xR+10},${(yHead+Math.min(ySill,yFloor))/2})`}>{openH.toFixed(1)}</text>
              <text x={(xL+xR)/2} y={yCeil-2} fontSize={6} fill="#1e3a6b" textAnchor="middle">ceiling {ceilingH.toFixed(1)}m</text>
              <text x={(xOL+xOR)/2} y={yHead-2} fontSize={5.5} fill={accent} textAnchor="middle" opacity={0.8}>{headH.toFixed(1)}m</text>
              {sill>0&&<text x={(xOL+xOR)/2} y={ySill+7} fontSize={5.5} fill={accent} textAnchor="middle" opacity={0.8}>{sill.toFixed(1)}m</text>}
            </svg>
            <div style={{ flex:1, display:"flex", flexDirection:"column", gap:5 }}>
              <Stat label="HEAD HT" value={`${headH.toFixed(1)}m`}/>
              <Stat label="AREA"    value={`${(selOO.width*openH).toFixed(2)}m²`}/>
              <Stat label="WIDTH"   value={`${selOO.width.toFixed(1)}m`}/>
            </div>
          </div>

          <Stepper label="WIDTH" value={selOO.width} onMinus={()=>updateOpeningProp("width",-0.1,0.3,6)} onPlus={()=>updateOpeningProp("width",+0.1,0.3,6)} min={0.3} max={6}/>
          <Stepper label="OPENING HEIGHT" value={openH} onMinus={()=>updateOpeningProp("height",-0.1,0.2,ceilingH-sill)} onPlus={()=>updateOpeningProp("height",+0.1,0.2,ceilingH-sill)} min={0.2} max={ceilingH-sill}/>
          <Stepper label="SILL HEIGHT" value={sill} onMinus={()=>updateOpeningProp("sillHeight",-0.1,0,ceilingH-openH)} onPlus={()=>updateOpeningProp("sillHeight",+0.1,0,ceilingH-openH)} min={0} max={ceilingH-openH} ac={isWindow?"#fbbf24":"#a78bfa"}/>

          {headH > ceilingH && (
            <div style={{ background:"#2d1000",border:"1px solid #f59e0b",borderRadius:4,padding:"6px 8px",marginBottom:10,fontSize:9,color:"#fbbf24" }}>
              ⚠ Head height ({headH.toFixed(2)}m) exceeds ceiling ({ceilingH.toFixed(1)}m)
            </div>
          )}

          {/* U-value */}
          <Section label="U-VALUE" open={secU} onToggle={()=>setSecU(v=>!v)} accent={accent}>
            <URow label={isWindow?"Glazing":"Door"}
              value={selOO.uValue}
              defaultVal={globalU[defKey]}
              onChange={v => updateOpeningU(selOO.id, v)}
              accent={accent}/>
            <div style={{ color:"#1a3050", fontSize:8, marginTop:6 }}>
              Effective: <span style={{ color:"#7dd3fc" }}>{effU(selOO.uValue, globalU[defKey]).toFixed(2)}</span> W/m²K
            </div>
          </Section>

          {/* SHGC — windows only */}
          {isWindow && (() => {
            const shgc = selOO.glazing?.solarHeatGainCoeff ?? 0.63;
            const isDefault = selOO.glazing?.solarHeatGainCoeff == null;
            return (
              <div style={{ marginTop:14 }}>
                <div style={{ color:"#f59e0b", fontSize:9, letterSpacing:"0.15em",
                  borderBottom:"1px solid #132040", paddingBottom:5, marginBottom:8 }}>
                  SOLAR HEAT GAIN
                </div>
                <URow label="SHGC (g-value)"
                  value={isDefault ? null : shgc}
                  defaultVal={0.63}
                  onChange={v => updateOpeningSHGC(selOO.id, v === null ? null : Math.min(0.99, Math.max(0.01, v)))}
                  accent="#f59e0b"/>
                <div style={{ color:"#1a3050", fontSize:8, marginTop:4, lineHeight:1.6 }}>
                  Fraction of incident solar transmitted. 0.63 = double glazing · 0.27 = low-e triple.
                </div>
              </div>
            );
          })()}

          <button onClick={deleteSelectedOpening} style={{ width:"100%",padding:"8px",background:"#200a0a",border:"1px solid #7f1d1d",color:"#f87171",borderRadius:5,cursor:"pointer",fontSize:11,fontFamily:"monospace",marginTop:14 }}>
            DELETE {isWindow?"WINDOW":"DOOR"}
          </button>
        </div>
      );
    }

    // ── Roof selected ──
    const selectedRoof = roofs.find(r => r.id === selectedRoofId);
    if (selectedRoof) {
      const { points: rp, pitch, overhang = 0, edgeTypes } = selectedRoof;
      const updatePitch = (v) => {
        setRoofs(rs => rs.map(r => r.id === selectedRoofId ? { ...r, pitch: Math.max(1, Math.min(89, v)) } : r));
      };
      const toggleEdge = (i) => {
        setRoofs(rs => rs.map(r => {
          if (r.id !== selectedRoofId) return r;
          const et = [...r.edgeTypes];
          et[i] = et[i] === 'bottom' ? 'gable' : 'bottom';
          return { ...r, edgeTypes: et };
        }));
      };
      const setAllEdges = (type) => {
        setRoofs(rs => rs.map(r => r.id !== selectedRoofId ? r : { ...r, edgeTypes: r.edgeTypes.map(() => type) }));
      };
      return (
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14 }}>
            <div style={{ width:8,height:8,borderRadius:"50%",background:"#f59e0b" }}/>
            <span style={{ color:"#f59e0b", fontWeight:700, fontSize:12, letterSpacing:"0.1em" }}>ROOF</span>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6, marginBottom:14 }}>
            <Stat label="EDGES"  value={`${rp.length}`}/>
            <Stat label="AREA"   value={`${area(rp).toFixed(1)} m²`}/>
          </div>

          {/* Pitch control */}
          <div style={{ marginBottom:14 }}>
            <div style={{ color:"#2d5a8a", fontSize:9, letterSpacing:"0.12em", marginBottom:6 }}>ROOF PITCH</div>
            <div style={{ display:"flex", alignItems:"center", gap:6, background:"#0a1628", border:"1px solid #3a2000", borderRadius:5, padding:"5px 8px" }}>
              <button onClick={()=>updatePitch(pitch-1)} style={{ width:26,height:26,background:"#070d1a",border:"1px solid #f59e0b60",color:"#f59e0b",borderRadius:4,cursor:"pointer",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center" }}>−</button>
              <input type="number" min="1" max="89" step="1" value={pitch}
                onChange={e=>{ const v=parseInt(e.target.value); if(!isNaN(v)) updatePitch(v); }}
                style={{ flex:1,textAlign:"center",background:"transparent",border:"none",color:"#fde68a",fontSize:16,fontFamily:"monospace",outline:"none" }}/>
              <button onClick={()=>updatePitch(pitch+1)} style={{ width:26,height:26,background:"#070d1a",border:"1px solid #f59e0b60",color:"#f59e0b",borderRadius:4,cursor:"pointer",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center" }}>+</button>
              <span style={{ color:"#f59e0b", fontSize:12, fontFamily:"monospace" }}>°</span>
            </div>
            <div style={{ color:"#1a3050", fontSize:8, marginTop:4, lineHeight:1.6 }}>
              Rise: {(Math.tan(pitch*Math.PI/180)).toFixed(2)} m per 1 m run
            </div>
          </div>

          {/* Overhang control */}
          <div style={{ marginBottom:14 }}>
            <div style={{ color:"#2d5a8a", fontSize:9, letterSpacing:"0.12em", marginBottom:6 }}>OVERHANG</div>
            <div style={{ display:"flex", alignItems:"center", gap:6, background:"#0a1628", border:"1px solid #3a2000", borderRadius:5, padding:"5px 8px" }}>
              <button onClick={()=>setRoofs(rs=>rs.map(r=>r.id===selectedRoofId?{...r,overhang:Math.max(0,Math.round((overhang-0.05)*100)/100)}:r))}
                style={{ width:26,height:26,background:"#070d1a",border:"1px solid #f59e0b60",color:"#f59e0b",borderRadius:4,cursor:"pointer",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center" }}>−</button>
              <input type="number" min="0" max="2" step="0.05" value={overhang.toFixed(2)}
                onChange={e=>{ const v=parseFloat(e.target.value); if(!isNaN(v)) setRoofs(rs=>rs.map(r=>r.id===selectedRoofId?{...r,overhang:Math.max(0,v)}:r)); }}
                style={{ flex:1,textAlign:"center",background:"transparent",border:"none",color:"#fde68a",fontSize:16,fontFamily:"monospace",outline:"none" }}/>
              <button onClick={()=>setRoofs(rs=>rs.map(r=>r.id===selectedRoofId?{...r,overhang:Math.round((overhang+0.05)*100)/100}:r))}
                style={{ width:26,height:26,background:"#070d1a",border:"1px solid #f59e0b60",color:"#f59e0b",borderRadius:4,cursor:"pointer",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center" }}>+</button>
              <span style={{ color:"#f59e0b", fontSize:12, fontFamily:"monospace" }}>m</span>
            </div>
          </div>

          {/* Edge types */}
          <div style={{ color:"#2d5a8a", fontSize:9, letterSpacing:"0.12em", marginBottom:6 }}>EDGES</div>
          <div style={{ display:"flex", gap:6, marginBottom:8 }}>
            <button onClick={()=>setAllEdges('bottom')} style={{ flex:1, padding:"4px 0", background:"#0a1628", border:"1px solid #f59e0b60", color:"#f59e0b", borderRadius:4, cursor:"pointer", fontSize:9, fontFamily:"monospace" }}>ALL BOTTOM</button>
            <button onClick={()=>setAllEdges('gable')}  style={{ flex:1, padding:"4px 0", background:"#0a1628", border:"1px solid #4a7fa560", color:"#4a7fa5", borderRadius:4, cursor:"pointer", fontSize:9, fontFamily:"monospace" }}>ALL GABLE</button>
          </div>
          <div style={{ color:"#1a3050", fontSize:8, marginBottom:10, lineHeight:1.6 }}>
            <span style={{ color:"#f59e0b" }}>●</span> Bottom = eave (slope rises from edge)<br/>
            <span style={{ color:"#4a7fa5" }}>- -</span> Gable = vertical wall up to slope
          </div>
          {edgeTypes.map((et, i) => {
            const j = (i+1)%rp.length;
            const len = dist(rp[i], rp[j]);
            const isSelEdge = selectedRoofEdge?.edgeIdx === i && selectedRoofEdge?.roofId === selectedRoofId;
            const isBottom = et === 'bottom';
            return (
              <div key={i} onClick={()=>{ setSelectedRoofEdge({roofId:selectedRoofId,edgeIdx:i}); }}
                style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 8px",marginBottom:3,
                  background: isSelEdge ? "#2a1a00" : "#0a1628",
                  border: `1px solid ${isSelEdge ? "#f59e0b" : "#132040"}`,
                  borderRadius:3, cursor:"pointer" }}>
                <span style={{ color: isSelEdge ? "#fde68a" : "#4a7fa5", fontSize:9 }}>
                  Edge {i+1} <span style={{ color:"#1e3a6b", fontSize:8 }}>{len.toFixed(1)}m</span>
                </span>
                <button onClick={e=>{e.stopPropagation();toggleEdge(i);}}
                  style={{ padding:"2px 8px", fontSize:9, fontFamily:"monospace", borderRadius:3, cursor:"pointer",
                    background: isBottom ? "#f59e0b20" : "#0a1628",
                    border: `1px solid ${isBottom ? "#f59e0b" : "#4a7fa5"}`,
                    color: isBottom ? "#f59e0b" : "#4a7fa5" }}>
                  {isBottom ? "BOTTOM" : "GABLE"}
                </button>
              </div>
            );
          })}

          <button onClick={()=>{ setRoofs(rs=>rs.filter(r=>r.id!==selectedRoofId)); setSelectedRoofId(null); setSelectedRoofEdge(null); }}
            style={{ width:"100%",padding:"6px",background:"#200a0a",border:"1px solid #7f1d1d",color:"#f87171",borderRadius:3,cursor:"pointer",fontSize:11,fontFamily:"monospace",marginTop:14 }}>
            DELETE ROOF
          </button>
        </div>
      );
    }

    // ── Wall selected ──
    if (selectedWall) {
      const len = dist(selectedWall.a, selectedWall.b);
      const ang = Math.atan2(selectedWall.b.y-selectedWall.a.y, selectedWall.b.x-selectedWall.a.x)*180/Math.PI;
      const dirs = ["E","SE","S","SW","W","NW","N","NE"];
      const dirL = dirs[Math.round(((ang%360)+360)%360/45)%8];
      const wallOpenings = openings.filter(o=>o.wallId===selectedWall.id);
      return (
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14 }}>
            <div style={{ width:8,height:8,borderRadius:"50%",background:"#60a5fa" }}/>
            <span style={{ color:"#60a5fa", fontWeight:700, fontSize:12, letterSpacing:"0.1em" }}>WALL</span>
            <span style={{ color:"#1e3a6b", fontSize:9 }}>{dirL}</span>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6, marginBottom:4 }}>
            <Stat label="LENGTH"   value={`${len.toFixed(2)} m`}/>
            <Stat label="OPENINGS" value={`${wallOpenings.length}`}/>
          </div>

          <Section label="U-VALUE" open={secU} onToggle={()=>setSecU(v=>!v)} accent="#60a5fa">
            <URow label="Wall" value={selectedWall.uValue} defaultVal={globalU.wall}
              onChange={v=>updateWallU(selectedWall.id, v)}/>
            <div style={{ color:"#1a3050",fontSize:8,marginTop:8,lineHeight:1.6 }}>
              Shared by any room(s) bordering this wall.<br/>
              Effective: <span style={{color:"#7dd3fc"}}>{effU(selectedWall.uValue,globalU.wall).toFixed(2)}</span> W/m²K
            </div>
          </Section>

          <button onClick={()=>{
              recorder.record("wall_delete", { wallId: selectedWall.id });
              setWalls(ws=>ws.filter(w=>w.id!==selectedWall.id));
              setOpenings(os=>os.filter(o=>o.wallId!==selectedWall.id));
              setSelectedWallId(null);
            }}
            style={{ width:"100%",padding:"6px",background:"#200a0a",border:"1px solid #7f1d1d",color:"#f87171",borderRadius:3,cursor:"pointer",fontSize:11,fontFamily:"monospace",marginTop:14 }}>
            DELETE WALL
          </button>
        </div>
      );
    }

    // ── Area (room) selected ──
    if (selectedArea) {
      const areaOpenings = selectedArea.openings || [];
      const wins = areaOpenings.filter(o=>o.type==="window").length;
      const drs  = areaOpenings.filter(o=>o.type==="door").length;

      return (
        <div>
          <div style={{ marginBottom:12 }}>
            <div style={{ color:"#2d5a8a",fontSize:9,marginBottom:4,letterSpacing:"0.1em" }}>ROOM NAME</div>
            <input value={selectedArea.name}
              onChange={e => renameArea(selectedArea.id, e.target.value)}
              style={{ background:"#0a1628",border:"1px solid #1e3a6b",color:"#c8d8f0",padding:"5px 8px",borderRadius:3,width:"100%",fontFamily:"monospace",fontSize:11,outline:"none",boxSizing:"border-box" }}/>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6, marginBottom:4 }}>
            <Stat label="AREA"      value={`${area(selectedArea.points).toFixed(2)} m²`}/>
            <Stat label="VOLUME"    value={`${(area(selectedArea.points)*ceilingH).toFixed(1)} m³`}/>
            <Stat label="CEILING"   value={`${ceilingH.toFixed(1)} m`}/>
            <Stat label="PERIMETER" value={`${perimeter(selectedArea.points).toFixed(2)} m`}/>
          </div>

          {/* ── U-values ── */}
          <Section label="U-VALUES" open={secU} onToggle={()=>setSecU(v=>!v)} accent="#38bdf8">
            <URow label="Floor" value={selectedArea.floorU} defaultVal={globalU.floor} onChange={v=>updateAreaMeta(selectedArea.id,"floorU",v)}/>
            <URow label="Roof / ceiling" value={selectedArea.roofU} defaultVal={globalU.roof} onChange={v=>updateAreaMeta(selectedArea.id,"roofU",v)}/>
            <div style={{ color:"#1a3050",fontSize:8,marginTop:8,lineHeight:1.6 }}>
              Floor effective: <span style={{color:"#7dd3fc"}}>{effU(selectedArea.floorU,globalU.floor).toFixed(2)}</span> W/m²K<br/>
              Roof effective:  <span style={{color:"#7dd3fc"}}>{effU(selectedArea.roofU, globalU.roof ).toFixed(2)}</span> W/m²K
            </div>
          </Section>

          {/* ── Walls ── */}
          <Section label="WALLS" open={secWall} onToggle={()=>setSecWall(v=>!v)}>
            {selectedArea.points.map((p, i) => {
              const next = selectedArea.points[(i+1)%selectedArea.points.length];
              const len  = dist(p, next);
              const ang  = Math.atan2(next.y-p.y, next.x-p.x)*180/Math.PI;
              const dirs = ["E","SE","S","SW","W","NW","N","NE"];
              const dirL = dirs[Math.round(((ang%360)+360)%360/45)%8];
              const wo   = areaOpenings.filter(o=>o.wallIdx===i);
              const wallId = selectedArea.wallIds[i];
              const wallObj = walls.find(w=>w.id===wallId);
              const wallUval = wallObj?.uValue ?? null;
              return (
                <div key={i} style={{ paddingBottom:8, marginBottom:8, borderBottom:"1px solid #0a1628" }}>
                  <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4 }}>
                    <span style={{ color:"#4a7fa5",fontSize:9 }}>
                      Wall {i+1} <span style={{color:"#1e4060"}}>{dirL}</span>
                      {wo.length>0&&<span style={{color:"#38bdf860",fontSize:8,marginLeft:4}}>{wo.length}✦</span>}
                    </span>
                    <span style={{ color:"#7dd3fc",fontSize:9 }}>{len.toFixed(2)}m</span>
                  </div>
                  <URow label="U-value" value={wallUval} defaultVal={globalU.wall}
                    onChange={v=>updateWallU(wallId,v)}/>
                </div>
              );
            })}
          </Section>

          {/* ── Openings summary ── */}
          {areaOpenings.length > 0 && (
            <Section label="OPENINGS" open={true} onToggle={()=>{}}>
              <div style={{ display:"flex",gap:6,marginBottom:8 }}>
                <div style={{ flex:1,background:"#0a1628",border:"1px solid #132040",borderRadius:4,padding:"6px",textAlign:"center" }}>
                  <div style={{ color:"#38bdf8",fontSize:16,fontWeight:700 }}>{wins}</div>
                  <div style={{ color:"#2d5a8a",fontSize:8 }}>WINDOWS</div>
                </div>
                <div style={{ flex:1,background:"#0a1628",border:"1px solid #132040",borderRadius:4,padding:"6px",textAlign:"center" }}>
                  <div style={{ color:"#a78bfa",fontSize:16,fontWeight:700 }}>{drs}</div>
                  <div style={{ color:"#2d5a8a",fontSize:8 }}>DOORS</div>
                </div>
              </div>
              {areaOpenings.map(o => {
                const c = o.type==="window"?"#38bdf8":"#a78bfa";
                const defK = o.type==="window"?"window":"door";
                return (
                  <div key={o.id} onClick={()=>{ setSelectedOpening({openingId:o.id}); setSelectedId(null); setSelectedWallId(null); }}
                    style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 8px",marginBottom:3,background:"#0a1628",border:"1px solid #132040",borderRadius:3,cursor:"pointer" }}>
                    <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                      <div style={{ width:6,height:6,borderRadius:"50%",background:c }}/>
                      <span style={{ color:c,fontSize:10 }}>{o.type.toUpperCase()}</span>
                      <span style={{ color:"#1e3a6b",fontSize:9 }}>W{o.wallIdx+1}</span>
                    </div>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ color:"#4a7fa5",fontSize:9 }}>{o.width.toFixed(1)}m</div>
                      <div style={{ color:"#1e3a6b",fontSize:7 }}>{effU(o.uValue,globalU[defK]).toFixed(2)} W/m²K</div>
                    </div>
                  </div>
                );
              })}
            </Section>
          )}
        </div>
      );
    }

    // ── Nothing selected ──
    const hints = {
      wall:   "Click to place wall points.\nEach click adds a wall segment.\nClick near an existing point\nto connect or close a loop.",
      select: "Click a wall or room\nto select and edit it.\nDrag corner points to reshape.",
      window: "Click on any wall\nto place a window.",
      door:   "Click on any wall\nto place a door.",
      roof:   "Click to place roof vertices.\nClick near start (or Enter) to close.\nThen select edges to set type.",
    };
    return (
      <div>
        <div style={{ background:"#0a1628",border:"1px solid #132040",borderRadius:4,padding:"10px",marginBottom:14,color:"#2d5a8a",fontSize:10,lineHeight:1.8,whiteSpace:"pre-line" }}>
          {hints[tool]}
        </div>
        <div style={{ color:"#2d5a8a",fontSize:9,letterSpacing:"0.12em",marginBottom:6 }}>ROOMS — {STOREY_LABELS[activeStorey].toUpperCase()}</div>
        {areas.length===0&&<div style={{ color:"#1b3660",fontSize:10,padding:"8px 0" }}>No enclosed rooms yet.</div>}
        {areas.map(a => {
          const wins=(a.openings||[]).filter(o=>o.type==="window").length;
          const drs =(a.openings||[]).filter(o=>o.type==="door").length;
          return (
            <div key={a.id} onClick={()=>{ setTool("select"); setSelectedId(a.id); setSelectedWallId(null); setSelectedOpening(null); }}
              onMouseEnter={()=>setHoveredId(a.id)} onMouseLeave={()=>setHoveredId(null)}
              style={{ padding:"5px 8px",marginBottom:3,borderRadius:3,cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",background:"#0a1628",border:`1px solid ${hoveredId===a.id?a.line+"80":"#132040"}` }}>
              <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                <div style={{ width:6,height:6,borderRadius:"50%",background:a.line }}/>
                <span style={{ color:"#c8d8f0",fontSize:11 }}>{a.name}</span>
                {wins>0&&<span style={{ color:"#38bdf880",fontSize:8 }}>{wins}▭</span>}
                {drs>0 &&<span style={{ color:"#a78bfa80",fontSize:8 }}>{drs}⬜</span>}
              </div>
              <span style={{ color:"#2d5a8a",fontSize:9 }}>{area(a.points).toFixed(1)} m²</span>
            </div>
          );
        })}
        {areas.length>0&&(
          <div style={{ display:"flex",justifyContent:"space-between",padding:"8px 0 0",borderTop:"1px solid #132040",marginTop:4 }}>
            <span style={{ color:"#2d5a8a",fontSize:9 }}>TOTAL</span>
            <span style={{ color:"#38bdf8",fontSize:11 }}>{totalArea.toFixed(1)} m²</span>
          </div>
        )}
        <div style={{ marginTop:20,color:"#2d5a8a",fontSize:9,letterSpacing:"0.12em",marginBottom:8 }}>SHORTCUTS</div>
        {[["D","Wall"],["S","Select"],["W","Window"],["R","Door"],["F","Roof"],["Esc","Cancel"],["Del","Delete"],["⌃Z","Undo"],["⌃⇧Z","Redo"]].map(([k,v])=>(
          <div key={k} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"3px 0",borderBottom:"1px solid #0a1628" }}>
            <span style={{ color:"#1e3a6b",background:"#0a1628",padding:"1px 5px",borderRadius:2,border:"1px solid #132040",fontSize:9 }}>{k}</span>
            <span style={{ color:"#2d5a8a",fontSize:9 }}>{v}</span>
          </div>
        ))}
      </div>
    );
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  const replaySetters = {
    setWallsByStorey, setOpeningsByStorey, setAreaMetaByStorey, setCeilingHeights,
    setGlobalU, setBuildingRotation, setSelectedId, setSelectedWallId,
    setSelectedOpening, setDraft, setActiveStorey, setRoofsByStorey,
  };

  const storeyValid = hasClosedBoundary(walls);

  return (
    <div style={{ display:"flex",flexDirection:"column",height:"100%",flex:1,minHeight:0,background:"#05090f",color:"#c8d8f0",fontFamily:"monospace",overflow:"hidden" }}>

      {/* ── Toolbar ── */}
      <div style={{ display:"flex",alignItems:"center",gap:6,padding:"0 12px",background:"#070d1a",borderBottom:"1px solid #132040",height:46,flexShrink:0 }}>
        <span style={{ color:"#38bdf8",fontWeight:700,fontSize:11,letterSpacing:"0.18em",marginRight:4 }}>FLOORPLAN</span>
        <div style={{ width:1,height:20,background:"#132040" }}/>
        {tools.map(({ id, label, key }) => {
          const tc=toolColors[id], isActive=tool===id;
          return <button key={id} onClick={()=>{ recorder.record("tool_change", { tool: id }); setTool(id); if(id!=="wall")setDraft([]); if(id!=="roof")setRoofDraft([]); }} style={{ padding:"5px 10px",background:isActive?tc.active:"transparent",color:isActive?tc.text:"#2d5a8a",border:`1px solid ${isActive?tc.border:"#132040"}`,borderRadius:5,cursor:"pointer",fontSize:10,fontFamily:"monospace",letterSpacing:"0.07em",transition:"all 0.15s",display:"flex",alignItems:"center",gap:5 }}>{label}<span style={{opacity:0.4,fontSize:8}}>[{key}]</span></button>;
        })}
        <div style={{ width:1,height:20,background:"#132040" }}/>
        <label style={{ display:"flex",alignItems:"center",gap:5,fontSize:9,cursor:"pointer",color:"#2d5a8a",userSelect:"none" }}>
          <input type="checkbox" checked={snapOn} onChange={e=>setSnapOn(e.target.checked)} style={{ accentColor:"#38bdf8" }}/> Snap
        </label>
        <label style={{ display:"flex",alignItems:"center",gap:5,fontSize:9,cursor:"pointer",color:snapOn?"#2d5a8a":"#1a2d40",userSelect:"none" }}>
          <input type="checkbox" checked={gridSnap} disabled={!snapOn} onChange={e=>setGridSnap(e.target.checked)} style={{ accentColor:"#38bdf8" }}/> Grid
        </label>
        <label style={{ display:"flex",alignItems:"center",gap:5,fontSize:9,cursor:"pointer",color:activeStorey>0?"#2d5a8a":"#1a2d40",userSelect:"none" }}>
          <input type="checkbox" checked={showGhost} onChange={e=>setShowGhost(e.target.checked)} disabled={activeStorey===0} style={{ accentColor:"#38bdf8" }}/> Ghost
        </label>
        {!storeyValid && (
          <div style={{ display:"flex",alignItems:"center",gap:5,padding:"3px 8px",background:"#2d1000",border:"1px solid #f59e0b",borderRadius:4,color:"#fbbf24",fontSize:9,letterSpacing:"0.05em" }}>
            ⚠ NO CLOSED BOUNDARY — heat-loss results will be inaccurate
          </div>
        )}
        <div style={{ flex:1 }}/>
        <span style={{ fontSize:9,color:"#1e3a6b" }}>{(zoom*100).toFixed(0)}%</span>
        {savedAt&&<span style={{ fontSize:9,color:"#1e4a30",letterSpacing:"0.08em" }}>● SAVED {savedAt.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</span>}
        <button onClick={undo} disabled={!undoAvailable} title="Undo (Ctrl+Z)" style={{ marginLeft:4,padding:"3px 8px",background:"transparent",border:`1px solid ${undoAvailable?"#1e3a6b":"#0f1d35"}`,color:undoAvailable?"#7dd3fc":"#0f1d35",borderRadius:4,cursor:undoAvailable?"pointer":"default",fontSize:9,fontFamily:"monospace" }}>↶ UNDO</button>
        <button onClick={redo} disabled={!redoAvailable} title="Redo (Ctrl+Shift+Z)" style={{ marginLeft:4,padding:"3px 8px",background:"transparent",border:`1px solid ${redoAvailable?"#1e3a6b":"#0f1d35"}`,color:redoAvailable?"#7dd3fc":"#0f1d35",borderRadius:4,cursor:redoAvailable?"pointer":"default",fontSize:9,fontFamily:"monospace" }}>↷ REDO</button>
        <div style={{ width:1,height:20,background:"#132040" }}/>
        <button onClick={clearStorage} style={{ marginLeft:4,padding:"3px 8px",background:"transparent",border:"1px solid #1e3a6b",color:"#1e3a6b",borderRadius:4,cursor:"pointer",fontSize:9,fontFamily:"monospace" }}>NEW</button>
        <button onClick={()=>recorder.download()} title="Download session recording for bug reports" style={{ marginLeft:4,padding:"3px 8px",background:"transparent",border:"1px solid #1e4a30",color:"#1e7a40",borderRadius:4,cursor:"pointer",fontSize:9,fontFamily:"monospace" }}>REC ↓</button>
        <button onClick={()=>setShowReplay(true)} title="Open replay panel" style={{ marginLeft:4,padding:"3px 8px",background:showReplay?"#0a2818":"transparent",border:`1px solid ${showReplay?"#1e7a40":"#1e4a30"}`,color:"#1e7a40",borderRadius:4,cursor:"pointer",fontSize:9,fontFamily:"monospace" }}>REPLAY</button>
      </div>

      <div style={{ display:"flex",flex:1,overflow:"hidden" }}>

        {/* ── Canvas wrapper (position:relative so overlay can sit on top) ── */}
        <div style={{ flex:1, position:"relative", minWidth:0 }}>
        {/* North overlay — top-right corner of canvas */}
        <div style={{ position:"absolute", top:10, right:10, zIndex:10, pointerEvents:"none" }}>
          <NorthOverlay rotation={buildingRotation} />
        </div>
        <svg ref={svgRef} style={{ width:"100%",height:"100%",display:"block",cursor:(tool==="wall"||tool==="window"||tool==="door"||tool==="roof")?"crosshair":"default" }}
          onMouseMove={onMouseMove} onMouseDown={onMouseDown} onMouseUp={onMouseUp} onClick={onCanvasClick}>
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom*PPM})`}>
            {renderGrid()}
            <line x1={-0.3} y1={0} x2={0.3} y2={0} stroke="#1b3660" strokeWidth={lw}/>
            <line x1={0} y1={-0.3} x2={0} y2={0.3} stroke="#1b3660" strokeWidth={lw}/>

            {/* Ghost */}
            {showGhost && activeStorey>0 && (wallsByStorey[activeStorey-1]||[]).map(w => {
              const wo = (openingsByStorey[activeStorey-1]||[]).filter(o=>o.wallId===w.id);
              return (
                <g key={`ghost-${w.id}`} style={{ pointerEvents:"none" }} opacity={0.22}>
                  {wallWithOpenings(w.a, w.b, wo, "#6a9fc8", lw*2, false)}
                </g>
              );
            })}

            {/* Areas */}
            {areas.map(a => {
              const pathD = a.points.map((p,i)=>`${i?"L":"M"} ${p.x} ${p.y}`).join(" ")+" Z";
              const c=centroid(a.points), ar=area(a.points);
              const isSel = selectedId===a.id;
              const fs=11.5/(zoom*PPM), fsSub=9/(zoom*PPM);
              return (
                <g key={a.id} onMouseEnter={()=>setHoveredId(a.id)} onMouseLeave={()=>setHoveredId(null)}>
                  <path d={pathD} fill={isSel?a.line+"26":a.bg} style={{ cursor:tool==="select"?"pointer":"default" }}/>
                  <text x={c.x} y={c.y-fs*0.55} fontSize={fs} fill={a.label} textAnchor="middle" fontWeight="700" style={{userSelect:"none",letterSpacing:"0.08em",pointerEvents:"none"}}>{a.name.toUpperCase()}</text>
                  <text x={c.x} y={c.y+fs*0.75} fontSize={fsSub} fill={a.line} textAnchor="middle" opacity={0.7} style={{userSelect:"none",pointerEvents:"none"}}>{ar.toFixed(1)} m²</text>
                </g>
              );
            })}

            {/* Walls */}
            {walls.map(w => {
              const wo = openings.filter(o=>o.wallId===w.id);
              const isSel = selectedWallId===w.id;
              const col = isSel ? "#f59e0b" : "#6a9fc8";
              return (
                <g key={w.id}>
                  {wallWithOpenings(w.a, w.b, wo, col, isSel?lw*3:lw*2, false)}
                  {isSel && renderMeasurement(w.a, w.b, `m-${w.id}`)}
                  {wo.map(o=>{ if(selectedOpening?.openingId!==o.id)return null;
                    const wLen=dist(w.a,w.b), dir={x:(w.b.x-w.a.x)/wLen,y:(w.b.y-w.a.y)/wLen};
                    const mid={x:w.a.x+dir.x*(o.offset+o.width/2), y:w.a.y+dir.y*(o.offset+o.width/2)};
                    return <circle key={o.id} cx={mid.x} cy={mid.y} r={5/(zoom*PPM)} fill="none" stroke="#f59e0b" strokeWidth={lw*1.5}/>; })}
                </g>
              );
            })}

            {/* Roofs */}
            {roofs.map(roof => {
              if (roof.points.length < 3) return null;
              const rp = offsetPolygon(roof.points, roof.overhang ?? 0);
              const pathD = rp.map((p,i) => `${i?"L":"M"} ${p.x} ${p.y}`).join(" ") + " Z";
              const isSel = selectedRoofId === roof.id;
              const ridgeLines = computeRoofLines(rp, roof.edgeTypes);
              return (
                <g key={roof.id} onClick={e => { if(tool==="select"||tool==="roof"){e.stopPropagation();setSelectedRoofId(roof.id);setSelectedRoofEdge(null);setSelectedId(null);setSelectedWallId(null);setSelectedOpening(null);} }}>
                  {/* Ridge/hip lines — faint */}
                  {ridgeLines.map((seg, si) => (
                    <line key={si} x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2}
                      stroke="#f59e0b" strokeWidth={lw * 1.2} opacity={0.25}
                      strokeDasharray={`${0.12} ${0.06}`} strokeLinecap="round" />
                  ))}
                  {/* Roof polygon fill */}
                  <path d={pathD} fill={isSel ? "#f59e0b18" : "#f59e0b0a"}
                    style={{ cursor: tool==="select"||tool==="roof" ? "pointer" : "crosshair" }} />
                  {/* Edges — bottom=solid, gable=dashed */}
                  {rp.map((p, i) => {
                    const j = (i+1)%rp.length;
                    const q = rp[j];
                    const et = roof.edgeTypes[i] || 'bottom';
                    const isSelEdge = selectedRoofEdge?.roofId === roof.id && selectedRoofEdge?.edgeIdx === i;
                    const col = isSelEdge ? "#fde68a" : (isSel ? "#f59e0b" : "#b45309");
                    const lwidth = isSelEdge ? lw*4 : (isSel ? lw*3 : lw*2);
                    return (
                      <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y}
                        stroke={col} strokeWidth={lwidth}
                        strokeDasharray={et==="gable" ? `${0.15} ${0.1}` : "none"}
                        strokeLinecap="round" />
                    );
                  })}
                  {/* Pitch label at centroid */}
                  {isSel && (() => {
                    const c = centroid(rp);
                    const fs = 11/(zoom*PPM);
                    return <text x={c.x} y={c.y} fontSize={fs} fill="#f59e0b" textAnchor="middle" dominantBaseline="middle" opacity={0.85} style={{userSelect:"none",pointerEvents:"none",fontFamily:"monospace"}}>{roof.pitch}°</text>;
                  })()}
                </g>
              );
            })}

            {/* Wall hover */}
            {wallHover&&(()=>{ const w=walls.find(ww=>ww.id===wallHover.wallId); if(!w)return null;
              const prev=[{id:"preview",type:tool,wallId:w.id,offset:wallHover.offset,width:OPENING_DEFAULTS[tool].width}];
              return <g><line x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y} stroke={tool==="window"?"#38bdf840":"#a78bfa40"} strokeWidth={lw*5} strokeLinecap="round"/>
                {wallWithOpenings(w.a,w.b,prev,"#6a9fc8",lw*2,true)}</g>; })()}

            {/* Draft */}
            {draft.length>0&&(()=>{
              return <g>
                {draft.map((p,i)=>i===0?null:<line key={i} x1={draft[i-1].x} y1={draft[i-1].y} x2={p.x} y2={p.y} stroke="#38bdf8" strokeWidth={lw*2.5} strokeLinecap="round"/>)}
                <line x1={draft[draft.length-1].x} y1={draft[draft.length-1].y} x2={cursor.x} y2={cursor.y} stroke="#38bdf8" strokeWidth={lw} opacity={0.5} strokeDasharray={`${0.1} ${0.07}`}/>
                {renderMeasurement(draft[draft.length-1],cursor,"prev",lengthInput?`${lengthInput}m`:undefined)}
                {draft.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r={i===0?6/(zoom*PPM):4/(zoom*PPM)} fill={i===0?"#38bdf8":"#1a4060"} stroke="#38bdf8" strokeWidth={lw}/>)}
                <circle cx={cursor.x} cy={cursor.y} r={3/(zoom*PPM)} fill="#38bdf8" opacity={0.8}/>
              </g>; })()}

            {/* Roof draft */}
            {tool==="roof"&&roofDraft.length>0&&(()=>{
              const nearClose=roofDraft.length>=3&&dist(cursor,roofDraft[0])<closeThreshold;
              return <g>
                {roofDraft.map((p,i)=>i===0?null:<line key={i} x1={roofDraft[i-1].x} y1={roofDraft[i-1].y} x2={p.x} y2={p.y} stroke="#f59e0b" strokeWidth={lw*2.5} strokeLinecap="round"/>)}
                <line x1={roofDraft[roofDraft.length-1].x} y1={roofDraft[roofDraft.length-1].y} x2={cursor.x} y2={cursor.y} stroke="#f59e0b" strokeWidth={lw} opacity={0.5} strokeDasharray={`${0.1} ${0.07}`}/>
                {nearClose&&<circle cx={roofDraft[0].x} cy={roofDraft[0].y} r={9/(zoom*PPM)} fill="#f59e0b20" stroke="#f59e0b" strokeWidth={lw*1.5}/>}
                {roofDraft.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r={i===0?6/(zoom*PPM):4/(zoom*PPM)} fill={i===0?"#f59e0b":"#3a2000"} stroke="#f59e0b" strokeWidth={lw}/>)}
                <circle cx={cursor.x} cy={cursor.y} r={3/(zoom*PPM)} fill="#f59e0b" opacity={0.8}/>
              </g>;
            })()}

            {(tool==="wall"||tool==="roof")&&snapGuides.map((g,i)=>
              <line key={i} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2}
                stroke="#38bdf8" strokeWidth={lw} opacity={0.35} strokeDasharray={`${0.06} ${0.06}`}/>)}

            {tool==="wall"&&draft.length===0&&<circle cx={cursor.x} cy={cursor.y} r={2.5/(zoom*PPM)} fill="#38bdf8" opacity={0.5}/>}
            {(tool==="window"||tool==="door")&&!wallHover&&<circle cx={cursor.x} cy={cursor.y} r={2.5/(zoom*PPM)} fill={tool==="window"?"#38bdf8":"#a78bfa"} opacity={0.5}/>}
            {tool==="roof"&&roofDraft.length===0&&<circle cx={cursor.x} cy={cursor.y} r={2.5/(zoom*PPM)} fill="#f59e0b" opacity={0.5}/>}

            {/* Editable vertex handles — rendered last so they sit above all walls/areas */}
            {(() => {
              const selArea = areas.find(a => a.id === selectedId);
              const handlePoints = selArea ? selArea.points
                : selectedWall ? [selectedWall.a, selectedWall.b]
                : [];
              return handlePoints.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r={5.5/(zoom*PPM)} fill="#f59e0b" stroke="#fff4" strokeWidth={lw} style={{cursor:"move"}} onMouseDown={e=>onVertexMouseDown(e,p)}/>);
            })()}
          </g>
        </svg>
        </div>{/* end canvas wrapper */}

        {/* ── Right panel ── */}
        <div style={{ width:240,background:"#070d1a",borderLeft:"1px solid #132040",padding:14,overflowY:"auto",flexShrink:0,fontSize:11 }}>
          <div style={{ color:"#2d5a8a",letterSpacing:"0.18em",fontSize:9,marginBottom:14 }}>PROPERTIES</div>
          {renderPanelContent()}

          {/* ── Orientation / north direction ── */}
          <div style={{ marginTop: 16 }}>
            <div style={{ color: "#2d5a8a", fontSize: 9, letterSpacing: "0.15em",
              borderBottom: "1px solid #132040", paddingBottom: 5, marginBottom: 12 }}>
              ORIENTATION
            </div>
            <CompassWidget rotation={buildingRotation} />
            <div style={{ marginTop: 10 }}>
              <input
                type="range" min={0} max={359} step={1}
                value={buildingRotation}
                onChange={e => { const v = Number(e.target.value); setBuildingRotation(v); recorder.record("rotation_change", { rotation: v }); }}
                style={{ width: "100%", accentColor: "#38bdf8", cursor: "pointer" }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 4 }}>
                <span style={{ color: "#4a7fa5", fontSize: 9 }}>
                  {String(buildingRotation).padStart(3, "0")}°
                </span>
                <span style={{ color: "#7dd3fc", fontSize: 11, fontFamily: "monospace" }}>
                  {bearingLabel(buildingRotation)}
                </span>
                <button
                  onClick={() => setBuildingRotation(0)}
                  title="Reset to north-up"
                  style={{ background: "none", border: "none", color: "#2d5a8a",
                    cursor: "pointer", fontSize: 10, padding: "0 2px" }}
                >↩</button>
              </div>
              <div style={{ color: "#1a3050", fontSize: 8, marginTop: 5, lineHeight: 1.6 }}>
                Clockwise angle from the drawing's up direction (↑) to true north.
                The compass rotates so N always points toward true north on your drawing.
              </div>
            </div>
          </div>

          {/* ── Global U-value defaults (always visible at bottom) ── */}
          <Section label="GLOBAL U-VALUE DEFAULTS" open={secDef} onToggle={()=>setSecDef(v=>!v)} accent="#4a7fa5">
            <div style={{ color:"#1a3050",fontSize:8,marginBottom:8,lineHeight:1.6 }}>
              Applies to any element with no individual override. Values in W/(m²·K).
            </div>
            {[
              ["wall",   "Wall",   "#60a5fa"],
              ["floor",  "Floor",  "#34d399"],
              ["roof",   "Roof",   "#34d399"],
              ["window", "Window", "#38bdf8"],
              ["door",   "Door",   "#a78bfa"],
            ].map(([key, label, ac]) => (
              <div key={key} style={{ display:"flex",alignItems:"center",gap:5,padding:"4px 0",borderBottom:"1px solid #0a1628" }}>
                <span style={{ color:"#4a7fa5",fontSize:9,width:52,flexShrink:0 }}>{label}</span>
                <input type="number" step="0.01" min="0.01" max="20"
                  value={globalU[key]}
                  onChange={e=>{ const v=parseFloat(e.target.value); if(!isNaN(v)&&v>0) setGlobalU(g=>({...g,[key]:v})); }}
                  style={{ flex:1,minWidth:0,background:"#0a1628",border:`1px solid ${ac}40`,color:"#7dd3fc",padding:"2px 5px",borderRadius:3,fontFamily:"monospace",fontSize:10,outline:"none" }}/>
                <button onClick={()=>setGlobalU(g=>({...g,[key]:DEFAULT_U_VALUES[key]}))} title="Reset to default"
                  style={{ background:"none",border:"none",color:"#2d5a8a",cursor:"pointer",fontSize:10,padding:"0 2px" }}>↩</button>
                <span style={{ color:"#1a3050",fontSize:7,flexShrink:0 }}>W/m²K</span>
              </div>
            ))}
          </Section>
        </div>
      </div>

      {/* ── Storey + ceiling bar ── */}
      <div style={{ display:"flex",alignItems:"center",background:"#070d1a",borderTop:"1px solid #132040",padding:"0 12px",height:44,flexShrink:0,gap:4 }}>
        <span style={{ color:"#1e3a6b",fontSize:9,marginRight:4,letterSpacing:"0.15em",flexShrink:0 }}>STOREY</span>
        {STOREY_LABELS.map((label,i)=>{ const isActive=activeStorey===i;
          return <button key={i} onClick={()=>{ recorder.record("storey_change", { storey: i }); setActiveStorey(i); setSelectedId(null); setSelectedWallId(null); setSelectedOpening(null); setDraft([]); setSelectedRoofId(null); setSelectedRoofEdge(null); setRoofDraft([]); }} style={{ padding:"4px 10px",height:32,background:isActive?"#1e4a7a":"#0a1628",color:isActive?"#7dd3fc":"#2d5a8a",border:`1px solid ${isActive?"#2563eb":"#132040"}`,borderRadius:6,cursor:"pointer",fontSize:10,fontFamily:"monospace",letterSpacing:"0.06em",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",lineHeight:1.2,transition:"all 0.15s",flexShrink:0 }}>
            <span>{label.toUpperCase()}</span>
            <span style={{ fontSize:7,opacity:0.6,color:isActive?"#38bdf8":"#1e3a6b" }}>{ceilingHeights[i].toFixed(1)}m</span>
          </button>; })}
        <div style={{ marginLeft:"auto",display:"flex",alignItems:"center",gap:6,background:"#0a1628",border:"1px solid #132040",borderRadius:8,padding:"4px 8px" }}>
          <span style={{ fontSize:8,color:"#2d5a8a",letterSpacing:"0.1em",flexShrink:0 }}>↕ CEIL</span>
          <button onClick={()=>adjustCeiling(-0.1)} style={{ width:26,height:26,background:"#070d1a",border:"1px solid #1e3a6b",color:"#4a7fa5",borderRadius:5,cursor:"pointer",fontSize:15,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"monospace" }}>−</button>
          <span style={{ color:"#7dd3fc",fontSize:12,fontFamily:"monospace",minWidth:38,textAlign:"center" }}>{ceilingH.toFixed(1)}<span style={{fontSize:8,color:"#4a7fa5"}}>m</span></span>
          <button onClick={()=>adjustCeiling(+0.1)} style={{ width:26,height:26,background:"#070d1a",border:"1px solid #1e3a6b",color:"#4a7fa5",borderRadius:5,cursor:"pointer",fontSize:15,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"monospace" }}>+</button>
        </div>
      </div>

      {showReplay && (
        <ReplayPanel
          onClose={() => setShowReplay(false)}
          setters={replaySetters}
        />
      )}
    </div>
  );
}
