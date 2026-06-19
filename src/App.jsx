import { useState } from "react";
import FloorPlanUI from "./FloorPlanUI.jsx";
import ThreeDView from "./ThreeDView.jsx";
import UValueCalculator from "./UValueCalculator.jsx";
import HeatSummary from "./HeatSummary.jsx";
import SolarTab from "./SolarTab.jsx";
import ThermalBridgesTab from "./ThermalBridgesTab.jsx";
import ProjectManager from "./ProjectManager.jsx";

const TABS = [
  { id: "floor-plan", label: "Floor plan" },
  { id: "3d-view", label: "3d view" },
  { id: "u-value-calculator", label: "u value calculator" },
  { id: "heat-summary", label: "heat summary" },
  { id: "solar", label: "solar" },
  { id: "thermal-bridges", label: "Thermal Bridges" },
];

function App() {
  const [activeTab, setActiveTab] = useState("floor-plan");
  const [currentProject, setCurrentProject] = useState(null);

  if (!currentProject) {
    return <ProjectManager onOpen={setCurrentProject} />;
  }

  const handleTabChange = (tabId) => {
    if (activeTab === "floor-plan" && tabId !== "floor-plan") {
      const valid = localStorage.getItem(`${currentProject.id}_floorplan_valid`);
      if (valid !== "true" && !window.confirm(
        "Energy calculations will not be valid until every storey's walls form a closed outer boundary. Leave anyway?"
      )) return;
    }
    setActiveTab(tabId);
  };

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#05090f",
        overflow: "hidden",
      }}
    >
      <nav
        aria-label="Application views"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          height: 42,
          padding: "0 12px",
          background: "#070d1a",
          borderBottom: "1px solid #132040",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={() => setCurrentProject(null)}
          title="Back to projects"
          style={{
            height: 30,
            padding: "0 10px",
            background: "transparent",
            color: "#2d5a8a",
            border: "1px solid #132040",
            borderRadius: 5,
            cursor: "pointer",
            fontFamily: "monospace",
            fontSize: 14,
            marginRight: 4,
          }}
        >
          ‹
        </button>
        <span
          style={{
            color: "#4a7aaa",
            fontFamily: "monospace",
            fontSize: 11,
            letterSpacing: "0.07em",
            marginRight: 8,
            maxWidth: 180,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {currentProject.name}
        </span>
        <div style={{ width: 1, height: 20, background: "#132040", marginRight: 8 }} />
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleTabChange(tab.id)}
              aria-current={isActive ? "page" : undefined}
              style={{
                height: 30,
                padding: "0 12px",
                background: isActive ? "#1e4a7a" : "transparent",
                color: isActive ? "#7dd3fc" : "#2d5a8a",
                border: `1px solid ${isActive ? "#2563eb" : "#132040"}`,
                borderRadius: 5,
                cursor: "pointer",
                fontFamily: "monospace",
                fontSize: 10,
                letterSpacing: "0.07em",
                textTransform: "uppercase",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      <main style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {activeTab === "floor-plan" && <FloorPlanUI projectId={currentProject.id} onNavigate={setActiveTab} />}
        {activeTab === "3d-view" && <ThreeDView projectId={currentProject.id} />}
        {activeTab === "u-value-calculator" && <UValueCalculator projectId={currentProject.id} />}
        {activeTab === "heat-summary" && <HeatSummary projectId={currentProject.id} />}
        {activeTab === "solar" && <SolarTab projectId={currentProject.id} />}
        {activeTab === "thermal-bridges" && <ThermalBridgesTab projectId={currentProject.id} />}
      </main>
    </div>
  );
}

export default App;
