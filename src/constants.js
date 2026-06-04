// Shared constants used by FloorPlanUI, geometryProcessor, and ThreeDView.

export const STOREY_LABELS = ["Ground", "First", "Second"];

// Sensible UK Part-L defaults, W/(m²·K)
export const DEFAULT_U_VALUES = {
  wall:   0.30,
  floor:  0.25,
  roof:   0.20,
  window: 1.60,
  door:   1.80,
};
