import { useState, useEffect, useRef, useCallback } from "react";
import { recorder } from "./sessionRecorder.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function formatMs(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2,"0")}:${String(s % 60).padStart(2,"0")}.${String(ms % 1000).padStart(3,"0")}`;
}

const EVENT_COLOR = {
  draw_point:       "#38bdf8",
  room_close:       "#34d399",
  opening_add:      "#fbbf24",
  opening_delete:   "#f87171",
  room_delete:      "#f87171",
  room_rename:      "#c084fc",
  select_room:      "#60a5fa",
  select_opening:   "#60a5fa",
  select_clear:     "#2d5a8a",
  tool_change:      "#7dd3fc",
  key_escape:       "#4a7fa5",
  vertex_drag_end:  "#fb923c",
  ceiling_adjust:   "#a78bfa",
  storey_change:    "#34d399",
  rotation_change:  "#fbbf24",
  uvalue_room:      "#c084fc",
  uvalue_wall:      "#c084fc",
  uvalue_opening:   "#c084fc",
  clear_all:        "#f87171",
};

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Props:
 *   onClose()
 *   setters: { setRoomsByStorey, setCeilingHeights, setGlobalU, setBuildingRotation,
 *              setSelectedId, setSelectedOpening, setDraft, setActiveStorey }
 */
export default function ReplayPanel({ onClose, setters }) {
  const [session,     setSession]     = useState(null);   // loaded session JSON
  const [cursor,      setCursor]      = useState(-1);     // index into events (-1 = at initial snapshot)
  const [playing,     setPlaying]     = useState(false);
  const [speed,       setSpeed]       = useState(1);
  const [error,       setError]       = useState(null);
  const [savedList,   setSavedList]   = useState([]);

  const timerRef    = useRef(null);
  const listRef     = useRef(null);

  // Load saved sessions from localStorage on open
  useEffect(() => {
    setSavedList(recorder.listSessions());
  }, []);

  // ── Apply a state snapshot to the live editor ──
  const applyState = useCallback((state) => {
    if (!state) return;
    setters.setRoomsByStorey(state.roomsByStorey   ?? { 0:[], 1:[], 2:[] });
    setters.setCeilingHeights(state.ceilingHeights ?? { 0:3.0, 1:2.7, 2:2.5 });
    setters.setGlobalU(state.globalU               ?? {});
    setters.setBuildingRotation(state.buildingRotation ?? 0);
    setters.setSelectedId(null);
    setters.setSelectedOpening(null);
    setters.setDraft([]);
  }, [setters]);

  // ── Restore initial localStorage snapshot (state before first action) ──
  const applyInitialSnapshot = useCallback((session) => {
    const snap = session.snapshot;
    // Parse each key and apply
    try {
      const rooms    = snap.floorplan_rooms     ? JSON.parse(snap.floorplan_rooms)    : { 0:[], 1:[], 2:[] };
      const ceilings = snap.floorplan_ceilings  ? JSON.parse(snap.floorplan_ceilings) : { 0:3.0, 1:2.7, 2:2.5 };
      const uvals    = snap.floorplan_uvalues   ? JSON.parse(snap.floorplan_uvalues)  : {};
      const rotation = snap.floorplan_rotation  ? JSON.parse(snap.floorplan_rotation) : 0;
      setters.setRoomsByStorey(rooms);
      setters.setCeilingHeights(ceilings);
      setters.setGlobalU(uvals);
      setters.setBuildingRotation(rotation);
      setters.setSelectedId(null);
      setters.setSelectedOpening(null);
      setters.setDraft([]);
    } catch (e) {
      setError(`Failed to restore initial snapshot: ${e.message}`);
    }
  }, [setters]);

  // ── Jump to a specific event index ──
  const jumpTo = useCallback((idx, session) => {
    if (!session) return;
    stopPlayback();
    if (idx < 0) {
      applyInitialSnapshot(session);
      setCursor(-1);
      return;
    }
    const evt = session.events[idx];
    if (evt?.state) applyState(evt.state);
    setCursor(idx);
    // Scroll event into view
    setTimeout(() => {
      const el = listRef.current?.querySelector(`[data-idx="${idx}"]`);
      el?.scrollIntoView({ block: "nearest" });
    }, 0);
  }, [applyInitialSnapshot, applyState]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Playback ──
  const stopPlayback = useCallback(() => {
    clearTimeout(timerRef.current);
    setPlaying(false);
  }, []);

  const scheduleNext = useCallback((fromIdx, session, speed) => {
    const nextIdx = fromIdx + 1;
    if (nextIdx >= session.events.length) {
      setPlaying(false);
      return;
    }
    const delay = (session.events[nextIdx].t - session.events[fromIdx].t) / speed;
    timerRef.current = setTimeout(() => {
      const evt = session.events[nextIdx];
      if (evt?.state) applyState(evt.state);
      setCursor(nextIdx);
      setTimeout(() => {
        const el = listRef.current?.querySelector(`[data-idx="${nextIdx}"]`);
        el?.scrollIntoView({ block: "nearest" });
      }, 0);
      scheduleNext(nextIdx, session, speed);
    }, Math.max(0, delay));
  }, [applyState]);

  const startPlayback = useCallback((fromIdx, session, speed) => {
    stopPlayback();
    if (!session || fromIdx >= session.events.length - 1) return;
    setPlaying(true);
    scheduleNext(fromIdx, session, speed);
  }, [stopPlayback, scheduleNext]);

  // Clean up timer on unmount
  useEffect(() => () => clearTimeout(timerRef.current), []);

  // ── Load a session ──
  const loadSession = useCallback((sess) => {
    stopPlayback();
    setError(null);
    setSession(sess);
    setCursor(-1);
    applyInitialSnapshot(sess);
  }, [stopPlayback, applyInitialSnapshot]);

  const handleFileLoad = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const sess = JSON.parse(ev.target.result);
        if (!sess.events || !sess.snapshot) throw new Error("Not a valid session file");
        loadSession(sess);
      } catch (err) {
        setError(`Could not load file: ${err.message}`);
      }
    };
    reader.readAsText(file);
    // Reset file input so the same file can be reloaded
    e.target.value = "";
  };

  const events = session?.events ?? [];
  const duration = events.length ? events[events.length - 1].t : 0;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      display: "flex", alignItems: "flex-start", justifyContent: "flex-end",
      pointerEvents: "none",
    }}>
      {/* Backdrop — click to close */}
      <div
        onClick={onClose}
        style={{ position:"absolute", inset:0, background:"#000000aa", pointerEvents:"auto" }}
      />

      {/* Panel */}
      <div style={{
        position: "relative", pointerEvents: "auto",
        width: 340, height: "100%",
        background: "#070d1a",
        borderLeft: "1px solid #132040",
        display: "flex", flexDirection: "column",
        fontFamily: "monospace",
      }}>

        {/* Header */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
          padding:"0 14px", height:42, borderBottom:"1px solid #132040", flexShrink:0 }}>
          <span style={{ color:"#1e7a40", fontSize:11, letterSpacing:"0.15em" }}>● SESSION REPLAY</span>
          <button onClick={onClose} style={{ background:"none", border:"none", color:"#2d5a8a",
            cursor:"pointer", fontSize:16, lineHeight:1 }}>✕</button>
        </div>

        {/* Load controls */}
        <div style={{ padding:"12px 14px", borderBottom:"1px solid #132040", flexShrink:0 }}>
          <div style={{ color:"#2d5a8a", fontSize:9, letterSpacing:"0.12em", marginBottom:8 }}>LOAD SESSION</div>
          <label style={{ display:"block", padding:"6px 10px", background:"#0a1628",
            border:"1px solid #1e4a7a", borderRadius:4, color:"#7dd3fc", fontSize:10,
            cursor:"pointer", textAlign:"center", marginBottom:8 }}>
            📂 Load from file…
            <input type="file" accept=".json" onChange={handleFileLoad}
              style={{ display:"none" }} />
          </label>

          {savedList.length > 0 && (
            <div>
              <div style={{ color:"#1e3a6b", fontSize:8, letterSpacing:"0.1em", marginBottom:4 }}>
                SAVED IN BROWSER ({savedList.length})
              </div>
              <div style={{ maxHeight:110, overflowY:"auto" }}>
                {[...savedList].reverse().map(s => (
                  <div key={s.id}
                    onClick={() => loadSession(s)}
                    style={{ padding:"5px 8px", marginBottom:3, borderRadius:3, cursor:"pointer",
                      background: session?.id === s.id ? "#0f2a50" : "#0a1628",
                      border: `1px solid ${session?.id === s.id ? "#2563eb" : "#132040"}`,
                      display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <div>
                      <div style={{ color:"#7dd3fc", fontSize:9 }}>
                        {new Date(s.startedAt).toLocaleString([], { dateStyle:"short", timeStyle:"short" })}
                      </div>
                      <div style={{ color:"#2d5a8a", fontSize:8 }}>
                        {s.events.length} events · {formatMs(s.events[s.events.length-1]?.t ?? 0)}
                      </div>
                    </div>
                    <span style={{ color:"#2563eb", fontSize:10 }}>▶</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div style={{ marginTop:8, padding:"6px 8px", background:"#200a0a",
              border:"1px solid #7f1d1d", borderRadius:4, color:"#f87171", fontSize:9 }}>
              {error}
            </div>
          )}
        </div>

        {session && (<>
          {/* Session info */}
          <div style={{ padding:"8px 14px", borderBottom:"1px solid #132040", flexShrink:0,
            display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div>
              <div style={{ color:"#4a7fa5", fontSize:9 }}>
                {new Date(session.startedAt).toLocaleString([], { dateStyle:"medium", timeStyle:"short" })}
              </div>
              <div style={{ color:"#1e3a6b", fontSize:8 }}>
                {events.length} events · total {formatMs(duration)}
              </div>
            </div>
            <div style={{ color:"#1e7a40", fontSize:10 }}>
              {cursor < 0 ? "START" : `${cursor + 1} / ${events.length}`}
            </div>
          </div>

          {/* Transport bar */}
          <div style={{ padding:"10px 14px", borderBottom:"1px solid #132040", flexShrink:0 }}>
            {/* Scrubber */}
            <input
              type="range" min={-1} max={events.length - 1} step={1}
              value={cursor}
              onChange={e => jumpTo(Number(e.target.value), session)}
              style={{ width:"100%", accentColor:"#1e7a40", cursor:"pointer", marginBottom:8 }}
            />
            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
              {/* Rewind to start */}
              <button onClick={() => jumpTo(-1, session)}
                title="Go to start"
                style={btnStyle("#132040","#2d5a8a")}>⏮</button>
              {/* Step back */}
              <button onClick={() => jumpTo(Math.max(-1, cursor - 1), session)}
                title="Previous event"
                style={btnStyle("#132040","#2d5a8a")}>◀</button>
              {/* Play / Pause */}
              <button
                onClick={() => playing
                  ? stopPlayback()
                  : startPlayback(cursor, session, speed)}
                style={btnStyle(playing ? "#0c3050" : "#0a2818", playing ? "#38bdf8" : "#1e7a40", 16)}>
                {playing ? "⏸" : "▶"}
              </button>
              {/* Step forward */}
              <button onClick={() => jumpTo(Math.min(events.length - 1, cursor + 1), session)}
                title="Next event"
                style={btnStyle("#132040","#2d5a8a")}>▶</button>
              {/* Jump to end */}
              <button onClick={() => jumpTo(events.length - 1, session)}
                title="Go to end"
                style={btnStyle("#132040","#2d5a8a")}>⏭</button>
              <div style={{ flex:1 }}/>
              {/* Speed */}
              <div style={{ display:"flex", alignItems:"center", gap:3 }}>
                {[0.5, 1, 2, 4].map(s => (
                  <button key={s}
                    onClick={() => { setSpeed(s); if (playing) startPlayback(cursor, session, s); }}
                    style={{ padding:"2px 5px", background: speed===s ? "#1e4a7a" : "#0a1628",
                      border:`1px solid ${speed===s?"#2563eb":"#132040"}`,
                      color: speed===s ? "#7dd3fc" : "#2d5a8a",
                      borderRadius:3, cursor:"pointer", fontSize:8, fontFamily:"monospace" }}>
                    {s}×
                  </button>
                ))}
              </div>
            </div>
            {/* Timestamp */}
            <div style={{ marginTop:6, color:"#1e4a30", fontSize:9, textAlign:"center" }}>
              {cursor < 0 ? "── initial state ──" : formatMs(events[cursor]?.t ?? 0)}
            </div>
          </div>

          {/* Event list */}
          <div ref={listRef} style={{ flex:1, overflowY:"auto", padding:"6px 0" }}>
            {/* Virtual "start" entry */}
            <div
              data-idx="-1"
              onClick={() => jumpTo(-1, session)}
              style={{
                padding:"4px 14px", cursor:"pointer", fontSize:9,
                background: cursor === -1 ? "#0f2a50" : "transparent",
                borderLeft: `2px solid ${cursor === -1 ? "#2563eb" : "transparent"}`,
                color:"#2d5a8a",
              }}>
              ── initial state ──
            </div>
            {events.map((evt, i) => {
              const col = EVENT_COLOR[evt.type] ?? "#4a7fa5";
              const isCurrent = cursor === i;
              return (
                <div
                  key={i}
                  data-idx={i}
                  onClick={() => jumpTo(i, session)}
                  style={{
                    padding:"4px 14px", cursor:"pointer",
                    background: isCurrent ? "#0f2a50" : "transparent",
                    borderLeft: `2px solid ${isCurrent ? "#2563eb" : "transparent"}`,
                    display:"flex", alignItems:"baseline", gap:8,
                  }}>
                  <span style={{ color:"#1e3a6b", fontSize:8, flexShrink:0, minWidth:52 }}>
                    {formatMs(evt.t)}
                  </span>
                  <span style={{ color:col, fontSize:9, flexShrink:0 }}>
                    {evt.type}
                  </span>
                  <span style={{ color:"#1e3a6b", fontSize:8, overflow:"hidden",
                    textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {detailString(evt)}
                  </span>
                </div>
              );
            })}
          </div>
        </>)}

        {!session && (
          <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center",
            color:"#1e3a6b", fontSize:10, textAlign:"center", padding:24 }}>
            Load a session file or select one<br/>from the browser list above.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function btnStyle(bg, color, size = 13) {
  return {
    width:28, height:28, background:bg, border:`1px solid ${color}44`,
    color, borderRadius:4, cursor:"pointer", fontSize:size,
    display:"flex", alignItems:"center", justifyContent:"center",
    fontFamily:"monospace",
  };
}

function detailString(evt) {
  switch (evt.type) {
    case "tool_change":      return evt.tool ?? "";
    case "draw_point":       return evt.pt   ? `(${evt.pt.x.toFixed(1)}, ${evt.pt.y.toFixed(1)})` : "";
    case "room_close":       return `${evt.points?.length ?? "?"} pts`;
    case "opening_add":      return `${evt.type2 ?? evt.type} wall ${(evt.wallIdx??0)+1}`;
    case "room_rename":      return evt.name ?? "";
    case "ceiling_adjust":   return `storey ${evt.storey} → ${evt.height}m`;
    case "storey_change":    return `→ ${evt.storey}`;
    case "rotation_change":  return `${evt.rotation}°`;
    case "uvalue_room":      return `${evt.key} = ${evt.value ?? "default"}`;
    case "uvalue_wall":      return `wall ${(evt.wallIdx??0)+1} = ${evt.value ?? "default"}`;
    case "uvalue_opening":   return evt.value != null ? `${evt.value} W/m²K` : "default";
    case "vertex_drag_end":  return `room … v${evt.vIdx}`;
    default:                 return "";
  }
}
