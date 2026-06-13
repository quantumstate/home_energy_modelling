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

// Fraction of the full inside-to-outside ΔT assumed across a surface
// adjoining an unheated space (e.g. garage, loft), per SAP convention.
export const UNHEATED_DELTA_T_FACTOR = 0.5;
