import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { buildingModelFromState, processBuilding } from "./geometryProcessor.js";
import { parseEPW, computeHDD, computeMonthlyHDD } from "./epwParser.js";
import { solarPosition, verticalIncident } from "./solarGain.js";
import kewEPWRaw from "./assets/GBR_ENG_Kew.Observatory.037750_TMYx.2011-2025.epw?raw";

// ─── Load processed building from localStorage ────────────────────────────────
function loadProcessedBuilding(projectId) {
  const pk = (key) => `${projectId}_${key}`;
  try {
    const raw = localStorage.getItem(pk("building_model"));
    if (raw) return processBuilding(JSON.parse(raw));
  } catch {}
  try {
    const roomsByStorey    = JSON.parse(localStorage.getItem(pk("floorplan_rooms")))    || { 0: [], 1: [], 2: [] };
    const ceilingHeights   = JSON.parse(localStorage.getItem(pk("floorplan_ceilings"))) || { 0: 3.0, 1: 2.7, 2: 2.5 };
    const globalU          = JSON.parse(localStorage.getItem(pk("floorplan_uvalues")))  || null;
    const buildingRotation = JSON.parse(localStorage.getItem(pk("floorplan_rotation"))) || 0;
    return processBuilding(buildingModelFromState({ roomsByStorey, ceilingHeights, globalU, site: { buildingRotation } }));
  } catch {}
  return null;
}

// ─── Primitive UI components ──────────────────────────────────────────────────
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

function MetricRow({ label, value, unit }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      padding: "6px 0", borderBottom: "1px solid #0a1628",
    }}>
      <span style={{ color: "#4a7fa5", fontSize: 11 }}>{label}</span>
      <span style={{ fontFamily: "monospace", fontSize: 13, color: "#c8d8f0" }}>
        {value}
        {unit && <span style={{ fontSize: 9, color: "#2d5a8a", marginLeft: 4 }}>{unit}</span>}
      </span>
    </div>
  );
}

function Card({ children, accent }) {
  return (
    <div style={{
      background: "#070d1a", border: `1px solid ${accent || "#132040"}`,
      borderRadius: 6, padding: "16px 18px", marginBottom: 16,
    }}>
      {children}
    </div>
  );
}

function NumInput({ label, value, onChange, min, max, step, unit, dimLabel }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ color: dimLabel ? "#2d5a8a" : "#4a7fa5", fontSize: 10, flex: 1 }}>{label}</span>
      <input
        type="number" min={min} max={max} step={step} value={value}
        onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(v); }}
        style={{
          width: 80, background: "#0a1628", border: "1px solid #1e3a6b",
          color: "#7dd3fc", padding: "4px 8px", borderRadius: 4,
          fontFamily: "monospace", fontSize: 12, outline: "none", textAlign: "right",
        }}
      />
      {unit && <span style={{ color: "#2d5a8a", fontSize: 9, width: 52 }}>{unit}</span>}
    </div>
  );
}

// ─── Monthly HDD bar chart ────────────────────────────────────────────────────
const MONTH_ABBR = ["J","F","M","A","M","J","J","A","S","O","N","D"];

function MonthlyHDDChart({ monthlyHDD, monthlyStats }) {
  const maxHDD   = Math.max(...monthlyHDD, 1);
  const barH     = 60;

  return (
    <div>
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(12, 1fr)",
        gap: 3, alignItems: "end", height: barH + 32,
      }}>
        {monthlyHDD.map((hdd, i) => {
          const frac    = hdd / maxHDD;
          const h       = Math.max(2, Math.round(frac * barH));
          const meanT   = monthlyStats ? monthlyStats[i].meanTemp : null;
          const isCold  = meanT !== null && meanT < 5;
          const barColor = isCold ? "#38bdf8" : hdd > 0 ? "#60a5fa" : "#1e3a6b";
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
              {/* Tooltip-style HDD value on hover handled via title */}
              <div
                title={`${MONTH_ABBR[i]}: ${hdd.toFixed(0)} K·day${meanT !== null ? `  (mean ${meanT.toFixed(1)}°C)` : ""}`}
                style={{
                  width: "100%", height: h, background: barColor,
                  borderRadius: "2px 2px 0 0", cursor: "default",
                  alignSelf: "flex-end",
                }}
              />
              <span style={{ color: "#2d5a8a", fontSize: 8 }}>{MONTH_ABBR[i]}</span>
            </div>
          );
        })}
      </div>
      {/* Y-axis label */}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        <span style={{ color: "#1e3a6b", fontSize: 8 }}>0</span>
        <span style={{ color: "#1e3a6b", fontSize: 8 }}>{maxHDD.toFixed(0)} K·day</span>
      </div>
    </div>
  );
}

// ─── Monthly temperature sparkline ───────────────────────────────────────────
function MonthlyTempTable({ monthlyStats, baseTemp }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "2px 6px", marginTop: 8 }}>
      {monthlyStats.map(m => {
        const isHeating = m.meanTemp < baseTemp;
        return (
          <div key={m.name} style={{
            background: "#0a1628", borderRadius: 3, padding: "5px 7px",
            border: `1px solid ${isHeating ? "#1e3a6b" : "#132040"}`,
          }}>
            <div style={{ color: "#2d5a8a", fontSize: 8, marginBottom: 2 }}>{m.name}</div>
            <div style={{
              fontFamily: "monospace", fontSize: 11,
              color: m.meanTemp < 0 ? "#38bdf8" : m.meanTemp < 10 ? "#7dd3fc" : m.meanTemp < 18 ? "#c8d8f0" : "#fbbf24",
            }}>
              {m.meanTemp.toFixed(1)}°C
            </div>
            <div style={{ color: "#1e3a6b", fontSize: 7, marginTop: 1 }}>
              {m.minTemp.toFixed(0)} / {m.maxTemp.toFixed(0)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Representative compass bearing for each 8-direction orientation label
const ORIENTATION_BEARING = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

// ─── Monthly solar gain bar chart ─────────────────────────────────────────────
function MonthlySolarChart({ monthlySolar }) {
  const maxVal = Math.max(...monthlySolar, 1);
  const barH   = 60;
  return (
    <div>
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(12, 1fr)",
        gap: 3, alignItems: "end", height: barH + 32,
      }}>
        {monthlySolar.map((kwh, i) => {
          const h = Math.max(2, Math.round((kwh / maxVal) * barH));
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
              <div
                title={`${MONTH_ABBR[i]}: ${kwh.toFixed(0)} kWh`}
                style={{
                  width: "100%", height: h, borderRadius: "2px 2px 0 0",
                  background: "linear-gradient(to top, #f59e0b, #fbbf24)",
                  alignSelf: "flex-end", cursor: "default",
                }}
              />
              <span style={{ color: "#2d5a8a", fontSize: 8 }}>{MONTH_ABBR[i]}</span>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        <span style={{ color: "#1e3a6b", fontSize: 8 }}>0</span>
        <span style={{ color: "#1e3a6b", fontSize: 8 }}>{maxVal.toFixed(0)} kWh</span>
      </div>
    </div>
  );
}

// ─── Monthly net heat demand bar chart ────────────────────────────────────────
function MonthlyNetDemandChart({ monthlyNetDemand }) {
  const maxVal = Math.max(...monthlyNetDemand, 1);
  const barH   = 60;
  return (
    <div>
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(12, 1fr)",
        gap: 3, alignItems: "end", height: barH + 32,
      }}>
        {monthlyNetDemand.map((kwh, i) => {
          const h = Math.max(kwh > 0 ? 2 : 0, Math.round((kwh / maxVal) * barH));
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
              <div
                title={`${MONTH_ABBR[i]}: ${kwh.toFixed(0)} kWh`}
                style={{
                  width: "100%", height: h, borderRadius: "2px 2px 0 0",
                  background: kwh > 0 ? "linear-gradient(to top, #1d4ed8, #38bdf8)" : "transparent",
                  alignSelf: "flex-end", cursor: "default",
                }}
              />
              <span style={{ color: "#2d5a8a", fontSize: 8 }}>{MONTH_ABBR[i]}</span>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        <span style={{ color: "#1e3a6b", fontSize: 8 }}>0</span>
        <span style={{ color: "#1e3a6b", fontSize: 8 }}>{maxVal.toFixed(0)} kWh</span>
      </div>
    </div>
  );
}

// ─── EPW drop-zone / file picker ──────────────────────────────────────────────
function EPWDropZone({ onLoad, error }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const readFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => onLoad(e.target.result, file.name);
    reader.readAsText(file);
  };

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragging(false);
    readFile(e.dataTransfer.files[0]);
  }, [onLoad]);

  const onDragOver = (e) => { e.preventDefault(); setDragging(true); };
  const onDragLeave = () => setDragging(false);

  return (
    <div
      onClick={() => inputRef.current.click()}
      onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave}
      style={{
        border: `1px dashed ${dragging ? "#38bdf8" : error ? "#f87171" : "#1e3a6b"}`,
        borderRadius: 5, padding: "18px 16px", textAlign: "center",
        cursor: "pointer", transition: "border-color 0.15s",
        background: dragging ? "#0a1e38" : "transparent",
      }}
    >
      <div style={{ color: dragging ? "#38bdf8" : "#2d5a8a", fontSize: 11, marginBottom: 4 }}>
        Drop an EPW file here, or click to browse
      </div>
      <div style={{ color: "#1e3a6b", fontSize: 9 }}>
        EnergyPlus Weather (.epw) — from{" "}
        <span style={{ color: "#2d5a8a" }}>climate.onebuilding.org</span> or EnergyPlus.net
      </div>
      {error && (
        <div style={{ color: "#f87171", fontSize: 9, marginTop: 6 }}>{error}</div>
      )}
      <input
        ref={inputRef} type="file" accept=".epw" style={{ display: "none" }}
        onChange={e => readFile(e.target.files[0])}
      />
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function HeatSummary({ projectId }) {
  // EPW state
  const [epwData,    setEpwData]    = useState(null);   // parsed EPW result
  const [epwName,    setEpwName]    = useState(null);   // filename
  const [epwError,   setEpwError]   = useState(null);
  const [baseTemp,   setBaseTemp]   = useState(15.5);   // °C — CIBSE UK default

  // HDD: derived from EPW when available, otherwise user-editable
  const [hddManual,  setHddManual]  = useState(2500);
  const [hddOverride, setHddOverride] = useState(false); // user overriding EPW value

  const pb = useMemo(() => loadProcessedBuilding(projectId), [projectId]);

  // ── Auto-load bundled Kew EPW on first mount ────────────────────────────────
  useEffect(() => {
    try {
      const data = parseEPW(kewEPWRaw);
      setEpwData(data);
      setEpwName("GBR_ENG_Kew.Observatory.037750_TMYx.2011-2025.epw");
    } catch (err) {
      setEpwError(err.message || "Failed to parse bundled EPW file.");
    }
  }, []);

  // ── EPW load handler ────────────────────────────────────────────────────────
  const handleEPWLoad = useCallback((text, filename) => {
    try {
      const data = parseEPW(text);
      setEpwData(data);
      setEpwName(filename);
      setEpwError(null);
      setHddOverride(false);  // reset override when new file loaded
    } catch (err) {
      setEpwError(err.message || "Failed to parse EPW file.");
    }
  }, []);

  const clearEPW = () => { setEpwData(null); setEpwName(null); setEpwError(null); };

  // ── Derived climate values ──────────────────────────────────────────────────
  const epwHDD = useMemo(() => {
    if (!epwData) return null;
    return computeHDD(epwData.hourly, baseTemp);
  }, [epwData, baseTemp]);

  const monthlyHDD = useMemo(() => {
    if (!epwData) return null;
    return computeMonthlyHDD(epwData.hourly, baseTemp);
  }, [epwData, baseTemp]);

  // Active HDD value used in calculations
  const hdd = epwData && !hddOverride ? epwHDD : hddManual;

  // ── Solar gain inputs — group external windows by orientation ───────────────
  const windowGroups = useMemo(() => {
    if (!pb) return [];
    const groups = {};
    pb.rooms
      .filter(r => r.isHeated)
      .flatMap(r => r.walls)
      .filter(w => w.adjacency === "external")
      .flatMap(w => w.openings)
      .filter(o => o.type === "window")
      .forEach(o => {
        const or = o.orientation;
        if (!groups[or]) groups[or] = { orientation: or, bearing: ORIENTATION_BEARING[or] ?? 0, effectiveArea: 0, area: 0 };
        groups[or].effectiveArea += o.area * o.solarHeatGainCoeff;
        groups[or].area          += o.area;
      });
    return Object.values(groups);
  }, [pb]);

  // ── Ventilation inputs ──────────────────────────────────────────────────────
  const [ach50,          setAch50]          = useState(5.0);
  const [deratingFactor, setDeratingFactor] = useState(20);
  const [mvhrEnabled,    setMvhrEnabled]    = useState(false);
  const [mvhrFlow,       setMvhrFlow]       = useState(30);   // l/s
  const [mvhrEfficiency, setMvhrEfficiency] = useState(80);   // %

  // Ventilation HLC computed here so it is available to the combined useMemo below.
  // Uses pb?.summary?.totalVolume so it evaluates safely before the early-return guard.
  const totalVolume     = pb?.summary?.totalVolume ?? 0;
  const naturalAch      = ach50 / Math.max(1, deratingFactor);
  const infiltrationHLC = 0.33 * totalVolume * naturalAch;
  // MVHR: supply flow (l/s) × ρCp (1.2 W/(l/s·K)) × unrecovered fraction
  const mvhrVentHLC     = mvhrEnabled ? (mvhrFlow * 1.2 * (1 - mvhrEfficiency / 100)) : 0;
  const ventilationHLC  = infiltrationHLC + mvhrVentHLC;

  // ── Internal gains + heating inputs ────────────────────────────────────────
  const [electricityKwhPerDay, setElectricityKwhPerDay] = useState(8);
  const [numPeople,            setNumPeople]            = useState(2);
  const [hoursAtHome,          setHoursAtHome]          = useState(12);
  const [internalTemp,         setInternalTemp]         = useState(21);

  // Single pass over hourly EPW data: accumulates solar gain and fabric heat loss together
  // per day, then applies max(0, loss - solar - internal) per day.
  // Temporary estimate — summer surpluses do not offset winter deficits.
  // TODO: replace with a thermal-mass-aware simulation once thermal mass is integrated into the model.
  const combined = useMemo(() => {
    if (!epwData || !pb || pb.rooms.length === 0) return null;
    const hlcVal = pb.summary.fabricHeatLossCoeff + ventilationHLC;
    const { latitude, longitude, timezone } = epwData.location;
    const internalGainPerDay =
      electricityKwhPerDay + (numPeople * 100 * hoursAtHome) / 1000;
    const hasWindows = windowGroups.length > 0;

    const monthlySolarWh   = new Array(12).fill(0);
    const monthlyNetDemand = new Array(12).fill(0);
    const byOrientationWh = {};
    for (const { orientation } of windowGroups) byOrientationWh[orientation] = 0;

    let netDemand   = 0;
    let dayLossKwh  = 0;
    let daySolarKwh = 0;
    let prevDayKey  = null;
    let prevMonth   = null;

    for (const rec of epwData.hourly) {
      const { month, day, hour, dni, dhi, ghi, dryBulb } = rec;
      const dayKey = month * 100 + day;

      if (prevDayKey !== null && dayKey !== prevDayKey) {
        const dayNet = Math.max(0, dayLossKwh - daySolarKwh - internalGainPerDay);
        netDemand += dayNet;
        monthlyNetDemand[prevMonth - 1] += dayNet;
        dayLossKwh  = 0;
        daySolarKwh = 0;
      }
      prevDayKey = dayKey;
      prevMonth  = month;

      dayLossKwh += (hlcVal * Math.max(0, internalTemp - dryBulb)) / 1000;

      if (hasWindows && ((ghi ?? 0) > 0 || (dhi ?? 0) > 0 || (dni ?? 0) > 0)) {
        const pos = solarPosition(latitude, longitude, timezone, month, day, hour);
        for (const { bearing, effectiveArea, orientation } of windowGroups) {
          const gainWh = verticalIncident(pos.altitude, pos.azimuth, bearing, dni, dhi, ghi)
            * effectiveArea;
          monthlySolarWh[month - 1]       += gainWh;
          byOrientationWh[orientation]    += gainWh;
          daySolarKwh                     += gainWh / 1000;
        }
      }
    }
    // Flush the final day
    if (prevDayKey !== null) {
      const dayNet = Math.max(0, dayLossKwh - daySolarKwh - internalGainPerDay);
      netDemand += dayNet;
      if (prevMonth !== null) monthlyNetDemand[prevMonth - 1] += dayNet;
    }

    const annualSolar = monthlySolarWh.reduce((s, v) => s + v, 0) / 1000;
    return {
      netDemand,
      monthlyNetDemand,
      monthlySolar:  monthlySolarWh.map(v => v / 1000),
      annualSolar,
      byOrientation: Object.fromEntries(
        Object.entries(byOrientationWh).map(([k, v]) => [k, v / 1000])
      ),
    };
  }, [epwData, pb, internalTemp, windowGroups, electricityKwhPerDay, numPeople, hoursAtHome, ventilationHLC]);

  // ── Building model ──────────────────────────────────────────────────────────
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
  const hlc      = summary.fabricHeatLossCoeff; // W/K
  const totalHLC = hlc + ventilationHLC;

  // Q (kWh) = HLC (W/K) × HDD (K·day) × 24 h/day ÷ 1000
  const conductiveLoss      = (hlc * hdd * 24) / 1000;
  const ventilationLoss     = (ventilationHLC * hdd * 24) / 1000;
  const totalFabricVentLoss = (totalHLC * hdd * 24) / 1000;

  // Internal gains
  const electricityGainKwh = electricityKwhPerDay * 365;
  const peopleGainKwh      = (numPeople * 100 * hoursAtHome * 365) / 1000;

  // ── Per-element HLC breakdown ───────────────────────────────────────────────
  const heatedRooms = pb.rooms.filter(r => r.isHeated);

  const externalWalls = heatedRooms.flatMap(r => r.walls).filter(w => w.adjacency === "external");
  const allOpenings   = externalWalls.flatMap(w => w.openings);
  const groundFloors  = heatedRooms.map(r => r.floor).filter(f => f.adjacency === "ground");
  const externalRoofs = heatedRooms.map(r => r.roof).filter(f => f.adjacency === "external");

  const wallHLC   = externalWalls.reduce((s, w) => s + w.heatLossCoeff, 0);
  const windowHLC = allOpenings.filter(o => o.type === "window").reduce((s, o) => s + o.heatLossCoeff, 0);
  const doorHLC   = allOpenings.filter(o => o.type === "door").reduce((s, o) => s + o.heatLossCoeff, 0);
  const floorHLC  = groundFloors.reduce((s, f) => s + f.heatLossCoeff, 0);
  const roofHLC   = externalRoofs.reduce((s, f) => s + f.heatLossCoeff, 0);

  const wallArea   = externalWalls.reduce((s, w) => s + w.netOpaqueArea, 0);
  const windowArea = allOpenings.filter(o => o.type === "window").reduce((s, o) => s + o.area, 0);
  const doorArea   = allOpenings.filter(o => o.type === "door").reduce((s, o) => s + o.area, 0);
  const floorArea  = groundFloors.reduce((s, f) => s + f.area, 0);
  const roofArea   = externalRoofs.reduce((s, f) => s + f.area, 0);

  const toKwh = (v) => ((v * hdd * 24) / 1000).toFixed(0);
  const pct   = (v) => hlc > 0 ? ((v / hlc) * 100).toFixed(1) : "0.0";

  const elementRows = [
    { label: "Opaque walls",   hlcVal: wallHLC,   area: wallArea,   color: "#60a5fa" },
    { label: "Windows",        hlcVal: windowHLC, area: windowArea, color: "#38bdf8" },
    { label: "Doors",          hlcVal: doorHLC,   area: doorArea,   color: "#a78bfa" },
    { label: "Ground floor",   hlcVal: floorHLC,  area: floorArea,  color: "#34d399" },
    { label: "Roof / ceiling", hlcVal: roofHLC,   area: roofArea,   color: "#fbbf24" },
  ];

  const Bar = ({ hlcVal, color }) => {
    const width = hlc > 0 ? (hlcVal / hlc) * 100 : 0;
    return (
      <div style={{ flex: 1, height: 6, background: "#0a1628", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${width}%`, height: "100%", background: color, borderRadius: 3 }} />
      </div>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column", background: "#05090f",
      color: "#c8d8f0", fontFamily: "monospace", overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, height: 46,
        padding: "0 20px", background: "#070d1a",
        borderBottom: "1px solid #132040", flexShrink: 0,
      }}>
        <span style={{ color: "#38bdf8", fontWeight: 700, fontSize: 11, letterSpacing: "0.18em" }}>
          HEAT SUMMARY
        </span>
        {epwName && (
          <span style={{ color: "#2d5a8a", fontSize: 9, marginLeft: 4 }}>
            ● {epwName}
          </span>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "24px" }}>
        <div style={{ maxWidth: 640, margin: "0 auto" }}>

          {/* ── EPW file ── */}
          <Card>
            <SectionHeader label="WEATHER FILE (EPW)" />
            {!epwData ? (
              <EPWDropZone onLoad={handleEPWLoad} error={epwError} />
            ) : (
              <div>
                {/* Location summary */}
                <div style={{
                  display: "flex", justifyContent: "space-between", alignItems: "flex-start",
                  marginBottom: 14, paddingBottom: 14, borderBottom: "1px solid #132040",
                }}>
                  <div>
                    <div style={{ color: "#7dd3fc", fontSize: 13, fontWeight: 700 }}>
                      {epwData.location.city}
                      {epwData.location.region ? `, ${epwData.location.region}` : ""}
                    </div>
                    <div style={{ color: "#4a7fa5", fontSize: 10, marginTop: 3 }}>
                      {epwData.location.country}
                      {epwData.location.wmo ? `  ·  WMO ${epwData.location.wmo}` : ""}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ color: "#c8d8f0", fontSize: 10, fontFamily: "monospace" }}>
                      {epwData.location.latitude.toFixed(2)}°{epwData.location.latitude >= 0 ? "N" : "S"}
                      {"  "}
                      {Math.abs(epwData.location.longitude).toFixed(2)}°{epwData.location.longitude >= 0 ? "E" : "W"}
                    </div>
                    <div style={{ color: "#2d5a8a", fontSize: 9, marginTop: 2 }}>
                      {epwData.location.elevation}m elev · UTC{epwData.location.timezone >= 0 ? "+" : ""}{epwData.location.timezone}
                    </div>
                  </div>
                </div>

                {/* Base temperature */}
                <div style={{ marginBottom: 14 }}>
                  <NumInput
                    label="Base (balance-point) temperature"
                    value={baseTemp}
                    onChange={setBaseTemp}
                    min={5} max={22} step={0.5}
                    unit="°C"
                  />
                  <div style={{ color: "#1e3a6b", fontSize: 8, marginTop: 5, lineHeight: 1.6 }}>
                    15.5°C — CIBSE UK standard &nbsp;·&nbsp; 15°C — common European standard
                  </div>
                </div>

                {/* Monthly HDD chart */}
                {monthlyHDD && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ color: "#2d5a8a", fontSize: 9, marginBottom: 8, letterSpacing: "0.1em" }}>
                      MONTHLY HEATING DEGREE DAYS
                    </div>
                    <MonthlyHDDChart monthlyHDD={monthlyHDD} monthlyStats={epwData.monthly} />
                  </div>
                )}

                {/* Monthly temperature mini-table */}
                {epwData.monthly && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ color: "#2d5a8a", fontSize: 9, marginBottom: 4, letterSpacing: "0.1em" }}>
                      MEAN DAILY TEMPERATURE &nbsp;<span style={{ color: "#1e3a6b" }}>( min / max recorded °C )</span>
                    </div>
                    <MonthlyTempTable monthlyStats={epwData.monthly} baseTemp={baseTemp} />
                  </div>
                )}

                {/* Computed HDD */}
                <div style={{
                  marginTop: 14, paddingTop: 12, borderTop: "1px solid #132040",
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                }}>
                  <div>
                    <span style={{ color: "#4a7fa5", fontSize: 10 }}>Annual HDD from file </span>
                    <span style={{ color: "#1e3a6b", fontSize: 9 }}>
                      (base {baseTemp}°C)
                    </span>
                  </div>
                  <span style={{ color: "#7dd3fc", fontFamily: "monospace", fontSize: 14 }}>
                    {epwHDD.toFixed(0)}
                    <span style={{ fontSize: 9, color: "#2d5a8a", marginLeft: 4 }}>K·day/yr</span>
                  </span>
                </div>

                <button
                  onClick={clearEPW}
                  style={{
                    marginTop: 12, width: "100%", padding: "6px", background: "transparent",
                    border: "1px solid #1e3a6b", color: "#2d5a8a", borderRadius: 4,
                    cursor: "pointer", fontSize: 9, fontFamily: "monospace", letterSpacing: "0.1em",
                  }}
                >
                  CLEAR — use manual HDD
                </button>
              </div>
            )}
          </Card>

          {/* ── HDD input (manual, or EPW override) ── */}
          <Card>
            <SectionHeader label={epwData && !hddOverride ? "HEATING DEGREE DAYS — FROM EPW" : "HEATING DEGREE DAYS"} />
            {epwData && !hddOverride ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <span style={{ color: "#7dd3fc", fontFamily: "monospace", fontSize: 18 }}>
                    {epwHDD.toFixed(0)}
                  </span>
                  <span style={{ color: "#2d5a8a", fontSize: 9, marginLeft: 6 }}>K·day/yr</span>
                </div>
                <button
                  onClick={() => { setHddManual(Math.round(epwHDD)); setHddOverride(true); }}
                  style={{
                    padding: "4px 10px", background: "transparent",
                    border: "1px solid #1e3a6b", color: "#2d5a8a", borderRadius: 4,
                    cursor: "pointer", fontSize: 9, fontFamily: "monospace",
                  }}
                >
                  OVERRIDE
                </button>
              </div>
            ) : (
              <div>
                <NumInput
                  label="Heating degree days"
                  value={hddManual}
                  onChange={setHddManual}
                  min={0} max={8000} step={50}
                  unit="K·day/yr"
                  dimLabel={epwData && hddOverride}
                />
                {epwData && hddOverride && (
                  <button
                    onClick={() => setHddOverride(false)}
                    style={{
                      marginTop: 8, padding: "3px 8px", background: "transparent",
                      border: "1px solid #1e3a6b", color: "#2d5a8a", borderRadius: 3,
                      cursor: "pointer", fontSize: 8, fontFamily: "monospace",
                    }}
                  >
                    ↩ REVERT TO EPW VALUE ({epwHDD.toFixed(0)})
                  </button>
                )}
                {!epwData && (
                  <div style={{ color: "#1e3a6b", fontSize: 8, marginTop: 8, lineHeight: 1.7 }}>
                    Annual sum of (base temp − mean daily outside temp). UK typical: 1800–3500 K·day/yr.
                    Load an EPW file above for site-specific values.
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* ── Building envelope ── */}
          <Card>
            <SectionHeader label="BUILDING ENVELOPE" />
            <MetricRow label="Heated floor area"      value={summary.totalFloorArea.toFixed(1)}   unit="m²" />
            <MetricRow label="Heated volume"          value={summary.totalVolume.toFixed(1)}       unit="m³" />
            <MetricRow label="Total envelope area"    value={summary.totalEnvelopeArea.toFixed(1)} unit="m²" />
            <MetricRow label="Average fabric U-value" value={summary.avgFabricU.toFixed(3)}        unit="W/m²K" />
          </Card>

          {/* ── Conductive losses ── */}
          <Card accent="#1e3a6b">
            <SectionHeader label="CONDUCTIVE FABRIC LOSSES" />

            {/* Headline total */}
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

            {/* Per-element breakdown */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {elementRows.map(({ label, hlcVal, area, color }) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 3, height: 28, background: color, borderRadius: 2, flexShrink: 0 }} />
                  <div style={{ width: 110, color: "#4a7fa5", fontSize: 10 }}>{label}</div>
                  <Bar hlcVal={hlcVal} color={color} />
                  <div style={{ width: 52, textAlign: "right", color: "#4a7fa5", fontSize: 10, fontFamily: "monospace" }}>
                    {area.toFixed(1)}
                    <span style={{ fontSize: 7, color: "#2d5a8a", marginLeft: 2 }}>m²</span>
                  </div>
                  <div style={{ width: 64, textAlign: "right", color: "#c8d8f0", fontSize: 11, fontFamily: "monospace" }}>
                    {toKwh(hlcVal)}
                    <span style={{ fontSize: 8, color: "#2d5a8a", marginLeft: 3 }}>kWh</span>
                  </div>
                  <div style={{ width: 40, textAlign: "right", color: "#2d5a8a", fontSize: 9 }}>
                    {pct(hlcVal)}%
                  </div>
                </div>
              ))}
            </div>

            {/* Intensity */}
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

          {/* ── Ventilation / infiltration ── */}
          <Card accent="#1e3a6b">
            <SectionHeader label="VENTILATION &amp; INFILTRATION" />

            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
              <NumInput
                label="Air permeability (ACH50)"
                value={ach50}
                onChange={setAch50}
                min={0.5} max={30} step={0.5}
                unit="ACH@50Pa"
              />
              <NumInput
                label="Derating factor (n₅₀)"
                value={deratingFactor}
                onChange={setDeratingFactor}
                min={1} max={40} step={1}
                unit="÷"
              />
              <div style={{ color: "#1e3a6b", fontSize: 8, lineHeight: 1.6 }}>
                Natural ACH = ACH50 ÷ n₅₀. UK dwellings: n₅₀ = 20. Passivhaus: 25–30.
              </div>
            </div>

            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "baseline",
              padding: "10px 0 14px", borderBottom: "1px solid #132040", marginBottom: 14,
            }}>
              <div>
                <div style={{ color: "#7dd3fc", fontSize: 22, fontFamily: "monospace", fontWeight: 700 }}>
                  {ventilationLoss.toFixed(0)}
                  <span style={{ fontSize: 12, color: "#2d5a8a", marginLeft: 6 }}>kWh/yr</span>
                </div>
                <div style={{ color: "#2d5a8a", fontSize: 9, marginTop: 3 }}>
                  Infiltration {infiltrationHLC.toFixed(1)} W/K
                  {mvhrEnabled && ` + MVHR ${mvhrVentHLC.toFixed(1)} W/K`}
                  {" · "}natural ACH {naturalAch.toFixed(3)} · volume {summary.totalVolume.toFixed(0)} m³
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: "#4a7fa5", fontSize: 11 }}>
                  {ventilationHLC.toFixed(1)}
                  <span style={{ fontSize: 9, color: "#2d5a8a", marginLeft: 4 }}>W/K</span>
                </div>
                <div style={{ color: "#1e3a6b", fontSize: 9, marginTop: 2 }}>ventilation HLC</div>
              </div>
            </div>

            {/* MVHR toggle */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: mvhrEnabled ? 12 : 0 }}>
              <button
                onClick={() => setMvhrEnabled(e => !e)}
                style={{
                  height: 22, padding: "0 10px",
                  background: mvhrEnabled ? "#0c2a1a" : "transparent",
                  color: mvhrEnabled ? "#34d399" : "#2d5a8a",
                  border: `1px solid ${mvhrEnabled ? "#166534" : "#132040"}`,
                  borderRadius: 4, cursor: "pointer",
                  fontFamily: "monospace", fontSize: 9, letterSpacing: "0.08em",
                }}
              >
                {mvhrEnabled ? "MVHR ON" : "MVHR OFF"}
              </button>
              <span style={{ color: "#2d5a8a", fontSize: 9 }}>Mechanical ventilation with heat recovery</span>
            </div>

            {mvhrEnabled && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 12, borderTop: "1px solid #132040" }}>
                <NumInput
                  label="Supply flow rate"
                  value={mvhrFlow}
                  onChange={setMvhrFlow}
                  min={1} max={500} step={1}
                  unit="l/s"
                />
                <NumInput
                  label="Heat recovery efficiency"
                  value={mvhrEfficiency}
                  onChange={setMvhrEfficiency}
                  min={0} max={100} step={1}
                  unit="%"
                />
                <div style={{
                  display: "flex", justifyContent: "space-between", alignItems: "baseline",
                  paddingTop: 8, borderTop: "1px solid #132040",
                }}>
                  <span style={{ color: "#4a7fa5", fontSize: 10 }}>MVHR heat loss ({(100 - mvhrEfficiency).toFixed(0)}% unrecovered)</span>
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: "#7dd3fc" }}>
                    {mvhrVentHLC.toFixed(1)}
                    <span style={{ fontSize: 8, color: "#2d5a8a", marginLeft: 4 }}>W/K</span>
                  </span>
                </div>
              </div>
            )}
          </Card>

          {/* ── Solar gains ── */}
          {combined && windowGroups.length > 0 ? (
            <Card accent="#78350f">
              <SectionHeader label="SOLAR GAINS THROUGH GLAZING" />

              {/* Headline */}
              <div style={{
                display: "flex", justifyContent: "space-between", alignItems: "baseline",
                padding: "10px 0 14px", borderBottom: "1px solid #132040", marginBottom: 14,
              }}>
                <div>
                  <div style={{ color: "#fbbf24", fontSize: 22, fontFamily: "monospace", fontWeight: 700 }}>
                    {combined.annualSolar.toFixed(0)}
                    <span style={{ fontSize: 12, color: "#78350f", marginLeft: 6 }}>kWh/yr</span>
                  </div>
                  <div style={{ color: "#78350f", fontSize: 9, marginTop: 3 }}>
                    DNI × cos θ + isotropic diffuse + ground-reflected, summed over all hours
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ color: "#fbbf24", fontSize: 11, fontFamily: "monospace" }}>
                    {windowGroups.reduce((s, g) => s + g.effectiveArea, 0).toFixed(2)}
                    <span style={{ fontSize: 9, color: "#78350f", marginLeft: 4 }}>m² eff.</span>
                  </div>
                  <div style={{ color: "#78350f", fontSize: 9, marginTop: 2 }}>Σ area × SHGC</div>
                </div>
              </div>

              {/* Monthly chart */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ color: "#78350f", fontSize: 9, marginBottom: 8, letterSpacing: "0.1em" }}>
                  MONTHLY SOLAR GAIN
                </div>
                <MonthlySolarChart monthlySolar={combined.monthlySolar} />
              </div>

              {/* By orientation */}
              {Object.keys(combined.byOrientation).length > 0 && (
                <div>
                  <div style={{ color: "#78350f", fontSize: 9, marginBottom: 8, letterSpacing: "0.1em" }}>
                    BY ORIENTATION
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {Object.entries(combined.byOrientation)
                      .sort((a, b) => b[1] - a[1])
                      .map(([or, kwh]) => {
                        const width = combined.annualSolar > 0 ? (kwh / combined.annualSolar) * 100 : 0;
                        const grp   = windowGroups.find(g => g.orientation === or);
                        return (
                          <div key={or} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <div style={{ width: 28, color: "#fbbf24", fontSize: 10, fontFamily: "monospace" }}>{or}</div>
                            <div style={{ flex: 1, height: 6, background: "#0a1628", borderRadius: 3, overflow: "hidden" }}>
                              <div style={{ width: `${width}%`, height: "100%", background: "#f59e0b", borderRadius: 3 }} />
                            </div>
                            {grp && (
                              <div style={{ width: 52, textAlign: "right", color: "#4a7fa5", fontSize: 9, fontFamily: "monospace" }}>
                                {grp.area.toFixed(2)}
                                <span style={{ fontSize: 7, color: "#2d5a8a", marginLeft: 2 }}>m²</span>
                              </div>
                            )}
                            <div style={{ width: 64, textAlign: "right", color: "#c8d8f0", fontSize: 11, fontFamily: "monospace" }}>
                              {kwh.toFixed(0)}
                              <span style={{ fontSize: 8, color: "#78350f", marginLeft: 3 }}>kWh</span>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}
            </Card>
          ) : epwData && windowGroups.length === 0 ? (
            <Card>
              <SectionHeader label="SOLAR GAINS THROUGH GLAZING" />
              <div style={{ color: "#2d5a8a", fontSize: 10 }}>
                No external windows found in the heated floor plan. Add windows to external walls to see solar gains.
              </div>
            </Card>
          ) : null}

          {/* ── Internal gains ── */}
          <Card accent="#134e2a">
            <SectionHeader label="INTERNAL GAINS" />

            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
              <NumInput
                label="Electricity consumption"
                value={electricityKwhPerDay}
                onChange={setElectricityKwhPerDay}
                min={0} max={100} step={0.5}
                unit="kWh/day"
              />
              <div style={{ color: "#1e3a6b", fontSize: 8, marginLeft: 0, lineHeight: 1.6 }}>
                All electricity use assumed to become heat (lighting, appliances, cooking, etc.)
              </div>

              <div style={{ borderTop: "1px solid #132040", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                <NumInput
                  label="Number of people"
                  value={numPeople}
                  onChange={setNumPeople}
                  min={0} max={20} step={1}
                  unit="people"
                />
                <NumInput
                  label="Average hours at home per day"
                  value={hoursAtHome}
                  onChange={setHoursAtHome}
                  min={0} max={24} step={0.5}
                  unit="h/day"
                />
                <div style={{ color: "#1e3a6b", fontSize: 8, lineHeight: 1.6 }}>
                  Each person generates 100 W while at home
                </div>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 12, borderTop: "1px solid #132040" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ color: "#4a7fa5", fontSize: 10 }}>Electricity (all → heat)</span>
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "#34d399" }}>
                  {electricityGainKwh.toFixed(0)}
                  <span style={{ fontSize: 8, color: "#134e2a", marginLeft: 4 }}>kWh/yr</span>
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ color: "#4a7fa5", fontSize: 10 }}>Occupants (100 W × {numPeople} people × {hoursAtHome} h/day)</span>
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "#34d399" }}>
                  {peopleGainKwh.toFixed(0)}
                  <span style={{ fontSize: 8, color: "#134e2a", marginLeft: 4 }}>kWh/yr</span>
                </span>
              </div>
              <div style={{
                display: "flex", justifyContent: "space-between", alignItems: "baseline",
                paddingTop: 8, borderTop: "1px solid #132040",
              }}>
                <span style={{ color: "#34d399", fontSize: 11, fontWeight: 700 }}>Total internal gains</span>
                <span style={{ fontFamily: "monospace", fontSize: 14, color: "#34d399", fontWeight: 700 }}>
                  {(electricityGainKwh + peopleGainKwh).toFixed(0)}
                  <span style={{ fontSize: 9, color: "#134e2a", marginLeft: 4 }}>kWh/yr</span>
                </span>
              </div>
            </div>
          </Card>

          {/* ── Net heat demand ── */}
          <Card accent="#1e3a6b">
            <SectionHeader label="NET HEAT DEMAND" />

            <div style={{ marginBottom: 14 }}>
              <NumInput
                label="Internal (design) temperature"
                value={internalTemp}
                onChange={setInternalTemp}
                min={10} max={30} step={0.5}
                unit="°C"
              />
            </div>

            {combined !== null ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ color: "#1e3a6b", fontSize: 8, marginBottom: 6, lineHeight: 1.6 }}>
                  Computed day-by-day: fabric + ventilation loss at {internalTemp}°C minus solar and internal gains per day,
                  so summer surpluses do not offset winter heating.
                </div>
                {combined && windowGroups.length > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ color: "#4a7fa5", fontSize: 10 }}>Solar gains offset</span>
                    <span style={{ fontFamily: "monospace", fontSize: 12, color: "#fbbf24" }}>
                      {combined.annualSolar.toFixed(0)}
                      <span style={{ fontSize: 8, color: "#78350f", marginLeft: 4 }}>kWh/yr</span>
                    </span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={{ color: "#4a7fa5", fontSize: 10 }}>Internal gains offset</span>
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: "#34d399" }}>
                    {(electricityGainKwh + peopleGainKwh).toFixed(0)}
                    <span style={{ fontSize: 8, color: "#134e2a", marginLeft: 4 }}>kWh/yr</span>
                  </span>
                </div>
                <div style={{
                  display: "flex", justifyContent: "space-between", alignItems: "baseline",
                  paddingTop: 10, borderTop: "1px solid #132040",
                }}>
                  <span style={{ color: "#7dd3fc", fontSize: 12, fontWeight: 700 }}>Net heating demand</span>
                  <span style={{ fontFamily: "monospace", fontSize: 18, color: "#7dd3fc", fontWeight: 700 }}>
                    {combined.netDemand.toFixed(0)}
                    <span style={{ fontSize: 10, color: "#2d5a8a", marginLeft: 6 }}>kWh/yr</span>
                  </span>
                </div>
                {summary.totalFloorArea > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ color: "#4a7fa5", fontSize: 10 }}>Heat demand intensity</span>
                    <span style={{ fontFamily: "monospace", fontSize: 13, color: "#7dd3fc" }}>
                      {(combined.netDemand / summary.totalFloorArea).toFixed(1)}
                      <span style={{ fontSize: 9, color: "#2d5a8a", marginLeft: 4 }}>kWh/m²·yr</span>
                    </span>
                  </div>
                )}
                {combined.monthlyNetDemand && (
                  <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid #132040" }}>
                    <div style={{ color: "#2d5a8a", fontSize: 9, marginBottom: 8, letterSpacing: "0.1em" }}>
                      MONTHLY NET HEATING DEMAND
                    </div>
                    <MonthlyNetDemandChart monthlyNetDemand={combined.monthlyNetDemand} />
                  </div>
                )}
              </div>
            ) : (
              <div style={{ color: "#2d5a8a", fontSize: 10 }}>
                Load an EPW weather file to compute net heating demand.
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
