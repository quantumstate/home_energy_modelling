import { useState } from "react";

const PROJECTS_KEY = "projects_list";

export function loadProjects() {
  try {
    const s = localStorage.getItem(PROJECTS_KEY);
    return s ? JSON.parse(s) : [];
  } catch {
    return [];
  }
}

function saveProjects(projects) {
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects)); } catch {}
}

export function createProject(name) {
  const projects = loadProjects();
  const id = `proj_${Date.now()}`;
  const project = { id, name: name.trim(), createdAt: Date.now() };
  saveProjects([...projects, project]);
  return project;
}

export function deleteProject(id) {
  const projects = loadProjects().filter(p => p.id !== id);
  saveProjects(projects);
  const prefix = `${id}_`;
  Object.keys(localStorage)
    .filter(k => k.startsWith(prefix))
    .forEach(k => localStorage.removeItem(k));
}

export function projectKey(projectId, key) {
  return `${projectId}_${key}`;
}

const BTN = {
  height: 30,
  padding: "0 14px",
  border: "1px solid #132040",
  borderRadius: 5,
  cursor: "pointer",
  fontFamily: "monospace",
  fontSize: 11,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
};

export default function ProjectManager({ onOpen }) {
  const [projects, setProjects] = useState(() => loadProjects());
  const [newName, setNewName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);

  const refresh = () => setProjects(loadProjects());

  const handleCreate = () => {
    const name = newName.trim() || "Untitled project";
    const project = createProject(name);
    setNewName("");
    refresh();
    onOpen(project);
  };

  const handleDelete = (id) => {
    deleteProject(id);
    setConfirmDelete(null);
    refresh();
  };

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#05090f",
        color: "#7dd3fc",
        fontFamily: "monospace",
      }}
    >
      <div style={{ width: 480, maxWidth: "90vw" }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 28, letterSpacing: "0.08em", color: "#93c5fd" }}>
          HOME ENERGY MODELLING
        </h1>

        <section style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 11, letterSpacing: "0.1em", color: "#2d5a8a", marginBottom: 12 }}>
            CREATE NEW PROJECT
          </h2>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              placeholder="Project name"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleCreate()}
              style={{
                flex: 1,
                height: 32,
                padding: "0 10px",
                background: "#070d1a",
                border: "1px solid #132040",
                borderRadius: 5,
                color: "#7dd3fc",
                fontFamily: "monospace",
                fontSize: 12,
                outline: "none",
              }}
            />
            <button
              onClick={handleCreate}
              style={{ ...BTN, background: "#1e4a7a", color: "#7dd3fc", border: "1px solid #2563eb" }}
            >
              Create
            </button>
          </div>
        </section>

        {projects.length > 0 && (
          <section>
            <h2 style={{ fontSize: 11, letterSpacing: "0.1em", color: "#2d5a8a", marginBottom: 12 }}>
              PROJECTS
            </h2>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
              {projects.map(p => (
                <li
                  key={p.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 12px",
                    background: "#070d1a",
                    border: "1px solid #132040",
                    borderRadius: 6,
                  }}
                >
                  <span style={{ flex: 1, fontSize: 13, color: "#93c5fd" }}>{p.name}</span>
                  <span style={{ fontSize: 10, color: "#2d5a8a" }}>
                    {new Date(p.createdAt).toLocaleDateString()}
                  </span>
                  {confirmDelete === p.id ? (
                    <>
                      <span style={{ fontSize: 10, color: "#f47272" }}>Delete?</span>
                      <button onClick={() => handleDelete(p.id)} style={{ ...BTN, background: "#3b0a0a", color: "#f47272", border: "1px solid #7f1d1d" }}>Yes</button>
                      <button onClick={() => setConfirmDelete(null)} style={{ ...BTN, background: "transparent", color: "#2d5a8a" }}>No</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => onOpen(p)} style={{ ...BTN, background: "#1e4a7a", color: "#7dd3fc", border: "1px solid #2563eb" }}>Open</button>
                      <button onClick={() => setConfirmDelete(p.id)} style={{ ...BTN, background: "transparent", color: "#2d5a8a" }}>Delete</button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
