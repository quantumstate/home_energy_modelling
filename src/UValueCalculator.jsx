import { useMemo, useState } from "react";

const DEFAULT_LAYERS = [
  { id: "external-render", name: "External render", thicknessMm: 20, lambda: 0.7 },
  { id: "insulation", name: "Insulation", thicknessMm: 100, lambda: 0.035 },
  { id: "blockwork", name: "Blockwork", thicknessMm: 100, lambda: 0.51 },
  { id: "plasterboard", name: "Plasterboard", thicknessMm: 12.5, lambda: 0.25 },
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
    >
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
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

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "42px minmax(180px, 1.5fr) minmax(120px, 0.8fr) minmax(120px, 0.8fr) minmax(95px, 0.6fr) 132px",
            gap: 8,
            alignItems: "center",
            color: "#2d5a8a",
            fontSize: 9,
            letterSpacing: "0.12em",
            marginBottom: 7,
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

        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {layers.map((layer, index) => {
            const rValue = layerRValue(layer);
            return (
              <div
                key={layer.id}
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
            );
          })}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(180px, 1fr))",
            gap: 10,
            marginTop: 16,
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
