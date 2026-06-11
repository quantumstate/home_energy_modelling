import { useEffect, useRef, useState, useCallback } from "react";
import { runThermalSolve, runBuildMesh } from "./thermalSolver.js";
import {
  MATERIALS,
  CONDITIONS,
  DEFAULT_CONDITION_ID,
  SIDES,
  getEdgeSegment,
  isEdgeShared,
  edgeKey,
  distToSegment,
} from "./thermalBridgeGeometry.js";

const STORAGE_KEY = "thermal_bridges_model";

// ─── Geometry ─────────────────────────────────────────────────────────────────
const GRID_MM = 50; // base grid spacing in mm
const PX_PER_MM_DEFAULT = 1.5;
const SNAP_TOLERANCE_PX = 8;
const EDGE_HIT_TOLERANCE_PX = 6;

const createId = () => `shape-${crypto.randomUUID()}`;

function readStored(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.shapes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeRect(x, y, w, h) {
  return {
    x: w < 0 ? x + w : x,
    y: h < 0 ? y + h : y,
    w: Math.abs(w),
    h: Math.abs(h),
  };
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

export default function ThermalBridgesTab({ projectId }) {
  const storageKey = `${projectId}_${STORAGE_KEY}`;
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  const initial = readStored(storageKey);
  const [shapes, setShapes] = useState(initial?.shapes || []);
  const [view, setView] = useState(
    initial?.view || { offsetX: 80, offsetY: 80, scale: PX_PER_MM_DEFAULT }
  );

  const [tool, setTool] = useState("rect"); // "rect" | "select"
  const [activeMaterialId, setActiveMaterialId] = useState(MATERIALS[0].id);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null); // in-progress rect (world mm coords)
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [snapGuides, setSnapGuides] = useState({ x: [], y: [] }); // world mm positions

  const [edgeConditions, setEdgeConditions] = useState(initial?.edgeConditions || {}); // edgeKey -> conditionId
  const [activeConditionId, setActiveConditionId] = useState(DEFAULT_CONDITION_ID);
  const [selectedEdge, setSelectedEdge] = useState(null); // { shapeId, side }

  const [solveStatus, setSolveStatus] = useState("idle"); // "idle" | "running" | "done" | "unavailable" | "error"
  const [solveResult, setSolveResult] = useState(null);

  const [showMesh, setShowMesh] = useState(false);
  const [meshStatus, setMeshStatus] = useState("idle"); // "idle" | "loading" | "done" | "unavailable" | "error"
  const [meshResult, setMeshResult] = useState(null);

  const dragRef = useRef(null); // generic drag state for pan / move / resize / draw

  const handleSolve = async () => {
    setSolveStatus("running");
    try {
      const result = await runThermalSolve(shapes, edgeConditions);
      if (!result) {
        setSolveStatus("unavailable");
        setSolveResult(null);
        return;
      }
      setSolveResult(result);
      setSolveStatus("done");
    } catch {
      setSolveStatus("error");
      setSolveResult(null);
    }
  };

  // ─── Persist ──────────────────────────────────────────────────────────────
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ shapes, view, edgeConditions }));
    } catch {
      // best effort
    }
  }, [shapes, view, edgeConditions, storageKey]);

  // ─── Mesh debug view ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!showMesh) return;
    let cancelled = false;
    if (shapes.length === 0) {
      Promise.resolve().then(() => {
        if (cancelled) return;
        setMeshResult(null);
        setMeshStatus("idle");
      });
      return () => {
        cancelled = true;
      };
    }
    Promise.resolve().then(() => {
      if (!cancelled) setMeshStatus("loading");
    });
    runBuildMesh(shapes)
      .then((mesh) => {
        if (cancelled) return;
        if (!mesh) {
          setMeshResult(null);
          setMeshStatus("unavailable");
          return;
        }
        setMeshResult(mesh);
        setMeshStatus("done");
      })
      .catch(() => {
        if (cancelled) return;
        setMeshResult(null);
        setMeshStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [showMesh, shapes]);

  // Resolves the boundary condition for an edge: shared edges between
  // elements may not have one, external edges default to adiabatic.
  const getEdgeCondition = useCallback(
    (shapeId, side) => {
      if (isEdgeShared(shapes, shapeId, side)) return null;
      return edgeConditions[edgeKey(shapeId, side)] || DEFAULT_CONDITION_ID;
    },
    [shapes, edgeConditions]
  );

  // ─── Coordinate helpers ───────────────────────────────────────────────────
  const screenToWorld = useCallback(
    (sx, sy) => ({
      x: (sx - view.offsetX) / view.scale,
      y: (sy - view.offsetY) / view.scale,
    }),
    [view]
  );

  const getCanvasPoint = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  };

  // ─── Snapping ─────────────────────────────────────────────────────────────
  // Returns the x/y edges (and grid lines) of every other shape that a dragged
  // point or edge can snap to.
  const getSnapCandidates = useCallback(
    (excludeId) => {
      const xs = [];
      const ys = [];
      for (const s of shapes) {
        if (s.id === excludeId) continue;
        xs.push(s.x, s.x + s.w);
        ys.push(s.y, s.y + s.h);
      }
      return { xs, ys };
    },
    [shapes]
  );

  // Snaps `value` to the nearest candidate (or grid line) within tolerance.
  // Returns { value, guide } where `guide` is the snapped-to position, or null.
  const snapValue = useCallback(
    (value, candidates, tol) => {
      let best = value;
      let bestDiff = tol;
      let guide = null;
      for (const c of candidates) {
        const diff = Math.abs(value - c);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = c;
          guide = c;
        }
      }
      const gridSnap = Math.round(value / GRID_MM) * GRID_MM;
      const gridDiff = Math.abs(value - gridSnap);
      if (gridDiff < bestDiff) {
        best = gridSnap;
        guide = gridSnap;
      }
      return { value: best, guide };
    },
    []
  );

  // ─── Drawing ──────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // background
    ctx.fillStyle = "#070d1a";
    ctx.fillRect(0, 0, cssW, cssH);

    // grid
    const { offsetX, offsetY, scale } = view;
    const minor = GRID_MM * scale;
    if (minor > 4) {
      const startX = offsetX % (minor * 10);
      const startY = offsetY % (minor * 10);
      ctx.lineWidth = 1;
      for (let x = startX; x < cssW; x += minor) {
        const isMajor = Math.round((x - offsetX) / minor) % 10 === 0;
        ctx.strokeStyle = isMajor ? "#1e3a6b" : "#0f1f3d";
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, cssH);
        ctx.stroke();
      }
      for (let y = startY; y < cssH; y += minor) {
        const isMajor = Math.round((y - offsetY) / minor) % 10 === 0;
        ctx.strokeStyle = isMajor ? "#1e3a6b" : "#0f1f3d";
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(cssW, y + 0.5);
        ctx.stroke();
      }
    }

    // origin axes
    ctx.strokeStyle = "#2d5a8a";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, offsetY + 0.5);
    ctx.lineTo(cssW, offsetY + 0.5);
    ctx.moveTo(offsetX + 0.5, 0);
    ctx.lineTo(offsetX + 0.5, cssH);
    ctx.stroke();

    // shapes
    const renderRect = (shape, isSelected) => {
      const material = MATERIALS.find((m) => m.id === shape.materialId) || MATERIALS[0];
      const x = offsetX + shape.x * scale;
      const y = offsetY + shape.y * scale;
      const w = shape.w * scale;
      const h = shape.h * scale;
      ctx.fillStyle = material.color + "55";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = material.color;
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.strokeRect(x, y, w, h);

      if (isSelected) {
        ctx.fillStyle = "#7dd3fc";
        const handles = [
          [x, y], [x + w, y], [x, y + h], [x + w, y + h],
        ];
        for (const [hx, hy] of handles) {
          ctx.fillRect(hx - 4, hy - 4, 8, 8);
        }
      }

      // label dimensions if large enough
      if (w > 40 && h > 16) {
        ctx.fillStyle = "#c8d8f0";
        ctx.font = "10px monospace";
        ctx.fillText(material.name, x + 4, y + 12);
        ctx.fillText(`${shape.w.toFixed(0)} × ${shape.h.toFixed(0)} mm`, x + 4, y + h - 4);
      }
    };

    for (const shape of shapes) {
      renderRect(shape, shape.id === selectedId);
    }

    if (draft) {
      const r = normalizeRect(draft.x, draft.y, draft.w, draft.h);
      renderRect({ ...r, materialId: activeMaterialId, id: "__draft" }, false);
    }

    // mesh debug overlay
    if (showMesh && meshResult) {
      const { cellSizeMm, originX, originY, cols, rows, elements } = meshResult;
      const cellPx = cellSizeMm * scale;

      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const el = elements[j * cols + i];
          const ex = offsetX + (originX + i * cellSizeMm) * scale;
          const ey = offsetY + (originY + j * cellSizeMm) * scale;
          if (el.lambda <= 0) {
            ctx.fillStyle = "#f4727233";
          } else {
            const t = Math.max(0, Math.min(1, Math.log10(el.lambda + 1) / Math.log10(51)));
            const r = Math.round(56 + t * (244 - 56));
            const g = Math.round(189 - t * (189 - 114));
            const b = Math.round(248 - t * (248 - 114));
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.18)`;
          }
          ctx.fillRect(ex, ey, cellPx, cellPx);
        }
      }

      ctx.strokeStyle = "#7dd3fc55";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= cols; i++) {
        const x = offsetX + (originX + i * cellSizeMm) * scale;
        ctx.moveTo(x + 0.5, offsetY + originY * scale);
        ctx.lineTo(x + 0.5, offsetY + (originY + rows * cellSizeMm) * scale);
      }
      for (let j = 0; j <= rows; j++) {
        const y = offsetY + (originY + j * cellSizeMm) * scale;
        ctx.moveTo(offsetX + originX * scale, y + 0.5);
        ctx.lineTo(offsetX + (originX + cols * cellSizeMm) * scale, y + 0.5);
      }
      ctx.stroke();
    }

    // boundary condition edges
    if (tool === "boundary") {
      for (const shape of shapes) {
        for (const side of SIDES) {
          const seg = getEdgeSegment(shape, side);
          const a = { x: offsetX + seg.a.x * scale, y: offsetY + seg.a.y * scale };
          const b = { x: offsetX + seg.b.x * scale, y: offsetY + seg.b.y * scale };
          const shared = isEdgeShared(shapes, shape.id, side);
          const isSelected = selectedEdge && selectedEdge.shapeId === shape.id && selectedEdge.side === side;

          if (shared) {
            ctx.strokeStyle = "#33415580";
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
            ctx.setLineDash([]);
            continue;
          }

          const conditionId = getEdgeCondition(shape.id, side);
          const condition = CONDITIONS.find((c) => c.id === conditionId) || CONDITIONS[CONDITIONS.length - 1];
          ctx.strokeStyle = condition.color;
          ctx.lineWidth = isSelected ? 6 : 4;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          ctx.lineCap = "butt";

          if (isSelected) {
            ctx.strokeStyle = "#7dd3fc";
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }
    }

    // snap guides
    if (snapGuides.x.length || snapGuides.y.length) {
      ctx.strokeStyle = "#7dd3fc";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      for (const wx of snapGuides.x) {
        const x = offsetX + wx * scale;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, cssH);
        ctx.stroke();
      }
      for (const wy of snapGuides.y) {
        const y = offsetY + wy * scale;
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(cssW, y + 0.5);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  }, [shapes, view, selectedId, draft, activeMaterialId, snapGuides, tool, selectedEdge, getEdgeCondition, showMesh, meshResult]);

  useEffect(() => {
    draw();
  }, [draw]);

  // resize observer to redraw on container resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(el);
    return () => ro.disconnect();
  }, [draw]);

  // ─── Hit testing ──────────────────────────────────────────────────────────
  const hitTest = (worldPt) => {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (worldPt.x >= s.x && worldPt.x <= s.x + s.w && worldPt.y >= s.y && worldPt.y <= s.y + s.h) {
        return s;
      }
    }
    return null;
  };

  // Finds the nearest selectable (non-shared) edge to a screen point, within tolerance.
  const edgeAtPoint = (screenPt) => {
    const { offsetX, offsetY, scale } = view;
    let best = null;
    let bestDist = EDGE_HIT_TOLERANCE_PX;
    for (const shape of shapes) {
      for (const side of SIDES) {
        if (isEdgeShared(shapes, shape.id, side)) continue;
        const seg = getEdgeSegment(shape, side);
        const a = { x: offsetX + seg.a.x * scale, y: offsetY + seg.a.y * scale };
        const b = { x: offsetX + seg.b.x * scale, y: offsetY + seg.b.y * scale };
        const d = distToSegment({ x: screenPt.sx, y: screenPt.sy }, a, b);
        if (d < bestDist) {
          bestDist = d;
          best = { shapeId: shape.id, side };
        }
      }
    }
    return best;
  };

  const HANDLE_TOLERANCE_PX = 8;
  const handleAtPoint = (shape, screenPt) => {
    const { offsetX, offsetY, scale } = view;
    const x = offsetX + shape.x * scale;
    const y = offsetY + shape.y * scale;
    const w = shape.w * scale;
    const h = shape.h * scale;
    const corners = {
      nw: [x, y], ne: [x + w, y], sw: [x, y + h], se: [x + w, y + h],
    };
    for (const [name, [hx, hy]] of Object.entries(corners)) {
      if (Math.abs(screenPt.sx - hx) <= HANDLE_TOLERANCE_PX && Math.abs(screenPt.sy - hy) <= HANDLE_TOLERANCE_PX) {
        return name;
      }
    }
    return null;
  };

  // ─── Mouse handlers ───────────────────────────────────────────────────────
  const onMouseDown = (e) => {
    const screenPt = getCanvasPoint(e);
    const worldPt = screenToWorld(screenPt.sx, screenPt.sy);

    // middle-click or ctrl-click: pan
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
        setEdgeConditions((current) => ({ ...current, [edgeKey(edge.shapeId, edge.side)]: activeConditionId }));
        dragRef.current = { mode: "paint-boundary" };
      }
      return;
    }

    if (tool === "select" && e.button === 0) {
      // check resize handle on selected shape first
      const selected = shapes.find((s) => s.id === selectedId);
      if (selected) {
        const handle = handleAtPoint(selected, screenPt);
        if (handle) {
          dragRef.current = { mode: "resize", id: selected.id, handle, original: { ...selected } };
          return;
        }
      }
      const hit = hitTest(worldPt);
      if (hit) {
        setSelectedId(hit.id);
        dragRef.current = {
          mode: "move",
          id: hit.id,
          startWorld: worldPt,
          original: { ...hit },
        };
      } else {
        setSelectedId(null);
      }
    }
  };

  const onMouseMove = (e) => {
    const drag = dragRef.current;
    if (!drag) return;
    const screenPt = getCanvasPoint(e);
    const worldPt = screenToWorld(screenPt.sx, screenPt.sy);

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
        setEdgeConditions((current) => ({ ...current, [edgeKey(edge.shapeId, edge.side)]: activeConditionId }));
      }
      return;
    }

    const tol = SNAP_TOLERANCE_PX / view.scale;

    if (drag.mode === "draw") {
      let { x: wx, y: wy } = worldPt;
      const guides = { x: [], y: [] };
      if (snapEnabled) {
        const { xs, ys } = getSnapCandidates(null);
        const sx = snapValue(wx, xs, tol);
        const sy = snapValue(wy, ys, tol);
        wx = sx.value;
        wy = sy.value;
        if (sx.guide !== null) guides.x.push(sx.guide);
        if (sy.guide !== null) guides.y.push(sy.guide);
      }
      setSnapGuides(guides);
      setDraft({
        x: drag.startWorld.x,
        y: drag.startWorld.y,
        w: wx - drag.startWorld.x,
        h: wy - drag.startWorld.y,
      });
      return;
    }

    if (drag.mode === "move") {
      let dx = worldPt.x - drag.startWorld.x;
      let dy = worldPt.y - drag.startWorld.y;
      const guides = { x: [], y: [] };
      if (snapEnabled) {
        const { xs, ys } = getSnapCandidates(drag.id);
        const left = drag.original.x + dx;
        const right = drag.original.x + drag.original.w + dx;
        const top = drag.original.y + dy;
        const bottom = drag.original.y + drag.original.h + dy;
        const snapLeft = snapValue(left, xs, tol);
        const snapRight = snapValue(right, xs, tol);
        const snapTop = snapValue(top, ys, tol);
        const snapBottom = snapValue(bottom, ys, tol);
        const dxLeft = snapLeft.value - left;
        const dxRight = snapRight.value - right;
        if (dxLeft !== 0 || dxRight !== 0) {
          if (Math.abs(dxLeft) <= Math.abs(dxRight) && dxLeft !== 0) {
            dx += dxLeft;
            guides.x.push(snapLeft.guide);
          } else {
            dx += dxRight;
            guides.x.push(snapRight.guide);
          }
        }
        const dyTop = snapTop.value - top;
        const dyBottom = snapBottom.value - bottom;
        if (dyTop !== 0 || dyBottom !== 0) {
          if (Math.abs(dyTop) <= Math.abs(dyBottom) && dyTop !== 0) {
            dy += dyTop;
            guides.y.push(snapTop.guide);
          } else {
            dy += dyBottom;
            guides.y.push(snapBottom.guide);
          }
        }
      }
      setSnapGuides(guides);
      setShapes((current) =>
        current.map((s) =>
          s.id === drag.id ? { ...s, x: drag.original.x + dx, y: drag.original.y + dy } : s
        )
      );
      return;
    }

    if (drag.mode === "resize") {
      const orig = drag.original;
      let { x: wx, y: wy } = worldPt;
      const guides = { x: [], y: [] };
      if (snapEnabled) {
        const { xs, ys } = getSnapCandidates(drag.id);
        const sx = snapValue(wx, xs, tol);
        const sy = snapValue(wy, ys, tol);
        wx = sx.value;
        wy = sy.value;
        if (sx.guide !== null) guides.x.push(sx.guide);
        if (sy.guide !== null) guides.y.push(sy.guide);
      }
      setSnapGuides(guides);

      let { x, y, w, h } = orig;
      if (drag.handle.includes("n")) {
        h = orig.y + orig.h - wy;
        y = wy;
      }
      if (drag.handle.includes("s")) {
        h = wy - orig.y;
      }
      if (drag.handle.includes("w")) {
        w = orig.x + orig.w - wx;
        x = wx;
      }
      if (drag.handle.includes("e")) {
        w = wx - orig.x;
      }
      const norm = normalizeRect(x, y, w, h);
      setShapes((current) => current.map((s) => (s.id === drag.id ? { ...s, ...norm } : s)));
      return;
    }
  };

  const onMouseUp = () => {
    const drag = dragRef.current;
    if (drag?.mode === "draw" && draft) {
      const norm = normalizeRect(draft.x, draft.y, draft.w, draft.h);
      if (norm.w > 1 && norm.h > 1) {
        const newShape = { id: createId(), ...norm, materialId: activeMaterialId };
        setShapes((current) => [...current, newShape]);
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
      const newScale = Math.min(20, Math.max(0.2, v.scale * factor));
      return {
        scale: newScale,
        offsetX: screenPt.sx - worldBefore.x * newScale,
        offsetY: screenPt.sy - worldBefore.y * newScale,
      };
    });
  };

  // ─── Keyboard: delete selected shape ─────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "SELECT")) return;
        setShapes((current) => current.filter((s) => s.id !== selectedId));
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId]);

  const selectedShape = shapes.find((s) => s.id === selectedId) || null;

  const updateSelectedShape = (updater) => {
    setShapes((current) => current.map((s) => (s.id === selectedId ? updater(s) : s)));
  };

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0, minWidth: 0 }}>
      {/* Canvas area */}
      <div ref={containerRef} style={{ flex: 1, position: "relative", minWidth: 0 }}>
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: "100%", display: "block", cursor: tool === "rect" ? "crosshair" : tool === "boundary" ? "pointer" : "default" }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
        />
        <div
          style={{
            position: "absolute",
            top: 10,
            left: 10,
            display: "flex",
            gap: 6,
            background: "#070d1aee",
            border: "1px solid #132040",
            borderRadius: 6,
            padding: 6,
          }}
        >
          <button type="button" style={buttonStyle(tool === "rect")} onClick={() => setTool("rect")}>
            Draw
          </button>
          <button type="button" style={buttonStyle(tool === "select")} onClick={() => setTool("select")}>
            Select
          </button>
          <button type="button" style={buttonStyle(tool === "boundary")} onClick={() => setTool("boundary")}>
            Boundary
          </button>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 10px",
              border: "1px solid #1e3a6b",
              borderRadius: 4,
              color: snapEnabled ? "#7dd3fc" : "#4a7fa5",
              cursor: "pointer",
              fontFamily: "monospace",
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            <input
              type="checkbox"
              checked={snapEnabled}
              onChange={(e) => setSnapEnabled(e.target.checked)}
            />
            Snap
          </label>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 10px",
              border: "1px solid #1e3a6b",
              borderRadius: 4,
              color: showMesh ? "#7dd3fc" : "#4a7fa5",
              cursor: "pointer",
              fontFamily: "monospace",
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            <input
              type="checkbox"
              checked={showMesh}
              onChange={(e) => setShowMesh(e.target.checked)}
            />
            Mesh
          </label>
        </div>
        <div
          style={{
            position: "absolute",
            bottom: 10,
            left: 10,
            color: "#4a7fa5",
            fontFamily: "monospace",
            fontSize: 10,
            background: "#070d1aee",
            border: "1px solid #132040",
            borderRadius: 6,
            padding: "6px 8px",
            lineHeight: 1.6,
          }}
        >
          Draw: click + drag to add a layer<br />
          Select: drag to move, drag corners to resize, Delete to remove<br />
          Boundary: pick a condition, then click or drag across edges<br />
          Shift + drag, or scroll to pan / zoom
        </div>
      </div>

      {/* Side panel */}
      <div
        style={{
          width: 240,
          flexShrink: 0,
          borderLeft: "1px solid #132040",
          background: "#070d1a",
          padding: 12,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {tool === "boundary" && (
          <div>
            <div style={{ color: "#4a7aaa", fontFamily: "monospace", fontSize: 11, letterSpacing: "0.07em", marginBottom: 8, textTransform: "uppercase" }}>
              Boundary condition
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {CONDITIONS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setActiveConditionId(c.id);
                    if (selectedEdge && !isEdgeShared(shapes, selectedEdge.shapeId, selectedEdge.side)) {
                      setEdgeConditions((current) => ({ ...current, [edgeKey(selectedEdge.shapeId, selectedEdge.side)]: c.id }));
                    }
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 8px",
                    background: activeConditionId === c.id ? "#1e4a7a" : "#0a1628",
                    border: `1px solid ${activeConditionId === c.id ? "#2563eb" : "#1e3a6b"}`,
                    borderRadius: 4,
                    color: "#c8d8f0",
                    cursor: "pointer",
                    fontFamily: "monospace",
                    fontSize: 11,
                    textAlign: "left",
                  }}
                >
                  <span style={{ width: 12, height: 12, borderRadius: 2, background: c.color, flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>{c.name}</span>
                  <span style={{ color: "#4a7fa5", fontSize: 10 }}>
                    {c.temperature !== null ? `${c.temperature}°C` : "—"}
                  </span>
                </button>
              ))}
            </div>

            <div style={{ marginTop: 12, color: "#4a7fa5", fontFamily: "monospace", fontSize: 10, lineHeight: 1.6 }}>
              {selectedEdge ? (
                <>
                  Selected: {selectedEdge.side} edge<br />
                  Condition:{" "}
                  {(() => {
                    const cid = getEdgeCondition(selectedEdge.shapeId, selectedEdge.side);
                    const c = CONDITIONS.find((x) => x.id === cid);
                    return c ? `${c.name}${c.temperature !== null ? ` (${c.temperature}°C)` : ""}` : "—";
                  })()}
                </>
              ) : (
                <>Click an edge, or drag across several, to apply the selected condition.</>
              )}
              <div style={{ marginTop: 8, color: "#2d5a8a" }}>
                External edges default to adiabatic. Edges shared between two
                elements (dashed grey) cannot have a boundary condition.
              </div>
            </div>
          </div>
        )}

        {tool !== "boundary" && (
        <div>
          <div style={{ color: "#4a7aaa", fontFamily: "monospace", fontSize: 11, letterSpacing: "0.07em", marginBottom: 8, textTransform: "uppercase" }}>
            Material
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {MATERIALS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  setActiveMaterialId(m.id);
                  if (selectedShape) {
                    updateSelectedShape((s) => ({ ...s, materialId: m.id }));
                  }
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  background: activeMaterialId === m.id ? "#1e4a7a" : "#0a1628",
                  border: `1px solid ${activeMaterialId === m.id ? "#2563eb" : "#1e3a6b"}`,
                  borderRadius: 4,
                  color: "#c8d8f0",
                  cursor: "pointer",
                  fontFamily: "monospace",
                  fontSize: 11,
                  textAlign: "left",
                }}
              >
                <span style={{ width: 12, height: 12, borderRadius: 2, background: m.color, flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{m.name}</span>
                <span style={{ color: "#4a7fa5", fontSize: 10 }}>{m.lambda}</span>
              </button>
            ))}
          </div>
        </div>
        )}

        {tool !== "boundary" && selectedShape && (
          <div>
            <div style={{ color: "#4a7aaa", fontFamily: "monospace", fontSize: 11, letterSpacing: "0.07em", marginBottom: 8, textTransform: "uppercase" }}>
              Selected layer
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, color: "#4a7fa5", fontFamily: "monospace", fontSize: 10 }}>
                X (mm)
                <input
                  type="number"
                  style={fieldStyle}
                  value={Math.round(selectedShape.x)}
                  onChange={(e) => updateSelectedShape((s) => ({ ...s, x: Number(e.target.value) }))}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, color: "#4a7fa5", fontFamily: "monospace", fontSize: 10 }}>
                Y (mm)
                <input
                  type="number"
                  style={fieldStyle}
                  value={Math.round(selectedShape.y)}
                  onChange={(e) => updateSelectedShape((s) => ({ ...s, y: Number(e.target.value) }))}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, color: "#4a7fa5", fontFamily: "monospace", fontSize: 10 }}>
                Width (mm)
                <input
                  type="number"
                  style={fieldStyle}
                  value={Math.round(selectedShape.w)}
                  onChange={(e) => updateSelectedShape((s) => ({ ...s, w: Math.max(1, Number(e.target.value)) }))}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, color: "#4a7fa5", fontFamily: "monospace", fontSize: 10 }}>
                Height (mm)
                <input
                  type="number"
                  style={fieldStyle}
                  value={Math.round(selectedShape.h)}
                  onChange={(e) => updateSelectedShape((s) => ({ ...s, h: Math.max(1, Number(e.target.value)) }))}
                />
              </label>
            </div>
            <button
              type="button"
              style={{ ...buttonStyle(false), width: "100%", color: "#f47272", borderColor: "#7a2d2d" }}
              onClick={() => {
                setShapes((current) => current.filter((s) => s.id !== selectedId));
                setSelectedId(null);
              }}
            >
              Delete layer
            </button>
          </div>
        )}

        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
          <button
            type="button"
            style={{ ...buttonStyle(false), width: "100%" }}
            onClick={handleSolve}
            disabled={solveStatus === "running" || shapes.length === 0}
          >
            {solveStatus === "running" ? "Solving…" : "Run thermal solve"}
          </button>
          {solveStatus === "unavailable" && (
            <div style={{ color: "#fbbf24", fontFamily: "monospace", fontSize: 10, lineHeight: 1.6 }}>
              Wasm solver not built. Run <code>npm run build:wasm</code> (requires Emscripten).
            </div>
          )}
          {solveStatus === "error" && (
            <div style={{ color: "#f47272", fontFamily: "monospace", fontSize: 10, lineHeight: 1.6 }}>
              Solve failed — see console for details.
            </div>
          )}
          {solveStatus === "done" && solveResult && (
            <div style={{ color: "#34d399", fontFamily: "monospace", fontSize: 10, lineHeight: 1.6 }}>
              Result grid: {solveResult.cols} × {solveResult.rows} cells @ {solveResult.cellSizeMm}mm
            </div>
          )}
          {showMesh && meshStatus === "unavailable" && (
            <div style={{ color: "#fbbf24", fontFamily: "monospace", fontSize: 10, lineHeight: 1.6 }}>
              Wasm solver not built. Run <code>npm run build:wasm</code> (requires Emscripten).
            </div>
          )}
          {showMesh && meshStatus === "error" && (
            <div style={{ color: "#f47272", fontFamily: "monospace", fontSize: 10, lineHeight: 1.6 }}>
              Mesh build failed — see console for details.
            </div>
          )}
          {showMesh && meshStatus === "done" && meshResult && (
            <div style={{ color: "#34d399", fontFamily: "monospace", fontSize: 10, lineHeight: 1.6 }}>
              Mesh: {meshResult.cols} × {meshResult.rows} elements @ {meshResult.cellSizeMm}mm
            </div>
          )}
          <div style={{ color: "#2d5a8a", fontFamily: "monospace", fontSize: 10, lineHeight: 1.6 }}>
            {shapes.length} layer{shapes.length === 1 ? "" : "s"} drawn
          </div>
        </div>
      </div>
    </div>
  );
}
