import { useMemo, useState } from "react";

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

const blankLayer = () => ({
  id: `layer-${crypto.randomUUID()}`,
  name: "New layer",
  thicknessMm: 50,
  lambda: 0.04,
});

const layerFromPreset = (preset) => ({
  id: `layer-${crypto.randomUUID()}`,
  name: preset.name,
  thicknessMm: preset.thicknessMm,
  lambda: preset.lambda,
});

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

export default function UValueCalculator() {
  const [layers, setLayers] = useState(DEFAULT_LAYERS);
  const [dropIndex, setDropIndex] = useState(null);
  const [draggedPresetId, setDraggedPresetId] = useState(null);

  const totals = useMemo(() => {
    const totalR = layers.reduce((sum, layer) => sum + layerRValue(layer), 0);
    return {
      totalR,
      uValue: totalR > 0 ? 1 / totalR : 0,
    };
  }, [layers]);

  const updateLayer = (id, key, value) => {
    setLayers((current) =>
      current.map((layer) => (layer.id === id ? { ...layer, [key]: value } : layer)),
    );
  };

  const addLayer = () => {
    setLayers((current) => [...current, blankLayer()]);
  };

  const removeLayer = (id) => {
    setLayers((current) => current.filter((layer) => layer.id !== id));
  };

  const moveLayer = (index, direction) => {
    setLayers((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) return current;

      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  const insertPreset = (presetId, index) => {
    const preset = PRESETS.find((item) => item.id === presetId);
    if (!preset) return;

    setLayers((current) => {
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
      <div style={{ maxWidth: 1320, margin: "0 auto" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 16,
          }}
        >
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
              LAYERS RUN OUTSIDE TO INSIDE
            </div>
          </div>

          <button
            type="button"
            onClick={addLayer}
            style={{
              ...buttonStyle,
              height: 34,
              padding: "0 12px",
              color: "#7dd3fc",
              borderColor: "#2563eb",
            }}
          >
            ADD LAYER
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(720px, 1fr) 290px", gap: 16, alignItems: "start" }}>
          <div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "42px minmax(180px, 1.5fr) minmax(120px, 0.8fr) minmax(120px, 0.8fr) minmax(95px, 0.6fr) 132px",
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
              <div>Name</div>
              <div>Thickness</div>
              <div>Lambda</div>
              <div>R value</div>
              <div>Actions</div>
            </div>

            <div style={{ display: "flex", flexDirection: "column" }} onDragLeave={() => setDropIndex(null)}>
              {dropZone(0)}
              {layers.map((layer, index) => {
                const rValue = layerRValue(layer);
                return (
                  <div key={layer.id}>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "42px minmax(180px, 1.5fr) minmax(120px, 0.8fr) minmax(120px, 0.8fr) minmax(95px, 0.6fr) 132px",
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

                      <div
                        style={{
                          color: rValue > 0 ? "#7dd3fc" : "#7f1d1d",
                          fontSize: 13,
                          fontWeight: 700,
                        }}
                      >
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
            </div>
          </div>

          <aside
            style={{
              background: "#070d1a",
              border: "1px solid #132040",
              borderRadius: 6,
              padding: 12,
              position: "sticky",
              top: 0,
            }}
          >
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

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(180px, 1fr))",
            gap: 10,
            marginTop: 16,
            maxWidth: "calc(100% - 306px)",
          }}
        >
          <div style={{ background: "#070d1a", border: "1px solid #132040", borderRadius: 6, padding: 14 }}>
            <div style={{ color: "#2d5a8a", fontSize: 9, letterSpacing: "0.14em", marginBottom: 6 }}>
              TOTAL R VALUE
            </div>
            <div style={{ color: "#7dd3fc", fontSize: 24, fontWeight: 700 }}>
              {formatNumber(totals.totalR)}
              <span style={{ color: "#2d5a8a", fontSize: 11, marginLeft: 8 }}>m2K/W</span>
            </div>
          </div>

          <div style={{ background: "#070d1a", border: "1px solid #132040", borderRadius: 6, padding: 14 }}>
            <div style={{ color: "#2d5a8a", fontSize: 9, letterSpacing: "0.14em", marginBottom: 6 }}>
              U VALUE
            </div>
            <div style={{ color: "#34d399", fontSize: 24, fontWeight: 700 }}>
              {totals.uValue > 0 ? formatNumber(totals.uValue) : "-"}
              <span style={{ color: "#2d5a8a", fontSize: 11, marginLeft: 8 }}>W/m2K</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
