import { useState, useMemo } from "react";
import { buildingModelFromState, processBuilding } from "./geometryProcessor.js";

// ─── Load processed building from localStorage ────────────────────────────────
function loadProcessedBuilding() {
  try {
    const raw = localStorage.getItem("building_model");
    if (raw) return processBuilding(JSON.parse(raw));
  } catch {}
  try {
    const roomsByStorey  = JSON.parse(localStorage.getItem("floorplan_rooms"))  || { 0: [], 1: [], 2: [] };
    const ceilingHeights = JSON.parse(localStorage.getItem("floorplan_ceilings")) || { 0: 3.0, 1: 2.7, 2: 2.5 };
    const globalU        = JSON.parse(localStorage.getItem("floorplan_uvalues")) || null;
    return processBuilding(buildingModelFromState({ roomsByStorey, ceilingHeights, globalU }));
  } catch {}
  return null;
}

// ─── Small display components ─────────────────────────────────────────────────
function SectionHeader({ label }) {
  return (
    <div style={{
      color: "#2d5a8a", fontSize: 9, letterSpacing: "0.18em",
      borderBottom: "1px solid #132040", paddingBottom: 6, marginBottom: 14,
    }}>
      {label}
    </div>
  );
}

function MetricRow({ label, value, unit, highlight }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      padding: "6px 0", borderBottom: "1px solid #0a1628",
    }}>
      <span style={{ color: "#4a7fa5", fontSize: 11 }}>{label}</span>
      <span style={{ fontFamily: "monospace", fontSize: 13, color: highlight ? "#7dd3fc" : "#c8d8f0" }}>
        {value}
        {unit && <span style={{ fontSize: 9, color: "#2d5a8a", marginLeft: 4 }}>{unit}</span>}
      </span>
    </div>
  );
}

function Card({ children, accent }) {
  return (
    <div style={{
      background: "#070d1a",
      border: `1px solid ${accent || "#132040"}`,
      borderRadius: 6,
      padding: "16px 18px",
      marginBottom: 16,
    }}>
      {children}
    </div>
  );
}

function NumInput({ label, value, onChange, min, max, step, unit }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ color: "#4a7fa5", fontSize: 10, flex: 1 }}>{label}</span>
      <input
        type="number" min={min} max={max} step={step}
        value={value}
        onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(v); }}
        style={{
          width: 80, background: "#0a1628", border: "1px solid #1e3a6b",
          color: "#7dd3fc", padding: "4px 8px", borderRadius: 4,
          fontFamily: "monospace", fontSize: 12, outline: "none", textAlign: "right",
        }}
      />
      {unit && <span style={{ color: "#2d5a8a", fontSize: 9, width: 40 }}>{unit}</span>}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function HeatSummary() {
  const [hdd, setHdd] = useState(2500);

  const pb = useMemo(loadProcessedBuilding, []);

  if (!pb || pb.rooms.length === 0) {
    return (
      <div style={{
        flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
        background: "#05090f", color: "#2d5a8a", fontFamily: "monospace", fontSize: 12,
      }}>
        No rooms in floor plan. Draw rooms in the Floor Plan tab first.
      </div>
    );
  }

  const { summary } = pb;
  const hlc = summary.fabricHeatLossCoeff;            // W/K

  // Q (kWh) = HLC (W/K) × HDD (K·day) × 24 h/day ÷ 1000
  const conductiveLoss = (hlc * hdd * 24) / 1000;    // kWh

  // Per-element breakdown: walls, glazing, doors, floors, roofs
  const heatedRooms = pb.rooms.filter(r => r.isHeated);

  const wallHLC    = heatedRooms.flatMap(r => r.walls)
    .filter(w => w.adjacency === "external")
    .reduce((s, w) => s + w.heatLossCoeff, 0);

  const windowHLC  = heatedRooms.flatMap(r => r.walls)
    .flatMap(w => w.openings)
    .filter(o => o.type === "window")
    .reduce((s, o) => s + o.heatLossCoeff, 0);

  const doorHLC    = heatedRooms.flatMap(r => r.walls)
    .flatMap(w => w.openings)
    .filter(o => o.type === "door")
    .reduce((s, o) => s + o.heatLossCoeff, 0);

  const floorHLC   = heatedRooms.map(r => r.floor)
    .filter(f => f.adjacency === "ground")
    .reduce((s, f) => s + f.heatLossCoeff, 0);

  const roofHLC    = heatedRooms.map(r => r.roof)
    .filter(f => f.adjacency === "external")
    .reduce((s, f) => s + f.heatLossCoeff, 0);

  const toKwh = (hlcVal) => ((hlcVal * hdd * 24) / 1000).toFixed(0);
  const pct   = (hlcVal) => hlc > 0 ? ((hlcVal / hlc) * 100).toFixed(1) : "0.0";

  const elementRows = [
    { label: "Opaque walls",   hlcVal: wallHLC,   color: "#60a5fa" },
    { label: "Windows",        hlcVal: windowHLC, color: "#38bdf8" },
    { label: "Doors",          hlcVal: doorHLC,   color: "#a78bfa" },
    { label: "Ground floor",   hlcVal: floorHLC,  color: "#34d399" },
    { label: "Roof / ceiling", hlcVal: roofHLC,   color: "#fbbf24" },
  ];

  // Simple horizontal bar (percentage of total HLC)
  const Bar = ({ hlcVal, color }) => {
    const width = hlc > 0 ? (hlcVal / hlc) * 100 : 0;
    return (
      <div style={{ flex: 1, height: 6, background: "#0a1628", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${width}%`, height: "100%", background: color, borderRadius: 3 }} />
      </div>
    );
  };

  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column", background: "#05090f",
      color: "#c8d8f0", fontFamily: "monospace", overflow: "hidden",
    }}>
      {/* Header bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        height: 46, padding: "0 20px", background: "#070d1a",
        borderBottom: "1px solid #132040", flexShrink: 0,
      }}>
        <span style={{ color: "#38bdf8", fontWeight: 700, fontSize: 11, letterSpacing: "0.18em" }}>
          HEAT SUMMARY
        </span>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px" }}>
        <div style={{ maxWidth: 640, margin: "0 auto", display: "flex", flexDirection: "column", gap: 0 }}>

          {/* ── Inputs ── */}
          <Card>
            <SectionHeader label="INPUTS" />
            <NumInput
              label="Heating degree days"
              value={hdd}
              onChange={setHdd}
              min={0} max={8000} step={50}
              unit="K·day/yr"
            />
            <div style={{ color: "#1e3a6b", fontSize: 8, marginTop: 8, lineHeight: 1.7 }}>
              Annual sum of (base temperature − mean daily outside temperature) for all days
              where heating is needed. Typical UK values: 1800–3500 K·day/yr.
            </div>
          </Card>

          {/* ── Building summary ── */}
          <Card>
            <SectionHeader label="BUILDING ENVELOPE" />
            <MetricRow label="Heated floor area"     value={summary.totalFloorArea.toFixed(1)}    unit="m²" />
            <MetricRow label="Heated volume"         value={summary.totalVolume.toFixed(1)}        unit="m³" />
            <MetricRow label="Total envelope area"   value={summary.totalEnvelopeArea.toFixed(1)}  unit="m²" />
            <MetricRow label="Average fabric U-value" value={summary.avgFabricU.toFixed(3)}        unit="W/m²K" />
          </Card>

          {/* ── Conductive losses ── */}
          <Card accent="#1e3a6b">
            <SectionHeader label="CONDUCTIVE FABRIC LOSSES" />

            {/* Total */}
            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "baseline",
              padding: "10px 0 14px", borderBottom: "1px solid #132040", marginBottom: 14,
            }}>
              <div>
                <div style={{ color: "#7dd3fc", fontSize: 22, fontFamily: "monospace", fontWeight: 700 }}>
                  {conductiveLoss.toFixed(0)}
                  <span style={{ fontSize: 12, color: "#2d5a8a", marginLeft: 6 }}>kWh/yr</span>
                </div>
                <div style={{ color: "#2d5a8a", fontSize: 9, marginTop: 3 }}>
                  Fabric HLC × HDD × 24 h/day ÷ 1000
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: "#4a7fa5", fontSize: 11 }}>
                  {hlc.toFixed(1)}
                  <span style={{ fontSize: 9, color: "#2d5a8a", marginLeft: 4 }}>W/K</span>
                </div>
                <div style={{ color: "#1e3a6b", fontSize: 9, marginTop: 2 }}>fabric HLC</div>
              </div>
            </div>

            {/* Per-element rows */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {elementRows.map(({ label, hlcVal, color }) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 3, height: 28, background: color, borderRadius: 2, flexShrink: 0 }} />
                  <div style={{ width: 110, color: "#4a7fa5", fontSize: 10 }}>{label}</div>
                  <Bar hlcVal={hlcVal} color={color} />
                  <div style={{ width: 72, textAlign: "right", color: "#c8d8f0", fontSize: 11, fontFamily: "monospace" }}>
                    {toKwh(hlcVal)}
                    <span style={{ fontSize: 8, color: "#2d5a8a", marginLeft: 3 }}>kWh</span>
                  </div>
                  <div style={{ width: 40, textAlign: "right", color: "#2d5a8a", fontSize: 9 }}>
                    {pct(hlcVal)}%
                  </div>
                </div>
              ))}
            </div>

            {/* Per m² intensity */}
            {summary.totalFloorArea > 0 && (
              <div style={{
                marginTop: 16, paddingTop: 12, borderTop: "1px solid #132040",
                display: "flex", justifyContent: "space-between", alignItems: "baseline",
              }}>
                <span style={{ color: "#4a7fa5", fontSize: 10 }}>Heat loss intensity</span>
                <span style={{ fontFamily: "monospace", fontSize: 13, color: "#7dd3fc" }}>
                  {(conductiveLoss / summary.totalFloorArea).toFixed(1)}
                  <span style={{ fontSize: 9, color: "#2d5a8a", marginLeft: 4 }}>kWh/m²·yr</span>
                </span>
              </div>
            )}
          </Card>

          {/* ── Warnings ── */}
          {summary.warnings.length > 0 && (
            <Card accent="#7f1d1d">
              <SectionHeader label="WARNINGS" />
              {summary.warnings.map((w, i) => (
                <div key={i} style={{
                  fontSize: 10, color: w.severity === "error" ? "#f87171" : "#fbbf24",
                  padding: "4px 0", borderBottom: "1px solid #0a1628",
                }}>
                  {w.message}
                </div>
              ))}
            </Card>
          )}

        </div>
      </div>
    </div>
  );
}
