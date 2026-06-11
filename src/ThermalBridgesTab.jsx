import { useEffect, useRef, useState, useCallback } from "react";

const STORAGE_KEY = "thermal_bridges_model";

// ─── Materials ────────────────────────────────────────────────────────────────
const MATERIALS = [
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

// ─── Geometry ─────────────────────────────────────────────────────────────────
const GRID_MM = 50; // base grid spacing in mm
const PX_PER_MM_DEFAULT = 1.5;

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

  const dragRef = useRef(null); // generic drag state for pan / move / resize / draw

  // ─── Persist ──────────────────────────────────────────────────────────────
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ shapes, view }));
    } catch {
      // best effort
    }
  }, [shapes, view, storageKey]);

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
  }, [shapes, view, selectedId, draft, activeMaterialId]);

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

    if (drag.mode === "draw") {
      setDraft({
        x: drag.startWorld.x,
        y: drag.startWorld.y,
        w: worldPt.x - drag.startWorld.x,
        h: worldPt.y - drag.startWorld.y,
      });
      return;
    }

    if (drag.mode === "move") {
      const dx = worldPt.x - drag.startWorld.x;
      const dy = worldPt.y - drag.startWorld.y;
      setShapes((current) =>
        current.map((s) =>
          s.id === drag.id ? { ...s, x: drag.original.x + dx, y: drag.original.y + dy } : s
        )
      );
      return;
    }

    if (drag.mode === "resize") {
      const orig = drag.original;
      let { x, y, w, h } = orig;
      if (drag.handle.includes("n")) {
        h = orig.y + orig.h - worldPt.y;
        y = worldPt.y;
      }
      if (drag.handle.includes("s")) {
        h = worldPt.y - orig.y;
      }
      if (drag.handle.includes("w")) {
        w = orig.x + orig.w - worldPt.x;
        x = worldPt.x;
      }
      if (drag.handle.includes("e")) {
        w = worldPt.x - orig.x;
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
          style={{ width: "100%", height: "100%", display: "block", cursor: tool === "rect" ? "crosshair" : "default" }}
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

        {selectedShape && (
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

        <div style={{ marginTop: "auto", color: "#2d5a8a", fontFamily: "monospace", fontSize: 10, lineHeight: 1.6 }}>
          {shapes.length} layer{shapes.length === 1 ? "" : "s"} drawn
        </div>
      </div>
    </div>
  );
}
