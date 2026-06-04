import { useState } from "react";
import FloorPlanUI from "./FloorPlanUI.jsx";
import ThreeDView from "./ThreeDView.jsx";
import UValueCalculator from "./UValueCalculator.jsx";
import HeatSummary from "./HeatSummary.jsx";

const TABS = [
  { id: "floor-plan", label: "Floor plan" },
  { id: "3d-view", label: "3d view" },
  { id: "u-value-calculator", label: "u value calculator" },
  { id: "heat-summary", label: "heat summary" },
];

function App() {
  const [activeTab, setActiveTab] = useState("floor-plan");

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
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
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
        {activeTab === "floor-plan" && <FloorPlanUI />}
        {activeTab === "3d-view" && <ThreeDView />}
        {activeTab === "u-value-calculator" && <UValueCalculator />}
        {activeTab === "heat-summary" && <HeatSummary />}
      </main>
    </div>
  );
}

export default App;
