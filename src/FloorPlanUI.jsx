import { useState, useRef, useCallback, useEffect } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const PPM  = 60;
const GRID = 0.5;
const WALL_HOVER_THRESHOLD = 0.35;

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

// Sensible UK Part-L defaults, W/(m²·K)
const DEFAULT_U_VALUES = { wall: 0.30, floor: 0.25, roof: 0.20, window: 1.60, door: 1.80 };

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

let _uid = 0;
const uid = () => `id${++_uid}`;

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

// ─── Main component ───────────────────────────────────────────────────────────
export default function FloorPlanUI() {
  const svgRef = useRef(null);

  // ── View ──
  const [zoom, setZoom] = useState(1);
  const [pan,  setPan]  = useState({ x: 280, y: 220 });
  const zoomRef = useRef(1), panRef = useRef({ x: 280, y: 220 });
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { panRef.current  = pan;  }, [pan]);

  // ── Storeys ──
  const STOREY_LABELS = ["Ground", "First", "Second"];
  const [activeStorey, setActiveStorey] = useState(0);

  const [roomsByStorey, setRoomsByStorey] = useState(() => {
    try { const s = localStorage.getItem("floorplan_rooms"); return s ? JSON.parse(s) : { 0:[], 1:[], 2:[] }; }
    catch { return { 0:[], 1:[], 2:[] }; }
  });
  const [ceilingHeights, setCeilingHeights] = useState(() => {
    try { const s = localStorage.getItem("floorplan_ceilings"); return s ? JSON.parse(s) : { 0:3.0, 1:2.7, 2:2.5 }; }
    catch { return { 0:3.0, 1:2.7, 2:2.5 }; }
  });
  const [globalU, setGlobalU] = useState(() => {
    try { const s = localStorage.getItem("floorplan_uvalues"); return s ? JSON.parse(s) : { ...DEFAULT_U_VALUES }; }
    catch { return { ...DEFAULT_U_VALUES }; }
  });

  const ceilingH = ceilingHeights[activeStorey];
  const adjustCeiling = (delta) =>
    setCeilingHeights(h => ({ ...h, [activeStorey]: Math.round(Math.max(1.8, Math.min(6.0, h[activeStorey]+delta))*10)/10 }));

  const rooms = roomsByStorey[activeStorey] || [];
  const setRooms = useCallback((updater) => {
    setRoomsByStorey(prev => ({
      ...prev,
      [activeStorey]: typeof updater === "function" ? updater(prev[activeStorey] || []) : updater,
    }));
  }, [activeStorey]);

  // ── Persist ──
  const [savedAt, setSavedAt] = useState(null);
  useEffect(() => { try { localStorage.setItem("floorplan_rooms", JSON.stringify(roomsByStorey)); setSavedAt(new Date()); } catch {} }, [roomsByStorey]);
  useEffect(() => { try { localStorage.setItem("floorplan_ceilings", JSON.stringify(ceilingHeights)); } catch {} }, [ceilingHeights]);
  useEffect(() => { try { localStorage.setItem("floorplan_uvalues", JSON.stringify(globalU)); } catch {} }, [globalU]);

  const clearStorage = () => {
    if (!window.confirm("Clear all floors and start over?")) return;
    try { ["floorplan_rooms","floorplan_ceilings","floorplan_uvalues"].forEach(k => localStorage.removeItem(k)); } catch {}
    setRoomsByStorey({ 0:[], 1:[], 2:[] });
    setCeilingHeights({ 0:3.0, 1:2.7, 2:2.5 });
    setGlobalU({ ...DEFAULT_U_VALUES });
    setSelectedId(null); setSelectedOpening(null); setDraft([]);
  };

  // ── Tool & drawing ──
  const [tool,      setTool]      = useState("draw");
  const [draft,     setDraft]     = useState([]);
  const [cursor,    setCursor]    = useState({ x:0, y:0 });
  const [snapOn,    setSnapOn]    = useState(true);
  const [showGhost, setShowGhost] = useState(true);

  // ── Selection ──
  const [selectedId,      setSelectedId]      = useState(null);
  const [selectedOpening, setSelectedOpening] = useState(null);
  const [hoveredId,       setHoveredId]       = useState(null);
  const [wallHover,       setWallHover]       = useState(null);

  // ── Panel sections open/closed ──
  const [secU,    setSecU]    = useState(true);  // U-values in room panel
  const [secWall, setSecWall] = useState(false); // Wall list in room panel
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

  // ── Wall hover ──
  const findWallHover = useCallback((cursor, rooms, openingWidth) => {
    let best = WALL_HOVER_THRESHOLD, result = null;
    for (const room of rooms) {
      const pts = room.points;
      for (let i = 0; i < pts.length; i++) {
        const j = (i+1) % pts.length;
        const d = distToSegment(cursor, pts[i], pts[j]);
        if (d < best) {
          best = d;
          const { t, len } = projectOntoWall(cursor, pts[i], pts[j]);
          const half = openingWidth / 2;
          if (len < openingWidth + 0.1) continue;
          result = { roomId: room.id, wallIdx: i, offset: Math.max(half, Math.min(len-half, t*len))-half, wallLen: len };
        }
      }
    }
    return result;
  }, []);

  // ── U-value helpers ──
  const effU = (override, defaultVal) => (override !== null && override !== undefined) ? override : defaultVal;
  const updateRoomU = (roomId, key, value) =>
    setRooms(rs => rs.map(r => r.id === roomId ? { ...r, [key]: value } : r));
  const updateWallU = (roomId, wallIdx, value) =>
    setRooms(rs => rs.map(r => {
      if (r.id !== roomId) return r;
      const wallUs = { ...r.wallUs };
      if (value === null) delete wallUs[wallIdx]; else wallUs[wallIdx] = value;
      return { ...r, wallUs };
    }));
  const updateOpeningU = (roomId, openingId, value) =>
    setRooms(rs => rs.map(r => {
      if (r.id !== roomId) return r;
      return { ...r, openings: r.openings.map(o => o.id === openingId ? { ...o, uValue: value } : o) };
    }));

  // ── New room/opening factories ──
  const newRoom = (draft, rooms, pal) => ({
    id: uid(), name: `Room ${rooms.length+1}`, points: [...draft],
    openings: [], wallUs: {}, floorU: null, roofU: null, ...pal,
  });
  const newOpening = (tool, wh) => ({
    id: uid(), type: tool, wallIdx: wh.wallIdx, offset: wh.offset,
    width: OPENING_DEFAULTS[tool].width, height: OPENING_DEFAULTS[tool].height,
    sillHeight: OPENING_DEFAULTS[tool].sillHeight, uValue: null,
  });

  // ── Mouse ──
  const onMouseMove = useCallback((e) => {
    const p = panState.current;
    if (p.active) { const np = { x: p.startPan.x+e.clientX-p.origin.x, y: p.startPan.y+e.clientY-p.origin.y }; setPan(np); panRef.current = np; return; }
    const raw = svgPt(e), pt = snapPt(raw);
    setCursor(pt);
    if (dragVertex.current) {
      const { roomId, vIdx } = dragVertex.current;
      setRooms(rs => rs.map(r => { if (r.id !== roomId) return r; const pts=[...r.points]; pts[vIdx]=pt; return {...r,points:pts}; }));
      return;
    }
    if (tool === "window" || tool === "door") setWallHover(findWallHover(raw, rooms, OPENING_DEFAULTS[tool].width));
    else setWallHover(null);
  }, [svgPt, snapPt, tool, rooms, findWallHover, setRooms]);

  const onMouseDown = useCallback((e) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      panState.current = { active: true, origin: { x:e.clientX, y:e.clientY }, startPan: {...panRef.current} };
      e.preventDefault();
    }
  }, []);
  const onMouseUp = useCallback(() => { panState.current.active = false; dragVertex.current = null; }, []);

  const onCanvasClick = useCallback((e) => {
    if (panState.current.active) return;
    const pt = snapPt(svgPt(e)), rawPt = svgPt(e);

    if (tool === "window" || tool === "door") {
      const wh = findWallHover(rawPt, rooms, OPENING_DEFAULTS[tool].width);
      if (wh) setRooms(rs => rs.map(r => r.id === wh.roomId ? { ...r, openings: [...r.openings, newOpening(tool, wh)] } : r));
      return;
    }
    if (tool === "select") {
      for (const room of rooms) {
        for (const o of room.openings) {
          const ptA = room.points[o.wallIdx], ptB = room.points[(o.wallIdx+1)%room.points.length];
          const wLen = dist(ptA, ptB), dir = { x:(ptB.x-ptA.x)/wLen, y:(ptB.y-ptA.y)/wLen };
          const mid = { x:ptA.x+dir.x*(o.offset+o.width/2), y:ptA.y+dir.y*(o.offset+o.width/2) };
          if (dist(rawPt, mid) < Math.max(0.25, o.width/2)) { setSelectedOpening({ roomId:room.id, openingId:o.id }); setSelectedId(null); return; }
        }
      }
      const hit = [...rooms].reverse().find(r => pointInPoly(rawPt, r.points));
      if (hit) { setSelectedId(hit.id); setSelectedOpening(null); } else { setSelectedId(null); setSelectedOpening(null); }
      return;
    }
    if (tool !== "draw") return;
    if (draft.length >= 3 && dist(pt, draft[0]) < closeThreshold) {
      const pal = PALETTE[rooms.length % PALETTE.length];
      setRooms(rs => [...rs, newRoom(draft, rooms, pal)]);
      setDraft([]);
    } else { setDraft(d => [...d, pt]); }
  }, [tool, snapPt, svgPt, draft, closeThreshold, rooms, setRooms, findWallHover]);

  const onVertexMouseDown = useCallback((e, roomId, vIdx) => {
    if (tool !== "select") return;
    e.stopPropagation(); dragVertex.current = { roomId, vIdx };
    setSelectedId(roomId); setSelectedOpening(null);
  }, [tool]);

  const onRoomClick = useCallback((e, roomId) => {
    if (tool !== "select") return;
    e.stopPropagation(); setSelectedId(roomId); setSelectedOpening(null);
  }, [tool]);

  // ── Keyboard ──
  useEffect(() => {
    const fn = (e) => {
      if (e.target.tagName === "INPUT") return;
      if (e.key === "Escape") { setDraft([]); setSelectedId(null); setSelectedOpening(null); }
      if (e.key === "d") setTool("draw");
      if (e.key === "s") { setTool("select"); setDraft([]); }
      if (e.key === "w") setTool("window");
      if (e.key === "r") setTool("door");
      if (e.key === "Enter" && tool === "draw" && draft.length >= 3) {
        const pal = PALETTE[rooms.length % PALETTE.length];
        setRooms(rs => [...rs, newRoom(draft, rooms, pal)]); setDraft([]);
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedOpening) {
          const { roomId, openingId } = selectedOpening;
          setRooms(rs => rs.map(r => r.id === roomId ? { ...r, openings: r.openings.filter(o => o.id !== openingId) } : r));
          setSelectedOpening(null);
        } else if (selectedId) { setRooms(rs => rs.filter(r => r.id !== selectedId)); setSelectedId(null); }
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [draft, tool, rooms, selectedId, selectedOpening, setRooms]);

  // ── Scroll zoom ──
  useEffect(() => {
    const svg = svgRef.current;
    const fn = (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect(), mx = e.clientX-r.left, my = e.clientY-r.top;
      const factor = e.deltaY < 0 ? 1.12 : 1/1.12;
      setZoom(pz => { const nz = Math.min(8, Math.max(0.15, pz*factor)); zoomRef.current = nz; setPan(pp => { const np = { x:mx-(mx-pp.x)*nz/pz, y:my-(my-pp.y)*nz/pz }; panRef.current=np; return np; }); return nz; });
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

  const renderMeasurement = (a, b, key) => {
    const len = dist(a,b); if (len<0.25) return null;
    const mx=(a.x+b.x)/2, my=(a.y+b.y)/2, ang=Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI;
    const fs=9.5/(zoom*PPM), off=0.14, nx=-(b.y-a.y)/len*off, ny=(b.x-a.x)/len*off;
    const rot=ang>90||ang<-90?ang+180:ang;
    return <text key={key} x={mx+nx} y={my+ny} fontSize={fs} fill="#4a85b8" textAnchor="middle" dominantBaseline="middle" transform={`rotate(${rot},${mx+nx},${my+ny})`} style={{userSelect:"none",fontFamily:"monospace",pointerEvents:"none"}}>{len.toFixed(2)}m</text>;
  };

  // ── Derived ──
  const selectedRoom   = rooms.find(r => r.id === selectedId);
  const selOR          = selectedOpening ? rooms.find(r => r.id === selectedOpening.roomId) : null;
  const selOO          = selOR?.openings?.find(o => o.id === selectedOpening?.openingId);
  const totalArea      = rooms.reduce((s,r) => s+area(r.points), 0);
  const perimeter      = (pts) => pts.reduce((s,p,i) => s+dist(p,pts[(i+1)%pts.length]), 0);

  const updateOpeningProp = (prop, delta, min, max) => {
    if (!selectedOpening) return;
    const { roomId, openingId } = selectedOpening;
    setRooms(rs => rs.map(r => {
      if (r.id !== roomId) return r;
      return { ...r, openings: r.openings.map(o => {
        if (o.id !== openingId) return o;
        return { ...o, [prop]: Math.round(Math.max(min, Math.min(max, (o[prop]??0)+delta))*10)/10 };
      })};
    }));
  };
  const deleteSelectedOpening = () => {
    if (!selectedOpening) return;
    const { roomId, openingId } = selectedOpening;
    setRooms(rs => rs.map(r => r.id === roomId ? { ...r, openings: r.openings.filter(o => o.id !== openingId) } : r));
    setSelectedOpening(null);
  };

  const tools = [
    { id:"draw",   label:"DRAW",   key:"D" },
    { id:"select", label:"SELECT", key:"S" },
    { id:"window", label:"WINDOW", key:"W" },
    { id:"door",   label:"DOOR",   key:"R" },
  ];
  const toolColors = {
    draw:   { active:"#1e4a7a", border:"#2563eb", text:"#7dd3fc" },
    select: { active:"#1e4a7a", border:"#2563eb", text:"#7dd3fc" },
    window: { active:"#0c3050", border:"#38bdf8", text:"#7dd3fc" },
    door:   { active:"#1e1040", border:"#a78bfa", text:"#c4b5fd" },
  };

  // ─── Properties panel ─────────────────────────────────────────────────────
  const renderPanelContent = () => {

    // ── Opening selected ──
    if (selOO && selOR) {
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
            <span style={{ color:"#1e3a6b", fontSize:9 }}>{selOR.name} · Wall {selOO.wallIdx+1}</span>
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
              onChange={v => updateOpeningU(selOR.id, selOO.id, v)}
              accent={accent}/>
            <div style={{ color:"#1a3050", fontSize:8, marginTop:6 }}>
              Effective: <span style={{ color:"#7dd3fc" }}>{effU(selOO.uValue, globalU[defKey]).toFixed(2)}</span> W/m²K
            </div>
          </Section>

          <button onClick={deleteSelectedOpening} style={{ width:"100%",padding:"8px",background:"#200a0a",border:"1px solid #7f1d1d",color:"#f87171",borderRadius:5,cursor:"pointer",fontSize:11,fontFamily:"monospace",marginTop:14 }}>
            DELETE {isWindow?"WINDOW":"DOOR"}
          </button>
        </div>
      );
    }

    // ── Room selected ──
    if (selectedRoom) {
      const openings = selectedRoom.openings || [];
      const wins = openings.filter(o=>o.type==="window").length;
      const drs  = openings.filter(o=>o.type==="door").length;

      return (
        <div>
          <div style={{ marginBottom:12 }}>
            <div style={{ color:"#2d5a8a",fontSize:9,marginBottom:4,letterSpacing:"0.1em" }}>ROOM NAME</div>
            <input value={selectedRoom.name}
              onChange={e => setRooms(rs=>rs.map(r=>r.id===selectedId?{...r,name:e.target.value}:r))}
              style={{ background:"#0a1628",border:"1px solid #1e3a6b",color:"#c8d8f0",padding:"5px 8px",borderRadius:3,width:"100%",fontFamily:"monospace",fontSize:11,outline:"none",boxSizing:"border-box" }}/>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6, marginBottom:4 }}>
            <Stat label="AREA"      value={`${area(selectedRoom.points).toFixed(2)} m²`}/>
            <Stat label="VOLUME"    value={`${(area(selectedRoom.points)*ceilingH).toFixed(1)} m³`}/>
            <Stat label="CEILING"   value={`${ceilingH.toFixed(1)} m`}/>
            <Stat label="PERIMETER" value={`${perimeter(selectedRoom.points).toFixed(2)} m`}/>
          </div>

          {/* ── U-values ── */}
          <Section label="U-VALUES" open={secU} onToggle={()=>setSecU(v=>!v)} accent="#38bdf8">
            <URow label="Floor" value={selectedRoom.floorU} defaultVal={globalU.floor} onChange={v=>updateRoomU(selectedRoom.id,"floorU",v)}/>
            <URow label="Roof / ceiling" value={selectedRoom.roofU} defaultVal={globalU.roof} onChange={v=>updateRoomU(selectedRoom.id,"roofU",v)}/>
            <div style={{ color:"#1a3050",fontSize:8,marginTop:8,lineHeight:1.6 }}>
              Floor effective: <span style={{color:"#7dd3fc"}}>{effU(selectedRoom.floorU,globalU.floor).toFixed(2)}</span> W/m²K<br/>
              Roof effective:  <span style={{color:"#7dd3fc"}}>{effU(selectedRoom.roofU, globalU.roof ).toFixed(2)}</span> W/m²K
            </div>
          </Section>

          {/* ── Walls ── */}
          <Section label="WALLS" open={secWall} onToggle={()=>setSecWall(v=>!v)}>
            {selectedRoom.points.map((p, i) => {
              const next = selectedRoom.points[(i+1)%selectedRoom.points.length];
              const len  = dist(p, next);
              const ang  = Math.atan2(next.y-p.y, next.x-p.x)*180/Math.PI;
              const dirs = ["E","SE","S","SW","W","NW","N","NE"];
              const dirL = dirs[Math.round(((ang%360)+360)%360/45)%8];
              const wo   = openings.filter(o=>o.wallIdx===i);
              const wallUval = selectedRoom.wallUs?.[i] ?? null;
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
                    onChange={v=>updateWallU(selectedRoom.id,i,v)}/>
                </div>
              );
            })}
          </Section>

          {/* ── Openings summary ── */}
          {openings.length > 0 && (
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
              {openings.map(o => {
                const c = o.type==="window"?"#38bdf8":"#a78bfa";
                const defK = o.type==="window"?"window":"door";
                return (
                  <div key={o.id} onClick={()=>{ setSelectedOpening({roomId:selectedId,openingId:o.id}); setSelectedId(null); }}
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

          <button onClick={()=>{ setRooms(rs=>rs.filter(r=>r.id!==selectedId)); setSelectedId(null); }}
            style={{ width:"100%",padding:"6px",background:"#200a0a",border:"1px solid #7f1d1d",color:"#f87171",borderRadius:3,cursor:"pointer",fontSize:11,fontFamily:"monospace",marginTop:14 }}>
            DELETE ROOM
          </button>
        </div>
      );
    }

    // ── Nothing selected ──
    const hints = { draw:"Click to place vertices.\nClick near start to close.\nPress Enter to close.", select:"Click a room or opening\nto select and edit it.\nDrag vertices to reshape.", window:"Click on any wall\nto place a window.", door:"Click on any wall\nto place a door." };
    return (
      <div>
        <div style={{ background:"#0a1628",border:"1px solid #132040",borderRadius:4,padding:"10px",marginBottom:14,color:"#2d5a8a",fontSize:10,lineHeight:1.8,whiteSpace:"pre-line" }}>
          {hints[tool]}
        </div>
        <div style={{ color:"#2d5a8a",fontSize:9,letterSpacing:"0.12em",marginBottom:6 }}>ROOMS — {STOREY_LABELS[activeStorey].toUpperCase()}</div>
        {rooms.length===0&&<div style={{ color:"#1b3660",fontSize:10,padding:"8px 0" }}>No rooms yet.</div>}
        {rooms.map(r => {
          const wins=(r.openings||[]).filter(o=>o.type==="window").length;
          const drs =(r.openings||[]).filter(o=>o.type==="door").length;
          return (
            <div key={r.id} onClick={()=>{ setTool("select"); setSelectedId(r.id); }}
              onMouseEnter={()=>setHoveredId(r.id)} onMouseLeave={()=>setHoveredId(null)}
              style={{ padding:"5px 8px",marginBottom:3,borderRadius:3,cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",background:"#0a1628",border:`1px solid ${hoveredId===r.id?r.line+"80":"#132040"}` }}>
              <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                <div style={{ width:6,height:6,borderRadius:"50%",background:r.line }}/>
                <span style={{ color:"#c8d8f0",fontSize:11 }}>{r.name}</span>
                {wins>0&&<span style={{ color:"#38bdf880",fontSize:8 }}>{wins}▭</span>}
                {drs>0 &&<span style={{ color:"#a78bfa80",fontSize:8 }}>{drs}⬜</span>}
              </div>
              <span style={{ color:"#2d5a8a",fontSize:9 }}>{area(r.points).toFixed(1)} m²</span>
            </div>
          );
        })}
        {rooms.length>0&&(
          <div style={{ display:"flex",justifyContent:"space-between",padding:"8px 0 0",borderTop:"1px solid #132040",marginTop:4 }}>
            <span style={{ color:"#2d5a8a",fontSize:9 }}>TOTAL</span>
            <span style={{ color:"#38bdf8",fontSize:11 }}>{totalArea.toFixed(1)} m²</span>
          </div>
        )}
        <div style={{ marginTop:20,color:"#2d5a8a",fontSize:9,letterSpacing:"0.12em",marginBottom:8 }}>SHORTCUTS</div>
        {[["D","Draw"],["S","Select"],["W","Window"],["R","Door"],["Enter","Close room"],["Esc","Cancel"],["Del","Delete"]].map(([k,v])=>(
          <div key={k} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"3px 0",borderBottom:"1px solid #0a1628" }}>
            <span style={{ color:"#1e3a6b",background:"#0a1628",padding:"1px 5px",borderRadius:2,border:"1px solid #132040",fontSize:9 }}>{k}</span>
            <span style={{ color:"#2d5a8a",fontSize:9 }}>{v}</span>
          </div>
        ))}
      </div>
    );
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ display:"flex",flexDirection:"column",height:"100%",flex:1,minHeight:0,background:"#05090f",color:"#c8d8f0",fontFamily:"monospace",overflow:"hidden" }}>

      {/* ── Toolbar ── */}
      <div style={{ display:"flex",alignItems:"center",gap:6,padding:"0 12px",background:"#070d1a",borderBottom:"1px solid #132040",height:46,flexShrink:0 }}>
        <span style={{ color:"#38bdf8",fontWeight:700,fontSize:11,letterSpacing:"0.18em",marginRight:4 }}>FLOORPLAN</span>
        <div style={{ width:1,height:20,background:"#132040" }}/>
        {tools.map(({ id, label, key }) => {
          const tc=toolColors[id], isActive=tool===id;
          return <button key={id} onClick={()=>{ setTool(id); if(id!=="draw")setDraft([]); }} style={{ padding:"5px 10px",background:isActive?tc.active:"transparent",color:isActive?tc.text:"#2d5a8a",border:`1px solid ${isActive?tc.border:"#132040"}`,borderRadius:5,cursor:"pointer",fontSize:10,fontFamily:"monospace",letterSpacing:"0.07em",transition:"all 0.15s",display:"flex",alignItems:"center",gap:5 }}>{label}<span style={{opacity:0.4,fontSize:8}}>[{key}]</span></button>;
        })}
        <div style={{ width:1,height:20,background:"#132040" }}/>
        <label style={{ display:"flex",alignItems:"center",gap:5,fontSize:9,cursor:"pointer",color:"#2d5a8a",userSelect:"none" }}>
          <input type="checkbox" checked={snapOn} onChange={e=>setSnapOn(e.target.checked)} style={{ accentColor:"#38bdf8" }}/> Snap
        </label>
        <label style={{ display:"flex",alignItems:"center",gap:5,fontSize:9,cursor:"pointer",color:activeStorey>0?"#2d5a8a":"#1a2d40",userSelect:"none" }}>
          <input type="checkbox" checked={showGhost} onChange={e=>setShowGhost(e.target.checked)} disabled={activeStorey===0} style={{ accentColor:"#38bdf8" }}/> Ghost
        </label>
        <div style={{ flex:1 }}/>
        <span style={{ fontSize:9,color:"#1e3a6b" }}>{(zoom*100).toFixed(0)}%</span>
        {savedAt&&<span style={{ fontSize:9,color:"#1e4a30",letterSpacing:"0.08em" }}>● SAVED {savedAt.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</span>}
        <button onClick={clearStorage} style={{ marginLeft:4,padding:"3px 8px",background:"transparent",border:"1px solid #1e3a6b",color:"#1e3a6b",borderRadius:4,cursor:"pointer",fontSize:9,fontFamily:"monospace" }}>NEW</button>
      </div>

      <div style={{ display:"flex",flex:1,overflow:"hidden" }}>

        {/* ── Canvas ── */}
        <svg ref={svgRef} style={{ flex:1,display:"block",cursor:(tool==="draw"||tool==="window"||tool==="door")?"crosshair":"default" }}
          onMouseMove={onMouseMove} onMouseDown={onMouseDown} onMouseUp={onMouseUp} onClick={onCanvasClick}>
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom*PPM})`}>
            {renderGrid()}
            <line x1={-0.3} y1={0} x2={0.3} y2={0} stroke="#1b3660" strokeWidth={lw}/>
            <line x1={0} y1={-0.3} x2={0} y2={0.3} stroke="#1b3660" strokeWidth={lw}/>

            {/* Ghost */}
            {showGhost && activeStorey>0 && (roomsByStorey[activeStorey-1]||[]).map(room => {
              const pts=room.points, pathD=pts.map((p,i)=>`${i?"L":"M"} ${p.x} ${p.y}`).join(" ")+" Z";
              return (
                <g key={`ghost-${room.id}`} style={{ pointerEvents:"none" }}>
                  <path d={pathD} fill="#4a7fa5" fillOpacity={0.04}/>
                  {pts.map((p,i)=>{ const next=pts[(i+1)%pts.length],wo=(room.openings||[]).filter(o=>o.wallIdx===i);
                    return <g key={i} opacity={0.22}>{wallWithOpenings(p,next,wo,"#6a9fc8",lw*2,false)}</g>; })}
                </g>
              );
            })}

            {/* Rooms */}
            {rooms.map(room => {
              const pts=room.points, pathD=pts.map((p,i)=>`${i?"L":"M"} ${p.x} ${p.y}`).join(" ")+" Z";
              const c=centroid(pts), a=area(pts);
              const isSel=selectedId===room.id, isHov=hoveredId===room.id;
              const fs=11.5/(zoom*PPM), fsSub=9/(zoom*PPM);
              const wallCol=isSel?"#f59e0b":room.line;
              return (
                <g key={room.id} onMouseEnter={()=>setHoveredId(room.id)} onMouseLeave={()=>setHoveredId(null)} onClick={e=>onRoomClick(e,room.id)}>
                  <path d={pathD} fill={isSel?room.line+"26":room.bg} style={{ cursor:tool==="select"?"pointer":"crosshair" }}/>
                  {pts.map((p,i)=>{ const next=pts[(i+1)%pts.length],wo=(room.openings||[]).filter(o=>o.wallIdx===i);
                    return <g key={i}>{wallWithOpenings(p,next,wo,wallCol,(isSel||isHov)?lw*3:lw*2,false)}{isSel&&renderMeasurement(p,next,`m-${room.id}-${i}`)}</g>; })}
                  <text x={c.x} y={c.y-fs*0.55} fontSize={fs} fill={room.label} textAnchor="middle" fontWeight="700" style={{userSelect:"none",letterSpacing:"0.08em",pointerEvents:"none"}}>{room.name.toUpperCase()}</text>
                  <text x={c.x} y={c.y+fs*0.75} fontSize={fsSub} fill={room.line} textAnchor="middle" opacity={0.7} style={{userSelect:"none",pointerEvents:"none"}}>{a.toFixed(1)} m²</text>
                  {isSel&&pts.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r={5.5/(zoom*PPM)} fill="#f59e0b" stroke="#fff4" strokeWidth={lw} style={{cursor:"move"}} onMouseDown={e=>onVertexMouseDown(e,room.id,i)}/>)}
                  {(room.openings||[]).map(o=>{ if(selectedOpening?.openingId!==o.id)return null;
                    const ptA=pts[o.wallIdx],ptB=pts[(o.wallIdx+1)%pts.length],wLen=dist(ptA,ptB);
                    const dir={x:(ptB.x-ptA.x)/wLen,y:(ptB.y-ptA.y)/wLen};
                    const mid={x:ptA.x+dir.x*(o.offset+o.width/2),y:ptA.y+dir.y*(o.offset+o.width/2)};
                    return <circle key={o.id} cx={mid.x} cy={mid.y} r={5/(zoom*PPM)} fill="none" stroke="#f59e0b" strokeWidth={lw*1.5}/>; })}
                </g>
              );
            })}

            {/* Wall hover */}
            {wallHover&&(()=>{ const room=rooms.find(r=>r.id===wallHover.roomId); if(!room)return null;
              const pts=room.points,ptA=pts[wallHover.wallIdx],ptB=pts[(wallHover.wallIdx+1)%pts.length];
              const prev=[{id:"preview",type:tool,wallIdx:0,offset:wallHover.offset,width:OPENING_DEFAULTS[tool].width}];
              return <g><line x1={ptA.x} y1={ptA.y} x2={ptB.x} y2={ptB.y} stroke={tool==="window"?"#38bdf840":"#a78bfa40"} strokeWidth={lw*5} strokeLinecap="round"/>
                {wallWithOpenings(ptA,ptB,prev,room.line,lw*2,true)}</g>; })()}

            {/* Draft */}
            {draft.length>0&&(()=>{ const nearClose=draft.length>=3&&dist(cursor,draft[0])<closeThreshold;
              return <g>
                {draft.map((p,i)=>i===0?null:<line key={i} x1={draft[i-1].x} y1={draft[i-1].y} x2={p.x} y2={p.y} stroke="#38bdf8" strokeWidth={lw*2.5} strokeLinecap="round"/>)}
                <line x1={draft[draft.length-1].x} y1={draft[draft.length-1].y} x2={cursor.x} y2={cursor.y} stroke="#38bdf8" strokeWidth={lw} opacity={0.5} strokeDasharray={`${0.1} ${0.07}`}/>
                {nearClose&&<circle cx={draft[0].x} cy={draft[0].y} r={9/(zoom*PPM)} fill="#38bdf820" stroke="#38bdf8" strokeWidth={lw*1.5}/>}
                {renderMeasurement(draft[draft.length-1],cursor,"prev")}
                {draft.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r={i===0?6/(zoom*PPM):4/(zoom*PPM)} fill={i===0?"#38bdf8":"#1a4060"} stroke="#38bdf8" strokeWidth={lw}/>)}
                <circle cx={cursor.x} cy={cursor.y} r={3/(zoom*PPM)} fill="#38bdf8" opacity={0.8}/>
              </g>; })()}

            {tool==="draw"&&draft.length===0&&<circle cx={cursor.x} cy={cursor.y} r={2.5/(zoom*PPM)} fill="#38bdf8" opacity={0.5}/>}
            {(tool==="window"||tool==="door")&&!wallHover&&<circle cx={cursor.x} cy={cursor.y} r={2.5/(zoom*PPM)} fill={tool==="window"?"#38bdf8":"#a78bfa"} opacity={0.5}/>}
          </g>
        </svg>

        {/* ── Right panel ── */}
        <div style={{ width:240,background:"#070d1a",borderLeft:"1px solid #132040",padding:14,overflowY:"auto",flexShrink:0,fontSize:11 }}>
          <div style={{ color:"#2d5a8a",letterSpacing:"0.18em",fontSize:9,marginBottom:14 }}>PROPERTIES</div>
          {renderPanelContent()}

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
          return <button key={i} onClick={()=>{ setActiveStorey(i); setSelectedId(null); setSelectedOpening(null); setDraft([]); }} style={{ padding:"4px 10px",height:32,background:isActive?"#1e4a7a":"#0a1628",color:isActive?"#7dd3fc":"#2d5a8a",border:`1px solid ${isActive?"#2563eb":"#132040"}`,borderRadius:6,cursor:"pointer",fontSize:10,fontFamily:"monospace",letterSpacing:"0.06em",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",lineHeight:1.2,transition:"all 0.15s",flexShrink:0 }}>
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
    </div>
  );
}
