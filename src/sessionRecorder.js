// Session recording for bug reproduction.
// Records a localStorage snapshot at session start, then a timestamped event log
// where each event carries the full editor state at that moment so it can be
// replayed simply by stepping through state snapshots.
//
// Sessions are stored in localStorage under "session_recordings" (up to 5 kept).

const STORAGE_KEY = "session_recordings";
const MAX_SESSIONS = 5;
const LS_KEYS = ["floorplan_rooms", "floorplan_ceilings", "floorplan_uvalues", "floorplan_rotation"];

function snapshotLocalStorage() {
  const snap = {};
  for (const key of LS_KEYS) {
    const val = localStorage.getItem(key);
    if (val !== null) snap[key] = val;
  }
  return snap;
}

function loadSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveSessions(sessions) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {}
}

class SessionRecorder {
  constructor() {
    this._session = null;
    this._stateGetter = null;
  }

  /**
   * Register a callback that returns the current editor state.
   * Called after every recorded action to snapshot state.
   * fn() → { roomsByStorey, ceilingHeights, globalU, buildingRotation }
   */
  setStateGetter(fn) {
    this._stateGetter = fn;
  }

  start() {
    this._session = {
      id: `session_${Date.now()}`,
      startedAt: new Date().toISOString(),
      snapshot: snapshotLocalStorage(),
      events: [],
    };
  }

  record(type, payload = {}) {
    if (!this._session) return;
    const state = this._stateGetter ? this._stateGetter() : null;
    this._session.events.push({
      t: Date.now() - new Date(this._session.startedAt).getTime(),
      type,
      state,
      ...payload,
    });
    // Persist incrementally so we don't lose events on a crash
    this._flush();
  }

  _flush() {
    if (!this._session) return;
    try {
      const sessions = loadSessions();
      const idx = sessions.findIndex(s => s.id === this._session.id);
      if (idx >= 0) sessions[idx] = this._session;
      else sessions.push(this._session);
      const trimmed = sessions.slice(-MAX_SESSIONS);
      saveSessions(trimmed);
    } catch {}
  }

  download() {
    if (!this._session) return;
    const json = JSON.stringify(this._session, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `session_${this._session.startedAt.replace(/[:.]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Return all sessions stored in localStorage. */
  listSessions() {
    return loadSessions();
  }

  get eventCount() {
    return this._session?.events.length ?? 0;
  }
}

export const recorder = new SessionRecorder();
