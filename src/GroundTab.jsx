import { useEffect, useRef, useState, useCallback } from "react";
import { runBuildGroundMesh, runGroundSolve } from "./groundSolver.js";
import {
  GROUND_MATERIALS,
  GROUND_CONDITIONS,
  DEFAULT_GROUND_CONDITION_ID,
  DEFAULT_GROUND_CONFIG,
  SIDES,
  getEdgeSegment,
  getExposedSegments,
  edgeKey,
  distToSegment,
  distToPolyline,
} from "./groundGeometry.js";

const STORAGE_KEY = "ground_model";
const GRID_MM = 500;
const PX_PER_MM_DEFAULT = 0.04;  // 1 m = 40 px → 15 m domain fits in ~600 px
const SNAP_TOLERANCE_PX = 8;
const EDGE_HIT_TOLERANCE_PX = 6;

const createId = () => `shape-${crypto.randomUUID()}`;

// Default ground box dimensions (shown in the initial view).
const GROUND_BOX_W_MM = 10000;   // 10 m wide
const GROUND_BOX_H_MM = 15000;   // 15 m deep (updated to match domainDepthM)

function makeDefaultGroundBox() {
  return {
    id: createId(),
    x: -GROUND_BOX_W_MM / 2,
    y: 0,
    w: GROUND_BOX_W_MM,
    h: GROUND_BOX_H_MM,
    materialId: "ground",
    isGround: true,
  };
}

function readInitialState(storageKey) {
  const defaultView = { offsetX: 350, offsetY: 50, scale: PX_PER_MM_DEFAULT };
  const defaultState = () => ({
    shapes: [makeDefaultGroundBox()],
    edgeConditions: {},
    measureLine: [],
    config: { ...DEFAULT_GROUND_CONFIG },
    view: defaultView,
  });

  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) throw new Error();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.shapes)) throw new Error();
    return {
      shapes:         parsed.shapes,
      edgeConditions: parsed.edgeConditions || {},
      measureLine:    parsed.measureLine || [],
      config:         { ...DEFAULT_GROUND_CONFIG, ...(parsed.config || {}) },
      view:           parsed.view || defaultView,
    };
  } catch {
    return defaultState();
  }
}

function normalizeRect(x, y, w, h) {
  return { x: w < 0 ? x + w : x, y: h < 0 ? y + h : y, w: Math.abs(w), h: Math.abs(h) };
}

const fieldStyle = {
  width: "100%",
  boxSizing: "border-box",
  background: "#0a1628",
  border: "1px solid #132040",
  borderRadius: 4,
  color: "#c8d8f0",
  fontFamily: "monospace",
  fontSize: 12,
  outline: "none",
  padding: "6px 8px",
};

const buttonStyle = (active) => ({
  padding: "6px 10px",
  background: active ? "#1e4a7a" : "#0a1628",
  border: `1px solid ${active ? "#2563eb" : "#1e3a6b"}`,
  borderRadius: 4,
  color: active ? "#7dd3fc" : "#4a7fa5",
  cursor: "pointer",
  fontFamily: "monospace",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
});

const sectionLabel = {
  color: "#4a7aaa",
  fontFamily: "monospace",
  fontSize: 11,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  marginBottom: 8,
};

// Colour map: blue → cyan → green → yellow → red
const COLOR_STOPS = [
  [37, 52, 148], [44, 127, 184], [65, 182, 196],
  [120, 198, 121], [255, 237, 100], [244, 109, 67], [189, 0, 38],
];

function tempColor(t, tMin, tMax) {
  const range = tMax - tMin;
  const frac = range < 1e-6 ? 0.5 : Math.max(0, Math.min(1, (t - tMin) / range));
  const scaled = frac * (COLOR_STOPS.length - 1);
  const i = Math.min(COLOR_STOPS.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const [r0, g0, b0] = COLOR_STOPS[i];
  const [r1, g1, b1] = COLOR_STOPS[i + 1];
  return `rgb(${Math.round(r0 + f * (r1 - r0))},${Math.round(g0 + f * (g1 - g0))},${Math.round(b0 + f * (b1 - b0))})`;
}

export default function GroundTab({ projectId }) {
  const storageKey = `${projectId}_${STORAGE_KEY}`;
  const canvasRef    = useRef(null);
  const containerRef = useRef(null);
  const dragRef      = useRef(null);

  const _init = readInitialState(storageKey);
  const [shapes,         setShapes]         = useState(_init.shapes);
  const [edgeConditions, setEdgeConditions] = useState(_init.edgeConditions);
  const [measureLine,    setMeasureLine]    = useState(_init.measureLine);  // [{x,y}, ...]
  const [config,         setConfig]         = useState(_init.config);
  const [view,           setView]           = useState(_init.view);

  // Tools: "rect" | "select" | "boundary" | "line"
  const [tool,             setTool]             = useState("rect");
  const [activeMaterialId, setActiveMaterialId] = useState("concrete");
  const [activeConditionId,setActiveConditionId]= useState(DEFAULT_GROUND_CONDITION_ID);
  const [selectedId,       setSelectedId]       = useState(null);
  const [selectedEdge,     setSelectedEdge]     = useState(null);
  const [draft,            setDraft]            = useState(null);
  const [snapEnabled,      setSnapEnabled]      = useState(true);
  const [snapGuides,       setSnapGuides]       = useState({ x: [], y: [] });
  const [showMesh,         setShowMesh]         = useState(false);

  // Solve state
  const [solveStatus,   setSolveStatus]   = useState("idle"); // "idle"|"running"|"done"|"error"|"unavailable"
  const [solveProgress, setSolveProgress] = useState(0);      // 0–100
  const [solveResult,     setSolveResult]     = useState(null);
  const [solveColorRange, setSolveColorRange] = useState(null); // {tMin, tMax} fixed across all weeks
  const [selectedWeek,    setSelectedWeek]    = useState(0);

  // Mesh preview state
  const [meshResult,   setMeshResult]   = useState(null);
  const [meshStatus,   setMeshStatus]   = useState("idle");

  // ── Persist ──────────────────────────────────────────────────────────────
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ shapes, edgeConditions, measureLine, config, view }));
    } catch { /* best effort */ }
  }, [shapes, edgeConditions, measureLine, config, view, storageKey]);

  // ── Mesh preview ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!showMesh) return;
    if (shapes.length === 0) { setMeshResult(null); setMeshStatus("idle"); return; }
    setMeshStatus("loading");
    let cancelled = false;
    runBuildGroundMesh(shapes, config).then((mesh) => {
      if (cancelled) return;
      if (!mesh) { setMeshStatus("unavailable"); return; }
      setMeshResult(mesh);
      setMeshStatus("done");
    }).catch(() => { if (!cancelled) setMeshStatus("error"); });
    return () => { cancelled = true; };
  }, [showMesh, shapes, config]);

  // ── Solve ────────────────────────────────────────────────────────────────
  const handleSolve = async () => {
    setSolveStatus("running");
    setSolveProgress(0);
    try {
      const result = await runGroundSolve(
        shapes, edgeConditions, measureLine, config,
        (pct) => setSolveProgress(pct),
      );
      if (!result) { setSolveStatus("error"); return; }
      if (result === "unavailable") { setSolveStatus("unavailable"); return; }
      setSolveResult(result);
      // Compute global color range across all 52 weeks so the scale is consistent.
      if (result && result.cols > 0) {
        const { lambda, weeklyTemps, cols, rows } = result;
        const cellCount = cols * rows;
        let tMin = Infinity, tMax = -Infinity;
        for (let k = 0; k < weeklyTemps.length; k++) {
          if (lambda[k % cellCount] <= 0) continue;
          const t = weeklyTemps[k];
          if (t < tMin) tMin = t;
          if (t > tMax) tMax = t;
        }
        setSolveColorRange(isFinite(tMin) ? { tMin, tMax } : { tMin: 0, tMax: 20 });
      }
      setSolveStatus("done");
      setSelectedWeek(0);
    } catch (err) {
      console.error(err);
      setSolveStatus("error");
    }
  };

  // ── Coordinate helpers ────────────────────────────────────────────────────
  const screenToWorld = useCallback((sx, sy) => ({
    x: (sx - view.offsetX) / view.scale,
    y: (sy - view.offsetY) / view.scale,
  }), [view]);

  const getCanvasPoint = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  };

  // ── Snapping ──────────────────────────────────────────────────────────────
  const getSnapCandidates = useCallback((excludeId) => {
    const xs = [], ys = [];
    for (const s of shapes) {
      if (s.id === excludeId) continue;
      xs.push(s.x, s.x + s.w);
      ys.push(s.y, s.y + s.h);
    }
    return { xs, ys };
  }, [shapes]);

  const snapValue = useCallback((value, candidates, tol) => {
    let best = value, bestDiff = tol, guide = null;
    for (const c of candidates) {
      const diff = Math.abs(value - c);
      if (diff < bestDiff) { bestDiff = diff; best = c; guide = c; }
    }
    const gridSnap = Math.round(value / GRID_MM) * GRID_MM;
    if (Math.abs(value - gridSnap) < bestDiff) { best = gridSnap; guide = gridSnap; }
    return { value: best, guide };
  }, []);

  // ── Drawing ───────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    ctx.fillStyle = "#070d1a";
    ctx.fillRect(0, 0, cssW, cssH);

    const { offsetX, offsetY, scale } = view;

    // Grid
    const minor = GRID_MM * scale;
    if (minor > 3) {
      for (let x = offsetX % (minor * 10); x < cssW; x += minor) {
        const isMajor = Math.round((x - offsetX) / minor) % 10 === 0;
        ctx.strokeStyle = isMajor ? "#1e3a6b" : "#0f1f3d";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, cssH); ctx.stroke();
      }
      for (let y = offsetY % (minor * 10); y < cssH; y += minor) {
        const isMajor = Math.round((y - offsetY) / minor) % 10 === 0;
        ctx.strokeStyle = isMajor ? "#1e3a6b" : "#0f1f3d";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(cssW, y + 0.5); ctx.stroke();
      }
    }

    // Axes
    ctx.strokeStyle = "#2d5a8a"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, offsetY + 0.5); ctx.lineTo(cssW, offsetY + 0.5);
    ctx.moveTo(offsetX + 0.5, 0); ctx.lineTo(offsetX + 0.5, cssH);
    ctx.stroke();

    // Solve result: temperature field overlay
    if (solveStatus === "done" && solveResult && solveResult.cols > 0) {
      const { cols, rows, nodeXs, nodeYs, lambda, weeklyTemps } = solveResult;
      const cellCount = cols * rows;
      const weekOffset = selectedWeek * cellCount;

      const { tMin, tMax } = solveColorRange ?? { tMin: 0, tMax: 20 };

      for (let cj = 0; cj < rows; cj++) {
        for (let ci = 0; ci < cols; ci++) {
          if (lambda[cj * cols + ci] <= 0) continue;
          const t = weeklyTemps[weekOffset + cj * cols + ci];
          const sx = offsetX + nodeXs[ci]     * scale;
          const sy = offsetY + nodeYs[cj]     * scale;
          const sw = (nodeXs[ci + 1] - nodeXs[ci]) * scale;
          const sh = (nodeYs[cj + 1] - nodeYs[cj]) * scale;
          ctx.fillStyle = tempColor(t, tMin, tMax);
          ctx.fillRect(sx, sy, sw, sh);
        }
      }
    }

    // Mesh overlay
    if (showMesh && meshResult && meshStatus === "done") {
      const { cols, rows, nodeXs, nodeYs, lambda } = meshResult;
      ctx.strokeStyle = "#7dd3fc33";
      ctx.lineWidth = 0.5;
      for (let cj = 0; cj < rows; cj++) {
        for (let ci = 0; ci < cols; ci++) {
          if (lambda[cj * cols + ci] <= 0) continue;
          const sx = offsetX + nodeXs[ci]     * scale;
          const sy = offsetY + nodeYs[cj]     * scale;
          const sw = (nodeXs[ci + 1] - nodeXs[ci]) * scale;
          const sh = (nodeYs[cj + 1] - nodeYs[cj]) * scale;
          ctx.strokeRect(sx + 0.5, sy + 0.5, sw, sh);
        }
      }
    }

    // Shapes
    const renderRect = (shape, isSelected) => {
      const material = GROUND_MATERIALS.find((m) => m.id === shape.materialId) || GROUND_MATERIALS[0];
      const sx = offsetX + shape.x * scale;
      const sy = offsetY + shape.y * scale;
      const sw = shape.w * scale;
      const sh = shape.h * scale;

      // Ground box: dashed hatching for the "infinite" feel
      if (shape.isGround) {
        ctx.fillStyle = material.color + "22";
        ctx.fillRect(sx, sy, sw, sh);
        ctx.strokeStyle = material.color + "88";
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 6]);
        ctx.strokeRect(sx, sy, sw, sh);
        ctx.setLineDash([]);
        // Label
        if (sw > 60 && sh > 20) {
          ctx.fillStyle = material.color + "bb";
          ctx.font = "10px monospace";
          ctx.fillText("Ground (half-space)", sx + 6, sy + 14);
        }
        return;
      }

      ctx.fillStyle = material.color + "55";
      ctx.fillRect(sx, sy, sw, sh);
      ctx.strokeStyle = isSelected ? material.color : material.color + "cc";
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.strokeRect(sx, sy, sw, sh);

      if (isSelected) {
        ctx.fillStyle = "#7dd3fc";
        for (const [hx, hy] of [[sx, sy], [sx + sw, sy], [sx, sy + sh], [sx + sw, sy + sh]])
          ctx.fillRect(hx - 4, hy - 4, 8, 8);
      }

      if (sw > 40 && sh > 16) {
        ctx.fillStyle = "#c8d8f0";
        ctx.font = "10px monospace";
        ctx.fillText(material.name, sx + 4, sy + 12);
        ctx.fillText(`${shape.w.toFixed(0)}×${shape.h.toFixed(0)}mm`, sx + 4, sy + sh - 4);
      }
    };

    // Draw ground box first, then building layers
    for (const shape of shapes) {
      if (shape.isGround) renderRect(shape, shape.id === selectedId);
    }
    for (const shape of shapes) {
      if (!shape.isGround) renderRect(shape, shape.id === selectedId);
    }

    if (draft) {
      const r = normalizeRect(draft.x, draft.y, draft.w, draft.h);
      renderRect({ ...r, materialId: activeMaterialId, id: "__draft", isGround: false }, false);
    }

    // Boundary edges
    if (tool === "boundary") {
      for (const shape of shapes) {
        for (const side of SIDES) {
          const exposedSegs = getExposedSegments(shapes, shape.id, side);
          const condId = edgeConditions[edgeKey(shape.id, side)] || DEFAULT_GROUND_CONDITION_ID;
          const cond   = GROUND_CONDITIONS.find((c) => c.id === condId);
          const isSelected = selectedEdge?.shapeId === shape.id && selectedEdge?.side === side;

          const full = getEdgeSegment(shape, side);
          ctx.strokeStyle = "#33415580"; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(offsetX + full.a.x * scale, offsetY + full.a.y * scale);
          ctx.lineTo(offsetX + full.b.x * scale, offsetY + full.b.y * scale);
          ctx.stroke();
          ctx.setLineDash([]);

          if (exposedSegs.length === 0) continue;
          for (const seg of exposedSegs) {
            ctx.strokeStyle = cond?.color ?? "#6b7280";
            ctx.lineWidth = isSelected ? 6 : 4;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(offsetX + seg.a.x * scale, offsetY + seg.a.y * scale);
            ctx.lineTo(offsetX + seg.b.x * scale, offsetY + seg.b.y * scale);
            ctx.stroke();
            ctx.lineCap = "butt";
          }
        }
      }
    }

    // Measurement polyline
    if (measureLine.length >= 1) {
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 4]);
      ctx.beginPath();
      measureLine.forEach((pt, i) => {
        const sx = offsetX + pt.x * scale;
        const sy = offsetY + pt.y * scale;
        i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      // Draw vertex dots
      ctx.fillStyle = "#f59e0b";
      for (const pt of measureLine) {
        ctx.beginPath();
        ctx.arc(offsetX + pt.x * scale, offsetY + pt.y * scale, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      // Label
      if (measureLine.length >= 2) {
        const mid = measureLine[Math.floor(measureLine.length / 2)];
        ctx.fillStyle = "#f59e0b";
        ctx.font = "10px monospace";
        ctx.fillText("heat loss line", offsetX + mid.x * scale + 6, offsetY + mid.y * scale - 4);
      }
    }

    // Snap guides
    if (snapGuides.x.length || snapGuides.y.length) {
      ctx.strokeStyle = "#7dd3fc"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      for (const wx of snapGuides.x) {
        const x = offsetX + wx * scale;
        ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, cssH); ctx.stroke();
      }
      for (const wy of snapGuides.y) {
        const y = offsetY + wy * scale;
        ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(cssW, y + 0.5); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  }, [shapes, view, selectedId, draft, activeMaterialId, snapGuides, tool, selectedEdge,
      edgeConditions, showMesh, meshResult, meshStatus, solveStatus, solveResult, measureLine, selectedWeek]);

  useEffect(() => { draw(); }, [draw]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(el);
    return () => ro.disconnect();
  }, [draw]);

  // ── Hit testing ───────────────────────────────────────────────────────────
  const hitTest = (worldPt) => {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (!s.isGround && worldPt.x >= s.x && worldPt.x <= s.x + s.w && worldPt.y >= s.y && worldPt.y <= s.y + s.h)
        return s;
    }
    // Ground box fallback
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (s.isGround && worldPt.x >= s.x && worldPt.x <= s.x + s.w && worldPt.y >= s.y && worldPt.y <= s.y + s.h)
        return s;
    }
    return null;
  };

  const edgeAtPoint = (screenPt) => {
    let best = null, bestDist = EDGE_HIT_TOLERANCE_PX;
    for (const shape of shapes) {
      for (const side of SIDES) {
        const exposed = getExposedSegments(shapes, shape.id, side);
        for (const seg of exposed) {
          const a = { x: view.offsetX + seg.a.x * view.scale, y: view.offsetY + seg.a.y * view.scale };
          const b = { x: view.offsetX + seg.b.x * view.scale, y: view.offsetY + seg.b.y * view.scale };
          const d = distToSegment({ x: screenPt.sx, y: screenPt.sy }, a, b);
          if (d < bestDist) { bestDist = d; best = { shapeId: shape.id, side }; }
        }
      }
    }
    return best;
  };

  const HANDLE_TOL = 8;
  const handleAtPoint = (shape, screenPt) => {
    const x = view.offsetX + shape.x * view.scale;
    const y = view.offsetY + shape.y * view.scale;
    const w = shape.w * view.scale, h = shape.h * view.scale;
    for (const [name, [hx, hy]] of Object.entries({ nw:[x,y], ne:[x+w,y], sw:[x,y+h], se:[x+w,y+h] })) {
      if (Math.abs(screenPt.sx - hx) <= HANDLE_TOL && Math.abs(screenPt.sy - hy) <= HANDLE_TOL)
        return name;
    }
    return null;
  };

  // ── Mouse handlers ────────────────────────────────────────────────────────
  const onMouseDown = (e) => {
    const screenPt = getCanvasPoint(e);
    const worldPt  = screenToWorld(screenPt.sx, screenPt.sy);

    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
      dragRef.current = { mode: "pan", startSx: screenPt.sx, startSy: screenPt.sy, startView: view };
      return;
    }

    if (tool === "rect" && e.button === 0) {
      setSelectedId(null);
      setDraft({ x: worldPt.x, y: worldPt.y, w: 0, h: 0 });
      dragRef.current = { mode: "draw", startWorld: worldPt };
      return;
    }

    if (tool === "boundary" && e.button === 0) {
      const edge = edgeAtPoint(screenPt);
      setSelectedEdge(edge);
      if (edge) {
        setEdgeConditions((prev) => ({ ...prev, [edgeKey(edge.shapeId, edge.side)]: activeConditionId }));
        dragRef.current = { mode: "paint-boundary" };
      }
      return;
    }

    if (tool === "line" && e.button === 0) {
      // Double-click ends the line
      if (e.detail === 2) {
        dragRef.current = null;
        return;
      }
      setMeasureLine((prev) => {
        const pt = { x: worldPt.x, y: worldPt.y };
        if (snapEnabled && prev.length > 0) {
          // Snap to axis-aligned from last point
          const last = prev[prev.length - 1];
          const dx = Math.abs(pt.x - last.x), dy = Math.abs(pt.y - last.y);
          if (dx < SNAP_TOLERANCE_PX / view.scale) pt.x = last.x;
          else if (dy < SNAP_TOLERANCE_PX / view.scale) pt.y = last.y;
        }
        return [...prev, pt];
      });
      return;
    }

    if (tool === "select" && e.button === 0) {
      const selected = shapes.find((s) => s.id === selectedId);
      if (selected && !selected.isGround) {
        const handle = handleAtPoint(selected, screenPt);
        if (handle) {
          dragRef.current = { mode: "resize", id: selected.id, handle, original: { ...selected } };
          return;
        }
      }
      const hit = hitTest(worldPt);
      if (hit) {
        setSelectedId(hit.id);
        if (!hit.isGround) {
          dragRef.current = { mode: "move", id: hit.id, startWorld: worldPt, original: { ...hit } };
        }
      } else {
        setSelectedId(null);
      }
    }
  };

  const onMouseMove = (e) => {
    const drag = dragRef.current;
    if (!drag) return;
    const screenPt = getCanvasPoint(e);
    const worldPt  = screenToWorld(screenPt.sx, screenPt.sy);
    const tol = SNAP_TOLERANCE_PX / view.scale;

    if (drag.mode === "pan") {
      setView((v) => ({
        ...v,
        offsetX: drag.startView.offsetX + (screenPt.sx - drag.startSx),
        offsetY: drag.startView.offsetY + (screenPt.sy - drag.startSy),
      }));
      return;
    }
    if (drag.mode === "paint-boundary") {
      const edge = edgeAtPoint(screenPt);
      if (edge) {
        setSelectedEdge(edge);
        setEdgeConditions((prev) => ({ ...prev, [edgeKey(edge.shapeId, edge.side)]: activeConditionId }));
      }
      return;
    }
    if (drag.mode === "draw") {
      let { x: wx, y: wy } = worldPt;
      const guides = { x: [], y: [] };
      if (snapEnabled) {
        const { xs, ys } = getSnapCandidates(null);
        const sx = snapValue(wx, xs, tol), sy = snapValue(wy, ys, tol);
        wx = sx.value; wy = sy.value;
        if (sx.guide !== null) guides.x.push(sx.guide);
        if (sy.guide !== null) guides.y.push(sy.guide);
      }
      setSnapGuides(guides);
      setDraft({ x: drag.startWorld.x, y: drag.startWorld.y, w: wx - drag.startWorld.x, h: wy - drag.startWorld.y });
      return;
    }
    if (drag.mode === "move") {
      let dx = worldPt.x - drag.startWorld.x;
      let dy = worldPt.y - drag.startWorld.y;
      const guides = { x: [], y: [] };
      if (snapEnabled) {
        const { xs, ys } = getSnapCandidates(drag.id);
        const left = drag.original.x + dx, right = drag.original.x + drag.original.w + dx;
        const top  = drag.original.y + dy, bot   = drag.original.y + drag.original.h + dy;
        const sl = snapValue(left,  xs, tol), sr = snapValue(right, xs, tol);
        const st = snapValue(top,   ys, tol), sb = snapValue(bot,   ys, tol);
        const dxl = sl.value - left, dxr = sr.value - right;
        if (dxl !== 0 || dxr !== 0) {
          if (Math.abs(dxl) <= Math.abs(dxr) && dxl !== 0) { dx += dxl; guides.x.push(sl.guide); }
          else if (dxr !== 0) { dx += dxr; guides.x.push(sr.guide); }
        }
        const dyt = st.value - top, dyb = sb.value - bot;
        if (dyt !== 0 || dyb !== 0) {
          if (Math.abs(dyt) <= Math.abs(dyb) && dyt !== 0) { dy += dyt; guides.y.push(st.guide); }
          else if (dyb !== 0) { dy += dyb; guides.y.push(sb.guide); }
        }
      }
      setSnapGuides(guides);
      setShapes((cur) => cur.map((s) => s.id === drag.id ? { ...s, x: drag.original.x + dx, y: drag.original.y + dy } : s));
      return;
    }
    if (drag.mode === "resize") {
      const orig = drag.original;
      let { x: wx, y: wy } = worldPt;
      if (snapEnabled) {
        const { xs, ys } = getSnapCandidates(drag.id);
        wx = snapValue(wx, xs, tol).value;
        wy = snapValue(wy, ys, tol).value;
      }
      let { x, y, w, h } = orig;
      if (drag.handle.includes("n")) { h = orig.y + orig.h - wy; y = wy; }
      if (drag.handle.includes("s")) { h = wy - orig.y; }
      if (drag.handle.includes("w")) { w = orig.x + orig.w - wx; x = wx; }
      if (drag.handle.includes("e")) { w = wx - orig.x; }
      setShapes((cur) => cur.map((s) => s.id === drag.id ? { ...s, ...normalizeRect(x, y, w, h) } : s));
    }
  };

  const onMouseUp = () => {
    const drag = dragRef.current;
    if (drag?.mode === "draw" && draft) {
      const norm = normalizeRect(draft.x, draft.y, draft.w, draft.h);
      if (norm.w > 1 && norm.h > 1) {
        const newShape = { id: createId(), ...norm, materialId: activeMaterialId, isGround: false };
        setShapes((cur) => [...cur, newShape]);
        setSelectedId(newShape.id);
        setTool("select");
      }
      setDraft(null);
    }
    setSnapGuides({ x: [], y: [] });
    dragRef.current = null;
  };

  const onWheel = (e) => {
    e.preventDefault();
    const screenPt = getCanvasPoint(e);
    const worldBefore = screenToWorld(screenPt.sx, screenPt.sy);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setView((v) => {
      const newScale = Math.min(20, Math.max(0.05, v.scale * factor));
      return { scale: newScale, offsetX: screenPt.sx - worldBefore.x * newScale, offsetY: screenPt.sy - worldBefore.y * newScale };
    });
  };

  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "SELECT")) return;
        const shape = shapes.find((s) => s.id === selectedId);
        if (shape?.isGround) return;  // cannot delete the ground box
        setShapes((cur) => cur.filter((s) => s.id !== selectedId));
        setSelectedId(null);
      }
      if (e.key === "Escape" && tool === "line") {
        // Remove last line point on Escape while drawing
        setMeasureLine((prev) => prev.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId, shapes, tool]);

  const selectedShape = shapes.find((s) => s.id === selectedId) || null;
  const updateSelectedShape = (fn) =>
    setShapes((cur) => cur.map((s) => s.id === selectedId ? fn(s) : s));

  // ── Config field helper ───────────────────────────────────────────────────
  const configField = (label, key, min, max, step = 1) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, color: "#4a7fa5", fontFamily: "monospace", fontSize: 10 }}>
      {label}
      <input
        type="number"
        min={min} max={max} step={step}
        value={config[key]}
        onChange={(e) => setConfig((c) => ({ ...c, [key]: Number(e.target.value) }))}
        style={fieldStyle}
      />
    </label>
  );

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0, minWidth: 0 }}>
      {/* Canvas */}
      <div ref={containerRef} style={{ flex: 1, position: "relative", minWidth: 0 }}>
        <canvas
          ref={canvasRef}
          style={{
            width: "100%", height: "100%", display: "block",
            cursor: tool === "rect" ? "crosshair" : tool === "line" ? "crosshair" : tool === "boundary" ? "pointer" : "default",
          }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
        />

        {/* Toolbar */}
        <div style={{ position: "absolute", top: 10, left: 10, display: "flex", gap: 6, background: "#070d1aee", border: "1px solid #132040", borderRadius: 6, padding: 6 }}>
          <button type="button" style={buttonStyle(tool === "rect")}     onClick={() => setTool("rect")}>Draw</button>
          <button type="button" style={buttonStyle(tool === "select")}   onClick={() => setTool("select")}>Select</button>
          <button type="button" style={buttonStyle(tool === "boundary")} onClick={() => setTool("boundary")}>Boundary</button>
          <button type="button" style={buttonStyle(tool === "line")}     onClick={() => setTool("line")}
            title="Draw heat-loss measurement line (click to add points, double-click or Escape to finish)">
            Heat line
          </button>
          {measureLine.length > 0 && (
            <button type="button" style={{ ...buttonStyle(false), color: "#f47272", borderColor: "#7a2d2d" }}
              onClick={() => setMeasureLine([])}>Clear line</button>
          )}
          <label style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 10px", border: "1px solid #1e3a6b", borderRadius: 4, color: snapEnabled ? "#7dd3fc" : "#4a7fa5", cursor: "pointer", fontFamily: "monospace", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            <input type="checkbox" checked={snapEnabled} onChange={(e) => setSnapEnabled(e.target.checked)} />
            Snap
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 10px", border: "1px solid #1e3a6b", borderRadius: 4, color: showMesh ? "#7dd3fc" : "#4a7fa5", cursor: "pointer", fontFamily: "monospace", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            <input type="checkbox" checked={showMesh} onChange={(e) => setShowMesh(e.target.checked)} />
            Mesh
          </label>
        </div>

        {/* Help text */}
        <div style={{ position: "absolute", bottom: 10, left: 10, color: "#4a7fa5", fontFamily: "monospace", fontSize: 10, background: "#070d1aee", border: "1px solid #132040", borderRadius: 6, padding: "6px 8px", lineHeight: 1.6 }}>
          Draw: drag to add layers on top of ground<br />
          Select: drag to move, corners to resize, Delete to remove<br />
          Boundary: pick condition type, click/drag edges<br />
          Heat line: click points, double-click/Escape to finish<br />
          Shift+drag or scroll to pan/zoom
        </div>
      </div>

      {/* Side panel */}
      <div style={{ width: 260, flexShrink: 0, borderLeft: "1px solid #132040", background: "#070d1a", padding: 12, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Tool-specific panels */}
        {tool === "boundary" && (
          <div>
            <div style={sectionLabel}>Boundary condition</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {GROUND_CONDITIONS.map((c) => (
                <button key={c.id} type="button"
                  onClick={() => {
                    setActiveConditionId(c.id);
                    if (selectedEdge) {
                      setEdgeConditions((prev) => ({ ...prev, [edgeKey(selectedEdge.shapeId, selectedEdge.side)]: c.id }));
                    }
                  }}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", background: activeConditionId === c.id ? "#1e4a7a" : "#0a1628", border: `1px solid ${activeConditionId === c.id ? "#2563eb" : "#1e3a6b"}`, borderRadius: 4, color: "#c8d8f0", cursor: "pointer", fontFamily: "monospace", fontSize: 11, textAlign: "left" }}>
                  <span style={{ width: 12, height: 12, borderRadius: 2, background: c.color, flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>{c.name}</span>
                  <span style={{ color: "#4a7fa5", fontSize: 9 }}>{c.description}</span>
                </button>
              ))}
            </div>
            <div style={{ marginTop: 8, color: "#4a7fa5", fontFamily: "monospace", fontSize: 10, lineHeight: 1.6 }}>
              {selectedEdge ? `Selected: ${selectedEdge.side} edge` : "Click an edge to apply condition."}
              <div style={{ marginTop: 4, color: "#2d5a8a" }}>
                Surface = EPW exterior air temperature (varies hourly).<br />
                Inside = fixed indoor temperature ({config.indoorTemp}°C).<br />
                Adiabatic = zero flux (sides/bottom of ground domain).
              </div>
            </div>
          </div>
        )}

        {tool !== "boundary" && (
          <div>
            <div style={sectionLabel}>Material</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {GROUND_MATERIALS.filter((m) => m.id !== "ground").map((m) => (
                <button key={m.id} type="button"
                  onClick={() => {
                    setActiveMaterialId(m.id);
                    if (selectedShape && !selectedShape.isGround)
                      updateSelectedShape((s) => ({ ...s, materialId: m.id }));
                  }}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", background: activeMaterialId === m.id ? "#1e4a7a" : "#0a1628", border: `1px solid ${activeMaterialId === m.id ? "#2563eb" : "#1e3a6b"}`, borderRadius: 4, color: "#c8d8f0", cursor: "pointer", fontFamily: "monospace", fontSize: 10, textAlign: "left" }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: m.color, flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>{m.name}</span>
                  <span style={{ color: "#4a7fa5", fontSize: 9 }}>λ={m.lambda} ρc={m.density}×{m.specificHeat}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {tool === "select" && selectedShape && !selectedShape.isGround && (
          <div>
            <div style={sectionLabel}>Selected layer</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, marginBottom: 6 }}>
              {[["X (mm)", "x"], ["Y (mm)", "y"], ["W (mm)", "w"], ["H (mm)", "h"]].map(([lbl, prop]) => (
                <label key={prop} style={{ display: "flex", flexDirection: "column", gap: 3, color: "#4a7fa5", fontFamily: "monospace", fontSize: 10 }}>
                  {lbl}
                  <input type="number" style={fieldStyle} value={Math.round(selectedShape[prop])}
                    onChange={(e) => updateSelectedShape((s) => ({ ...s, [prop]: Number(e.target.value) }))} />
                </label>
              ))}
            </div>
            <button type="button"
              style={{ ...buttonStyle(false), width: "100%", color: "#f47272", borderColor: "#7a2d2d" }}
              onClick={() => { setShapes((cur) => cur.filter((s) => s.id !== selectedId)); setSelectedId(null); }}>
              Delete layer
            </button>
          </div>
        )}

        {/* Domain / solver config */}
        <div>
          <div style={sectionLabel}>Domain &amp; mesh</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {configField("Domain depth (m)",       "domainDepthM",     1, 50, 1)}
            {configField("Domain half-width (m)",  "domainHalfWidthM", 1, 50, 1)}
            {configField("Near cell (mm)",          "nearCellMm",       5, 200, 5)}
            {configField("Growth ratio",            "growthRatio",      1.05, 2.0, 0.05)}
            {configField("Max cell (mm)",           "maxCellMm",        50, 2000, 50)}
          </div>
        </div>

        <div>
          <div style={sectionLabel}>Solver</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {configField("Indoor temp (°C)",  "indoorTemp",   5,  35, 1)}
            {configField("Spin-up years",     "spinupYears",  0,  10, 1)}
            <label style={{ display: "flex", flexDirection: "column", gap: 3, color: "#4a7fa5", fontFamily: "monospace", fontSize: 10 }}>
              Timestep
              <select
                value={config.stepsPerYear}
                onChange={(e) => {
                  const spy = Number(e.target.value);
                  const dt = spy === 8760 ? 3600 : spy === 1460 ? 21600 : 86400;
                  setConfig((c) => ({ ...c, stepsPerYear: spy, dtSeconds: dt }));
                }}
                style={{ ...fieldStyle, cursor: "pointer" }}>
                <option value={365}>Daily (365 steps/yr)</option>
                <option value={1460}>6-hourly (1460 steps/yr)</option>
                <option value={8760}>Hourly (8760 steps/yr)</option>
              </select>
            </label>
          </div>
        </div>

        {/* Mesh status */}
        {showMesh && (
          <div style={{ color: meshStatus === "done" ? "#34d399" : meshStatus === "error" || meshStatus === "unavailable" ? "#f47272" : "#4a7fa5", fontFamily: "monospace", fontSize: 10 }}>
            {meshStatus === "loading" && "Building mesh…"}
            {meshStatus === "done" && meshResult && `Mesh: ${meshResult.cols}×${meshResult.rows} cells`}
            {meshStatus === "unavailable" && "WASM not built — run npm run build:wasm:ground:win"}
            {meshStatus === "error" && "Mesh build failed"}
          </div>
        )}

        {/* Solve button + results */}
        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
          <button type="button"
            style={{ ...buttonStyle(false), width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
            onClick={handleSolve}
            disabled={solveStatus === "running" || shapes.length === 0}>
            {solveStatus === "running" ? "Solving…" : "Run ground simulation"}
          </button>

          {solveStatus === "running" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ background: "#0a1628", border: "1px solid #132040", borderRadius: 4, height: 8, overflow: "hidden" }}>
                <div style={{ width: `${solveProgress}%`, height: "100%", background: "#2563eb", borderRadius: 4, transition: "width 0.4s ease" }} />
              </div>
              <div style={{ color: "#4a7fa5", fontFamily: "monospace", fontSize: 10, textAlign: "center" }}>
                {solveProgress}% — {solveProgress < 100 ? "solving…" : "finishing…"}
              </div>
            </div>
          )}

          {solveStatus === "unavailable" && (
            <div style={{ color: "#fbbf24", fontFamily: "monospace", fontSize: 10, lineHeight: 1.6 }}>
              WASM not built. Run <code>npm run build:wasm:ground:win</code>.
            </div>
          )}
          {solveStatus === "error" && (
            <div style={{ color: "#f47272", fontFamily: "monospace", fontSize: 10 }}>
              Solve failed — see console.
            </div>
          )}

          {solveStatus === "done" && solveResult && (
            <div style={{ color: "#34d399", fontFamily: "monospace", fontSize: 10, lineHeight: 1.7 }}>
              Done — {solveResult.totalSteps} steps<br />
              Grid: {solveResult.cols}×{solveResult.rows} cells<br />
              Periodicity residual: {solveResult.periodicityResidual.toFixed(3)}°C

              {/* Weekly temperature snapshot slider */}
              <div style={{ marginTop: 10 }}>
                <div style={{ color: "#4a7aaa", marginBottom: 4 }}>
                  Week {selectedWeek + 1} / 52
                </div>
                <input type="range" min={0} max={51} value={selectedWeek}
                  onChange={(e) => setSelectedWeek(Number(e.target.value))}
                  style={{ width: "100%", accentColor: "#2563eb" }} />
              </div>

              {/* Monthly heat-loss chart */}
              {solveResult.monthlyHeatLossKwh && solveResult.monthlyHeatLossKwh.some((v) => v !== 0) && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ color: "#4a7aaa", marginBottom: 4 }}>Monthly heat loss (kWh/m depth)</div>
                  {["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].map((mo, i) => {
                    const val = solveResult.monthlyHeatLossKwh[i] ?? 0;
                    const maxVal = Math.max(...solveResult.monthlyHeatLossKwh.map(Math.abs), 0.001);
                    const barW = Math.abs(val) / maxVal * 100;
                    const isNeg = val < 0;
                    return (
                      <div key={mo} style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
                        <span style={{ width: 24, color: "#4a7fa5", flexShrink: 0 }}>{mo}</span>
                        <div style={{ flex: 1, height: 10, background: "#0a1628", borderRadius: 2, overflow: "hidden" }}>
                          <div style={{ width: `${barW}%`, height: "100%", background: isNeg ? "#38bdf8" : "#f97316", borderRadius: 2 }} />
                        </div>
                        <span style={{ width: 44, textAlign: "right", color: isNeg ? "#38bdf8" : "#f97316" }}>
                          {val.toFixed(1)}
                        </span>
                      </div>
                    );
                  })}
                  <div style={{ color: "#4a7fa5", fontSize: 9, marginTop: 4 }}>
                    Orange = heat loss to ground · Blue = heat gain from ground
                  </div>
                </div>
              )}
              {solveResult.monthlyHeatLossKwh && solveResult.monthlyHeatLossKwh.every((v) => v === 0) && (
                <div style={{ color: "#4a7fa5", fontSize: 9, marginTop: 6 }}>
                  No heat loss data — draw a measurement line first.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
