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

  const activeElement = elements.find((element) => element.id === activeElementId) || elements[0];
  const layers = activeElement?.layers || [];

  const totals = useMemo(() => {
    const { rsi, rse } = SURFACE_RESISTANCES[activeElement?.type] || SURFACE_RESISTANCES.wall;
    const layersR = layers.reduce((sum, layer) => sum + layerRValue(layer), 0);
    const totalR = rse + layersR + rsi;
    return { rsi, rse, layersR, totalR, uValue: totalR > 0 ? 1 / totalR : 0 };
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

  const gridCols = "42px minmax(180px, 1.5fr) minmax(120px, 0.8fr) minmax(120px, 0.8fr) minmax(95px, 0.6fr) 132px";
  const skinRow = (label, side, rValue, accent) => (
    <div style={{ display:"grid", gridTemplateColumns: gridCols, gap:8, alignItems:"center",
      background:"#040810", border:"1px dashed #0d1a2e", borderRadius:6, padding:8, marginBottom:2 }}>
      <div style={{ color: accent, fontSize:9, letterSpacing:"0.08em", textTransform:"uppercase" }}>{side}</div>
      <div style={{ color:"#2d5a8a", fontSize:11 }}>{label}</div>
      <div style={{ color:"#1a3050", fontSize:10 }}>—</div>
      <div style={{ color:"#1a3050", fontSize:10 }}>—</div>
      <div style={{ color:"#4a7fa5", fontSize:13, fontWeight:700 }}>{formatNumber(rValue)}</div>
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
                const totalR = element.layers.reduce((sum, layer) => sum + layerRValue(layer), 0) + rsi + rse;
                const uValue = totalR > 0 ? 1 / totalR : 0;

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
              <div>Actions</div>
            </div>

            <div style={{ display: "flex", flexDirection: "column" }} onDragLeave={() => setDropIndex(null)}>
              {skinRow("External surface", "EXT", totals.rse, "#38bdf8")}
              {dropZone(0)}
              {layers.map((layer, index) => {
                const rValue = layerRValue(layer);
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
                  Rse {formatNumber(totals.rse, 2)} + layers {formatNumber(totals.layersR)} + Rsi {formatNumber(totals.rsi, 2)}
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
    </section>
  );
}
