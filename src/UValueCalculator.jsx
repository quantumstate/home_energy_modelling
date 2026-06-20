import { useEffect, useMemo, useRef, useState } from "react";

const STORAGE_KEY = "uvalue_building_elements";

const ELEMENT_TYPES = ["wall", "floor", "roof"];

const DEFAULT_LAYERS = [
  { id: "external-render", name: "External render", thicknessMm: 20, lambda: 0.7 },
  { id: "insulation", name: "Insulation", thicknessMm: 100, lambda: 0.035 },
  { id: "blockwork", name: "Blockwork", thicknessMm: 100, lambda: 0.51 },
  { id: "plasterboard", name: "Plasterboard", thicknessMm: 12.5, lambda: 0.25 },
];

const PRESETS = [
  { id: "mineral-wool", name: "Mineral wool", thicknessMm: 100, lambda: 0.037 },
  { id: "pir-board", name: "PIR board", thicknessMm: 75, lambda: 0.022 },
  { id: "eps", name: "EPS insulation", thicknessMm: 100, lambda: 0.038 },
  { id: "brick", name: "Brick", thicknessMm: 102.5, lambda: 0.77 },
  { id: "concrete-block", name: "Concrete block", thicknessMm: 100, lambda: 0.51 },
  { id: "timber", name: "Timber", thicknessMm: 45, lambda: 0.13 },
  { id: "plasterboard", name: "Plasterboard", thicknessMm: 12.5, lambda: 0.25 },
  { id: "render", name: "Render", thicknessMm: 20, lambda: 0.7 },
];

// Surface resistances per BS EN ISO 6946:2017 (m²K/W).
// Heat flow direction determines Rsi: horizontal → wall, upward → roof, downward → floor.
const SURFACE_RESISTANCES = {
  wall:  { rsi: 0.13, rse: 0.04 }, // horizontal heat flow
  roof:  { rsi: 0.10, rse: 0.04 }, // upward heat flow
  floor: { rsi: 0.17, rse: 0.04 }, // downward heat flow
};

const BRIDGE_MATERIALS = [
  { id: "softwood",   name: "Softwood timber",  lambda: 0.13  },
  { id: "hardwood",   name: "Hardwood timber",  lambda: 0.18  },
  { id: "osb",        name: "OSB / plywood",    lambda: 0.13  },
  { id: "concrete",   name: "Concrete (dense)", lambda: 1.35  },
  { id: "masonry",    name: "Masonry / brick",  lambda: 0.90  },
  { id: "steel",      name: "Structural steel", lambda: 50    },
  { id: "stainless",  name: "Stainless steel",  lambda: 17    },
  { id: "aluminium",  name: "Aluminium",        lambda: 160   },
];

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
  padding: "8px 9px",
};

const buttonStyle = {
  height: 30,
  minWidth: 30,
  background: "#0a1628",
  border: "1px solid #1e3a6b",
  borderRadius: 4,
  color: "#4a7fa5",
  cursor: "pointer",
  fontFamily: "monospace",
  fontSize: 11,
};

const createId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

const cloneLayer = (layer) => ({
  ...layer,
  id: createId("layer"),
});

const blankLayer = () => ({
  id: createId("layer"),
  name: "New layer",
  thicknessMm: 50,
  lambda: 0.04,
});

const layerFromPreset = (preset) => ({
  id: createId("layer"),
  name: preset.name,
  thicknessMm: preset.thicknessMm,
  lambda: preset.lambda,
});

const createElement = (type = "wall", index = 1) => ({
  id: createId("element"),
  type,
  name: `${type[0].toUpperCase()}${type.slice(1)} build-up ${index}`,
  layers: type === "wall" ? DEFAULT_LAYERS.map(cloneLayer) : [blankLayer()],
});

function readStoredElements(storageKey) {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return null;

    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function layerRValue(layer) {
  const thickness = Number(layer.thicknessMm);
  const lambda = Number(layer.lambda);

  if (!Number.isFinite(thickness) || !Number.isFinite(lambda) || thickness <= 0 || lambda <= 0) {
    return 0;
  }

  return thickness / 1000 / lambda;
}

// Returns the bridge fraction (0–1) for a thermalBridge config object.
function bridgeFraction(tb) {
  if (!tb) return 0;
  if (tb.mode === "percentage")
    return Math.min(1, Math.max(0, (Number(tb.percentage) || 0) / 100));
  if (tb.mode === "stud") {
    const spacing = Number(tb.studSpacingMm), thick = Number(tb.studThicknessMm);
    return spacing > 0 ? Math.min(1, thick / spacing) : 0;
  }
  if (tb.mode === "fixings") {
    const n = Number(tb.fixingsPerM2), d = Number(tb.fixingDiameterMm) / 1000;
    return Math.min(1, n * Math.PI * (d / 2) ** 2);
  }
  return 0;
}

// BS EN ISO 6946 upper-bound parallel-path method across the full wall.
// For N layers that carry thermal bridges, enumerate all 2^N path combinations.
// Each path replaces the bridged layer(s) with either the bridge or base material
// for its entire thickness, then sums the full-wall series resistance (Rse → layers → Rsi).
// U = Σ (path_fraction × 1/R_path).
function computeParallelPathU(layers, rsi, rse) {
  const bridgedIdx = [];
  for (let i = 0; i < layers.length; i++) {
    const tb = layers[i].thermalBridge;
    if (tb?.bridgeMaterial && bridgeFraction(tb) > 0) bridgedIdx.push(i);
  }

  if (bridgedIdx.length === 0) {
    const totalR = rse + layers.reduce((s, l) => s + layerRValue(l), 0) + rsi;
    return totalR > 0 ? 1 / totalR : 0;
  }

  const n = bridgedIdx.length;
  let uValue = 0;
  for (let mask = 0; mask < (1 << n); mask++) {
    let frac = 1, R = rse + rsi, bi = 0;
    for (let i = 0; i < layers.length; i++) {
      if (bridgedIdx[bi] === i) {
        const layer = layers[i];
        const tb = layer.thermalBridge;
        const f = bridgeFraction(tb);
        const useBridge = Boolean((mask >> bi) & 1);
        bi++;
        if (useBridge) {
          frac *= f;
          const mat = BRIDGE_MATERIALS.find(m => m.id === tb.bridgeMaterial);
          R += mat ? Number(layer.thicknessMm) / 1000 / mat.lambda : layerRValue(layer);
        } else {
          frac *= (1 - f);
          R += layerRValue(layer);
        }
      } else {
        R += layerRValue(layers[i]);
      }
    }
    if (R > 0 && frac > 0) uValue += frac / R;
  }
  return uValue;
}

function formatNumber(value, digits = 3) {
  if (!Number.isFinite(value)) return "-";
  return value.toFixed(digits);
}

export default function UValueCalculator({ projectId }) {
  const storageKey = `${projectId}_${STORAGE_KEY}`;
  const initialElements = useMemo(() => readStoredElements(storageKey) || [createElement("wall", 1)], [storageKey]);
  const [elements, setElements] = useState(initialElements);
  const [activeElementId, setActiveElementId] = useState(initialElements[0].id);

  // Resync local state if the storage key changes (e.g. switching projects)
  // while this component stays mounted.
  const prevInitialElements = useRef(initialElements);
  if (prevInitialElements.current !== initialElements) {
    prevInitialElements.current = initialElements;
    setElements(initialElements);
    setActiveElementId(initialElements[0].id);
  }

  const [newElementType, setNewElementType] = useState("wall");
  const [dropIndex, setDropIndex] = useState(null);
  const [draggedPresetId, setDraggedPresetId] = useState(null);
  const [editBridgeLayerId, setEditBridgeLayerId] = useState(null);
  const [bridgeDraft, setBridgeDraft] = useState(null);

  const activeElement = elements.find((element) => element.id === activeElementId) || elements[0];
  const layers = activeElement?.layers || [];

  const totals = useMemo(() => {
    const { rsi, rse } = SURFACE_RESISTANCES[activeElement?.type] || SURFACE_RESISTANCES.wall;
    const uValue = computeParallelPathU(layers, rsi, rse);
    const totalR = uValue > 0 ? 1 / uValue : 0;
    const layersR = layers.reduce((s, l) => s + layerRValue(l), 0);
    const hasBridges = layers.some(l => {
      const tb = l.thermalBridge;
      return tb?.bridgeMaterial && bridgeFraction(tb) > 0;
    });
    return { rsi, rse, layersR, totalR, uValue, hasBridges };
  }, [layers, activeElement?.type]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(elements));
    } catch {
      // Local storage is best effort; the calculator still works without it.
    }
  }, [elements]);

  const updateActiveElement = (updater) => {
    setElements((current) =>
      current.map((element) => (element.id === activeElement.id ? updater(element) : element)),
    );
  };

  const updateElementField = (key, value) => {
    updateActiveElement((element) => ({ ...element, [key]: value }));
  };

  const updateLayers = (updater) => {
    updateActiveElement((element) => ({
      ...element,
      layers: typeof updater === "function" ? updater(element.layers) : updater,
    }));
  };

  const updateLayer = (id, key, value) => {
    updateLayers((current) =>
      current.map((layer) => (layer.id === id ? { ...layer, [key]: value } : layer)),
    );
  };

  const addLayer = () => {
    updateLayers((current) => [...current, blankLayer()]);
  };

  const removeLayer = (id) => {
    updateLayers((current) => current.filter((layer) => layer.id !== id));
  };

  const moveLayer = (index, direction) => {
    updateLayers((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) return current;

      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  const addElement = () => {
    const sameTypeCount = elements.filter((element) => element.type === newElementType).length + 1;
    const element = createElement(newElementType, sameTypeCount);
    setElements((current) => [...current, element]);
    setActiveElementId(element.id);
  };

  const removeActiveElement = () => {
    if (elements.length === 1) return;

    setElements((current) => {
      const next = current.filter((element) => element.id !== activeElement.id);
      setActiveElementId(next[0].id);
      return next;
    });
  };

  const insertPreset = (presetId, index) => {
    const preset = PRESETS.find((item) => item.id === presetId);
    if (!preset) return;

    updateLayers((current) => {
      const next = [...current];
      next.splice(index, 0, layerFromPreset(preset));
      return next;
    });
    setDropIndex(null);
  };

  const onPresetDragStart = (event, presetId) => {
    setDraggedPresetId(presetId);
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-u-value-preset", presetId);
  };

  const onPresetDragEnd = () => {
    setDraggedPresetId(null);
    setDropIndex(null);
  };

  const onDropBetweenLayers = (event, index) => {
    event.preventDefault();
    const presetId = event.dataTransfer.getData("application/x-u-value-preset") || draggedPresetId;
    insertPreset(presetId, index);
    setDraggedPresetId(null);
  };

  const onDragOverDropZone = (event, index) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropIndex(index);
  };

  const dropZone = (index) => (
    <div
      key={`drop-${index}`}
      onDragOver={(event) => onDragOverDropZone(event, index)}
      onDragLeave={() => setDropIndex((current) => (current === index ? null : current))}
      onDrop={(event) => onDropBetweenLayers(event, index)}
      onMouseEnter={() => {
        if (draggedPresetId) setDropIndex(index);
      }}
      onMouseUp={() => {
        if (draggedPresetId) insertPreset(draggedPresetId, index);
      }}
      data-testid={`preset-drop-${index}`}
      style={{
        height: dropIndex === index ? 28 : 16,
        border: `1px dashed ${dropIndex === index ? "#38bdf8" : "transparent"}`,
        borderRadius: 5,
        background: dropIndex === index ? "#38bdf814" : "transparent",
        transition: "height 0.12s ease, background 0.12s ease, border-color 0.12s ease",
      }}
      aria-label={`Drop preset at position ${index + 1}`}
    />
  );

  const openBridgeDialog = (layer) => {
    setEditBridgeLayerId(layer.id);
    setBridgeDraft(layer.thermalBridge ? { ...layer.thermalBridge } : {
      bridgeMaterial: "softwood", mode: "percentage",
      percentage: 10, studSpacingMm: 600, studThicknessMm: 45,
      fixingsPerM2: 4, fixingDiameterMm: 10,
    });
  };
  const saveBridge = () => {
    updateLayer(editBridgeLayerId, "thermalBridge", bridgeDraft);
    setEditBridgeLayerId(null);
  };
  const removeBridge = () => {
    updateLayer(editBridgeLayerId, "thermalBridge", null);
    setEditBridgeLayerId(null);
  };

  const gridCols = "42px minmax(180px, 1.5fr) minmax(120px, 0.8fr) minmax(120px, 0.8fr) minmax(95px, 0.6fr) 92px 132px";
  const skinRow = (label, side, rValue, accent) => (
    <div style={{ display:"grid", gridTemplateColumns: gridCols, gap:8, alignItems:"center",
      background:"#040810", border:"1px dashed #0d1a2e", borderRadius:6, padding:8, marginBottom:2 }}>
      <div style={{ color: accent, fontSize:9, letterSpacing:"0.08em", textTransform:"uppercase" }}>{side}</div>
      <div style={{ color:"#2d5a8a", fontSize:11 }}>{label}</div>
      <div style={{ color:"#1a3050", fontSize:10 }}>—</div>
      <div style={{ color:"#1a3050", fontSize:10 }}>—</div>
      <div style={{ color:"#4a7fa5", fontSize:13, fontWeight:700 }}>{formatNumber(rValue)}</div>
      <div />
      <div />
    </div>
  );

  return (
    <section
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        background: "#05090f",
        color: "#c8d8f0",
        fontFamily: "monospace",
        padding: 18,
        textAlign: "left",
      }}
      onMouseUp={() => {
        setDraggedPresetId(null);
        setDropIndex(null);
      }}
    >
      <div style={{ maxWidth: 1420, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
          <div>
            <h1
              style={{
                margin: 0,
                color: "#7dd3fc",
                fontFamily: "monospace",
                fontSize: 16,
                fontWeight: 700,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
              }}
            >
              U value calculator
            </h1>
            <div style={{ color: "#2d5a8a", fontSize: 10, letterSpacing: "0.09em", marginTop: 5 }}>
              BUILDING ELEMENTS WITH OUTSIDE-TO-INSIDE LAYER BUILD-UPS
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "230px minmax(720px, 1fr) 290px", gap: 16, alignItems: "start" }}>
          <aside style={{ background: "#070d1a", border: "1px solid #132040", borderRadius: 6, padding: 12 }}>
            <div style={{ color: "#7dd3fc", fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", marginBottom: 10 }}>
              ELEMENTS
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {elements.map((element) => {
                const isActive = element.id === activeElement.id;
                const { rsi, rse } = SURFACE_RESISTANCES[element.type] || SURFACE_RESISTANCES.wall;
                const uValue = computeParallelPathU(element.layers, rsi, rse);

                return (
                  <button
                    key={element.id}
                    type="button"
                    onClick={() => setActiveElementId(element.id)}
                    style={{
                      background: isActive ? "#1e4a7a" : "#0a1628",
                      border: `1px solid ${isActive ? "#2563eb" : "#132040"}`,
                      borderRadius: 5,
                      color: isActive ? "#7dd3fc" : "#c8d8f0",
                      cursor: "pointer",
                      fontFamily: "monospace",
                      padding: 9,
                      textAlign: "left",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 11, fontWeight: 700 }}>{element.name}</span>
                      <span style={{ color: isActive ? "#bae6fd" : "#2d5a8a", fontSize: 9, textTransform: "uppercase" }}>
                        {element.type}
                      </span>
                    </div>
                    <div style={{ color: isActive ? "#bae6fd" : "#2d5a8a", fontSize: 9 }}>
                      U {uValue > 0 ? formatNumber(uValue) : "-"} W/m2K
                    </div>
                  </button>
                );
              })}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
              <select
                data-testid="new-element-type"
                value={newElementType}
                onChange={(event) => setNewElementType(event.target.value)}
                style={{ ...fieldStyle, width: 126, height: 34, padding: "0 8px", textTransform: "uppercase" }}
              >
                {ELEMENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <button
                data-testid="add-element"
                type="button"
                onClick={addElement}
                style={{ ...buttonStyle, height: 34, padding: "0 12px", color: "#7dd3fc", borderColor: "#2563eb" }}
              >
                ADD ELEMENT
              </button>
            </div>
          </aside>

          <div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(220px, 1fr) 130px 92px",
                gap: 8,
                background: "#070d1a",
                border: "1px solid #132040",
                borderRadius: 6,
                padding: 10,
                marginBottom: 12,
              }}
            >
              <label>
                <div style={{ color: "#2d5a8a", fontSize: 9, letterSpacing: "0.12em", marginBottom: 5 }}>BUILD-UP NAME</div>
                <input
                  data-testid="build-up-name"
                  type="text"
                  value={activeElement.name}
                  onChange={(event) => updateElementField("name", event.target.value)}
                  style={fieldStyle}
                />
              </label>
              <label>
                <div style={{ color: "#2d5a8a", fontSize: 9, letterSpacing: "0.12em", marginBottom: 5 }}>TYPE</div>
                <select
                  data-testid="active-element-type"
                  value={activeElement.type}
                  onChange={(event) => updateElementField("type", event.target.value)}
                  style={{ ...fieldStyle, height: 35, padding: "0 8px", textTransform: "uppercase" }}
                >
                  {ELEMENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={removeActiveElement}
                disabled={elements.length === 1}
                style={{
                  ...buttonStyle,
                  alignSelf: "end",
                  height: 35,
                  color: "#f87171",
                  borderColor: "#7f1d1d",
                  opacity: elements.length === 1 ? 0.35 : 1,
                }}
              >
                DELETE
              </button>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: gridCols,
                gap: 8,
                alignItems: "center",
                color: "#2d5a8a",
                fontSize: 9,
                letterSpacing: "0.12em",
                marginBottom: 2,
                padding: "0 8px",
                textTransform: "uppercase",
              }}
            >
              <div>Side</div>
              <div>Layer</div>
              <div>Thickness</div>
              <div>Lambda</div>
              <div>R value</div>
              <div>Bridge</div>
              <div>Actions</div>
            </div>

            <div style={{ display: "flex", flexDirection: "column" }} onDragLeave={() => setDropIndex(null)}>
              {skinRow("External surface", "EXT", totals.rse, "#38bdf8")}
              {dropZone(0)}
              {layers.map((layer, index) => {
                const rValue = layerRValue(layer);
                const hasBridge = Boolean(layer.thermalBridge?.bridgeMaterial && bridgeFraction(layer.thermalBridge) > 0);
                return (
                  <div key={layer.id}>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: gridCols,
                        gap: 8,
                        alignItems: "center",
                        background: "#070d1a",
                        border: "1px solid #132040",
                        borderRadius: 6,
                        padding: 8,
                      }}
                    >
                      <div
                        style={{
                          color: index === 0 ? "#38bdf8" : index === layers.length - 1 ? "#a78bfa" : "#2d5a8a",
                          fontSize: 9,
                          letterSpacing: "0.08em",
                          textTransform: "uppercase",
                        }}
                      >
                        {index === 0 ? "Out" : index === layers.length - 1 ? "In" : index + 1}
                      </div>

                      <input
                        type="text"
                        value={layer.name}
                        onChange={(event) => updateLayer(layer.id, "name", event.target.value)}
                        style={fieldStyle}
                      />

                      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          value={layer.thicknessMm}
                          onChange={(event) => updateLayer(layer.id, "thicknessMm", event.target.value)}
                          style={fieldStyle}
                        />
                        <span style={{ color: "#2d5a8a", fontSize: 10 }}>mm</span>
                      </label>

                      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input
                          type="number"
                          min="0"
                          step="0.001"
                          value={layer.lambda}
                          onChange={(event) => updateLayer(layer.id, "lambda", event.target.value)}
                          style={fieldStyle}
                        />
                        <span style={{ color: "#2d5a8a", fontSize: 10 }}>W/mK</span>
                      </label>

                      <div style={{ color: rValue > 0 ? "#7dd3fc" : "#7f1d1d", fontSize: 13, fontWeight: 700 }}>
                        {formatNumber(rValue)}
                      </div>

                      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                        {hasBridge && (
                          <span style={{ color:"#fb923c", fontSize:9, fontWeight:700, lineHeight:1 }}>
                            {(bridgeFraction(layer.thermalBridge) * 100).toFixed(
                              layer.thermalBridge.mode === "fixings" ? 3 : 1
                            )}%
                          </span>
                        )}
                        <button type="button" title="Edit thermal bridge"
                          onClick={() => openBridgeDialog(layer)}
                          style={{ ...buttonStyle, minWidth:24, height:22, fontSize:13, padding:"0 4px", lineHeight:1,
                            color: hasBridge ? "#fb923c" : "#2d5a8a",
                            borderColor: hasBridge ? "#fb923c50" : "#132040",
                            background: hasBridge ? "#1a0e00" : "#0a1628" }}>
                          ✏
                        </button>
                      </div>

                      <div style={{ display: "flex", gap: 5 }}>
                        <button
                          type="button"
                          onClick={() => moveLayer(index, -1)}
                          disabled={index === 0}
                          title="Move layer outward"
                          style={{ ...buttonStyle, opacity: index === 0 ? 0.35 : 1 }}
                        >
                          UP
                        </button>
                        <button
                          type="button"
                          onClick={() => moveLayer(index, 1)}
                          disabled={index === layers.length - 1}
                          title="Move layer inward"
                          style={{ ...buttonStyle, opacity: index === layers.length - 1 ? 0.35 : 1 }}
                        >
                          DN
                        </button>
                        <button
                          type="button"
                          onClick={() => removeLayer(layer.id)}
                          title="Remove layer"
                          style={{ ...buttonStyle, color: "#f87171", borderColor: "#7f1d1d" }}
                        >
                          DEL
                        </button>
                      </div>
                    </div>
                    {dropZone(index + 1)}
                  </div>
                );
              })}
              {skinRow("Internal surface", "INT", totals.rsi, "#a78bfa")}
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginTop: 10 }}>
              <button
                type="button"
                onClick={addLayer}
                style={{ ...buttonStyle, height: 34, padding: "0 12px", color: "#7dd3fc", borderColor: "#2563eb" }}
              >
                ADD LAYER
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(180px, 1fr))", gap: 10, marginTop: 16 }}>
              <div style={{ background: "#070d1a", border: "1px solid #132040", borderRadius: 6, padding: 14 }}>
                <div style={{ color: "#2d5a8a", fontSize: 9, letterSpacing: "0.14em", marginBottom: 6 }}>
                  TOTAL R VALUE
                </div>
                <div style={{ color: "#7dd3fc", fontSize: 24, fontWeight: 700 }}>
                  {formatNumber(totals.totalR)}
                  <span style={{ color: "#2d5a8a", fontSize: 11, marginLeft: 8 }}>m²K/W</span>
                </div>
                <div style={{ color: "#1a3050", fontSize: 8, marginTop: 6, lineHeight: 1.6 }}>
                  {totals.hasBridges
                    ? "Parallel path method — bridges span full wall"
                    : `Rse ${formatNumber(totals.rse, 2)} + layers ${formatNumber(totals.layersR)} + Rsi ${formatNumber(totals.rsi, 2)}`}
                </div>
              </div>

              <div style={{ background: "#070d1a", border: "1px solid #132040", borderRadius: 6, padding: 14 }}>
                <div style={{ color: "#2d5a8a", fontSize: 9, letterSpacing: "0.14em", marginBottom: 6 }}>
                  U VALUE
                </div>
                <div style={{ color: "#34d399", fontSize: 24, fontWeight: 700 }}>
                  {totals.uValue > 0 ? formatNumber(totals.uValue) : "-"}
                  <span style={{ color: "#2d5a8a", fontSize: 11, marginLeft: 8 }}>W/m²K</span>
                </div>
                <div style={{ color: "#1a3050", fontSize: 8, marginTop: 6, lineHeight: 1.6 }}>
                  Inc. surface resistances — BS EN ISO 6946
                </div>
              </div>
            </div>
          </div>

          <aside style={{ background: "#070d1a", border: "1px solid #132040", borderRadius: 6, padding: 12, position: "sticky", top: 0 }}>
            <div style={{ color: "#7dd3fc", fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", marginBottom: 4 }}>
              PRESETS
            </div>
            <div style={{ color: "#2d5a8a", fontSize: 9, letterSpacing: "0.08em", marginBottom: 10 }}>
              DRAG INTO A GAP BETWEEN LAYERS
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {PRESETS.map((preset) => {
                const rValue = layerRValue(preset);
                return (
                  <div
                    key={preset.id}
                    data-testid={`preset-${preset.id}`}
                    draggable
                    onDragStart={(event) => onPresetDragStart(event, preset.id)}
                    onDragEnd={onPresetDragEnd}
                    onMouseDown={() => setDraggedPresetId(preset.id)}
                    style={{
                      background: "#0a1628",
                      border: "1px solid #1e3a6b",
                      borderRadius: 5,
                      cursor: "grab",
                      padding: 9,
                    }}
                  >
                    <div style={{ color: "#c8d8f0", fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                      {preset.name}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, color: "#2d5a8a", fontSize: 9 }}>
                      <span>{preset.thicknessMm} mm</span>
                      <span>{preset.lambda} W/mK</span>
                      <span style={{ color: "#7dd3fc" }}>R {formatNumber(rValue)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>
        </div>
      </div>
      {editBridgeLayerId && bridgeDraft && (() => {
        const editLayer = layers.find(l => l.id === editBridgeLayerId);
        const f = bridgeFraction(bridgeDraft);
        const { rsi: dlgRsi, rse: dlgRse } = SURFACE_RESISTANCES[activeElement?.type] || SURFACE_RESISTANCES.wall;
        // Wall U without any bridge on this layer
        const layersNoBridge = layers.map(l => l.id === editBridgeLayerId ? { ...l, thermalBridge: null } : l);
        const uWithout = computeParallelPathU(layersNoBridge, dlgRsi, dlgRse);
        // Wall U with the current draft bridge on this layer
        const layersWithDraft = layers.map(l => l.id === editBridgeLayerId ? { ...l, thermalBridge: bridgeDraft } : l);
        const uWithDraft = bridgeDraft.bridgeMaterial && f > 0
          ? computeParallelPathU(layersWithDraft, dlgRsi, dlgRse) : null;

        const inStyle = { ...fieldStyle, fontSize: 11, padding: "5px 7px" };
        const labelStyle = { color: "#2d5a8a", fontSize: 9, letterSpacing: "0.1em", marginBottom: 3 };
        const modeBtn = (id, label) => (
          <button type="button" key={id} onClick={() => setBridgeDraft(d => ({ ...d, mode: id }))}
            style={{ flex:1, padding:"5px 0", fontFamily:"monospace", fontSize:10, cursor:"pointer",
              background: bridgeDraft.mode === id ? "#1e4a7a" : "#0a1628",
              border: `1px solid ${bridgeDraft.mode === id ? "#2563eb" : "#132040"}`,
              color: bridgeDraft.mode === id ? "#7dd3fc" : "#4a7fa5",
              borderRadius: 3 }}>
            {label}
          </button>
        );

        return (
          <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.72)",
            display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000 }}
            onClick={e => { if (e.target === e.currentTarget) setEditBridgeLayerId(null); }}>
            <div style={{ background:"#070d1a", border:"1px solid #1e3a6b", borderRadius:8,
              padding:22, width:440, maxWidth:"90vw", fontFamily:"monospace" }}>

              <div style={{ color:"#7dd3fc", fontSize:12, fontWeight:700, letterSpacing:"0.12em",
                marginBottom:4 }}>THERMAL BRIDGE</div>
              <div style={{ color:"#2d5a8a", fontSize:10, marginBottom:16 }}>
                {editLayer?.name || "Layer"}
              </div>

              {/* Bridge material */}
              <div style={{ marginBottom:14 }}>
                <div style={labelStyle}>BRIDGE MATERIAL</div>
                <select value={bridgeDraft.bridgeMaterial}
                  onChange={e => setBridgeDraft(d => ({ ...d, bridgeMaterial: e.target.value }))}
                  style={{ ...inStyle, height:32, padding:"0 8px", textTransform:"none" }}>
                  {BRIDGE_MATERIALS.map(m => (
                    <option key={m.id} value={m.id}>{m.name} — λ {m.lambda} W/mK</option>
                  ))}
                </select>
              </div>

              {/* Mode tabs */}
              <div style={{ marginBottom:12 }}>
                <div style={labelStyle}>BRIDGE TYPE</div>
                <div style={{ display:"flex", gap:4 }}>
                  {modeBtn("percentage", "Percentage")}
                  {modeBtn("stud", "Stud / Joist")}
                  {modeBtn("fixings", "Fixings")}
                </div>
              </div>

              {/* Mode inputs */}
              {bridgeDraft.mode === "percentage" && (
                <div style={{ marginBottom:14 }}>
                  <div style={labelStyle}>BRIDGE PERCENTAGE (%)</div>
                  <input type="number" min="0" max="100" step="0.1"
                    value={bridgeDraft.percentage}
                    onChange={e => setBridgeDraft(d => ({ ...d, percentage: e.target.value }))}
                    style={inStyle} />
                  <div style={{ color:"#1a3050", fontSize:8, marginTop:4 }}>
                    Fraction of layer cross-section occupied by bridge material
                  </div>
                </div>
              )}

              {bridgeDraft.mode === "stud" && (
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:14 }}>
                  <div>
                    <div style={labelStyle}>CENTRE-TO-CENTRE (mm)</div>
                    <input type="number" min="1" step="1"
                      value={bridgeDraft.studSpacingMm}
                      onChange={e => setBridgeDraft(d => ({ ...d, studSpacingMm: e.target.value }))}
                      style={inStyle} />
                  </div>
                  <div>
                    <div style={labelStyle}>STUD THICKNESS (mm)</div>
                    <input type="number" min="1" step="1"
                      value={bridgeDraft.studThicknessMm}
                      onChange={e => setBridgeDraft(d => ({ ...d, studThicknessMm: e.target.value }))}
                      style={inStyle} />
                  </div>
                  <div style={{ gridColumn:"1/-1", color:"#1a3050", fontSize:8, lineHeight:1.5 }}>
                    Bridge fraction: {(Math.min(1, Number(bridgeDraft.studThicknessMm) /
                      Math.max(1, Number(bridgeDraft.studSpacingMm))) * 100).toFixed(1)}%
                    &nbsp;({bridgeDraft.studThicknessMm} mm stud @ {bridgeDraft.studSpacingMm} mm c/c)
                  </div>
                </div>
              )}

              {bridgeDraft.mode === "fixings" && (
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:14 }}>
                  <div>
                    <div style={labelStyle}>FIXINGS PER m²</div>
                    <input type="number" min="0" step="0.1"
                      value={bridgeDraft.fixingsPerM2}
                      onChange={e => setBridgeDraft(d => ({ ...d, fixingsPerM2: e.target.value }))}
                      style={inStyle} />
                  </div>
                  <div>
                    <div style={labelStyle}>FIXING DIAMETER (mm)</div>
                    <input type="number" min="0" step="0.1"
                      value={bridgeDraft.fixingDiameterMm}
                      onChange={e => setBridgeDraft(d => ({ ...d, fixingDiameterMm: e.target.value }))}
                      style={inStyle} />
                  </div>
                  <div style={{ gridColumn:"1/-1", color:"#1a3050", fontSize:8, lineHeight:1.5 }}>
                    Bridge fraction: {(Math.min(1, Number(bridgeDraft.fixingsPerM2) *
                      Math.PI * ((Number(bridgeDraft.fixingDiameterMm) / 2000) ** 2)) * 100).toFixed(3)}%
                  </div>
                </div>
              )}

              {/* Preview — wall-level U impact */}
              <div style={{ background:"#050a14", border:"1px solid #0d1a2e", borderRadius:5,
                padding:"10px 12px", marginBottom:16, display:"grid",
                gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
                <div>
                  <div style={{ ...labelStyle, marginBottom:2 }}>WALL U (BASE)</div>
                  <div style={{ color:"#7dd3fc", fontSize:13, fontWeight:700 }}>
                    {formatNumber(uWithout)}
                  </div>
                </div>
                <div>
                  <div style={{ ...labelStyle, marginBottom:2 }}>BRIDGE FRACTION</div>
                  <div style={{ color:"#fbbf24", fontSize:13, fontWeight:700 }}>
                    {(f * 100).toFixed(3)}%
                  </div>
                </div>
                <div>
                  <div style={{ ...labelStyle, marginBottom:2 }}>WALL U (BRIDGED)</div>
                  <div style={{ color: uWithDraft !== null ? "#fb923c" : "#1a3050", fontSize:13, fontWeight:700 }}>
                    {uWithDraft !== null ? formatNumber(uWithDraft) : "—"}
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div style={{ display:"flex", gap:8 }}>
                <button type="button" onClick={saveBridge}
                  style={{ flex:1, height:34, fontFamily:"monospace", fontSize:11, cursor:"pointer",
                    background:"#1e4a7a", border:"1px solid #2563eb", color:"#7dd3fc", borderRadius:4 }}>
                  APPLY
                </button>
                {editLayer?.thermalBridge && (
                  <button type="button" onClick={removeBridge}
                    style={{ height:34, padding:"0 14px", fontFamily:"monospace", fontSize:11, cursor:"pointer",
                      background:"#200a0a", border:"1px solid #7f1d1d", color:"#f87171", borderRadius:4 }}>
                    REMOVE
                  </button>
                )}
                <button type="button" onClick={() => setEditBridgeLayerId(null)}
                  style={{ height:34, padding:"0 14px", fontFamily:"monospace", fontSize:11, cursor:"pointer",
                    background:"#0a1628", border:"1px solid #132040", color:"#4a7fa5", borderRadius:4 }}>
                  CANCEL
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </section>
  );
}
